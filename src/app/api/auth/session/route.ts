/**
 * GET /api/auth/session — Return the current session status.
 *
 * Works across both editions:
 * - Self-hosted: returns passphrase unlock status
 * - Managed: returns JWT session info
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getDialect } from "@/db";
import { getUserById } from "@/lib/auth/queries";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);

  if (!auth.authenticated) {
    return NextResponse.json({
      authenticated: false,
      method: null,
      userId: null,
    });
  }

  // In managed mode, include onboarding state
  let onboardingComplete = true; // default true so self-hosted never shows wizard
  if (getDialect() === "postgres" && auth.context.userId) {
    const user = await getUserById(auth.context.userId).catch(() => null);
    onboardingComplete = Boolean(user?.onboardingComplete);
  }

  return NextResponse.json({
    authenticated: true,
    method: auth.context.method,
    userId: auth.context.userId,
    mfaVerified: auth.context.mfaVerified,
    onboardingComplete,
  });
}
