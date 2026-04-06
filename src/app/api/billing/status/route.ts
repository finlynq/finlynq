/**
 * GET /api/billing/status — Current user's billing/plan status (Phase 6: NS-36)
 */

import { NextRequest, NextResponse } from "next/server";
import { getDialect } from "@/db";
import { requireAuth } from "@/lib/auth/require-auth";
import { getUserById } from "@/lib/auth/queries";

export async function GET(request: NextRequest) {
  if (getDialect() !== "postgres") {
    return NextResponse.json(
      { error: "Billing is only available in managed mode." },
      { status: 403 }
    );
  }

  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  const user = await getUserById(auth.context.userId);
  if (!user) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }

  return NextResponse.json({
    plan: user.plan ?? "free",
    planExpiresAt: user.planExpiresAt,
    stripeCustomerId: user.stripeCustomerId ? "connected" : null,
    onboardingComplete: user.onboardingComplete === 1,
    email: user.email,
    displayName: user.displayName,
  });
}
