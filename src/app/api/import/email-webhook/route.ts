import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// ─────────────────────────────────────────────────────────────────────────────
// TODO (2026-04-23) — Wire Resend Inbound to drive this webhook.
//
// The UI on /import generates `import-<uuid>@finlynq.com` addresses via
// /api/import/email-config. Those addresses will only actually receive mail
// once the following is in place:
//
//   1. DNS — Point finlynq.com MX records at Resend's inbound MX
//      (e.g. inbound-smtp.resend.com). Add SPF/DMARC so Resend can accept
//      forwarded mail without bounces.
//   2. Resend Inbound route — In the Resend dashboard, create an Inbound
//      route that matches `import-*@finlynq.com` and POSTs to
//      https://finlynq.com/api/import/email-webhook on message receipt.
//      Store the Resend signing secret in env as RESEND_WEBHOOK_SECRET.
//   3. Handler — Resend posts JSON (not multipart). Extend this handler to
//      detect `Content-Type: application/json`, parse `{from, to, subject,
//      attachments: [{filename, contentType, content(base64)}]}`, verify the
//      `svix-*` signature headers against RESEND_WEBHOOK_SECRET, and look up
//      the user by matching the `to` address against `settings.import_email`
//      (instead of the current `x-webhook-secret` header path).
//   4. Address → user lookup — Because the UI now mints per-user
//      `import-<uuid>@finlynq.com` addresses, the webhook must find the user
//      by that address, not by a shared webhook secret. The
//      `email_webhook_dek` / `email_webhook_secret` settings rows stay as the
//      envelope-encryption wrap for imported rows, but the auth path changes
//      from "secret matches" to "signature valid AND to-address belongs to a
//      user".
//   5. Rate limit + size cap — 10 MB per message, 25 messages/hour/user.
//
// Until that's done, the endpoint below still works for self-hosters wiring
// their own email→webhook bridge (e.g. a postfix filter or a custom SaaS
// with multipart POST). The current path is kept for backward compat.
// ─────────────────────────────────────────────────────────────────────────────

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

export async function POST(request: NextRequest) {
  try {
    // Verify webhook secret
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

    // Unwrap the DEK that was stored alongside the webhook secret at config
    // time. Users who configured the webhook before this rollout won't have
    // the wrap; imports still succeed but rows are written as plaintext.
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

    // Load user's import templates for CSV matching
    const templateRows = await db
      .select()
      .from(schema.importTemplates)
      .where(eq(schema.importTemplates.userId, userId))
      .all();
    const templates = templateRows.map(deserializeTemplate);

    const formData = await request.formData() as unknown as globalThis.FormData;
    const allRows: RawTransaction[] = [];
    const defaultAccount = formData.get("defaultAccount") as string | null;

    // Process all file attachments
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
          // Apply template's default account to rows without one
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

    // Use the webhook-wrapped DEK when available so imported rows are
    // encrypted at rest. Users who configured the webhook before this
    // rollout won't have a wrap — their rows go plaintext until they
    // regenerate the webhook secret.
    const result = await executeImport(allRows, [], userId, webhookDek ?? undefined);
    if ((result.imported ?? 0) > 0) invalidateUserTxCache(userId);

    // Create notification scoped to user
    await db.insert(schema.notifications)
      .values({
        type: "import",
        title: "Email Import Complete",
        message: `Imported ${result.imported} transactions (${result.skippedDuplicates} duplicates skipped)`,
        read: 0,
        createdAt: new Date().toISOString(),
        userId,
      })
      ;

    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = safeErrorMessage(error, "Email import failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
