/**
 * POST /api/auth/password-reset/request — Request a password reset email.
 *
 * Managed edition only. Always returns success to prevent user enumeration.
 * In a real deployment, this would send an email with the reset link.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDialect } from "@/db";
import { generateResetToken } from "@/lib/auth";
import { getUserByEmail, createPasswordResetToken } from "@/lib/auth/queries";
import { validateBody } from "@/lib/validate";
import { checkRateLimit } from "@/lib/rate-limit";
import { sendEmail, passwordResetEmail } from "@/lib/email";

const requestSchema = z.object({
  email: z.string().email("Invalid email address"),
});

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
      const { token, tokenHash, expiresAt } = generateResetToken();
      await createPasswordResetToken(user.id, tokenHash, expiresAt);

      // Send password reset email (fire-and-forget)
      sendEmail(passwordResetEmail(user.email, token)).catch(() => {});
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
