/**
 * Admin user management API (Phase 6: NS-36)
 *
 * GET  /api/admin/users — list all users (paginated)
 * PATCH /api/admin/users — update a user's role or plan
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDialect } from "@/db";
import { requireAdmin } from "@/lib/auth/require-admin";
import {
  listUsers,
  getUserCount,
  getUserById,
  updateUserRole,
  updateUserPlan,
} from "@/lib/auth/queries";
import { validateBody } from "@/lib/validate";

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

  const users = listUsers({ limit, offset });
  const total = getUserCount();

  return NextResponse.json({ users, total, limit, offset });
}

const updateSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["user", "admin"]).optional(),
  plan: z.enum(["free", "pro", "premium"]).optional(),
  planExpiresAt: z.string().optional(),
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

  try {
    const body = await request.json();
    const parsed = validateBody(body, updateSchema);
    if (parsed.error) return parsed.error;

    const { userId, role, plan, planExpiresAt } = parsed.data;

    const target = getUserById(userId);
    if (!target) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }

    if (role) updateUserRole(userId, role);
    if (plan) updateUserPlan(userId, plan, planExpiresAt);

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Failed to update user." },
      { status: 500 }
    );
  }
}
