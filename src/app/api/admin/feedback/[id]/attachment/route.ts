/**
 * GET /api/admin/feedback/[id]/attachment — stream the raw bytes of a feedback
 * row's image attachment (FINLYNQ-226) to the admin review UI.
 *
 * The file is stored PLAINTEXT on disk (uploads/feedback/<userId>/<uuid>.<ext>);
 * the maintainer has no per-user DEK, so the attachment was deliberately kept
 * out of the user-DEK envelope. Gated by requireAdmin + managed-mode guard, same
 * as the rest of /api/admin/feedback/*.
 */

import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import { db, schema, getDialect } from "@/db";
import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth/require-admin";
import { FEEDBACK_ATTACHMENT_MIME_EXT } from "@/lib/feedback/attachment";

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

  const [fb] = await db
    .select({
      attachmentPath: schema.feedback.attachmentPath,
      attachmentMime: schema.feedback.attachmentMime,
      attachmentFilename: schema.feedback.attachmentFilename,
    })
    .from(schema.feedback)
    .where(eq(schema.feedback.id, feedbackId));

  if (!fb || !fb.attachmentPath) {
    return NextResponse.json({ error: "No attachment." }, { status: 404 });
  }

  // Only ever serve a known image content-type — never echo back an arbitrary
  // stored value as the Content-Type.
  const mime =
    fb.attachmentMime && fb.attachmentMime in FEEDBACK_ATTACHMENT_MIME_EXT
      ? fb.attachmentMime
      : "application/octet-stream";

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(fb.attachmentPath);
  } catch {
    return NextResponse.json({ error: "Attachment file missing." }, { status: 404 });
  }

  const filename = (fb.attachmentFilename || "attachment").replace(/[\r\n"]/g, "");
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": mime,
      "Content-Length": String(bytes.length),
      // inline so the admin can preview in-browser; filename for save-as.
      "Content-Disposition": `inline; filename="${filename}"`,
      // Defense-in-depth: never let a stored image be interpreted as markup.
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
