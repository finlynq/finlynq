/**
 * POST /api/auth/mfa/verify — Complete MFA verification during login.
 *
 * Called after /api/auth/login returns { mfaRequired: true }.
 * Accepts the MFA-pending token and TOTP code, then issues a full session.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  verifySessionToken,
  verifyMfaCode,
  createSessionToken,
  AUTH_COOKIE,
} from "@/lib/auth";
import { SESSION_TTL_MS } from "@/lib/auth/jwt";
import { getUserById, recordSuccessfulLogin } from "@/lib/auth/queries";
import { validateBody, safeErrorMessage } from "@/lib/validate";
import { checkRateLimit } from "@/lib/rate-limit";
import { getDEK, putDEK, deleteDEK } from "@/lib/crypto/dek-cache";
import { decryptField } from "@/lib/crypto/envelope";
import { enqueueStreamDBackfill } from "@/lib/crypto/stream-d-backfill";
import { enqueuePhase3NullIfReady } from "@/lib/crypto/stream-d-phase3-null";

const verifySchema = z.object({
  mfaPendingToken: z.string().min(1, "Pending token is required"),
  code: z.string().length(6, "Code must be 6 digits"),
});

export async function POST(request: NextRequest) {
  // Rate limit MFA attempts
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

    // Verify the pending token
    const payload = await verifySessionToken(mfaPendingToken);
    if (!payload || !payload.sub) {
      return NextResponse.json(
        { error: "Invalid or expired pending token. Please log in again." },
        { status: 401 }
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
    const pendingJti = (payload.jti as string | undefined) ?? null;
    const pendingDek = pendingJti ? getDEK(pendingJti) : null;
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

    // Issue full session with MFA verified
    await recordSuccessfulLogin(user.id);
    const { token, jti } = await createSessionToken(user.id, true);
    if (pendingDek) {
      putDEK(jti, pendingDek, SESSION_TTL_MS);
      if (pendingJti) deleteDEK(pendingJti);
      // Stream D lazy backfill — same pattern as the non-MFA login path.
      enqueueStreamDBackfill(user.id, pendingDek);
      // Phase 3 per-user plaintext NULL — same pattern as the non-MFA path.
      enqueuePhase3NullIfReady(user.id, pendingDek);
    }

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
