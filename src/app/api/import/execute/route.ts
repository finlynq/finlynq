import { NextRequest, NextResponse } from "next/server";
import { executeImport } from "@/lib/import-pipeline";
import type { RawTransaction } from "@/lib/import-pipeline";
import { requireUnlock } from "@/lib/require-unlock";

export async function POST(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  try {
    const body = await request.json();
    const { rows, forceImportIndices = [] } = body as {
      rows: RawTransaction[];
      forceImportIndices: number[];
    };

    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json({ error: "No rows provided" }, { status: 400 });
    }

    const result = executeImport(rows, forceImportIndices);
    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Import failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
