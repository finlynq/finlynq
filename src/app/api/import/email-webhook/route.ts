/**
 * Inbound email webhook.
 *
 * Two accepted transports:
 *
 *   1. Resend Inbound (production path) — JSON body, svix-signed. The Resend
 *      dashboard points a catch-all `*@finlynq.com` route here. We verify
 *      the svix signature, route the `to` address through the 3-way router
 *      (import / mailbox / trash), and dispatch:
 *        - import  → stage transactions for review at /import/pending
 *        - mailbox → store in admin inbox, notify admins
 *        - trash   → store in admin inbox with 24h TTL, notify admins
 *      Always returns 200 on routed requests (no status-code leak). Returns
 *      401 on signature failure, 413 on oversize, 429 on rate limit.
 *
 *   2. Self-hosted multipart (legacy path) — `multipart/form-data` with
 *      `x-webhook-secret` header. Still auto-imports into `transactions`
 *      using the `email_webhook_dek` envelope. Kept for backward compat;
 *      will be removed once Phase B cutover lands.
 *
 * See Research/email-import-resend-plan.md.
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import {
  csvToRawTransactions,
  csvToRawTransactionsWithMapping,
  extractCSVHeaders,
} from "@/lib/csv-parser";
import { extractExcelRows, parseExcelSheets } from "@/lib/excel-parser";
import { executeImport } from "@/lib/import-pipeline";
import type { RawTransaction } from "@/lib/import-pipeline";
import { safeErrorMessage } from "@/lib/validate";
import { deserializeTemplate, findBestTemplate, autoDetectColumnMapping } from "@/lib/import-templates";
import { unwrapDEKForSecret } from "@/lib/api-auth";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { checkRateLimit } from "@/lib/rate-limit";
import { extractSvixHeaders, verifySvixSignature, SvixVerifyError } from "@/lib/webhooks/svix";
import { routeAddress } from "@/lib/email-import/address-router";
import { parseResendAttachments, type ResendAttachment } from "@/lib/email-import/parse-attachments";
import { stageEmailImport } from "@/lib/email-import/stage-email-import";
import {
  storeIncomingEmail,
  notifyAdminsOfIncoming,
} from "@/lib/email-import/store-incoming-email";

// 10 MB request-body cap on the Resend path.
const MAX_BODY_BYTES = 10 * 1024 * 1024;
// 25 emails/hour/recipient address.
const INBOUND_RATE_MAX = 25;
const INBOUND_RATE_WINDOW_MS = 60 * 60 * 1000;

export async function POST(request: NextRequest) {
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) {
    return handleResendInbound(request);
  }
  if (ct.includes("multipart/form-data")) {
    return handleSelfHostedMultipart(request);
  }
  return NextResponse.json({ error: "Unsupported content-type" }, { status: 415 });
}

// ─── Resend path ────────────────────────────────────────────────────────────

async function handleResendInbound(request: NextRequest): Promise<NextResponse> {
  // Size cap via Content-Length fast-path — we want to reject huge payloads
  // before buffering the body.
  const lenHeader = request.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    // Misconfiguration — fail loud so the deploy is obviously broken.
    console.error("[email-webhook] RESEND_WEBHOOK_SECRET not set");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }

  // Read the raw body once — we need the exact bytes for both signature
  // verification and JSON parsing. Re-parsing + stringifying would break
  // the HMAC because whitespace matters.
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  try {
    verifySvixSignature(rawBody, extractSvixHeaders(request.headers), secret);
  } catch (e) {
    if (e instanceof SvixVerifyError) {
      // Log reason internally (helps debug DNS / secret rotation issues) but
      // don't leak details in the response.
      console.warn(`[email-webhook] svix verify failed: ${e.reason}`);
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
    throw e;
  }

  // Body is authentic. Parse.
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = extractResendPayload(payload);
  if (!parsed) {
    return NextResponse.json({ error: "Unrecognized payload shape" }, { status: 400 });
  }

  const svixId = request.headers.get("svix-id") || null;

  // Route each recipient. A single email can be addressed to multiple
  // finlynq mailboxes; each gets its own routing decision + dispatch.
  const results: Array<{ to: string; category: string; note?: string }> = [];
  for (const to of parsed.to) {
    // Rate limit per-address. Shared across categories so an attacker can't
    // cycle import-*@ → trash → flood.
    const rl = checkRateLimit(
      `email-inbound:${to.toLowerCase()}`,
      INBOUND_RATE_MAX,
      INBOUND_RATE_WINDOW_MS,
    );
    if (!rl.allowed) {
      results.push({ to, category: "rate-limited" });
      continue;
    }

    const route = await routeAddress(to);

    if (route.category === "import" && route.userId) {
      try {
        const rows = await parseResendAttachments(parsed.attachments, route.userId);
        if (rows.length === 0) {
          // No usable attachments — treat as trash so admin can see the
          // body (some banks send HTML bodies with no CSV).
          await storeIncomingEmail({
            category: "trash",
            toAddress: route.address,
            fromAddress: parsed.from,
            subject: parsed.subject,
            bodyText: parsed.text,
            bodyHtml: parsed.html,
            attachmentCount: parsed.attachments.length,
            svixId,
          });
          await notifyAdminsOfIncoming("trash", route.address);
          results.push({ to: route.address, category: "trash", note: "no-attachments" });
          continue;
        }

        const stageResult = await stageEmailImport({
          userId: route.userId,
          rows,
          source: "email",
          fromAddress: parsed.from,
          subject: parsed.subject,
          svixId,
        });

        // User-facing notification — they'll see this next time they log in.
        if (!stageResult.alreadyProcessed) {
          await db.insert(schema.notifications).values({
            type: "import",
            title: "New email import pending",
            message: `${stageResult.totalRowCount} transactions from ${parsed.from} waiting at /import/pending`,
            read: 0,
            createdAt: new Date().toISOString(),
            userId: route.userId,
          });
        }
        results.push({
          to: route.address,
          category: "import",
          note: stageResult.alreadyProcessed ? "duplicate-svix" : "staged",
        });
      } catch (e) {
        console.error("[email-webhook] import path failed", e);
        // Don't surface the error publicly, but return 500 so Resend retries.
        return NextResponse.json({ error: "Internal error" }, { status: 500 });
      }
    } else {
      // mailbox or trash
      await storeIncomingEmail({
        category: route.category as "mailbox" | "trash",
        toAddress: route.address,
        fromAddress: parsed.from,
        subject: parsed.subject,
        bodyText: parsed.text,
        bodyHtml: parsed.html,
        attachmentCount: parsed.attachments.length,
        svixId,
      });
      await notifyAdminsOfIncoming(
        route.category as "mailbox" | "trash",
        route.address,
      );
      results.push({ to: route.address, category: route.category });
    }
  }

  return NextResponse.json({ ok: true, results });
}

// ─── Resend payload shape — tolerant parser ─────────────────────────────────

interface ParsedResendPayload {
  from: string;
  to: string[];
  subject: string | null;
  text: string | null;
  html: string | null;
  attachments: ResendAttachment[];
}

/**
 * Resend's public Inbound payload shape isn't 100% pinned yet. We accept a
 * few common variants (nested `data` envelope, `email`/`address` field
 * names, `content`/`content_b64`) so we don't break when they tweak the
 * schema. Returns null if we can't find recognizable from/to fields.
 */
