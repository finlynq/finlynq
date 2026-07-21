/**
 * Feedback-attachment policy (FINLYNQ-226 → v2 FINLYNQ-228) — single source of
 * truth for the type DENYLIST + size cap, shared by the server routes, the
 * dialog, and tests.
 *
 * v2: ANY file type EXCEPT dangerous ones, on the INITIAL submission AND on
 * every reply (user + admin). Stored ON DISK, PLAINTEXT (admin-readable — the
 * maintainer has no per-user DEK), never the user-DEK envelope. The 5 MB cap
 * MIRRORS the import pipeline's MAX_BYTES. The file lands as `<uuid>.<ext>` (a
 * sanitized extension derived from the original name); the original filename
 * lives only in the DB pointer, never on disk (no path-traversal surface).
 */

import path from "path";
import { getUploadsBaseDir } from "@/lib/uploads-dir";

/** 5 MB — mirrors the import pipeline's MAX_BYTES (src/app/api/import/staging/upload/route.ts). */
export const FEEDBACK_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * DENYLIST of dangerous file EXTENSIONS — executables/scripts that could run on
 * a host, plus active web content that could XSS in the admin/user origin.
 * Lowercased, alnum-only (the validator normalizes the candidate ext the same
 * way before lookup).
 */
export const FEEDBACK_DANGEROUS_EXTENSIONS: ReadonlySet<string> = new Set([
  // Windows executables / scripts
  "exe", "dll", "com", "bat", "cmd", "msi", "scr", "cpl", "ps1", "psm1",
  "vbs", "vbe", "jse", "wsf", "hta", "msc", "reg", "lnk", "gadget", "sys",
  // Cross-platform scripts / archives that execute
  "js", "mjs", "jar",
  // Unix executables / scripts
  "sh", "bash", "zsh", "csh", "run", "bin", "so", "dylib",
  // Installers / app bundles
  "app", "deb", "rpm", "dmg", "pkg", "apk", "ipa",
  // Active web content (XSS vector)
  "html", "htm", "xhtml", "svg", "svgz",
]);

/**
 * DENYLIST of dangerous MIME types. Belt-and-suspenders alongside the extension
 * check — a renamed `.txt` with a `text/html` content-type is still rejected.
 */
export const FEEDBACK_DANGEROUS_MIME: ReadonlySet<string> = new Set([
  "application/x-msdownload",
  "application/x-executable",
  "application/x-dosexec",
  "application/vnd.microsoft.portable-executable",
  "application/x-sh",
  "application/x-shellscript",
  "application/x-csh",
  "application/x-bat",
  "application/x-msdos-program",
  "application/java-archive",
  "application/x-apple-diskimage",
  "application/vnd.android.package-archive",
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
]);

/**
 * Image MIME types that are SAFE to serve INLINE (and to thumbnail in the UI).
 * Everything else is forced to a download (`Content-Disposition: attachment`).
 */
export const FEEDBACK_SAFE_INLINE_IMAGE_MIME: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/** Convenience for the dialog preview + serve logic. */
export function isSafeInlineImageMime(mime: string | null | undefined): boolean {
  return !!mime && FEEDBACK_SAFE_INLINE_IMAGE_MIME.has(mime);
}

/**
 * Hint for the client `<input accept>` — we no longer restrict to images, so
 * this is "any file" (empty = no restriction). Kept as a named export so the
 * dialog has a single place to tweak the picker hint.
 */
export const FEEDBACK_ATTACHMENT_ACCEPT = "";

export type AttachmentValidationError =
  | { code: "bad_type"; message: string }
  | { code: "too_large"; message: string }
  | { code: "empty"; message: string };

/**
 * Derive a sanitized lowercase extension from an original filename. Takes the
 * last `.`-segment, strips it to alphanumerics, and lowercases it. Missing /
 * empty → `"bin"`. Never returns a path-bearing or special-char string, so it
 * is safe to interpolate into the on-disk `<uuid>.<ext>` filename.
 */
export function sanitizeAttachmentExt(filename: string | null | undefined): string {
  if (!filename) return "bin";
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot < 0 || dot === base.length - 1) return "bin";
  const raw = base.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "");
  return raw || "bin";
}

/**
 * Pure validator for a candidate attachment. Returns `{ ext }` on success or a
 * typed error the route maps to a 4xx. SERVER-side enforcement — the client
 * mirror is convenience only.
 *
 * Any file type is allowed EXCEPT the dangerous denylist (by extension OR MIME).
 */
export function validateFeedbackAttachment(input: {
  filename: string | null | undefined;
  mime: string | null | undefined;
  size: number;
}): { ext: string } | AttachmentValidationError {
  const ext = sanitizeAttachmentExt(input.filename);
  const mime = (input.mime ?? "").toLowerCase();

  if (FEEDBACK_DANGEROUS_EXTENSIONS.has(ext) || FEEDBACK_DANGEROUS_MIME.has(mime)) {
    return {
      code: "bad_type",
      message:
        "That file type isn't allowed. Executables, scripts, and web pages (.exe, .sh, .js, .html, .svg, …) are blocked.",
    };
  }
  if (input.size <= 0) {
    return { code: "empty", message: "The file is empty." };
  }
  if (input.size > FEEDBACK_ATTACHMENT_MAX_BYTES) {
    return {
      code: "too_large",
      message: `File exceeds the ${Math.floor(
        FEEDBACK_ATTACHMENT_MAX_BYTES / (1024 * 1024),
      )} MB limit.`,
    };
  }
  return { ext };
}

/**
 * Resolve the on-disk storage path for a feedback attachment under the DURABLE
 * uploads root (getUploadsBaseDir — OUTSIDE `.next`, so it survives a deploy):
 * `<base>/feedback/<userId>/<uuid>.<ext>`. The directory is keyed on the thread
 * OWNER's userId for ALL messages (seed + user + admin replies), so a wipe can
 * find every file by owner; authorship is tracked in the DB row, not the path.
 */
export function feedbackAttachmentPath(
  userId: string,
  id: string,
  ext: string,
): { dir: string; file: string } {
  const dir = path.join(getUploadsBaseDir(), "feedback", userId);
  return { dir, file: path.join(dir, `${id}.${ext}`) };
}
