/**
 * GET /api/auth/verify-email?token=... — Verify email address.
 *
 * Managed edition only. Marks the user's email as verified
 * and redirects to dashboard.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDialect } from "@/db";
import { verifyUserEmail } from "@/lib/auth/queries";

export async function GET(request: NextRequest) {
  if (getDialect() !== "postgres") {
    return NextResponse.json(
      { error: "Email verification is only available in managed mode." },
      { status: 403 }
    );
  }

  const token = new URL(request.url).searchParams.get("token");
  if (!token) {
    return NextResponse.json(
      { error: "Missing verification token." },
      { status: 400 }
    );
  }

  const user = verifyUserEmail(token);
  if (!user) {
    return NextResponse.json(
      { error: "Invalid or expired verification token." },
      { status: 400 }
    );
  }

  // Redirect to dashboard with success message
  const appUrl = process.env.APP_URL || "http://localhost:3000";
  return NextResponse.redirect(`${appUrl}/dashboard?emailVerified=1`);
}