function extractResendPayload(raw: unknown): ParsedResendPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const outer = raw as Record<string, unknown>;
  const data = (outer.data && typeof outer.data === "object"
    ? (outer.data as Record<string, unknown>)
    : outer);

  const from = extractEmail(data.from);
  if (!from) return null;

  const toRaw = data.to;
  const to: string[] = [];
  if (Array.isArray(toRaw)) {
    for (const t of toRaw) {
      const addr = extractEmail(t);
      if (addr) to.push(addr);
    }
  } else {
    const single = extractEmail(toRaw);
    if (single) to.push(single);
  }
  if (to.length === 0) return null;

  const subject = typeof data.subject === "string" ? data.subject : null;
  const text = typeof data.text === "string" ? data.text : null;
  const html = typeof data.html === "string" ? data.html : null;

  const attachments: ResendAttachment[] = [];
  const attsRaw = data.attachments;
  if (Array.isArray(attsRaw)) {
    for (const a of attsRaw) {
      if (!a || typeof a !== "object") continue;
      const rec = a as Record<string, unknown>;
      const filename = typeof rec.filename === "string" ? rec.filename
        : typeof rec.name === "string" ? rec.name
        : null;
      // Accept `content`, `content_b64`, or `contentBase64`.
      const content = typeof rec.content === "string" ? rec.content
        : typeof rec.content_b64 === "string" ? rec.content_b64
        : typeof rec.contentBase64 === "string" ? rec.contentBase64
        : null;
      if (!filename || !content) continue;
      const contentType = typeof rec.content_type === "string" ? rec.content_type
        : typeof rec.contentType === "string" ? rec.contentType
        : undefined;
      attachments.push({ filename, contentType, content });
    }
  }

  return { from, to, subject, text, html, attachments };
}

