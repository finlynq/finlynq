import { NextRequest, NextResponse } from "next/server";
import { importAccounts, importCategories, importPortfolio, importTransactions } from "@/lib/csv-parser";
import { requireAuth } from "@/lib/auth/require-auth";
import { safeErrorMessage } from "@/lib/validate";

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
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
    const { dek } = auth.context;
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
