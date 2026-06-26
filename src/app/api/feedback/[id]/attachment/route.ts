/**
 * GET /api/feedback/[id]/attachment — stream a feedback attachment to the thread
 * OWNER (FINLYNQ-228). Owner-scoped: the feedback row's user_id must equal the
 * caller. The owner may fetch ANY attachment in their own thread, including
 * admin replies.
 *
 *   - no query        → the SEED attachment (on the `feedback` row).
 *   - ?messageId=<n>  → that feedback_messages row's attachment (must belong to
 *                       this thread).
 *
 * Inline only for safe images; everything else forced to a download (shared
 * serve helper). Plaintext on disk — same rationale as the admin serve route.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { serveFeedbackAttachment } from "@/lib/feedback/attachment-io";

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

  // Ownership — 404 (not 403) on a stranger's thread to avoid id enumeration.
  const [fb] = await db
    .select({
      attachmentPath: schema.feedback.attachmentPath,
      attachmentMime: schema.feedback.attachmentMime,
      attachmentFilename: schema.feedback.attachmentFilename,
    })
    .from(schema.feedback)
    .where(
      and(eq(schema.feedback.id, feedbackId), eq(schema.feedback.userId, userId)),
    );
  if (!fb) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const messageIdRaw = request.nextUrl.searchParams.get("messageId");
  if (messageIdRaw != null) {
    const messageId = Number(messageIdRaw);
    if (!Number.isInteger(messageId) || messageId <= 0) {
      return NextResponse.json({ error: "Invalid messageId." }, { status: 400 });
    }
    const [m] = await db
      .select({
        attachmentPath: schema.feedbackMessages.attachmentPath,
        attachmentMime: schema.feedbackMessages.attachmentMime,
        attachmentFilename: schema.feedbackMessages.attachmentFilename,
      })
      .from(schema.feedbackMessages)
      .where(
        and(
          eq(schema.feedbackMessages.id, messageId),
          eq(schema.feedbackMessages.feedbackId, feedbackId),
        ),
      );
    if (!m) return NextResponse.json({ error: "No attachment." }, { status: 404 });
    return serveFeedbackAttachment(m);
  }

  return serveFeedbackAttachment(fb);
}
