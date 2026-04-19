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
import { getUserById, recordSuccessfulLogin } from "@/lib/auth/queries";
import { validateBody, safeErrorMessage } from "@/lib/validate";
import { checkRateLimit } from "@/lib/rate-limit";

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

    if (!verifyMfaCode(user.mfaSecret, code)) {
      return NextResponse.json(
        { error: "Invalid verification code." },
        { status: 401 }
      );
    }

    // Issue full session with MFA verified
    await recordSuccessfulLogin(user.id);
    const token = await createSessionToken(user.id, user.email, true);

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
