/**
 * GET /api/feedback/[id] — one feedback thread for the owning user.
 *
 * Ownership-checked: a non-owned id returns 404 (not 403) to avoid id
 * enumeration. `adminNote` is NEVER included on this route (it is the private
 * maintainer note). Does not mark read — the client fires POST .../read.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, asc, eq } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { buildThreadSummary, toFeedbackMessage } from "@/lib/feedback/thread";
import type { FeedbackThread } from "@shared/types";

export const dynamic = "force-dynamic";

export async function GET(
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

  const [fb] = await db
    .select()
    .from(schema.feedback)
    .where(
      and(eq(schema.feedback.id, feedbackId), eq(schema.feedback.userId, userId)),
    );
  if (!fb) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const msgs = await db
    .select()
    .from(schema.feedbackMessages)
    .where(eq(schema.feedbackMessages.feedbackId, feedbackId))
    .orderBy(asc(schema.feedbackMessages.createdAt));

  const summary = buildThreadSummary(fb, msgs, "user");
  const thread: FeedbackThread = {
    ...summary,
    pageUrl: fb.pageUrl,
    appVersion: fb.appVersion,
    attachment: fb.attachmentFilename
      ? {
          filename: fb.attachmentFilename,
          mime: fb.attachmentMime,
          size: fb.attachmentSize,
        }
      : null,
    messages: msgs.map((m) => toFeedbackMessage(m, userId)),
  };
  return NextResponse.json(thread);
}
