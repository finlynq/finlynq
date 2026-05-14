/**
 * Admin user management API (Phase 6: NS-36)
 *
 * GET  /api/admin/users â€” list all users (paginated)
 * PATCH /api/admin/users â€” update a user's role or plan
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, getDialect } from "@/db";
import * as pgSchema from "@/db/schema-pg";
import { count, inArray } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth/require-admin";
import {
  listUsers,
  getUserCount,
  getUserById,
  updateUserRole,
  updateUserPlan,
} from "@/lib/auth/queries";
import { validateBody } from "@/lib/validate";
import { logAdminAction, clientIp } from "@/lib/admin-audit";
import { getDEK } from "@/lib/crypto/dek-cache";
import { decryptField } from "@/lib/crypto/envelope";
import { verifyMfaCode } from "@/lib/auth";

export async function GET(request: NextRequest) {
  if (getDialect() !== "postgres") {
    return NextResponse.json(
      { error: "Admin features are only available in managed mode." },
      { status: 403 }
    );
  }

  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 100);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

  const users = await listUsers({ limit, offset });
  const total = await getUserCount();

  // Transaction count per user — single GROUP BY query scoped to the page's
  // user ids, joined into the response in JS. Avoids an N+1 over users.
  const userIds = users.map((u) => u.id);
  const txCounts: Record<string, number> = {};
  if (userIds.length > 0) {
    const rows = await db
      .select({
        userId: pgSchema.transactions.userId,
        total: count(),
      })
      .from(pgSchema.transactions)
      .where(inArray(pgSchema.transactions.userId, userIds))
      .groupBy(pgSchema.transactions.userId);
    for (const r of rows) {
      txCounts[r.userId as string] = Number(r.total ?? 0);
    }
  }

  const usersWithCounts = users.map((u) => ({
    ...u,
    transactionCount: txCounts[u.id] ?? 0,
  }));

  return NextResponse.json({ users: usersWithCounts, total, limit, offset });
}

const updateSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["user", "admin"]).optional(),
  plan: z.enum(["free", "pro", "premium"]).optional(),
  planExpiresAt: z.string().optional(),
  // Required if the acting admin has MFA enabled â€” Finding Admin-MFA-step-up.
  // A stale session cookie alone can no longer silently mutate other users.
  mfaCode: z.string().length(6).optional(),
});

export async function PATCH(request: NextRequest) {
  if (getDialect() !== "postgres") {
    return NextResponse.json(
      { error: "Admin features are only available in managed mode." },
      { status: 403 }
    );
  }

  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;
  const { userId: adminUserId, sessionId } = auth.context;

  try {
    const body = await request.json();
    const parsed = validateBody(body, updateSchema);
    if (parsed.error) return parsed.error;

    const { userId, role, plan, planExpiresAt, mfaCode } = parsed.data;

    const adminUser = await getUserById(adminUserId);
    if (!adminUser) {
      return NextResponse.json({ error: "Admin user not found." }, { status: 404 });
    }

    // MFA step-up: if the admin has MFA enabled, require a fresh TOTP on the
    // request. Decrypt the stored secret with the admin's session DEK.
    if (adminUser.mfaEnabled && adminUser.mfaSecret) {
      if (!mfaCode) {
        return NextResponse.json(
          { error: "MFA code required for admin mutations.", code: "MFA_REQUIRED" },
          { status: 403 }
        );
      }
      const dek = sessionId ? getDEK(sessionId, userId) : null;
      if (!dek) {
        return NextResponse.json(
          { error: "Session expired. Please sign in again." },
          { status: 423 }
        );
      }
      let mfaSecret: string | null;
      try {
        mfaSecret = decryptField(dek, adminUser.mfaSecret);
      } catch {
        return NextResponse.json(
          { error: "MFA secret could not be decrypted." },
          { status: 500 }
        );
      }
      if (!mfaSecret || !verifyMfaCode(mfaSecret, mfaCode)) {
        return NextResponse.json(
          { error: "Invalid MFA code." },
          { status: 401 }
        );
      }
    }

    const target = await getUserById(userId);
    if (!target) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }

    const before = { role: target.role, plan: target.plan, planExpiresAt: target.planExpiresAt };

    if (role) await updateUserRole(userId, role);
    if (plan) await updateUserPlan(userId, plan, planExpiresAt);

    const after = {
      role: role ?? target.role,
      plan: plan ?? target.plan,
      planExpiresAt: planExpiresAt ?? target.planExpiresAt,
    };

    // Finding #16 â€” audit-log the mutation. Fire-and-forget so a failed audit
    // write doesn't block a legitimate admin op (but it is logged to server log).
    if (role && role !== target.role) {
      await logAdminAction({
        adminUserId,
        targetUserId: userId,
        action: "role_change",
        before: { role: target.role },
        after: { role },
        ip: clientIp(request),
      });
    }
    if (plan && plan !== target.plan) {
      await logAdminAction({
        adminUserId,
        targetUserId: userId,
        action: "plan_change",
        before: { plan: target.plan, planExpiresAt: target.planExpiresAt },
        after: { plan, planExpiresAt: planExpiresAt ?? null },
        ip: clientIp(request),
      });
    }

    return NextResponse.json({ success: true, before, after });
  } catch {
    return NextResponse.json(
      { error: "Failed to update user." },
      { status: 500 }
    );
  }
}
