/**
 * POST /api/auth/register — Create a new account (managed edition only).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDialect } from "@/db";
import { hashPassword, createSessionToken, AUTH_COOKIE } from "@/lib/auth";
import { createUser, getUserByEmail } from "@/lib/auth/queries";
import { validateBody, safeErrorMessage } from "@/lib/validate";
import { checkRateLimit } from "@/lib/rate-limit";

const registerSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  displayName: z.string().max(100).optional(),
});

export async function POST(request: NextRequest) {
  // Only available in managed mode
  if (getDialect() !== "postgres") {
    return NextResponse.json(
      { error: "Registration is only available in managed mode." },
      { status: 403 }
    );
  }

  // Rate limit: 3 registrations per minute per IP
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rateLimit = checkRateLimit(`register:${ip}`, 3, 60_000);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many registration attempts. Please try again later." },
      { status: 429 }
    );
  }

  try {
    const body = await request.json();
    const parsed = validateBody(body, registerSchema);
    if (parsed.error) return parsed.error;

    const { email, password, displayName } = parsed.data;

    // Check for existing user
    const existing = getUserByEmail(email);
    if (existing) {
      return NextResponse.json(
        { error: "An account with this email already exists." },
        { status: 409 }
      );
    }

    // Create user
    const passwordHash = await hashPassword(password);
    const user = createUser({ email, passwordHash, displayName });

    // Issue session token
    const token = await createSessionToken(user.id, email, false);

    const response = NextResponse.json(
      { success: true, userId: user.id },
      { status: 201 }
    );

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
      { error: safeErrorMessage(error, "Registration failed") },
      { status: 500 }
    );
  }
}
