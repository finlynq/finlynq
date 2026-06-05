/**
 * Inbound email webhook.
 *
 * Three accepted transports:
 *
 *   1. Provider JSON (production path) — `application/json`. The provider is
 *      selected by INBOUND_EMAIL_PROVIDER:
 *        - 'self-smtp' → self-hosted Mailpit (basic-auth; fetch body +
 *          attachments via REST; delete after store).
 *        - 'resend'    → Resend Inbound (svix-signed; no delete API) — default.
 *      Both share one handler via the InboundEmailProvider abstraction
 *      (src/lib/email-import/providers). The `to` address is routed through the
 *      3-way router (import / mailbox / trash):
 *        - import  → attachments stage at /import/pending; a transaction in the
 *                    BODY is heuristically parsed (no LLM) and staged too; in
 *                    both cases a per-user `email_inbox` row is created for the
 *                    Email tab in /import. The DEK-bearing sweep (B5) later
 *                    auto-records body emails that match a user rule.
 *        - mailbox → admin inbox, notify admins
 *        - trash   → admin inbox with 24h TTL, notify admins
 *      Always returns 200 on routed requests (no status-code leak). Returns
 *      401 on auth failure, 413 on oversize, 429 on rate limit. After durable
 *      store, the message is deleted from the provider (no-op for Resend).
 *
 *   2. Self-hosted multipart (legacy path) — `multipart/form-data` with
 *      `x-webhook-secret` header. Still auto-imports into `transactions`
 *      using the `email_webhook_dek` envelope. Kept for backward compat.
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
import { unwrapDEKForSecret, authLookupHash } from "@/lib/api-auth";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { checkRateLimit } from "@/lib/rate-limit";
import { routeAddress } from "@/lib/email-import/address-router";
import { parseResendAttachments } from "@/lib/email-import/parse-attachments";
import { stageEmailImport } from "@/lib/email-import/stage-email-import";
import {
  storeIncomingEmail,
  notifyAdminsOfIncoming,
} from "@/lib/email-import/store-incoming-email";
import { sendBounceIfAuthenticated } from "@/lib/email-import/bounce";
import { getInboundProvider } from "@/lib/email-import/providers";
import type { ParsedInboundEmail } from "@/lib/email-import/providers";
import { parseEmailBody } from "@/lib/email-import/parse-body";
import {
  storeEmailInbox,
  type EmailInboxAction,
} from "@/lib/email-import/store-email-inbox";

// 10 MB request-body cap on the JSON path.
const MAX_BODY_BYTES = 10 * 1024 * 1024;
// 25 emails/hour/recipient address.
const INBOUND_RATE_MAX = 25;
const INBOUND_RATE_WINDOW_MS = 60 * 60 * 1000;

export async function POST(request: NextRequest) {
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) {
    return handleProviderInbound(request);
  }
  if (ct.includes("multipart/form-data")) {
    return handleSelfHostedMultipart(request);
  }
  return NextResponse.json({ error: "Unsupported content-type" }, { status: 415 });
}

// ─── Provider JSON path (Resend OR Mailpit) ─────────────────────────────────

async function handleProviderInbound(request: NextRequest): Promise<NextResponse> {
  // Size cap via Content-Length fast-path before buffering the body.
  const lenHeader = request.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  const provider = getInboundProvider();

  // Read the raw body once — svix (Resend) needs the exact bytes for the HMAC.
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  const auth = await provider.verifyAuth(request, rawBody);
  if (!auth.ok) {
    const msg =
      auth.status === 500 ? "Webhook not configured" : "Unauthorized";
    return NextResponse.json({ error: msg }, { status: auth.status });
  }

  const parsed = provider.parsePayload(rawBody);
  if (!parsed) {
    return NextResponse.json({ error: "Unrecognized payload shape" }, { status: 400 });
  }

  // Enrich body + attachment bytes the webhook summary omitted. Resend inlines
  // body but not attachments; Mailpit inlines neither. "Payload wins, else
  // fetched." Never 5xx on a fetch miss — degrades to what the payload carried.
  const messageId = parsed.providerMessageId;
  let text = parsed.text;
  let html = parsed.html;
  let attachments = parsed.attachments;
  if (messageId && (attachments.length === 0 || (text == null && html == null))) {
    try {
      const content = await provider.fetchContent(messageId);
      if (text == null) text = content.text;
      if (html == null) html = content.html;
      if (attachments.length === 0) attachments = content.attachments;
    } catch (e) {
      console.warn("[email-webhook] fetchContent failed", e);
    }
  }

  const svixId = request.headers.get("svix-id") || null;
  const receivedDate = new Date().toISOString().slice(0, 10);

  // Route each recipient. A single email can hit multiple finlynq mailboxes.
  const results: Array<{ to: string; category: string; note?: string }> = [];
  for (const to of parsed.to) {
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
        const res = await ingestImportEmail({
          userId: route.userId,
          address: route.address,
          parsed,
          messageId,
          svixId,
          text,
          html,
          attachments,
          receivedDate,
        });
        results.push({ to: route.address, category: "import", note: res });
      } catch (e) {
        console.error("[email-webhook] import path failed", e);
        // 500 → Resend retries; Mailpit's poll backstop re-ingests. We do NOT
        // deleteReceived here (message stays in Mailpit for the retry).
        return NextResponse.json({ error: "Internal error" }, { status: 500 });
      }
    } else {
      // mailbox or trash
      await storeIncomingEmail({
        category: route.category as "mailbox" | "trash",
        toAddress: route.address,
        fromAddress: parsed.from,
        subject: parsed.subject,
        bodyText: text,
        bodyHtml: html,
        attachmentCount: attachments.length,
        svixId,
      });
      await notifyAdminsOfIncoming(
        route.category as "mailbox" | "trash",
        route.address,
      );
      if (route.category === "trash") {
        sendBounceIfAuthenticated({
          toAddress: route.address,
          fromAddress: parsed.from,
          subject: parsed.subject,
          authVerdict: parsed.authVerdict ?? {},
        }).catch((e) => console.warn("[email-webhook] bounce failed", e));
      }
      results.push({ to: route.address, category: route.category });
    }
  }

  // Durable store complete for every recipient — delete from the provider.
  // No-op for Resend; real DELETE for Mailpit. Best-effort: a failed delete is
  // backstopped by Mailpit's MP_MAX retention prune.
  if (messageId) {
    await provider.deleteReceived(messageId).catch((e) =>
      console.warn("[email-webhook] deleteReceived failed", e),
    );
  }

  return NextResponse.json({ ok: true, results });
}

/**
 * Ingest one import-addressed email for one recipient: attachments → staging,
 * else heuristic body parse → 1-row staging, ALWAYS an `email_inbox` row.
 * Idempotent on the per-recipient dedupe key (skips re-delivery / poll racing).
 * Returns a short status note for the response.
 */
