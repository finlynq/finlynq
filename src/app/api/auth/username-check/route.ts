/**
 * GET /api/auth/username-check?u=<value>
 *
 * Lightweight live availability check used by the signup form. Returns
 * { available: boolean }.
 *
 * Finding C-6 (2026-05-07) — anti-enumeration hardening. The previous
 * version returned distinct error strings for "format" vs "taken" vs
 * "reserved", letting an attacker walk the user table by toggling on the
 * exact reason. We now return a uniform `{ available: false }` for any
 * unclaimable identifier — the UI is left with a single "try a different
 * one" message and the response carries no enumeration signal.
 *
 * Rate-limited per IP (30/min) for typing-flow responsiveness. There is no
 * authenticated-session gate because this endpoint must be callable from the
 * signup form before the user has an account; a CAPTCHA would be the next
 * step if scripted enumeration becomes observable in logs.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDialect } from "@/db";
import { checkRateLimit } from "@/lib/rate-limit";
import { validateUsername } from "@/lib/auth/username";
import { isIdentifierClaimed } from "@/lib/auth/queries";

export async function GET(request: NextRequest) {
  if (getDialect() !== "postgres") {
    return NextResponse.json({ available: false }, { status: 403 });
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const limit = checkRateLimit(`username-check:${ip}`, 30, 60_000);
  if (!limit.allowed) {
    return NextResponse.json({ available: false }, { status: 429 });
  }

  const raw = request.nextUrl.searchParams.get("u") ?? "";
  const validation = validateUsername(raw);
  if (!validation.ok) {
    // Format / reserved / length failures — collapse into the same generic
    // "unavailable" shape as a real collision so the response can't be used
    // to fingerprint the validator's rules.
    return NextResponse.json({ available: false });
  }

  // isIdentifierClaimed is the right check: we want to reject usernames that
  // collide with someone else's email too, since that would violate the
  // single-identifier-per-user invariant.
  const taken = await isIdentifierClaimed(validation.value);
  if (taken) {
    return NextResponse.json({ available: false });
  }
  return NextResponse.json({ available: true });
}
