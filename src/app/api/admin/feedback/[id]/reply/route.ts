/**
 * POST /api/admin/feedback/[id]/reply — the admin replies to a user's feedback.
 *
 * Gated by requireAdmin + managed-mode guard. Inserts a feedback_messages row
 * (author_role='admin'), bumps feedback.updated_at + admin_last_read_at, and
 * soft-promotes status 'new' → 'triaged' (an admin reply implies triage; never
 * auto-resolve/demote). Audit-logged as `feedback_replied`. In-app only — the
 * user sees it via the "Your feedback" nav badge; no email is sent.
 *
 * FINLYNQ-228 — accepts multipart/form-data with one optional attachment (same
 * denylist + 5 MB cap). The file is stored under the THREAD OWNER's uploads dir
 * (so a wipe finds every thread file by owner), but author_role='admin' means a
 * wipe LEAVES it in place (maintainer-owned). The JSON path still works.
 */

import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import { z } from "zod";
import { db, schema, getDialect } from "@/db";
import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth/require-admin";
import { validateBody, safeErrorMessage } from "@/lib/validate";
import { logAdminAction, clientIp } from "@/lib/admin-audit";
import { toFeedbackMessage } from "@/lib/feedback/thread";
import { saveFeedbackAttachment } from "@/lib/feedback/attachment-io";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  body: z.string().trim().min(1, "Message is required").max(4000),
});

export async function POST(
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
    const contentType = request.headers.get("content-type") ?? "";
    const isMultipart = contentType.includes("multipart/form-data");

    let body: string;
    let fileEntry: File | null = null;
    if (isMultipart) {
      const form = (await request.formData()) as unknown as globalThis.FormData;
      const parsed = validateBody(
        { body: (form.get("body") as string | null) ?? undefined },
        bodySchema,
      );
      if (parsed.error) return parsed.error;
      body = parsed.data.body;
      const f = form.get("attachment");
      if (f && f instanceof File && f.size > 0) fileEntry = f;
    } else {
      const parsed = validateBody(await request.json(), bodySchema);
      if (parsed.error) return parsed.error;
      body = parsed.data.body;
    }

    const [existing] = await db
      .select()
      .from(schema.feedback)
      .where(eq(schema.feedback.id, feedbackId));
    if (!existing) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    // Store the admin attachment under the THREAD OWNER's dir (keeps every
    // thread file under one owner key) — authorship is the row's author_role.
    const saved = await saveFeedbackAttachment(existing.userId, fileEntry);
    if (!saved.ok) {
      return NextResponse.json({ error: saved.error }, { status: saved.status });
    }
    const attachment = saved.attachment;

    const now = new Date();
    let msg;
    try {
      [msg] = await db
        .insert(schema.feedbackMessages)
        .values({
          feedbackId,
          authorRole: "admin",
          authorId: adminUserId,
          body,
          createdAt: now,
          ...(attachment ?? {}),
        })
        .returning();
    } catch (e) {
      if (attachment) await fs.unlink(attachment.attachmentPath).catch(() => {});
      throw e;
    }

    // Replying implies triage — but never demote or auto-resolve.
    const newStatus = existing.status === "new" ? "triaged" : existing.status;
    await db
      .update(schema.feedback)
      .set({ updatedAt: now, adminLastReadAt: now, status: newStatus })
      .where(eq(schema.feedback.id, feedbackId));

    await logAdminAction({
      adminUserId,
      targetUserId: existing.userId,
      action: "feedback_replied",
      before: { id: existing.id, status: existing.status },
      after: { id: existing.id, status: newStatus },
      ip: clientIp(request),
    });

    return NextResponse.json(toFeedbackMessage(msg, adminUserId), { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: safeErrorMessage(e, "Failed to send reply.") },
      { status: 500 },
    );
  }
}
