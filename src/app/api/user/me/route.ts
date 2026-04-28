/**
 * GET /api/user/me — Return current user profile including onboarding status.
 * Used by the dashboard to decide whether to show the onboarding wizard.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getDialect } from "@/db";
import { getUserById } from "@/lib/auth/queries";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  const { userId, method } = auth.context;

  // Self-hosted users don't have a user record — onboarding always done
  if (method === "passphrase" || getDialect() !== "postgres") {
    return NextResponse.json({
      userId,
      username: null,
      email: null,
      displayName: null,
      onboardingComplete: true,
    });
  }

  const user = await getUserById(userId);
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  return NextResponse.json({
    userId,
    username: user.username ?? null,
    email: user.email ?? null,
    displayName: user.displayName ?? null,
    onboardingComplete: user.onboardingComplete === 1,
  });
}
