import { NextRequest, NextResponse } from "next/server";
import { extractExcelRows } from "@/lib/excel-parser";
import { previewImport } from "@/lib/import-pipeline";
import type { ColumnMapping } from "@/lib/excel-parser";
import { requireUnlock } from "@/lib/require-unlock";

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
    const rows = extractExcelRows(buffer, sheetName, mapping, hasHeaders);

    if (rows.length === 0) {
      return NextResponse.json({ error: "No valid rows found with the given mapping" }, { status: 400 });
    }

    const preview = previewImport(rows);
    return NextResponse.json({ type: "excel-mapped", ...preview });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Excel mapping failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
