import { NextResponse } from "next/server";
import type { StoreError } from "@/lib/forecast/store";

/** A refused forecast store write as a response (409 + `currentVersion` when someone saved in between). */
export function forecastStoreFailure(result: StoreError) {
  const status =
    result.code === "not_found" ? 404
    : result.code === "invalid" ? 400
    : 409; // duplicate_name, too_many, version_conflict, has_variants
  return NextResponse.json(
    { success: false, error: result.error, code: result.code, currentVersion: result.currentVersion },
    { status },
  );
}

/** The trailing numeric id of /api/forecast/<thing>/<id>[/...]. */
export function idFromPath(pathname: string, segmentAfter: string): number | null {
  const parts = pathname.split("/").filter(Boolean);
  const i = parts.indexOf(segmentAfter);
  const id = Number(parts[i + 1]);
  return i >= 0 && Number.isInteger(id) && id > 0 ? id : null;
}
