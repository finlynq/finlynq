/**
 * POST /api/auth/mfa/verify — Complete MFA verification during login.
 *
 * Called after /api/auth/login returns { mfaRequired: true }.
 * Accepts the MFA-pending token and TOTP code, then issues a full session.
 *
 * B7 hardening (2026-05-07):
 *  - Requires the pending token to actually be a pending token. A full
 *    session JWT can't be replayed here.
 *  - Per-pending-jti lifetime rate limit (5 attempts). After 5 wrong codes
 *    the pending token is dead — the user has to re-enter their password.
 *    This prevents botnet-style code grinding against a single captured
 *    pending cookie even when the per-IP gate is defeated by a proxy fleet.
 *  - On success, INSERTs the pending jti into `revoked_jtis` so the same
 *    token can't be reused for a second `/mfa/verify` call (or replayed
 *    by an attacker who captured both the pending cookie and a valid code).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  verifySessionTokenDetailed,
  verifyMfaCode,
  createSessionToken,
  AUTH_COOKIE,
  revokeJti,
} from "@/lib/auth";
import { SESSION_TTL_MS } from "@/lib/auth/jwt";
import { getUserById, recordSuccessfulLogin } from "@/lib/auth/queries";
import { validateBody, safeErrorMessage } from "@/lib/validate";
import { checkRateLimit } from "@/lib/rate-limit";
import { getDEK, putDEK, deleteDEK } from "@/lib/crypto/dek-cache";
import { decryptField } from "@/lib/crypto/envelope";
// Stream D Phase 4 (2026-05-03): plaintext display-name columns dropped;
// stream-d-backfill + stream-d-phase3-null helpers deleted. Canonicalize
// remains and reads ciphertext directly.
import { enqueueCanonicalizePortfolioNames } from "@/lib/crypto/stream-d-canonicalize-portfolio";
import { enqueueUpgradeStagingEncryption } from "@/lib/email-import/upgrade-staging-encryption";

const verifySchema = z.object({
  mfaPendingToken: z.string().min(1, "Pending token is required"),
  code: z.string().length(6, "Code must be 6 digits"),
});

/**
 * Per-pending-jti lifetime attempt counter. Bounded LRU so a flood of
 * captured pending tokens can't OOM the process. Once a jti hits the cap,
 * subsequent verify calls reject without verifying the code — the user has
 * to log in again. Resetting requires a new pending token (different jti).
 */
const MAX_VERIFY_ATTEMPTS = 5;
const ATTEMPTS_MAX_ENTRIES = 10_000;

interface AttemptEntry {
  count: number;
  /** Best-effort eviction hint; we drop entries on first miss after expiry. */
  expiresAt: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _g = globalThis as any;
if (!_g.__pfMfaVerifyAttempts) {
  _g.__pfMfaVerifyAttempts = new Map<string, AttemptEntry>();
}
const attemptCounter: Map<string, AttemptEntry> = _g.__pfMfaVerifyAttempts;

function recordAttempt(jti: string, expSeconds: number): number {
  // Sweep stale entries opportunistically — caps memory without a timer.
  if (attemptCounter.size >= ATTEMPTS_MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of attemptCounter) {
      if (v.expiresAt <= now) attemptCounter.delete(k);
    }
    // Still over? Evict the oldest (insertion-ordered Map).
    if (attemptCounter.size >= ATTEMPTS_MAX_ENTRIES) {
      const firstKey = attemptCounter.keys().next().value;
      if (firstKey !== undefined) attemptCounter.delete(firstKey);
    }
  }
  const entry = attemptCounter.get(jti);
  if (entry) {
    entry.count++;
    return entry.count;
  }
  // expSeconds is from JWT exp (epoch seconds). Pending TTL is 5m so the
  // counter is naturally short-lived; we still refuse subsequent attempts
  // even after exp because the JWT signature validation would reject anyway.
  attemptCounter.set(jti, {
    count: 1,
    expiresAt: expSeconds > 0 ? expSeconds * 1000 : Date.now() + 5 * 60_000,
  });
  return 1;
}

/** Test helper. Resets the per-jti counter. */
export function _clearVerifyAttempts(): void {
  attemptCounter.clear();
}

