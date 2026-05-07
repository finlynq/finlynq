import { NextRequest, NextResponse } from "next/server";
import { importAccounts, importCategories, importPortfolio, importTransactions } from "@/lib/csv-parser";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { safeErrorMessage } from "@/lib/validate";

// 20 MB cap on the multipart body. Larger imports should use the
// staging pipeline (`/api/import/staging/upload`), which streams. The
// previous lack of any cap meant a single authenticated user could OOM
// the server by uploading a multi-hundred-MB CSV that `formData()` then
// buffered into memory.
const MAX_BODY_BYTES = 20 * 1024 * 1024;

export async function POST(request: NextRequest) {
  // Pre-check the declared Content-Length before we start consuming the
  // body. This is a defense against very-large bodies; the formData()
  // parser would otherwise buffer the entire body into memory before we
  // get a chance to refuse.
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader) {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return NextResponse.json(
        { error: `Import body too large (${declared} bytes; max ${MAX_BODY_BYTES})` },
        { status: 413 }
      );
    }
  }

  // requireEncryption fires 423 at the boundary if the user has no DEK
  // (e.g. session expired between request and submit, or API-key
  // strategy without a wrapped DEK). The previous `requireAuth` allowed
  // the import to start running without a DEK; csv-parser's encrypted
  // dedup-lookup would then either crash deeper in the call stack or
  // silently fall back to plaintext-only matching.
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;
  try {
    const formData = await request.formData() as unknown as globalThis.FormData;
    const fileType = formData.get("type") as string;
    const file = formData.get("file") as File;

    if (!file || !fileType) {
      return NextResponse.json({ error: "Missing file or type" }, { status: 400 });
    }

    const text = await file.text();
    let result;

    // Stream D Phase 4 — pass DEK so importers can encrypt + dedup via lookup.
    switch (fileType) {
      case "accounts":
        result = await importAccounts(text, userId, dek);
        break;
      case "categories":
        result = await importCategories(text, userId, dek);
        break;
      case "portfolio":
        result = await importPortfolio(text, userId, dek);
        break;
      case "transactions":
        result = await importTransactions(text, userId, dek);
        break;
      default:
        return NextResponse.json({ error: "Invalid type" }, { status: 400 });
    }

    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = safeErrorMessage(error, "Import failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
