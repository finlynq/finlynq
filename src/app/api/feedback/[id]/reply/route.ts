/**
 * POST /api/feedback/[id]/reply — the user posts a follow-up on their own
 * feedback thread.
 *
 * Ownership-checked (404 on a non-owned id). Rate-limited on a DISTINCT bucket
 * (`feedback-reply:`) so replies don't starve the submit bucket (`feedback:`).
 * Inserts a feedback_messages row (author_role='user'), bumps feedback.updated_at
 * and the author's own user_last_read_at. Fires a best-effort admin email
 * notification (fire-and-forget) so the maintainer sees thread replies too.
 *
 * FINLYNQ-228 — accepts multipart/form-data with one optional attachment (same
 * denylist + 5 MB cap as the initial submit). The JSON path still works for
 * no-attachment / back-compat. The file is stored under the THREAD OWNER's
 * uploads dir (this is the owner's own thread).
 */

import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import { z } from "zod";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { validateBody, safeErrorMessage } from "@/lib/validate";
import { checkRateLimit } from "@/lib/rate-limit";
import { toFeedbackMessage } from "@/lib/feedback/thread";
import { saveFeedbackAttachment } from "@/lib/feedback/attachment-io";
import { notifyAdminsFeedbackReply } from "@/lib/feedback/notify";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  body: z.string().trim().min(1, "Message is required").max(4000),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  const feedbackId = Number((await params).id);
  if (!Number.isInteger(feedbackId) || feedbackId <= 0) {
    return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  }

  // Distinct bucket from the submit limiter: 30 replies/hour.
  const rl = checkRateLimit(`feedback-reply:${userId}`, 30, 60 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many replies. Please try again later." },
      { status: 429 },
    );
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

    // Ownership — 404 (not 403) on a stranger's id.
    const [fb] = await db
      .select({ id: schema.feedback.id, type: schema.feedback.type })
      .from(schema.feedback)
      .where(
        and(eq(schema.feedback.id, feedbackId), eq(schema.feedback.userId, userId)),
      );
    if (!fb) return NextResponse.json({ error: "Not found." }, { status: 404 });

    // Validate + write the optional attachment BEFORE the DB row, under the
    // thread owner's (= this user's) uploads dir. A bad upload persists nothing.
    const saved = await saveFeedbackAttachment(userId, fileEntry);
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
          authorRole: "user",
          authorId: userId,
          body,
          createdAt: now,
          ...(attachment ?? {}),
        })
        .returning();
    } catch (e) {
      if (attachment) await fs.unlink(attachment.attachmentPath).catch(() => {});
      throw e;
    }
    await db
      .update(schema.feedback)
      .set({ updatedAt: now, userLastReadAt: now })
      .where(eq(schema.feedback.id, feedbackId));

    // Fire-and-forget: notify admins of the new reply. Never block/500 the
    // user's reply on email failure.
    void notifyAdminsFeedbackReply({
      userId,
      feedbackId,
      feedbackType: fb.type,
      body,
    }).catch((err) => {
      console.error("[feedback-email] reply notify failed", err);
    });

    return NextResponse.json(toFeedbackMessage(msg, userId), { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: safeErrorMessage(e, "Failed to send reply.") },
      { status: 500 },
    );
  }
}
