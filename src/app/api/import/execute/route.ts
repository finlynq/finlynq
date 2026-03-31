import { NextRequest, NextResponse } from "next/server";
import { executeImport } from "@/lib/import-pipeline";
import type { RawTransaction } from "@/lib/import-pipeline";
import { requireAuth } from "@/lib/auth/require-auth";
import { z } from "zod";
import { validateBody, safeErrorMessage } from "@/lib/validate";

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
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

    const result = await executeImport(rows, forceImportIndices, userId);
    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = safeErrorMessage(error, "Import failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
