/**
 * GET /api/admin/feedback — list user feedback for review (paginated).
 *
 * Joins `users` for the submitter's username/email (plaintext identity fields).
 * Optional ?status=new|triaged|resolved filter. Gated by requireAdmin +
 * managed-mode guard.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema, getDialect } from "@/db";
import { desc, eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth/require-admin";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (getDialect() !== "postgres") {
    return NextResponse.json(
      { error: "Admin features are only available in managed mode." },
      { status: 403 },
    );
  }
  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;

  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status");
  const status =
    statusParam === "new" || statusParam === "triaged" || statusParam === "resolved"
      ? statusParam
      : null;
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 100);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

  const rows = await db
    .select({
      id: schema.feedback.id,
      userId: schema.feedback.userId,
      type: schema.feedback.type,
      message: schema.feedback.message,
      pageUrl: schema.feedback.pageUrl,
      appVersion: schema.feedback.appVersion,
      status: schema.feedback.status,
      adminNote: schema.feedback.adminNote,
      createdAt: schema.feedback.createdAt,
      updatedAt: schema.feedback.updatedAt,
      username: schema.users.username,
      email: schema.users.email,
    })
    .from(schema.feedback)
    .leftJoin(schema.users, eq(schema.users.id, schema.feedback.userId))
    .where(status ? eq(schema.feedback.status, status) : undefined)
    .orderBy(desc(schema.feedback.createdAt))
    .limit(limit)
    .offset(offset);

  return NextResponse.json({ feedback: rows, limit, offset });
}
