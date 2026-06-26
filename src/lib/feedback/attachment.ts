/**
 * Feedback-attachment policy (FINLYNQ-226) — single source of truth for the
 * image allowlist + size cap, shared by the server route and any test.
 *
 * v1: ONE image on the INITIAL feedback submission. Stored ON DISK, PLAINTEXT
 * (admin-readable — the maintainer has no per-user DEK), never the user-DEK
 * envelope. The 5 MB cap MIRRORS the import pipeline's MAX_BYTES.
 */

import path from "path";

/** 5 MB — mirrors the import pipeline's MAX_BYTES (src/app/api/mcp/upload/route.ts). */
export const FEEDBACK_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

/** Allowed image MIME types → canonical file extension. */
export const FEEDBACK_ATTACHMENT_MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Comma-joined allowlist for the client `<input accept>` + error messages. */
export const FEEDBACK_ATTACHMENT_ACCEPT = Object.keys(
  FEEDBACK_ATTACHMENT_MIME_EXT,
).join(",");

export type AttachmentValidationError =
  | { code: "bad_type"; message: string }
  | { code: "too_large"; message: string }
  | { code: "empty"; message: string };

/**
 * Pure validator for a candidate attachment. Returns `{ ext }` on success or a
 * typed error the route maps to a 4xx. SERVER-side enforcement — the client
 * mirror is convenience only.
 */
export function validateFeedbackAttachment(input: {
  mime: string;
  size: number;
}): { ext: string } | AttachmentValidationError {
  const ext = FEEDBACK_ATTACHMENT_MIME_EXT[input.mime];
  if (!ext) {
    return {
      code: "bad_type",
      message: `Unsupported file type — allowed: PNG, JPEG, WebP, GIF.`,
    };
  }
  if (input.size <= 0) {
    return { code: "empty", message: "The file is empty." };
  }
  if (input.size > FEEDBACK_ATTACHMENT_MAX_BYTES) {
    return {
      code: "too_large",
      message: `Image exceeds the ${Math.floor(
        FEEDBACK_ATTACHMENT_MAX_BYTES / (1024 * 1024),
      )} MB limit.`,
    };
  }
  return { ext };
}

/**
 * Resolve the on-disk storage path for a feedback attachment. Sibling of the
 * mcp_uploads dir (uploads/feedback/<userId>/<uuid>.<ext>) so it lives at the
 * repo root and survives a rebuild/deploy — NOT inside the .next build output.
 */
export function feedbackAttachmentPath(
  userId: string,
  id: string,
  ext: string,
): { dir: string; file: string } {
  const dir = path.resolve(process.cwd(), "uploads", "feedback", userId);
  return { dir, file: path.join(dir, `${id}.${ext}`) };
}
