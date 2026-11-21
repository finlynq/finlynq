import { NextResponse } from "next/server";
import type { SavedViewWriteResult } from "@/lib/saved-views/store";

/** A refused saved-view write as a response: 409 for a name already in use, 404 for a missing view. */
export function savedViewWriteFailure(result: Extract<SavedViewWriteResult, { ok: false }>) {
  const status = result.code === "duplicate_name" ? 409 : result.code === "not_found" ? 404 : 400;
  return NextResponse.json({ success: false, error: result.error, code: result.code }, { status });
}
