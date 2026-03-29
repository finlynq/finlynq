import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and } from "drizzle-orm";
import { csvToRawTransactions } from "@/lib/csv-parser";
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

    const formData = await request.formData();
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
        rows = csvToRawTransactions(text).rows;
      } else if (ext === "pdf") {
        const buffer = Buffer.from(await value.arrayBuffer());
        const result = await parsePdfToTransactions(buffer);
        rows = result.rows;
      } else if (ext === "xlsx" || ext === "xls") {
        const buffer = Buffer.from(await value.arrayBuffer());
        const sheets = parseExcelSheets(buffer);
        if (sheets.length > 0 && sheets[0].headers.length > 0) {
          // Auto-detect column mapping for email imports
          const sheet = sheets[0];
          const mapping = autoDetectMapping(sheet.headers);
          if (mapping) {
            rows = extractExcelRows(buffer, sheet.name, mapping).rows;
          }
        }
      }

      // Set default account for PDF/Excel rows that don't have one
      if (defaultAccount) {
        rows = rows.map((r) => ({
          ...r,
          account: r.account || defaultAccount,
        }));
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

function autoDetectMapping(headers: string[]) {
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
