import { NextRequest, NextResponse } from "next/server";
import { executeImport } from "@/lib/import-pipeline";
import type { RawTransaction } from "@/lib/import-pipeline";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { z } from "zod";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";

export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;
  try {
    const body = await request.json();

    const importSchema = z.object({
      rows: z.array(z.any()).min(1, "No rows provided"),
      forceImportIndices: z.array(z.number()).optional(),
    });
    const parsed = validateBody(body, importSchema);
    if (parsed.error) return parsed.error;

    const { rows, forceImportIndices = [] } = parsed.data as {
      rows: RawTransaction[];
      forceImportIndices: number[];
    };

    const result = await executeImport(rows, forceImportIndices, userId, dek);
    return NextResponse.json(result);
  } catch (error: unknown) {
    await logApiError("POST", "/api/import/execute", error, userId);
    const message = safeErrorMessage(error, "Import failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