function extractEmail(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const rec = raw as Record<string, unknown>;
    if (typeof rec.email === "string") return rec.email;
    if (typeof rec.address === "string") return rec.address;
  }
  return null;
}

// ─── Self-hosted multipart path (unchanged from pre-Resend) ─────────────────

async function handleSelfHostedMultipart(request: NextRequest): Promise<NextResponse> {
  try {
    const secret = request.headers.get("x-webhook-secret");
    const storedSecret = await db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, "email_webhook_secret"))
      .get();

    if (!storedSecret || secret !== storedSecret.value) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = storedSecret.userId;

    let webhookDek: Buffer | null = null;
    const dekRow = await db
      .select({ value: schema.settings.value })
      .from(schema.settings)
      .where(and(eq(schema.settings.key, "email_webhook_dek"), eq(schema.settings.userId, userId)))
      .get();
    if (dekRow?.value) {
      try {
        webhookDek = unwrapDEKForSecret(dekRow.value, secret!);
      } catch {
        webhookDek = null;
      }
    }

    const templateRows = await db
      .select()
      .from(schema.importTemplates)
      .where(eq(schema.importTemplates.userId, userId))
      .all();
    const templates = templateRows.map(deserializeTemplate);

    const formData = await request.formData() as unknown as globalThis.FormData;
    const allRows: RawTransaction[] = [];
    const defaultAccount = formData.get("defaultAccount") as string | null;

    for (const [key, value] of formData.entries()) {
      if (!(value instanceof File)) continue;
      if (key === "defaultAccount") continue;

      const ext = value.name.split(".").pop()?.toLowerCase();
      let rows: RawTransaction[] = [];

      if (ext === "csv") {
        const text = await value.text();
        const headers = extractCSVHeaders(text);
        const bestMatch = findBestTemplate(headers, templates);

        if (bestMatch) {
          const result = csvToRawTransactionsWithMapping(text, bestMatch.template.columnMapping as unknown as Record<string, string>);
          rows = result.rows;
          if (bestMatch.template.defaultAccount) {
            rows = rows.map((r) => ({
              ...r,
              account: r.account || bestMatch.template.defaultAccount!,
            }));
          }
        } else {
          rows = csvToRawTransactions(text).rows;
        }
      } else if (ext === "pdf") {
        const buffer = Buffer.from(await value.arrayBuffer());
        const { parsePdfToTransactions } = await import("@/lib/pdf-parser");
        const result = await parsePdfToTransactions(buffer);
        rows = result.rows;
      } else if (ext === "xlsx" || ext === "xls") {
        const buffer = Buffer.from(await value.arrayBuffer());
        const sheets = parseExcelSheets(buffer);
        if (sheets.length > 0 && sheets[0].headers.length > 0) {
          const sheet = sheets[0];
          const mapping = autoDetectColumnMapping(sheet.headers);
          if (mapping) {
            rows = extractExcelRows(buffer, sheet.name, mapping).rows;
          }
        }
      }

      if (defaultAccount) {
        rows = rows.map((r) => ({ ...r, account: r.account || defaultAccount }));
      }

      allRows.push(...rows);
    }

    if (allRows.length === 0) {
      return NextResponse.json({ message: "No importable data found in attachments" });
    }

    const result = await executeImport(allRows, [], userId, webhookDek ?? undefined);
    if ((result.imported ?? 0) > 0) invalidateUserTxCache(userId);

    await db.insert(schema.notifications)
      .values({
        type: "import",
        title: "Email Import Complete",
        message: `Imported ${result.imported} transactions (${result.skippedDuplicates} duplicates skipped)`,
        read: 0,
        createdAt: new Date().toISOString(),
        userId,
      });

    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = safeErrorMessage(error, "Email import failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
