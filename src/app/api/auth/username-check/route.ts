/**
 * GET /api/auth/username-check?u=<value>
 *
 * Lightweight live availability check used by the signup form. Returns
 * { available: boolean, error?: string }. The `error` field carries the
 * format error from validateUsername when the input fails the regex /
 * reserved check — the UI can render it inline without making the user
 * submit to find out.
 *
 * Rate-limited per IP (30/min) so the typing flow stays responsive but
 * scripted enumeration is bounded. We never reveal *why* a username is
 * unavailable beyond "format" vs "taken" — same anti-enumeration stance as
 * /api/auth/login's generic error.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDialect } from "@/db";
import { checkRateLimit } from "@/lib/rate-limit";
import { validateUsername } from "@/lib/auth/username";
import { isIdentifierClaimed } from "@/lib/auth/queries";

export async function GET(request: NextRequest) {
  if (getDialect() !== "postgres") {
    return NextResponse.json(
      { available: false, error: "Registration is only available in managed mode." },
      { status: 403 }
    );
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const limit = checkRateLimit(`username-check:${ip}`, 30, 60_000);
  if (!limit.allowed) {
    return NextResponse.json(
      { available: false, error: "Too many checks. Please slow down." },
      { status: 429 }
    );
  }

  const raw = request.nextUrl.searchParams.get("u") ?? "";
  const validation = validateUsername(raw);
  if (!validation.ok) {
    return NextResponse.json({ available: false, error: validation.error });
  }

  // isIdentifierClaimed is the right check: we want to reject usernames that
  // collide with someone else's email too, since that would violate the
  // single-identifier-per-user invariant.
  const taken = await isIdentifierClaimed(validation.value);
  if (taken) {
    return NextResponse.json({ available: false, error: "That username is taken." });
  }
  return NextResponse.json({ available: true });
}
