import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { csvToRawTransactions, csvToRawTransactionsWithMapping, extractCsvHeaders } from "@/lib/csv-parser";
import { parsePdfToTransactions } from "@/lib/pdf-parser";
import { extractExcelRows, parseExcelSheets } from "@/lib/excel-parser";
import { executeImport } from "@/lib/import-pipeline";
import type { RawTransaction } from "@/lib/import-pipeline";
import { safeErrorMessage } from "@/lib/validate";

export async function POST(request: NextRequest) {
  try {
    // Verify webhook secret
    const secret = request.headers.get("x-webhook-secret");
    const storedSecret = db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, "email_webhook_secret"))
      .get();

    if (!storedSecret || secret !== storedSecret.value) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Resolve the userId that owns this webhook secret
    const userId = storedSecret.userId;

    // Load saved import templates for this user (for CSV matching)
    const savedTemplates = db
      .select()
      .from(schema.importTemplates)
      .where(eq(schema.importTemplates.userId, userId))
      .all();

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
        const fileHeaders = extractCsvHeaders(text);

        // Try to match against saved templates
        const matchedTemplate = findBestTemplate(savedTemplates, fileHeaders);

        if (matchedTemplate) {
          const mapping = JSON.parse(matchedTemplate.columnMapping) as Record<string, string>;
          const templateDefault = matchedTemplate.defaultAccount ?? "";
          const result = csvToRawTransactionsWithMapping(text, mapping);
          rows = result.rows;
          // Apply template's default account if no account column mapped
          if (templateDefault) {
            rows = rows.map((r) => ({ ...r, account: r.account || templateDefault }));
          }
        } else {
          // Fall back to standard column names
          rows = csvToRawTransactions(text).rows;
        }
      } else if (ext === "pdf") {
        const buffer = Buffer.from(await value.arrayBuffer());
        const result = await parsePdfToTransactions(buffer);
        rows = result.rows;
      } else if (ext === "xlsx" || ext === "xls") {
        const buffer = Buffer.from(await value.arrayBuffer());
        const sheets = parseExcelSheets(buffer);
        if (sheets.length > 0 && sheets[0].headers.length > 0) {
          const sheet = sheets[0];
          const mapping = autoDetectExcelMapping(sheet.headers);
          if (mapping) {
            rows = extractExcelRows(buffer, sheet.name, mapping).rows;
          }
        }
      }

      // Apply global default account for rows that don't have one
      if (defaultAccount) {
        rows = rows.map((r) => ({ ...r, account: r.account || defaultAccount }));
      }

      allRows.push(...rows);
    }

    if (allRows.length === 0) {
      return NextResponse.json({ message: "No importable data found in attachments" });
    }

    const result = executeImport(allRows, [], userId);

    // Create notification scoped to user
    db.insert(schema.notifications)
      .values({
        type: "import",
        title: "Email Import Complete",
        message: `Imported ${result.imported} transactions (${result.skippedDuplicates} duplicates skipped)`,
        read: 0,
        createdAt: new Date().toISOString(),
        userId,
      })
      .run();

    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = safeErrorMessage(error, "Email import failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Score a file's headers against a template and return the best match (≥80%). */
function findBestTemplate(
  templates: Array<{ headers: string; columnMapping: string; defaultAccount: string | null }>,
  fileHeaders: string[],
) {
  if (templates.length === 0 || fileHeaders.length === 0) return null;
  const fileSet = new Set(fileHeaders.map((h) => h.toLowerCase().trim()));

  let best: (typeof templates)[number] | null = null;
  let bestScore = 0;

  for (const t of templates) {
    const tHeaders = JSON.parse(t.headers ?? "[]") as string[];
    if (tHeaders.length === 0) continue;
    const matches = tHeaders.filter((h) => fileSet.has(h.toLowerCase().trim())).length;
    const score = Math.round((matches / tHeaders.length) * 100);
    if (score > bestScore && score >= 80) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

function autoDetectExcelMapping(headers: string[]) {
  const lower = headers.map((h) => h.toLowerCase());
  const find = (keywords: string[]) =>
    headers[lower.findIndex((h) => keywords.some((k) => h.includes(k)))] || undefined;

  const date = find(["date", "posted", "transaction date"]);
  const amount = find(["amount", "total", "debit", "credit"]);

  if (!date || !amount) return null;

  return {
    date,
    amount,
    account: find(["account"]),
    payee: find(["payee", "description", "merchant", "name", "memo"]),
    category: find(["category", "type"]),
    currency: find(["currency"]),
    note: find(["note", "memo", "reference"]),
  };
}
