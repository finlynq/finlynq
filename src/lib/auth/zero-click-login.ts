/**
 * Zero-click auto-login for FIXTURE accounts (`/try-demo`, `/try-demo2`).
 *
 * Extracted verbatim from the original `/try-demo` route when the second entry
 * point was added — two copies of prefetch-guarding, DEK unwrapping and session
 * issuance is precisely the kind of duplication that drifts into a security
 * bug, and this is auth code.
 *
 * ⚠️ The account is chosen by the CALLER, from a hardcoded constant in its own
 * route file. This helper deliberately exposes no way to pass an identifier
 * through the request — `/try-demo`'s long-standing guarantee is that "a tweaked
 * URL cannot grant access to a different account", and adding a `?user=` param
 * would break it for every fixture account at once. A new zero-click account is
 * a new route with its own constant, nothing else.
 *
 * Only ever point this at an account whose credentials are intentionally public
 * and whose data is disposable fixture data.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDialect } from "@/db";
import { verifyPassword, createSessionToken, AUTH_COOKIE } from "@/lib/auth";
import { SESSION_TTL_MS } from "@/lib/auth/jwt";
import { getUserByIdentifier, recordSuccessfulLogin } from "@/lib/auth/queries";
import { logApiError } from "@/lib/validate";
import { checkRateLimit } from "@/lib/rate-limit";
import { deriveKEK, unwrapDEK } from "@/lib/crypto/envelope";
import { putDEK } from "@/lib/crypto/dek-cache";
import { enqueueBackfillSecurities } from "@/lib/securities/backfill";
import { enqueueUpgradeStagingEncryption } from "@/lib/email-import/upgrade-staging-encryption";
import { enqueueProcessPendingInbox } from "@/lib/email-import/process-pending-inbox";
import { enqueueUpgradeUserFieldEncryption } from "@/lib/crypto/upgrade-user-fields";

export interface ZeroClickAccount {
  /** Username or email of the fixture account. HARDCODED by the caller. */
  identifier: string;
  /** The fixture account's public password. */
  password: string;
  /** Rate-limit bucket + log prefix, e.g. "try-demo". */
  slug: string;
  /** Landing path when `?next=` is absent or unsafe. */
  defaultNext: string;
  /** Shown when the account hasn't been seeded, e.g. the script to run. */
  seedHint: string;
}

/**
 * Validate that `next` is a safe same-origin redirect target.
 *
 *   - Must start with `/`
 *   - Must NOT start with `//` (that's a protocol-relative URL — `//evil.com`
 *     resolves to `https://evil.com`, an open-redirect bait-and-switch)
 *   - Must NOT contain `\` (Windows-style backslash; some path normalizers
 *     treat `\\evil.com` like `//evil.com`)
 */
function isSafeNext(next: string | null | undefined): next is string {
  if (!next) return false;
  if (!next.startsWith("/")) return false;
  if (next.startsWith("//")) return false;
  if (next.includes("\\")) return false;
  return true;
}

