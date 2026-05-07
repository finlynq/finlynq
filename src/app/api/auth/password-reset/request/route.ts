/**
 * POST /api/auth/password-reset/request — Request a password reset email.
 *
 * Managed edition only. Always returns the same success response to prevent
 * user enumeration; the per-user rate limit happens silently after the user
 * is resolved so the response shape never differs between known and unknown
 * recipients.
 *
 * Finding C-7 (2026-05-07) — added per-user.id rate-limit bucket on top of
 * the existing per-IP limit. Without it, a distributed attacker could mail-
 * bomb a single recipient by spreading requests across many IPs (each IP
 * stays under the 3-per-5-min cap). The per-user check uses
 * `password_reset_tokens.created_at` rather than an in-memory bucket so the
 * limit survives process restarts and is not bypassed by horizontal scaling.
 * Whenever we DO issue a fresh token we also mark every prior unused token
 * for this user as used, capping the simultaneously-valid-tokens count to 1
 * — defends against a follow-up "intercept any of N pending emails" attack
 * if the user ever has their inbox compromised.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDialect } from "@/db";
import { generateResetToken } from "@/lib/auth";
import {
  getUserByEmail,
  createPasswordResetToken,
  countActiveResetTokensSince,
  markStaleResetTokensUsed,
} from "@/lib/auth/queries";
import { validateBody } from "@/lib/validate";
import { checkRateLimit } from "@/lib/rate-limit";
import { sendEmail, passwordResetEmail } from "@/lib/email";

const requestSchema = z.object({
  email: z.string().email("Invalid email address"),
});

const PER_USER_HOURLY_LIMIT = 3;
const PER_USER_DAILY_LIMIT = 10;
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

export async function POST(request: NextRequest) {
  if (getDialect() !== "postgres") {
    return NextResponse.json(
      { error: "Password reset is only available in managed mode." },
      { status: 403 }
    );
  }

  // Rate limit: 3 requests per 5 minutes per IP
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rateLimit = checkRateLimit(`pw-reset:${ip}`, 3, 300_000);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    const body = await request.json();
    const parsed = validateBody(body, requestSchema);
    if (parsed.error) return parsed.error;

    const user = await getUserByEmail(parsed.data.email);

    // Username-only accounts have no email-based recovery channel, so skip the
    // mail send when user.email is null. Same silent no-op as the existing
    // anti-enumeration response for unknown emails — by design.
    if (user && user.email) {
      // Finding C-7 — per-user rate limit. Quietly skip the mail-send when
      // either the hourly or daily cap is exceeded; never surface a distinct
      // error to the caller (that would itself be an enumeration signal:
      // "this email had recent reset activity, therefore it exists").
      const issuedLastHour = await countActiveResetTokensSince(user.id, ONE_HOUR_MS);
      const issuedLastDay = await countActiveResetTokensSince(user.id, ONE_DAY_MS);
      const overLimit =
        issuedLastHour >= PER_USER_HOURLY_LIMIT ||
        issuedLastDay >= PER_USER_DAILY_LIMIT;

      if (!overLimit) {
        // Mark any prior unused, unexpired tokens for this user as used
        // BEFORE issuing the new one. This caps simultaneously-valid tokens
        // per user to 1 — see header comment for rationale.
        await markStaleResetTokensUsed(user.id);

        const { token, tokenHash, expiresAt } = generateResetToken();
        await createPasswordResetToken(user.id, tokenHash, expiresAt);

        // Send password reset email (fire-and-forget)
        sendEmail(passwordResetEmail(user.email, token)).catch(() => {});
      }
    }

    // Always return success to prevent user enumeration
    return NextResponse.json({
      success: true,
      message:
        "If an account with that email exists, a password reset link has been sent.",
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to process password reset request." },
      { status: 500 }
    );
  }
}
