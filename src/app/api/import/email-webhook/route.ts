/**
 * Inbound email webhook.
 *
 * Three accepted transports:
 *
 *   1. Provider JSON (production path) — `application/json`. The provider is
 *      selected by INBOUND_EMAIL_PROVIDER:
 *        - 'self-smtp' → self-hosted via the DevManager push relay (HMAC-signed;
 *          self-contained payload — body + attachments inline; DevManager owns
 *          the Mailpit delete + retries, so the app makes no mail-store calls).
 *        - 'resend'    → Resend Inbound (svix-signed; no delete API) — default.
 *      Both share one handler via the InboundEmailProvider abstraction
 *      (src/lib/email-import/providers) + the shared ingest path
 *      (src/lib/email-import/ingest). The `to`/`recipient` address is routed
 *      import / mailbox / trash; import emails stage attachments + heuristically
 *      parse a body transaction + write a per-user email_inbox row; the
 *      DEK-bearing sweep (B5) later auto-records body emails that match a user
 *      rule. Always 200 on routed requests; 401 on auth failure, 413 on
 *      oversize. A non-2xx makes DevManager retain + retry the message (svix
 *      retries for Resend), so a transient failure loses nothing.
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
import { getInboundProvider } from "@/lib/email-import/providers";
import { resendProvider } from "@/lib/email-import/providers/resend";
import { ingestInboundEmail } from "@/lib/email-import/ingest";

// Request-body cap on the JSON path. The DevManager push relay inlines
// attachments as base64 (~+33%), so its 10 MB/message cap can yield a ~13.4 MB
// JSON payload; a 413 here would loop DevManager's retry. 20 MB gives headroom
// over the inflated worst case. (Resend payloads don't inline attachments, so
// this is only ever exercised by the self-smtp push.)
const MAX_BODY_BYTES = 20 * 1024 * 1024;

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
  const lenHeader = request.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  // Content-negotiate the provider by transport signature rather than binding
  // the single configured provider. The self-smtp DevManager relay carries an
  // `x-webhook-secret`/HMAC and NO svix headers; Resend Inbound is svix-signed.
  // So a svix-signed request is verified by the Resend provider even when the
  // deployment's default provider is self-smtp — this is what lets info@ mail
  // routed through Resend Inbound reach /admin/inbox without flipping the global
  // INBOUND_EMAIL_PROVIDER (which would break the mail.finlynq.com import path).
  // A request with no svix headers keeps the exact pre-existing behavior.
  const hasSvix = !!(
    request.headers.get("svix-signature") || request.headers.get("svix-id")
  );
  const provider = hasSvix ? resendProvider : getInboundProvider();

  // Read the raw body once — svix (Resend) needs the exact bytes for the HMAC.
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  const auth = await provider.verifyAuth(request, rawBody);
  if (!auth.ok) {
    const msg = auth.status === 500 ? "Webhook not configured" : "Unauthorized";
    return NextResponse.json({ error: msg }, { status: auth.status });
  }

  const parsed = provider.parsePayload(rawBody);
  if (!parsed) {
    return NextResponse.json({ error: "Unrecognized payload shape" }, { status: 400 });
  }

  const svixId = request.headers.get("svix-id") || null;
  const receivedDate = new Date().toISOString().slice(0, 10);

  let results;
  try {
    results = await ingestInboundEmail(provider, parsed, { svixId, receivedDate });
  } catch (e) {
    console.error("[email-webhook] ingest failed", e);
    // 500 → DevManager retains the message + retries on its reconciliation
    // sweep (svix retries for Resend). We do NOT deleteReceived.
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  // Durable store complete. deleteReceived is a no-op for both providers now
  // (Resend has no delete API; the DevManager relay deletes the Mailpit copy on
  // this 2xx). Kept so a future provider with a real delete still gets called.
  if (parsed.providerMessageId) {
    await provider.deleteReceived(parsed.providerMessageId).catch((e) =>
      console.warn("[email-webhook] deleteReceived failed", e),
    );
  }

  return NextResponse.json({ ok: true, results });
}

// ─── Self-hosted multipart path (unchanged from pre-Resend) ─────────────────

async function handleSelfHostedMultipart(request: NextRequest): Promise<NextResponse> {
  try {
    const secret = request.headers.get("x-webhook-secret");
    if (!secret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
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
