/**
 * GET /api/auth/session — Return the current session status.
 *
 * Works across both editions:
 * - Self-hosted: returns passphrase unlock status
 * - Managed: returns JWT session info
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db, getDialect, schema } from "@/db";
import { getUserById } from "@/lib/auth/queries";
import { and, eq } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);

  if (!auth.authenticated) {
    return NextResponse.json({
      authenticated: false,
      method: null,
      userId: null,
    });
  }

  // In managed mode, include onboarding state + admin flag + identity fields
  let onboardingComplete = true; // default true so self-hosted never shows wizard
  let isAdmin = false;
  let username: string | null = null;
  let email: string | null = null;
  let displayName: string | null = null;
  let displayCurrency = "CAD";
  if (getDialect() === "postgres" && auth.context.userId) {
    const user = await getUserById(auth.context.userId).catch(() => null);
    onboardingComplete = Boolean(user?.onboardingComplete);
    isAdmin = user?.role === "admin";
    username = user?.username ?? null;
    email = user?.email ?? null;
    displayName = user?.displayName ?? null;

    // Display currency from settings — single round-trip on first paint.
    const row = await db
      .select({ value: schema.settings.value })
      .from(schema.settings)
      .where(
        and(
          eq(schema.settings.key, "display_currency"),
          eq(schema.settings.userId, auth.context.userId)
        )
      )
      .limit(1)
      .catch(() => []);
    if (row[0]?.value) displayCurrency = row[0].value;
  }

  return NextResponse.json({
    authenticated: true,
    method: auth.context.method,
    authMethod: auth.context.method,
    userId: auth.context.userId,
    mfaVerified: auth.context.mfaVerified,
    onboardingComplete,
    isAdmin,
    username,
    email,
    displayName,
    displayCurrency,
  });
}
