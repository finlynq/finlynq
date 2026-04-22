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
    const templateRows = db
      .select()
      .from(schema.importTemplates)
      .where(eq(schema.importTemplates.userId, userId))
      .all();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const templates = (templateRows as any[]).map(deserializeTemplate);

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
