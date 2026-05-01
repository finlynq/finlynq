import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
import { parsePdfToTransactions } from "@/lib/pdf-parser";
import { parseExcelSheets } from "@/lib/excel-parser";
import { parseOfx } from "@/lib/ofx-parser";
import { previewImport } from "@/lib/import-pipeline";
import type { RawTransaction } from "@/lib/import-pipeline";
import { sourceTagFor, type FormatTag } from "@/lib/tx-source";
import { requireAuth } from "@/lib/auth/require-auth";
import { safeErrorMessage } from "@/lib/validate";
import { parseCsvWithFallback } from "@/lib/external-import/parsers/csv-pipeline";

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
      const result = await parseCsvWithFallback({
        text,
        userId,
        templateId,
      });
      if (result.kind === "template-not-found") {
        // Original behavior: silently fall through to canonical/auto-match
        // when a stale templateId is passed. Re-run without it.
        const fallback = await parseCsvWithFallback({ text, userId });
        return await respondWithCsvResult(fallback, file.name, userId, auth.context.dek ?? undefined);
      }
      return await respondWithCsvResult(result, file.name, userId, auth.context.dek ?? undefined);
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

      // Return OFX metadata + preview — account assignment happens on the
      // client. The `format` field is echoed back so the client can stamp
      // `source:ofx` or `source:qfx` on rows before /api/import/execute
      // (the actual rows are constructed client-side after the user picks
      // the destination account).
      return NextResponse.json({
        type: "ofx",
        format: ext, // "ofx" | "qfx" — hint for the client to stamp `source:<ext>`
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
      const taggedRows = stampFormatTag(result.rows, "pdf");
      const preview = await previewImport(taggedRows, userId, auth.context.dek ?? undefined);
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
      // Excel preview returns sheet metadata only; row-level `source:excel`
      // tagging happens after the user picks a sheet via /api/import/excel-map.
      return NextResponse.json({ type: "excel", sheets });
    }

    return NextResponse.json({ error: "Unsupported file type. Use CSV, Excel, PDF, OFX, or QFX." }, { status: 400 });
  } catch (error: unknown) {
    const message = safeErrorMessage(error, "Preview failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Issue #62: stamp every row with `source:<format>` so cross-source dedup can
 * identify how the data arrived. Idempotent — if the row already carries the
 * tag (e.g. on a re-preview after `/api/import/csv-map`), nothing changes.
 */
function stampFormatTag<R extends RawTransaction>(rows: R[], format: FormatTag): R[] {
  const tag = sourceTagFor(format);
  return rows.map((r) => {
    const existing = (r.tags ?? "").split(",").map((t) => t.trim()).filter((t) => t);
    if (existing.some((t) => t.toLowerCase() === tag.toLowerCase())) return r;
    return { ...r, tags: existing.length ? `${existing.join(",")},${tag}` : tag };
  });
}

/**
 * Format the shared CSV pipeline's result as the regular /import/preview
 * response. `parsed` results go through `previewImport` for DB-aware
 * NEW/DUPLICATE classification. `needs-mapping` is surfaced verbatim so
 * the client's column-mapping dialog kicks in.
 */
async function respondWithCsvResult(
  result: Awaited<ReturnType<typeof parseCsvWithFallback>>,
  fileName: string,
  userId: string,
  dek: Buffer | undefined,
): Promise<NextResponse> {
  if (result.kind === "template-not-found") {
    return NextResponse.json(
      { error: `Template #${result.templateId} not found` },
      { status: 400 },
    );
  }
  if (result.kind === "needs-mapping") {
    return NextResponse.json({
      type: "csv-needs-mapping",
      headers: result.headers,
      sampleRows: result.sampleRows,
      suggestedMapping: result.suggestedMapping,
      fileName,
    });
  }
  const taggedRows = stampFormatTag(result.rows, "csv");
  const preview = await previewImport(taggedRows, userId, dek);
  if (result.errors.length > 0) {
    preview.errors.push(
      ...result.errors.map((e) => ({ rowIndex: e.row - 2, message: e.message })),
    );
  }
  const payload: Record<string, unknown> = {
    type: "csv",
    headers: result.headers,
    ...preview,
  };
  if (result.appliedTemplateId !== undefined) {
    payload.appliedTemplateId = result.appliedTemplateId;
  }
  if (result.suggestedTemplate) {
    payload.suggestedTemplate = result.suggestedTemplate;
  }
  return NextResponse.json(payload);
}
