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
  wipeUserDataAndRewrap,
} from "@/lib/auth/queries";
import { createWrappedDEKForPassword } from "@/lib/crypto/envelope";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { validateBody, safeErrorMessage } from "@/lib/validate";
import { checkRateLimit } from "@/lib/rate-limit";

const confirmSchema = z.object({
  token: z.string().min(1, "Token is required"),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
  confirmation: z.literal("WIPE", {
    message: "Confirmation phrase must be 'WIPE' — all your data will be erased",
  }),
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

    // Envelope encryption + no-recovery policy: we can't decrypt data without
    // the old password. Reset wipes all user-owned data and provisions a
    // fresh DEK wrapped by the new password. The client must have
    // acknowledged this by sending `confirmation: "WIPE"` above.
    const newHash = await hashPassword(newPassword);
    const { wrapped } = createWrappedDEKForPassword(newPassword);
    await wipeUserDataAndRewrap(resetToken.userId, newHash, {
      kekSalt: wrapped.salt.toString("base64"),
      dekWrapped: wrapped.wrapped.toString("base64"),
      dekWrappedIv: wrapped.iv.toString("base64"),
      dekWrappedTag: wrapped.tag.toString("base64"),
    });
    await markResetTokenUsed(tokenHash);
    invalidateUserTxCache(resetToken.userId);

    return NextResponse.json({
      success: true,
      message:
        "Password reset complete. Your data has been wiped — you'll need to re-add your accounts, categories, and transactions.",
    });
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Password reset failed") },
      { status: 500 }
    );
  }
}