async function ingestImportEmail(args: {
  userId: string;
  address: string;
  parsed: ParsedInboundEmail;
  messageId: string | null;
  svixId: string | null;
  text: string | null;
  html: string | null;
  attachments: ParsedInboundEmail["attachments"];
  receivedDate: string;
}): Promise<string> {
  const { userId, address, parsed, messageId, svixId, text, html, attachments, receivedDate } = args;

  const dedupeKey = `${messageId ?? svixId ?? "noid"}:${address}`;

  // Idempotency: if this email+recipient was already stored, skip staging too
  // (avoids a duplicate staged_import on webhook retry / poll backstop).
  const pre = await db
    .select({ id: schema.emailInbox.id })
    .from(schema.emailInbox)
    .where(eq(schema.emailInbox.dedupeKey, dedupeKey))
    .limit(1);
  if (pre[0]?.id) return "duplicate";

  let sourceKind: "attachment" | "body";
  let action: EmailInboxAction;
  let stagedImportId: string | null = null;
  let parseConfidence: "high" | "low" | null = null;
  let totalRowCount = 0;

  // 1) Attachments first (existing CSV/PDF/Excel pipeline).
  const { rows, csvFallbackMeta } = await parseResendAttachments(attachments, userId);
  if (rows.length > 0) {
    sourceKind = "attachment";
    action = "needs_review";
    const stageResult = await stageEmailImport({
      userId,
      rows,
      source: "email",
      fromAddress: parsed.from,
      subject: parsed.subject,
      svixId,
      headers: csvFallbackMeta?.headers ?? null,
      sampleRows: csvFallbackMeta?.sampleRows ?? null,
    });
    stagedImportId = stageResult.stagedImportId;
    totalRowCount = stageResult.totalRowCount;
  } else {
    // 2) No usable attachment — heuristic body parse.
    sourceKind = "body";
    const body = parseEmailBody({
      text,
      html,
      subject: parsed.subject,
      receivedDate,
    });
    if (body.candidate && body.confidence != null) {
      action = "needs_review";
      parseConfidence = body.confidence;
      const raw: RawTransaction = {
        date: body.candidate.date,
        account: "", // resolved at sweep/record time from the email rule
        amount: body.candidate.amount,
        payee: body.candidate.payee,
        currency: body.candidate.currency,
        note: body.candidate.note,
      };
      const stageResult = await stageEmailImport({
        userId,
        rows: [raw],
        source: "email",
        fromAddress: parsed.from,
        subject: parsed.subject,
        svixId,
      });
      stagedImportId = stageResult.stagedImportId;
      totalRowCount = stageResult.totalRowCount;
    } else {
      // Non-financial / unparseable body — keep it visible in the tab so the
      // user can act, but no staged candidate.
      action = "unparseable";
    }
  }

  const stored = await storeEmailInbox({
    userId,
    dedupeKey,
    messageId,
    fromAddress: parsed.from,
    subject: parsed.subject,
    bodyText: text,
    bodyHtml: html,
    sourceKind,
    action,
    stagedImportId,
    parseConfidence,
  });

  if (!stored.alreadyExisted && action !== "unparseable") {
    await db.insert(schema.notifications).values({
      type: "import",
      title: "New email import pending",
      message:
        sourceKind === "attachment"
          ? `${totalRowCount} transaction(s) from ${parsed.from} waiting at /import?tab=email`
          : `A transaction from ${parsed.from} is waiting to be recorded at /import?tab=email`,
      read: 0,
      createdAt: new Date().toISOString(),
      userId,
    });
  }

  return action;
}

// ─── Self-hosted multipart path (unchanged from pre-Resend) ─────────────────

async function handleSelfHostedMultipart(request: NextRequest): Promise<NextResponse> {
  try {
    const secret = request.headers.get("x-webhook-secret");
    if (!secret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // Stored value is a hash; compare by hashing the presented secret.
    const secretHash = authLookupHash(secret);
    const storedSecret = await db
      .select()
      .from(schema.settings)
      .where(
        and(
          eq(schema.settings.key, "email_webhook_secret"),
          eq(schema.settings.value, secretHash)
        )
      )
      .get();

    if (!storedSecret) {
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
        const sheets = await parseExcelSheets(buffer);
        if (sheets.length > 0 && sheets[0].headers.length > 0) {
          const sheet = sheets[0];
          const mapping = autoDetectColumnMapping(sheet.headers);
          if (mapping) {
            rows = (await extractExcelRows(buffer, sheet.name, mapping)).rows;
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
