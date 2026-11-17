import { NextResponse } from "next/server";
import type { NoteWriteResult } from "@/lib/guides/notes-store";

/** A refused note write as a response: 409 when someone saved in between (with `currentVersion`). */
export function noteWriteFailure(result: Extract<NoteWriteResult, { ok: false }>) {
  const status = result.code === "version_conflict" ? 409 : result.code === "not_found" ? 404 : 400;
  return NextResponse.json(
    { success: false, error: result.error, code: result.code, currentVersion: result.currentVersion },
    { status },
  );
}
