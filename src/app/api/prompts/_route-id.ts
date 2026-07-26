/**
 * Extract the `[id]` segment from a `/api/prompts/<id>/…` request URL.
 *
 * `apiHandler` (FINLYNQ-261) wraps the route as `(request) => Promise<Response>`
 * and does not forward Next's `{ params }` context, so dynamic-segment routes on
 * apiHandler read the id from the path instead. The id is the segment
 * immediately after `prompts`.
 */
import type { NextRequest } from "next/server";

export function promptIdFromRequest(request: NextRequest): string {
  let pathname: string;
  try {
    pathname = request.nextUrl.pathname;
  } catch {
    pathname = new URL(request.url).pathname;
  }
  const segments = pathname.split("/").filter(Boolean);
  const idx = segments.indexOf("prompts");
  return idx >= 0 ? decodeURIComponent(segments[idx + 1] ?? "") : "";
}
