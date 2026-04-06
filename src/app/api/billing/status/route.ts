/**
 * GET /api/billing/status — Current user's billing/plan status (Session 2)
 *
 * Also handles trial expiry: if the user's trial has expired, automatically
 * downgrades them to the free tier before returning status.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDialect } from "@/db";
import { requireAuth } from "@/lib/auth/require-auth";
import { getUserById, updateUserPlan } from "@/lib/auth/queries";

export async function GET(request: NextRequest) {
  if (getDialect() !== "postgres") {
    return NextResponse.json(
      { error: "Billing is only available in managed mode." },
      { status: 403 }
    );
  }

  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  let user = await getUserById(auth.context.userId);
  if (!user) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }

  // Downgrade expired trials to free automatically
  if (
    user.plan === "trial" &&
    user.planExpiresAt &&
    new Date(user.planExpiresAt) < new Date()
  ) {
    await updateUserPlan(user.id, "free");
    user = await getUserById(user.id);
  }

  return NextResponse.json({
    plan: user?.plan ?? "free",
    planExpiresAt: user?.planExpiresAt ?? null,
    stripeCustomerId: user?.stripeCustomerId ? "connected" : null,
  });
}
