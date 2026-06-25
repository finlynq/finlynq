/**
 * GET /try-demo — Zero-click auto-login as the public demo user.
 *
 * Click a link from a blog post / Reddit thread / LinkedIn share and land
 * directly inside the demo app at whatever screen the marketing URL points
 * at — no typing the published credentials manually.
 *
 * Safety: this route is HARDCODED to authenticate as the demo user only.
 * It does not accept an identifier as a parameter, so there is no way for
 * a tweaked URL to grant access to a different account. The demo
 * credentials are intentionally public (see CLAUDE.md "Prod and demo coexist
 * on one Postgres DB") and the demo user owns only fixture data that's wiped
 * nightly; removing the typing step has no privacy impact.
 *
 * Two guardrails:
 *   1. ?next= is validated to be a same-origin path (starts with `/` and
 *      not `//` — otherwise an attacker could craft a phishing link like
 *      /try-demo?next=//evil.com that 302s to an attacker domain).
 *   2. Same rate-limiting as the login route — per-IP and per-identifier
 *      (the identifier is the constant demo email, so the per-id bucket
 *      effectively caps total /try-demo traffic).
 *
 * Refuses to run on non-Postgres deployments (the demo seed only targets
 * Postgres), and 404s cleanly if the demo user hasn't been seeded yet.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDialect } from "@/db";
import {
  verifyPassword,
  createSessionToken,
  AUTH_COOKIE,
} from "@/lib/auth";
import { SESSION_TTL_MS } from "@/lib/auth/jwt";
import {
  getUserByIdentifier,
  recordSuccessfulLogin,
} from "@/lib/auth/queries";
import { logApiError } from "@/lib/validate";
import { checkRateLimit } from "@/lib/rate-limit";
import { deriveKEK, unwrapDEK } from "@/lib/crypto/envelope";
import { putDEK } from "@/lib/crypto/dek-cache";
import { enqueueBackfillSecurities } from "@/lib/securities/backfill";
import { enqueueUpgradeStagingEncryption } from "@/lib/email-import/upgrade-staging-encryption";
import { enqueueProcessPendingInbox } from "@/lib/email-import/process-pending-inbox";
import { enqueueUpgradeUserFieldEncryption } from "@/lib/crypto/upgrade-user-fields";

const DEMO_IDENTIFIER = "demo@finlynq.com";
const DEMO_PASSWORD = "finlynq-demo";

/** Default landing screen when no ?next= is supplied. Picks /dashboard so
 *  first-time visitors see the at-a-glance net-worth + spending overview
 *  that anchors the app, rather than dropping straight into a workflow
 *  surface. Marketing links that want to showcase a specific feature
 *  (e.g. the pre-staged batch from scripts/seed-demo-pending-import.ts)
 *  should pass ?next=/import/pending explicitly. */
const DEFAULT_NEXT = "/dashboard";

/**
 * Validate that `next` is a safe same-origin redirect target.
 *
 *   - Must start with `/`
 *   - Must NOT start with `//` (that's a protocol-relative URL — `//evil.com`
 *     resolves to `https://evil.com`, an open-redirect bait-and-switch)
 *   - Must NOT contain `\` (Windows-style backslash; some path normalizers
 *     treat `\\evil.com` like `//evil.com`)
 *
 * Anything else gets rejected and we fall back to the default landing.
 */
function isSafeNext(next: string | null | undefined): next is string {
  if (!next) return false;
  if (!next.startsWith("/")) return false;
  if (next.startsWith("//")) return false;
  if (next.includes("\\")) return false;
  return true;
}

