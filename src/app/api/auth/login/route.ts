/**
 * POST /api/auth/login — Authenticate with email/password (managed edition).
 *
 * If MFA is enabled, returns { mfaRequired: true } instead of a session.
 * The client must then call /api/auth/mfa/verify with the TOTP code.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDialect } from "@/db";
import {
  verifyPassword,
  createSessionToken,
  AUTH_COOKIE,
} from "@/lib/auth";
import { getUserByEmail } from "@/lib/auth/queries";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { checkRateLimit } from "@/lib/rate-limit";

const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

export async function POST(request: NextRequest) {
  if (getDialect() !== "postgres") {
    return NextResponse.json(
      { error: "Account login is only available in managed mode. Use passphrase unlock for self-hosted." },
      { status: 403 }
    );
  }

  // Rate limit: 5 attempts per 60 seconds per IP
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rateLimit = checkRateLimit(`login:${ip}`, 5, 60_000);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many login attempts. Please try again later." },
      {
        status: 429,
        headers: {
          "Retry-After": String(
            Math.ceil((rateLimit.resetAt - Date.now()) / 1000)
          ),
        },
      }
    );
  }

  try {
    const body = await request.json();
    const parsed = validateBody(body, loginSchema);
    if (parsed.error) return parsed.error;

    const { email, password } = parsed.data;

    // Generic error to prevent user enumeration
    const invalidCredentials = NextResponse.json(
      { error: "Invalid email or password." },
      { status: 401 }
    );

    const user = await getUserByEmail(email);
    if (!user) return invalidCredentials;

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) return invalidCredentials;

    // If MFA is enabled, return a pending state (no session yet)
    if (user.mfaEnabled) {
      // Issue a short-lived MFA-pending token (5 min)
      const pendingToken = await createSessionToken(user.id, email, false);
      return NextResponse.json({
        mfaRequired: true,
        mfaPendingToken: pendingToken,
      });
    }

    // No MFA — issue full session
    const token = await createSessionToken(user.id, email, false);

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
    await logApiError("POST", "/api/auth/login", error);
    return NextResponse.json(
      { error: safeErrorMessage(error, "Login failed") },
      { status: 500 }
    );
  }
}
