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

    // Update the password and mark token used
    const passwordHash = await hashPassword(newPassword);
    await updateUserPassword(resetToken.userId, passwordHash);
    await markResetTokenUsed(tokenHash);

    return NextResponse.json({
      success: true,
      message: "Password has been reset. You can now log in with your new password.",
    });
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Password reset failed") },
      { status: 500 }
    );
  }
}
