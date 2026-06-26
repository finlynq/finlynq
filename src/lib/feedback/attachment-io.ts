/**
 * Feedback attachment server I/O (FINLYNQ-228) — the ONE place that validates +
 * writes an uploaded file to disk, and the ONE place that serves bytes back, so
 * the submit route, both reply routes, and both serve routes never diverge.
 *
 * Storage is PLAINTEXT on disk (admin-readable; the maintainer has no per-user
 * DEK) under the durable uploads root — see attachment.ts / uploads-dir.ts.
 */

import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { NextResponse } from "next/server";
import {
  FEEDBACK_ATTACHMENT_MAX_BYTES,
  feedbackAttachmentPath,
  isSafeInlineImageMime,
  validateFeedbackAttachment,
} from "@/lib/feedback/attachment";

export interface StoredAttachment {
  attachmentPath: string;
  attachmentFilename: string;
  attachmentMime: string;
  attachmentSize: number;
}

export type AttachmentSaveResult =
  | { ok: true; attachment: StoredAttachment | null }
  | { ok: false; status: number; error: string };

/**
 * Validate (denylist + 5 MB cap) and persist an optional uploaded file for the
 * thread owned by `ownerUserId`. Returns `{ attachment: null }` when no file was
 * provided, or a typed 4xx error WITHOUT writing anything on a bad upload — so a
 * rejected attachment never persists a row OR a file. The caller writes the DB
 * row AFTER a successful save and should unlink on a row-insert failure.
 */
export async function saveFeedbackAttachment(
  ownerUserId: string,
  file: File | null,
): Promise<AttachmentSaveResult> {
  if (!file || file.size <= 0) return { ok: true, attachment: null };

  const check = validateFeedbackAttachment({
    filename: file.name,
    mime: file.type,
    size: file.size,
  });
  if ("code" in check) {
    const status = check.code === "bad_type" ? 415 : check.code === "too_large" ? 413 : 400;
    return { ok: false, status, error: check.message };
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  // Re-check the realized byte length (the size header can lie / stream short).
  if (bytes.length === 0) {
    return { ok: false, status: 400, error: "The file is empty." };
  }
  if (bytes.length > FEEDBACK_ATTACHMENT_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `File exceeds the ${Math.floor(
        FEEDBACK_ATTACHMENT_MAX_BYTES / (1024 * 1024),
      )} MB limit.`,
    };
  }

  const id = crypto.randomUUID();
  const { dir, file: filePath } = feedbackAttachmentPath(ownerUserId, id, check.ext);
  await fs.mkdir(dir, { recursive: true });
  // Plaintext on purpose — admin-readable, NOT the user-DEK envelope.
  await fs.writeFile(filePath, bytes);

  return {
    ok: true,
    attachment: {
      attachmentPath: filePath,
      attachmentFilename: path.basename(file.name) || `attachment.${check.ext}`,
      attachmentMime: file.type || "application/octet-stream",
      attachmentSize: bytes.length,
    },
  };
}

/**
 * Stream a stored attachment's bytes back. Inline ONLY for safe images
 * (png/jpeg/webp/gif); everything else is forced to a download as
 * `application/octet-stream` (defense-in-depth so a denied-but-somehow-present
 * html/svg can't execute in our origin). Always `nosniff`. Returns a 404 when
 * the row has no attachment or the file is missing.
 */
export async function serveFeedbackAttachment(input: {
  attachmentPath: string | null;
  attachmentMime: string | null;
  attachmentFilename: string | null;
}): Promise<NextResponse> {
  if (!input.attachmentPath) {
    return NextResponse.json({ error: "No attachment." }, { status: 404 });
  }

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(input.attachmentPath);
  } catch {
    return NextResponse.json({ error: "Attachment file missing." }, { status: 404 });
  }

  const filename = (input.attachmentFilename || "attachment").replace(/[\r\n"\\]/g, "");
  const safeInline = isSafeInlineImageMime(input.attachmentMime);
  const contentType = safeInline
    ? (input.attachmentMime as string)
    : "application/octet-stream";
  const disposition = safeInline
    ? `inline; filename="${filename}"`
    : `attachment; filename="${filename}"`;

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(bytes.length),
      "Content-Disposition": disposition,
      // Never let a stored file be content-sniffed into executable markup.
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