export async function zeroClickLogin(
  request: NextRequest,
  account: ZeroClickAccount,
): Promise<NextResponse> {
  // Drive-by-login guard (FINLYNQ-223). This GET authenticates and sets the
  // `pf_session` cookie as a SIDE EFFECT. Next.js prefetches in-viewport
  // <Link>s, and browsers issue speculative prefetches/prerenders — either
  // would silently REPLACE a logged-in visitor's real session with the fixture
  // account (reproduced: an admin who merely loaded the homepage was switched
  // to the demo user). A genuine top-level navigation sends none of these
  // headers, so refuse to do any auth work — and set no cookie — on a prefetch.
  const secPurpose = request.headers.get("sec-purpose") ?? "";
  const isPrefetch =
    request.headers.get("next-router-prefetch") === "1" ||
    request.headers.get("purpose") === "prefetch" ||
    secPurpose.includes("prefetch");
  if (isPrefetch) {
    return new NextResponse(null, { status: 204 });
  }

  if (getDialect() !== "postgres") {
    return NextResponse.json(
      { error: `/${account.slug} is only available on the managed deployment.` },
      { status: 403 },
    );
  }

  const nextRaw = request.nextUrl.searchParams.get("next");
  const next = isSafeNext(nextRaw) ? nextRaw : account.defaultNext;

  // Per-IP rate limit, mirroring the login route's policy. Per-identifier
  // limiting (also from the login route) is implicit here because the
  // identifier is a constant.
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const ipLimit = checkRateLimit(`${account.slug}:${ip}`, 5, 60_000);
  if (!ipLimit.allowed) {
    return NextResponse.json(
      { error: "Too many sign-in attempts. Please try again in a minute." },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil((ipLimit.resetAt - Date.now()) / 1000)),
        },
      },
    );
  }

  try {
    const user = await getUserByIdentifier(account.identifier);
    if (!user) {
      // Seed hasn't run yet (fresh-DB bootstrap or a self-hoster pointing a
      // non-fixture DATABASE_URL at this code). Surface a clear message rather
      // than failing the password check below.
      return NextResponse.json({ error: account.seedHint }, { status: 404 });
    }

    // The fixture password is public, so this isn't keeping anyone out — it
    // verifies that the seeded password_hash still matches what we expect. If a
    // rotation changes the password without updating the route, login fails
    // loudly rather than silently auth'ing a different user.
    const valid = await verifyPassword(account.password, user.passwordHash);
    if (!valid) {
      return NextResponse.json(
        { error: `Credentials drifted from the seed. Re-run the ${account.slug} seed.` },
        { status: 500 },
      );
    }

    // Unwrap the DEK so encrypted-column reads work. The password is
    // hardcoded, so KEK derivation is deterministic — same as a real login.
    let dek: Buffer | null = null;
    if (user.kekSalt && user.dekWrapped && user.dekWrappedIv && user.dekWrappedTag) {
      try {
        const pepperVersion = user.pepperVersion ?? 1;
        const kek = deriveKEK(
          account.password,
          Buffer.from(user.kekSalt, "base64"),
          pepperVersion,
        );
        dek = unwrapDEK(kek, {
          salt: Buffer.from(user.kekSalt, "base64"),
          wrapped: Buffer.from(user.dekWrapped, "base64"),
          iv: Buffer.from(user.dekWrappedIv, "base64"),
          tag: Buffer.from(user.dekWrappedTag, "base64"),
        });
      } catch (err) {
        await logApiError("GET", `/${account.slug} (unwrap)`, err);
        return NextResponse.json(
          { error: `DEK unwrap failed. Re-run the ${account.slug} seed.` },
          { status: 500 },
        );
      }
    }

    // Fixture accounts never have MFA — short-circuit to session issuance.
    await recordSuccessfulLogin(user.id);
    const { token, jti } = await createSessionToken(user.id, false);
    if (dek) {
      putDEK(jti, dek, SESSION_TTL_MS, user.id);
      // Same post-login background tasks as the regular login route so the
      // fixture experience matches what a real user gets.
      enqueueBackfillSecurities(user.id, dek);
      enqueueUpgradeStagingEncryption(user.id, dek);
      enqueueUpgradeUserFieldEncryption(user.id, dek);
      enqueueProcessPendingInbox(user.id, dek);
    }

    // Build the absolute redirect URL from the X-Forwarded-* headers Caddy
    // sets, NOT from request.url. Behind the reverse proxy the upstream URL is
    // the systemd-bound 0.0.0.0:3456 form, so `new URL(next, request.url)`
    // produces a Location header that breaks in the browser
    // ("ERR_ADDRESS_INVALID").
    const forwardedHost = request.headers.get("x-forwarded-host");
    const forwardedProto = request.headers.get("x-forwarded-proto");
    const host = forwardedHost ?? request.nextUrl.host;
    const proto = forwardedProto ?? request.nextUrl.protocol.replace(/:$/, "");
    const response = NextResponse.redirect(`${proto}://${host}${next}`);
    response.cookies.set(AUTH_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24,
      path: "/",
    });
    return response;
  } catch (error) {
    await logApiError("GET", `/${account.slug}`, error);
    return NextResponse.json({ error: "Sign-in failed unexpectedly." }, { status: 500 });
  }
}
