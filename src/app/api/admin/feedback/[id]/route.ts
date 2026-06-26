/**
 * PATCH /api/admin/feedback/[id] — update a feedback item's status / admin note.
 * Gated by requireAdmin + managed-mode guard; audit-logged.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, schema, getDialect } from "@/db";
import { asc, eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth/require-admin";
import { validateBody, safeErrorMessage } from "@/lib/validate";
import { logAdminAction, clientIp } from "@/lib/admin-audit";
import { buildThreadSummary, toFeedbackMessage } from "@/lib/feedback/thread";
import type { FeedbackThread } from "@shared/types";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  status: z.enum(["new", "triaged", "resolved"]).optional(),
  adminNote: z.string().max(4000).nullable().optional(),
});

// GET /api/admin/feedback/[id] — full thread for the admin (seed + replies +
// adminNote + submitter identity). Side effect: marks admin_last_read_at = NOW()
// (opening a thread is an explicit read), clearing the admin-unread dot.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (getDialect() !== "postgres") {
    return NextResponse.json(
      { error: "Admin features are only available in managed mode." },
      { status: 403 },
    );
  }
  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;

  const feedbackId = Number((await params).id);
  if (!Number.isInteger(feedbackId) || feedbackId <= 0) {
    return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  }

  const [fb] = await db
    .select({
      id: schema.feedback.id,
      type: schema.feedback.type,
      status: schema.feedback.status,
      message: schema.feedback.message,
      pageUrl: schema.feedback.pageUrl,
      appVersion: schema.feedback.appVersion,
      adminNote: schema.feedback.adminNote,
      attachmentFilename: schema.feedback.attachmentFilename,
      attachmentMime: schema.feedback.attachmentMime,
      attachmentSize: schema.feedback.attachmentSize,
      userLastReadAt: schema.feedback.userLastReadAt,
      adminLastReadAt: schema.feedback.adminLastReadAt,
      createdAt: schema.feedback.createdAt,
      updatedAt: schema.feedback.updatedAt,
      username: schema.users.username,
      email: schema.users.email,
    })
    .from(schema.feedback)
    .leftJoin(schema.users, eq(schema.users.id, schema.feedback.userId))
    .where(eq(schema.feedback.id, feedbackId));
  if (!fb) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const msgs = await db
    .select()
    .from(schema.feedbackMessages)
    .where(eq(schema.feedbackMessages.feedbackId, feedbackId))
    .orderBy(asc(schema.feedbackMessages.createdAt));

  const summary = buildThreadSummary(fb, msgs, "admin");
  const thread: FeedbackThread = {
    ...summary,
    pageUrl: fb.pageUrl,
    appVersion: fb.appVersion,
    adminNote: fb.adminNote,
    username: fb.username,
    email: fb.email,
    attachment: fb.attachmentFilename
      ? {
          filename: fb.attachmentFilename,
          mime: fb.attachmentMime,
          size: fb.attachmentSize,
        }
      : null,
    messages: msgs.map((m) => toFeedbackMessage(m, auth.context.userId)),
  };

  // Mark admin-read after composing the response.
  await db
    .update(schema.feedback)
    .set({ adminLastReadAt: new Date() })
    .where(eq(schema.feedback.id, feedbackId));

  return NextResponse.json(thread);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (getDialect() !== "postgres") {
    return NextResponse.json(
      { error: "Admin features are only available in managed mode." },
      { status: 403 },
    );
  }
  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;
  const adminUserId = auth.context.userId;

  const feedbackId = Number((await params).id);
  if (!Number.isInteger(feedbackId) || feedbackId <= 0) {
    return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  }

  try {
    const body = await request.json();
    const parsed = validateBody(body, patchSchema);
    if (parsed.error) return parsed.error;
    const d = parsed.data;

    const [existing] = await db
      .select()
      .from(schema.feedback)
      .where(eq(schema.feedback.id, feedbackId));
    if (!existing) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    const update: Partial<typeof schema.feedback.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (d.status !== undefined) update.status = d.status;
    if (d.adminNote !== undefined) update.adminNote = d.adminNote;

    const [row] = await db
      .update(schema.feedback)
      .set(update)
      .where(eq(schema.feedback.id, feedbackId))
      .returning();

    if (d.status !== undefined && d.status !== existing.status) {
      await logAdminAction({
        adminUserId,
        action: "feedback_status_change",
        before: { id: existing.id, status: existing.status },
        after: { id: row.id, status: row.status },
        ip: clientIp(request),
      });
    }

    return NextResponse.json(row);
  } catch (e) {
    return NextResponse.json(
      { error: safeErrorMessage(e, "Failed to update feedback.") },
      { status: 500 },
    );
  }
}
