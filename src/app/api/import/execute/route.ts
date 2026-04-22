import { NextRequest, NextResponse } from "next/server";
import { executeImport } from "@/lib/import-pipeline";
import type { RawTransaction } from "@/lib/import-pipeline";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { z } from "zod";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";

const MAX_BODY_BYTES = 20 * 1024 * 1024; // 20 MB
const MAX_TRANSACTIONS = 50_000;

export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;

  // Reject oversized bodies early based on advertised Content-Length.
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: `Request body exceeds ${MAX_BODY_BYTES} byte limit` },
      { status: 413 }
    );
  }

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

    if (rows.length > MAX_TRANSACTIONS) {
      return NextResponse.json(
        { error: `Import exceeds ${MAX_TRANSACTIONS} transaction limit (got ${rows.length})` },
        { status: 422 }
      );
    }

    const result = await executeImport(rows, forceImportIndices, userId, dek);
    return NextResponse.json(result);
  } catch (error: unknown) {
    await logApiError("POST", "/api/import/execute", error, userId);
    const message = safeErrorMessage(error, "Import failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
