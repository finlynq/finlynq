/**
 * POST /api/onboarding/complete — Mark onboarding as finished.
 *
 * Persists the onboarding-completed flag on the user record (managed edition)
 * or in settings (self-hosted).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { getDialect } from "@/db";
import { completeOnboarding } from "@/lib/auth/queries";

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  const { userId } = auth.context;

  if (getDialect() === "postgres") {
    await completeOnboarding(userId);
  }

  return NextResponse.json({ success: true });
}
