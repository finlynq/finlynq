/**
 * GET /api/admin/feedback/[id]/attachment — stream the raw bytes of a feedback
 * attachment (FINLYNQ-226/228) to the admin review UI.
 *
 *   - no query        → the SEED attachment (on the `feedback` row).
 *   - ?messageId=<n>  → that feedback_messages row's attachment (must belong to
 *                       this thread).
 *
 * The file is stored PLAINTEXT on disk under the durable uploads root; the
 * maintainer has no per-user DEK, so the attachment was deliberately kept out of
 * the user-DEK envelope. Gated by requireAdmin + managed-mode guard. Inline only
 * for safe images; everything else is forced to a download (shared serve helper).
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema, getDialect } from "@/db";
import { and, eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth/require-admin";
import { serveFeedbackAttachment } from "@/lib/feedback/attachment-io";

export const dynamic = "force-dynamic";

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

  const [fb] = await db
    .select({
      attachmentPath: schema.feedback.attachmentPath,
      attachmentMime: schema.feedback.attachmentMime,
      attachmentFilename: schema.feedback.attachmentFilename,
    })
    .from(schema.feedback)
    .where(eq(schema.feedback.id, feedbackId));
  if (!fb) return NextResponse.json({ error: "No attachment." }, { status: 404 });
  return serveFeedbackAttachment(fb);
}