export async function POST(request: NextRequest) {
  // Per-IP soft cap stays in place — protects against a swarm of new pending
  // tokens being minted and hammering this route.
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rateLimit = checkRateLimit(`mfa:${ip}`, 5, 60_000);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many MFA attempts. Please try again later." },
      { status: 429 }
    );
  }

  try {
    const body = await request.json();
    const parsed = validateBody(body, verifySchema);
    if (parsed.error) return parsed.error;

    const { mfaPendingToken, code } = parsed.data;

    // Verify the pending token. We use the detailed variant so we don't
    // accidentally accept a revoked/promoted pending jti for a second call.
    const { payload } = await verifySessionTokenDetailed(mfaPendingToken);
    if (!payload || !payload.sub) {
      return NextResponse.json(
        { error: "Invalid or expired pending token. Please log in again." },
        { status: 401 }
      );
    }

    // The pending token MUST be a pending token. Rejecting full sessions
    // here means a captured logged-in JWT can't be replayed at this endpoint
    // to spoof an "MFA verified" promotion.
    if (!payload.pending) {
      return NextResponse.json(
        { error: "Invalid pending token. Please log in again." },
        { status: 401 }
      );
    }

    const pendingJti = (payload.jti as string | undefined) ?? null;
    if (!pendingJti) {
      return NextResponse.json(
        { error: "Invalid pending token. Please log in again." },
        { status: 401 }
      );
    }

    // Per-pending-jti lifetime attempt cap. The pending token's jti is
    // unique per /login call, so this caps attempts per password-correct
    // login attempt — enough to recover from a typo, not enough to brute the
    // 6-digit space (10^6) before the 5-minute TTL anyway.
    const expSec = typeof payload.exp === "number" ? payload.exp : 0;
    const attempts = recordAttempt(pendingJti, expSec);
    if (attempts > MAX_VERIFY_ATTEMPTS) {
      // Once exhausted, kill the pending token outright so it can't be reused
      // even if the attacker waits a moment.
      const exp = expSec > 0 ? new Date(expSec * 1000) : new Date(Date.now() + 5 * 60_000);
      await revokeJti(pendingJti, exp);
      deleteDEK(pendingJti);
      return NextResponse.json(
        {
          error:
            "Too many incorrect verification codes. Please log in again.",
        },
        { status: 429 }
      );
    }

    // Get the user and verify MFA
    const user = await getUserById(payload.sub);
    if (!user || !user.mfaEnabled || !user.mfaSecret) {
      return NextResponse.json(
        { error: "MFA is not configured for this account." },
        { status: 400 }
      );
    }

    // Need DEK to decrypt stored MFA secret. The password-verify step on /login
    // put the user's DEK in the cache keyed by the pending-session jti; we
    // promote it onto the full session below after we've verified the code.
    const pendingDek = getDEK(pendingJti, payload.sub);
    if (!pendingDek) {
      return NextResponse.json(
        { error: "Pending session has no DEK. Please sign in again." },
        { status: 401 }
      );
    }

    let decryptedSecret: string | null;
    try {
      decryptedSecret = decryptField(pendingDek, user.mfaSecret);
    } catch {
      return NextResponse.json(
        { error: "MFA secret could not be decrypted. Please contact support." },
        { status: 500 }
      );
    }

    if (!decryptedSecret || !verifyMfaCode(decryptedSecret, code)) {
      return NextResponse.json(
        { error: "Invalid verification code." },
        { status: 401 }
      );
    }

    // Issue full session with MFA verified. The pending jti is denylisted
    // so the same token can't be replayed for a second /mfa/verify (or to
    // probe whether the code we just verified is still good).
    await recordSuccessfulLogin(user.id);
    const { token, jti } = await createSessionToken(user.id, true);
    putDEK(jti, pendingDek, SESSION_TTL_MS, user.id);
    deleteDEK(pendingJti);
    const exp = expSec > 0 ? new Date(expSec * 1000) : new Date(Date.now() + 5 * 60_000);
    await revokeJti(pendingJti, exp);
    attemptCounter.delete(pendingJti);
    // Stream D Phase 4: only canonicalization remains. See login route.
    enqueueCanonicalizePortfolioNames(user.id, pendingDek);
    // Staging encryption upgrade — see login route for rationale.
    enqueueUpgradeStagingEncryption(user.id, pendingDek);

    const response = NextResponse.json({ success: true });

    response.cookies.set(AUTH_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24, // 24 hours
      path: "/",
    });

    return response;
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "MFA verification failed") },
      { status: 500 }
    );
  }
}
