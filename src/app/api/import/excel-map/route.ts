import { NextRequest, NextResponse } from "next/server";
import { extractExcelRows } from "@/lib/excel-parser";
import { previewImport } from "@/lib/import-pipeline";
import type { ColumnMapping } from "@/lib/excel-parser";
import { requireUnlock } from "@/lib/require-unlock";
import { safeErrorMessage } from "@/lib/validate";

export async function POST(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  try {
    const formData = await request.formData();
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
    const result = extractExcelRows(buffer, sheetName, mapping, hasHeaders);

    if (result.rows.length === 0) {
      const msg = result.errors.length > 0
        ? result.errors.map((e) => `Row ${e.row}: ${e.message}`).join("; ")
        : "No valid rows found with the given mapping";
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    const preview = previewImport(result.rows);
    if (result.errors.length > 0) {
      preview.errors.push(...result.errors.map((e) => ({ rowIndex: e.row - 2, message: e.message })));
    }
    return NextResponse.json({ type: "excel-mapped", totalRows: result.totalRows, ...preview });
  } catch (error: unknown) {
    const message = safeErrorMessage(error, "Excel mapping failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
