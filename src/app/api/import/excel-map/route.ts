import { NextRequest, NextResponse } from "next/server";
import { extractExcelRows } from "@/lib/excel-parser";
import { previewImport } from "@/lib/import-pipeline";
import type { ColumnMapping } from "@/lib/excel-parser";
import { requireAuth } from "@/lib/auth/require-auth";
import { safeErrorMessage } from "@/lib/validate";
import { sourceTagFor } from "@/lib/tx-source";

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  try {
    const formData = await request.formData() as unknown as globalThis.FormData;
    const file = formData.get("file") as File;
    const sheetName = formData.get("sheetName") as string;
    const mappingJson = formData.get("columnMapping") as string;
    const hasHeaders = formData.get("hasHeaders") !== "false";

    if (!file || !sheetName || !mappingJson) {
      return NextResponse.json({ error: "Missing file, sheetName, or columnMapping" }, { status: 400 });
    }

    const mapping: ColumnMapping = JSON.parse(mappingJson);
    if (!mapping.date || !mapping.amount) {
      return NextResponse.json({ error: "Date and Amount column mappings are required" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await extractExcelRows(buffer, sheetName, mapping, hasHeaders);

    if (result.rows.length === 0) {
      const msg = result.errors.length > 0
        ? result.errors.map((e) => `Row ${e.row}: ${e.message}`).join("; ")
        : "No valid rows found with the given mapping";
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    // Issue #62: stamp source:excel on every row so cross-source dedup can
    // identify the file shape this row arrived as.
    const excelTag = sourceTagFor("excel");
    result.rows = result.rows.map((r) => {
      const existing = (r.tags ?? "").split(",").map((t) => t.trim()).filter((t) => t);
      if (existing.some((t) => t.toLowerCase() === excelTag.toLowerCase())) return r;
      return { ...r, tags: existing.length ? `${existing.join(",")},${excelTag}` : excelTag };
    });
    const preview = await previewImport(result.rows, auth.context.userId, auth.context.dek ?? undefined);
    if (result.errors.length > 0) {
      preview.errors.push(...result.errors.map((e) => ({ rowIndex: e.row - 2, message: e.message })));
    }
    return NextResponse.json({ type: "excel-mapped", totalRows: result.totalRows, ...preview });
  } catch (error: unknown) {
    const message = safeErrorMessage(error, "Excel mapping failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