export async function GET(request: NextRequest) {
  // Drive-by-login guard (FINLYNQ-223). This GET authenticates as the demo
  // user and sets the `pf_session` cookie as a SIDE EFFECT. Next.js prefetches
  // in-viewport <Link>s, and browsers issue speculative prefetches/prerenders —
  // either would silently REPLACE a logged-in visitor's real session with the
  // demo (reproduced: an admin who merely loaded the homepage was switched to
  // the demo user). A genuine top-level navigation sends none of these headers,
  // so refuse to do any auth work — and set no cookie — on a prefetch.
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
      { error: "/try-demo is only available on the managed deployment." },
      { status: 403 },
    );
  }

  const nextRaw = request.nextUrl.searchParams.get("next");
  const next = isSafeNext(nextRaw) ? nextRaw : DEFAULT_NEXT;

  // Per-IP rate limit, mirroring the login route's policy. Per-identifier
  // limiting (also from the login route) is implicit here because the
  // identifier is the constant demo email.
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const ipLimit = checkRateLimit(`try-demo:${ip}`, 5, 60_000);
  if (!ipLimit.allowed) {
    return NextResponse.json(
      { error: "Too many demo attempts. Please try again in a minute." },
      {
        status: 429,
        headers: {
          "Retry-After": String(
            Math.ceil((ipLimit.resetAt - Date.now()) / 1000),
          ),
        },
      },
    );
  }

  try {
    const user = await getUserByIdentifier(DEMO_IDENTIFIER);
    if (!user) {
      // Demo seed hasn't run yet (fresh-DB bootstrap or self-hoster pointing
      // a non-demo DATABASE_URL at this code). Surface a clear message
      // rather than failing the password check below.
      return NextResponse.json(
        {
          error:
            "Demo user not seeded. Run `npx tsx scripts/seed-demo.ts` first.",
        },
        { status: 404 },
      );
    }

    // bcrypt verify against the hashed demo password. The demo password is
    // public, so this isn't keeping anyone out — it's just verifying that the
    // seeded password_hash still matches what we expect. If a rotation
    // changes DEMO_PASSWORD without updating this file, login fails loudly
    // rather than silently auth'ing a different user.
    const valid = await verifyPassword(DEMO_PASSWORD, user.passwordHash);
    if (!valid) {
      return NextResponse.json(
        { error: "Demo credentials drifted from the seed. Re-run seed-demo.ts." },
        { status: 500 },
      );
    }

    // Unwrap the demo DEK so encrypted-column reads work. The demo password
    // is hardcoded, so KEK derivation is deterministic — same as a real
    // login through /api/auth/login.
    let dek: Buffer | null = null;
    if (
      user.kekSalt &&
      user.dekWrapped &&
      user.dekWrappedIv &&
      user.dekWrappedTag
    ) {
      try {
        const pepperVersion = user.pepperVersion ?? 1;
        const kek = deriveKEK(
          DEMO_PASSWORD,
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
        await logApiError("GET", "/try-demo (unwrap)", err);
        return NextResponse.json(
          { error: "Demo DEK unwrap failed. Re-run seed-demo.ts." },
          { status: 500 },
        );
      }
    }

    // Demo never has MFA — short-circuit straight to session issuance.
    await recordSuccessfulLogin(user.id);
    const { token, jti } = await createSessionToken(user.id, false);
    if (dek) {
      putDEK(jti, dek, SESSION_TTL_MS, user.id);
      // Same post-login background tasks as the regular login route so the
      // demo experience matches what a real user gets.
      enqueueBackfillSecurities(user.id, dek);
      enqueueUpgradeStagingEncryption(user.id, dek);
      // Plaintext-gap closure backstop (2026-06-01) — see login route.
      enqueueUpgradeUserFieldEncryption(user.id, dek);
      // Email-inbox sweep (Epic B5) — see login route.
      enqueueProcessPendingInbox(user.id, dek);
    }

    // Build the absolute redirect URL from the X-Forwarded-* headers Caddy
    // sets, NOT from request.url. Behind the reverse proxy the upstream URL
    // is the systemd-bound 0.0.0.0:3456 form, so `new URL(next, request.url)`
    // produces a Location header that breaks in the browser
    // ("ERR_ADDRESS_INVALID"). Forwarded-host headers carry the original
    // public origin (finlynq.com) and are the standard pattern for routes
    // behind a reverse proxy.
    const forwardedHost = request.headers.get("x-forwarded-host");
    const forwardedProto = request.headers.get("x-forwarded-proto");
    const host = forwardedHost ?? request.nextUrl.host;
    const proto =
      forwardedProto ?? request.nextUrl.protocol.replace(/:$/, "");
    const redirectUrl = `${proto}://${host}${next}`;
    const response = NextResponse.redirect(redirectUrl);
    response.cookies.set(AUTH_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24,
      path: "/",
    });
    return response;
  } catch (error) {
    await logApiError("GET", "/try-demo", error);
    return NextResponse.json(
      { error: "Demo sign-in failed unexpectedly." },
      { status: 500 },
    );
  }
}
