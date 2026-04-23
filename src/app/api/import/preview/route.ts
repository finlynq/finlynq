import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
import {
  csvToRawTransactions,
  csvToRawTransactionsWithMapping,
  extractCsvHeaders,
  parseCSV,
} from "@/lib/csv-parser";
import { parsePdfToTransactions } from "@/lib/pdf-parser";
import { parseExcelSheets } from "@/lib/excel-parser";
import { parseOfx } from "@/lib/ofx-parser";
import { previewImport } from "@/lib/import-pipeline";
import { requireAuth } from "@/lib/auth/require-auth";
import { safeErrorMessage } from "@/lib/validate";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import {
  autoDetectColumnMapping,
  deserializeTemplate,
  findBestTemplate,
  type ColumnMapping,
  type ImportTemplate,
} from "@/lib/import-templates";

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  try {
    const formData = await request.formData() as unknown as globalThis.FormData;
    const file = formData.get("file") as File;
    const templateIdRaw = formData.get("templateId");
    const templateId =
      templateIdRaw && typeof templateIdRaw === "string" && templateIdRaw.trim()
        ? parseInt(templateIdRaw, 10)
        : null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const ext = file.name.split(".").pop()?.toLowerCase();

    if (ext === "csv") {
      const text = await file.text();
      const headers = extractCsvHeaders(text);

      // 1. Explicit template selected by user — use its mapping directly.
      if (templateId !== null && !Number.isNaN(templateId)) {
        const tplRow = await db
          .select()
          .from(schema.importTemplates)
          .where(and(
            eq(schema.importTemplates.id, templateId),
            eq(schema.importTemplates.userId, userId),
          ))
          .get();
        if (tplRow) {
          const tpl = deserializeTemplate(tplRow);
          const mapped = parseWithMapping(text, tpl.columnMapping, tpl.defaultAccount ?? null);
          const preview = await previewImport(mapped.rows);
          if (mapped.errors.length > 0) {
            preview.errors.push(
              ...mapped.errors.map((e) => ({ rowIndex: e.row - 2, message: e.message })),
            );
          }
          return NextResponse.json({
            type: "csv",
            headers,
            appliedTemplateId: tpl.id,
            ...preview,
          });
        }
      }

      // 2. Try canonical headers (Date / Amount / Account / Payee).
      const canonical = csvToRawTransactions(text);
      let canonicalPreview = await previewImport(canonical.rows);
      if (canonical.errors.length > 0) {
        canonicalPreview.errors.push(
          ...canonical.errors.map((e) => ({ rowIndex: e.row - 2, message: e.message })),
        );
      }
      if (canonicalPreview.valid.length > 0 || canonicalPreview.duplicates.length > 0) {
        return NextResponse.json({ type: "csv", headers, ...canonicalPreview });
      }

      // 3. Try an auto-matched saved template (≥80% header overlap).
      const allTemplates = await db
        .select()
        .from(schema.importTemplates)
        .where(eq(schema.importTemplates.userId, userId))
        .all();
      const templates: ImportTemplate[] = allTemplates.map(deserializeTemplate);
      const best = findBestTemplate(headers, templates);
      if (best) {
        const mapped = parseWithMapping(
          text,
          best.template.columnMapping,
          best.template.defaultAccount ?? null,
        );
        const preview = await previewImport(mapped.rows);
        if (mapped.errors.length > 0) {
          preview.errors.push(
            ...mapped.errors.map((e) => ({ rowIndex: e.row - 2, message: e.message })),
          );
        }
        if (preview.valid.length > 0 || preview.duplicates.length > 0) {
          return NextResponse.json({
            type: "csv",
            headers,
            appliedTemplateId: best.template.id,
            suggestedTemplate: { id: best.template.id, name: best.template.name, score: best.score },
            ...preview,
          });
        }
      }

      // 4. Nothing worked — return headers + auto-detected suggestion so the
      //    client can show a column-mapping dialog.
      const suggestedMapping = autoDetectColumnMapping(headers);
      const sampleRows = parseCSV(text).slice(0, 5);
      return NextResponse.json({
        type: "csv-needs-mapping",
        headers,
        sampleRows,
        suggestedMapping,
        fileName: file.name,
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
      const preview = await previewImport(result.rows);
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
      const sheets = await parseExcelSheets(buffer);
      return NextResponse.json({ type: "excel", sheets });
    }

    return NextResponse.json({ error: "Unsupported file type. Use CSV, Excel, PDF, OFX, or QFX." }, { status: 400 });
  } catch (error: unknown) {
    const message = safeErrorMessage(error, "Preview failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Parse a CSV with a column mapping and apply a default account if rows are missing one. */
function parseWithMapping(
  text: string,
  mapping: ColumnMapping,
  defaultAccount: string | null,
): { rows: ReturnType<typeof csvToRawTransactionsWithMapping>["rows"]; errors: ReturnType<typeof csvToRawTransactionsWithMapping>["errors"] } {
  const result = csvToRawTransactionsWithMapping(
    text,
    mapping as unknown as Record<string, string>,
  );
  if (defaultAccount) {
    result.rows = result.rows.map((r) => ({ ...r, account: r.account || defaultAccount }));
  }
  return result;
}
