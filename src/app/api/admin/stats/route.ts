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
  let totalLogins = 0;
  let activeLast7 = 0;
  let activeLast30 = 0;
  const planCounts: Record<string, number> = { free: 0, pro: 0, premium: 0 };

  for (const u of allUsers) {
    const t = new Date(u.createdAt as string).getTime();
    if (t >= d7) last7++;
    if (t >= d30) last30++;
    if (u.emailVerified) verified++;
    if (u.mfaEnabled) mfaEnabled++;
    const plan = (u.plan as string | null) ?? "free";
    planCounts[plan] = (planCounts[plan] || 0) + 1;

    totalLogins += Number(u.loginCount ?? 0);
    if (u.lastLoginAt) {
      const l = new Date(u.lastLoginAt as string).getTime();
      if (l >= d7) activeLast7++;
      if (l >= d30) activeLast30++;
    }
  }

  // Finding #18 — dropped the per-user recent-logins list. It exposed
  // email + displayName + loginCount of other users on every admin dashboard
  // hit, which isn't needed for operational awareness. Aggregate counts
  // below cover the same need.
  const loginsLast24h = allUsers.filter((u) => {
    if (!u.lastLoginAt) return false;
    return new Date(u.lastLoginAt as string).getTime() >= now - 24 * 60 * 60 * 1000;
  }).length;

  return NextResponse.json({
    ...stats,
    registrationsLast7Days: last7,
    registrationsLast30Days: last30,
    verifiedUsers: verified,
    mfaEnabledUsers: mfaEnabled,
    planBreakdown: planCounts,
    totalLogins,
    activeUsersLast7Days: activeLast7,
    activeUsersLast30Days: activeLast30,
    loginsLast24Hours: loginsLast24h,
  });
}
