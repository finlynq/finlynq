import { NextRequest, NextResponse } from "next/server";
import { csvToRawTransactions, parseCSV } from "@/lib/csv-parser";
import { parsePdfToTransactions } from "@/lib/pdf-parser";
import { parseExcelSheets } from "@/lib/excel-parser";
import { parseOfx } from "@/lib/ofx-parser";
import { previewImport } from "@/lib/import-pipeline";
import { requireAuth } from "@/lib/auth/require-auth";
import { safeErrorMessage } from "@/lib/validate";
import { db, schema } from "@/db";
import { eq, and } from "drizzle-orm";
import { rankTemplates, applyTemplateMapping, type ColumnMapping } from "@/lib/import-template-matcher";
import type { RawTransaction } from "@/lib/import-pipeline";

const { importTemplates } = schema;

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  try {
    const formData = await request.formData() as unknown as globalThis.FormData;
    const file = formData.get("file") as File;
    const templateIdRaw = formData.get("templateId") as string | null;
    const templateId = templateIdRaw ? parseInt(templateIdRaw, 10) : null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const ext = file.name.split(".").pop()?.toLowerCase();

    if (ext === "csv") {
      const text = await file.text();

      // If a templateId was supplied, apply the template's column mapping
      if (templateId && !isNaN(templateId)) {
        const tmpl = await db
          .select()
          .from(importTemplates)
          .where(and(eq(importTemplates.id, templateId), eq(importTemplates.userId, userId)))
          .get();

        if (!tmpl) {
          return NextResponse.json({ error: "Template not found" }, { status: 404 });
        }

        const mapping = JSON.parse(tmpl.columnMapping) as ColumnMapping;
        const csvRows = parseCSV(text);
        const rows: RawTransaction[] = csvRows.map((row) => {
          const mapped = applyTemplateMapping(row, mapping, tmpl.amountFormat);
          return {
            date: mapped.date,
            amount: mapped.amount,
            payee: mapped.payee,
            account: "", // account assignment happens at import time
            category: mapped.category || undefined,
            note: mapped.note || undefined,
            tags: mapped.tags || undefined,
            currency: mapped.currency || undefined,
          };
        });

        const preview = previewImport(rows);
        const allTemplates = await db
          .select()
          .from(importTemplates)
          .where(eq(importTemplates.userId, userId))
          .all();
        const csvHeaders = csvRows.length > 0 ? Object.keys(csvRows[0]) : [];
        const matches = rankTemplates(csvHeaders, allTemplates);

        return NextResponse.json({
          type: "csv",
          appliedTemplate: { id: tmpl.id, name: tmpl.name },
          suggestedTemplates: matches.slice(0, 3).map(({ template, score }) => ({
            id: template.id,
            name: template.name,
            score,
          })),
          ...preview,
        });
      }

      // No template — parse normally and suggest matching templates
      const { rows, errors: parseErrors } = csvToRawTransactions(text);
      const preview = previewImport(rows);
      if (parseErrors.length > 0) {
        preview.errors.push(...parseErrors.map((e) => ({ rowIndex: e.row - 2, message: e.message })));
      }

      // Suggest templates based on CSV headers
      const csvRows = parseCSV(text);
      const csvHeaders = csvRows.length > 0 ? Object.keys(csvRows[0]) : [];
      if (csvHeaders.length > 0) {
        const allTemplates = await db
          .select()
          .from(importTemplates)
          .where(eq(importTemplates.userId, userId))
          .all();
        const matches = rankTemplates(csvHeaders, allTemplates);
        const topMatches = matches.filter((m) => m.score > 0).slice(0, 3);
        return NextResponse.json({
          type: "csv",
          suggestedTemplates: topMatches.map(({ template, score }) => ({
            id: template.id,
            name: template.name,
            score,
          })),
          ...preview,
        });
      }

      return NextResponse.json({ type: "csv", ...preview });
    }

    if (ext === "ofx" || ext === "qfx") {
      const text = await file.text();
      const ofxResult = parseOfx(text);

      if (ofxResult.transactions.length === 0) {
        return NextResponse.json(
          { error: "No transactions found in OFX/QFX file." },
          { status: 400 },
        );
      }

      // Return OFX metadata + preview — account assignment happens on the client
      return NextResponse.json({
        type: "ofx",
        account: ofxResult.account,
        balanceAmount: ofxResult.balanceAmount,
        balanceDate: ofxResult.balanceDate,
        dateRange: ofxResult.dateRange,
        currency: ofxResult.currency,
        transactionCount: ofxResult.transactions.length,
        transactions: ofxResult.transactions,
      });
    }

    if (ext === "pdf") {
      const buffer = Buffer.from(await file.arrayBuffer());
      const result = await parsePdfToTransactions(buffer);
      if (result.errors.length > 0 && result.rows.length === 0) {
        return NextResponse.json({ error: result.errors.join(". ") }, { status: 400 });
      }
      const preview = previewImport(result.rows);
      return NextResponse.json({
        type: "pdf",
        confidence: result.confidence,
        rawText: result.rawText,
        warnings: result.errors.length > 0 ? result.errors : undefined,
        ...preview,
      });
    }

    if (ext === "xlsx" || ext === "xls") {
      const buffer = Buffer.from(await file.arrayBuffer());
      const sheets = parseExcelSheets(buffer);
      return NextResponse.json({ type: "excel", sheets });
    }

    return NextResponse.json({ error: "Unsupported file type. Use CSV, Excel, PDF, OFX, or QFX." }, { status: 400 });
  } catch (error: unknown) {
    const message = safeErrorMessage(error, "Preview failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
