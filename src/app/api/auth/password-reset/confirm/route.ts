/**
 * POST /api/auth/password-reset/confirm — Reset password with a valid token.
 *
 * Managed edition only. Validates the token, updates the password, and
 * marks the token as used.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDialect } from "@/db";
import { hashPassword, hashResetToken, isTokenExpired } from "@/lib/auth";
import {
  getPasswordResetToken,
  markResetTokenUsed,
  updateUserPassword,
} from "@/lib/auth/queries";
import { validateBody, safeErrorMessage } from "@/lib/validate";
import { checkRateLimit } from "@/lib/rate-limit";

const confirmSchema = z.object({
  token: z.string().min(1, "Token is required"),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});

export async function POST(request: NextRequest) {
  if (getDialect() !== "postgres") {
    return NextResponse.json(
      { error: "Password reset is only available in managed mode." },
      { status: 403 }
    );
  }

  // Rate limit: 5 attempts per 15 minutes per IP
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rateLimit = checkRateLimit(`pw-confirm:${ip}`, 5, 900_000);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again later." },
      { status: 429 }
    );
  }

  try {
    const body = await request.json();
    const parsed = validateBody(body, confirmSchema);
    if (parsed.error) return parsed.error;

    const { token, newPassword } = parsed.data;

    // Look up the token by its hash
    const tokenHash = hashResetToken(token);
    const resetToken = await getPasswordResetToken(tokenHash);

    if (!resetToken) {
      return NextResponse.json(
        { error: "Invalid or expired reset token." },
        { status: 400 }
      );
    }

    if (resetToken.usedAt) {
      return NextResponse.json(
        { error: "This reset token has already been used." },
        { status: 400 }
      );
    }

    if (isTokenExpired(resetToken.expiresAt)) {
      return NextResponse.json(
        { error: "This reset token has expired. Please request a new one." },
        { status: 400 }
      );
    }

    // Envelope encryption + no-recovery policy:
    //   A password reset CANNOT succeed with just a new password, because the
    //   user's DEK is wrapped by a KEK derived from the old password and we
    //   don't have it. The correct flow is to wipe all user-owned data and
    //   regenerate a fresh DEK. That wipe is implemented in Phase 2; until
    //   then, reset is disabled to avoid leaving the account in a state
    //   where the DEK wrapping no longer matches the stored ciphertext.
    void markResetTokenUsed;
    void updateUserPassword;
    void hashPassword;
    void newPassword;
    return NextResponse.json(
      {
        error:
          "Password reset is temporarily disabled while we roll out encryption. Please contact support if you need to regain access (your data will be wiped since we cannot recover encrypted data without your password).",
        resetTokenUserId: resetToken.userId,
      },
      { status: 503 }
    );
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Password reset failed") },
      { status: 500 }
    );
  }
}
