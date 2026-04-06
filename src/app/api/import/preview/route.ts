import { NextRequest, NextResponse } from "next/server";
import {
  csvToRawTransactions,
  csvToRawTransactionsWithMapping,
  extractCSVHeaders,
} from "@/lib/csv-parser";
import { parseExcelSheets } from "@/lib/excel-parser";
import { parseOfx } from "@/lib/ofx-parser";
import { previewImport } from "@/lib/import-pipeline";
import { requireAuth } from "@/lib/auth/require-auth";
import { safeErrorMessage } from "@/lib/validate";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { deserializeTemplate, findBestTemplate } from "@/lib/import-templates";

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  try {
    const formData = await request.formData() as unknown as globalThis.FormData;
    const file = formData.get("file") as File;
    const templateIdParam = formData.get("templateId") as string | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const ext = file.name.split(".").pop()?.toLowerCase();

    if (ext === "csv") {
      const text = await file.text();
      const headers = extractCSVHeaders(text);

      // Resolve template: explicit templateId or auto-match
      let appliedTemplate = null;
      let suggestedTemplate = null;

      // Load all user templates for matching
      const templateRows = db
        .select()
        .from(schema.importTemplates)
        .where(eq(schema.importTemplates.userId, userId))
        .all();
      const templates = templateRows.map(deserializeTemplate);

      if (templateIdParam) {
        const tid = parseInt(templateIdParam, 10);
        appliedTemplate = templates.find((t) => t.id === tid) ?? null;
      }

      if (!appliedTemplate) {
        const bestMatch = findBestTemplate(headers, templates);
        if (bestMatch) {
          suggestedTemplate = { id: bestMatch.template.id, name: bestMatch.template.name, score: bestMatch.score };
        }
      }

      let rows, parseErrors;
      if (appliedTemplate) {
        const result = csvToRawTransactionsWithMapping(text, appliedTemplate.columnMapping);
        // Apply default account from template if rows have no account
        if (appliedTemplate.defaultAccount) {
          result.rows = result.rows.map((r) => ({
            ...r,
            account: r.account || (appliedTemplate!.defaultAccount ?? ""),
          }));
        }
        rows = result.rows;
        parseErrors = result.errors;
      } else {
        const result = csvToRawTransactions(text);
        rows = result.rows;
        parseErrors = result.errors;
      }

      const preview = previewImport(rows);
      if (parseErrors.length > 0) {
        preview.errors.push(...parseErrors.map((e) => ({ rowIndex: e.row - 2, message: e.message })));
      }

      return NextResponse.json({
        type: "csv",
        headers,
        appliedTemplateId: appliedTemplate?.id ?? null,
        suggestedTemplate,
        ...preview,
      });
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
      const { parsePdfToTransactions } = await import("@/lib/pdf-parser");
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
