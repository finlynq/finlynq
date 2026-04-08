/**
 * Admin usage statistics API (Phase 6: NS-36)
 *
 * GET /api/admin/stats — aggregate platform usage numbers
 */

import { NextRequest, NextResponse } from "next/server";
import { getDialect } from "@/db";
import { requireAdmin } from "@/lib/auth/require-admin";
import { getUsageStats, listUsers } from "@/lib/auth/queries";

export async function GET(request: NextRequest) {
  if (getDialect() !== "postgres") {
    return NextResponse.json(
      { error: "Admin features are only available in managed mode." },
      { status: 403 }
    );
  }

  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;

  const stats = await getUsageStats();

  // Compute registrations in last 7 and 30 days
  const allUsers = await listUsers({ limit: 10000 });
  const now = Date.now();
  const d7 = now - 7 * 86_400_000;
  const d30 = now - 30 * 86_400_000;

  let last7 = 0;
  let last30 = 0;
  let verified = 0;
  let mfaEnabled = 0;
  const planCounts: Record<string, number> = { free: 0, pro: 0, premium: 0 };

  for (const u of allUsers) {
    const t = new Date(u.createdAt as string).getTime();
    if (t >= d7) last7++;
    if (t >= d30) last30++;
    if (u.emailVerified) verified++;
    if (u.mfaEnabled) mfaEnabled++;
    const plan = (u.plan as string | null) ?? "free";
    planCounts[plan] = (planCounts[plan] || 0) + 1;
  }

  return NextResponse.json({
    ...stats,
    registrationsLast7Days: last7,
    registrationsLast30Days: last30,
    verifiedUsers: verified,
    mfaEnabledUsers: mfaEnabled,
    planBreakdown: planCounts,
  });
}
