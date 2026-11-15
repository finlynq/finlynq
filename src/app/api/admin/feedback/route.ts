/**
 * GET /api/admin/feedback — list user feedback for review (paginated).
 *
 * Joins `users` for the submitter's username/email (plaintext identity fields).
 * Optional ?status=new|reopened|triaged|resolved filter. Gated by requireAdmin +
 * managed-mode guard.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema, getDialect } from "@/db";
import { desc, eq, inArray } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth/require-admin";
import { isFeedbackStatus } from "@/lib/feedback/status";

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
  const status = isFeedbackStatus(statusParam) ? statusParam : null;
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
      adminLastReadAt: schema.feedback.adminLastReadAt,
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

  // Per-thread reply count + admin-unread (a user reply newer than the admin's
  // last read of that thread). Fetched only for the current page of rows.
  const ids = rows.map((r) => r.id);
  const msgs = ids.length
    ? await db
        .select({
          feedbackId: schema.feedbackMessages.feedbackId,
          authorRole: schema.feedbackMessages.authorRole,
          createdAt: schema.feedbackMessages.createdAt,
        })
        .from(schema.feedbackMessages)
        .where(inArray(schema.feedbackMessages.feedbackId, ids))
    : [];

  const feedback = rows.map((r) => {
    const threadMsgs = msgs.filter((m) => m.feedbackId === r.id);
    const readMs = r.adminLastReadAt ? new Date(r.adminLastReadAt).getTime() : 0;
    const adminUnread = threadMsgs.some(
      (m) => m.authorRole === "user" && new Date(m.createdAt).getTime() > readMs,
    );
    return { ...r, replyCount: threadMsgs.length, adminUnread };
  });

  return NextResponse.json({ feedback, limit, offset });
}
