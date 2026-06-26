-- FINLYNQ-226: allow attaching one image/screenshot on the in-app feedback form.
--
-- The attachment is stored ON DISK (mirroring mcp_uploads) under
-- uploads/feedback/<userId>/<uuid>.<ext>; these columns are the PLAINTEXT pointer
-- to that file. Plaintext is deliberate — feedback (and therefore its attachment)
-- must be readable by the maintainer at /admin/feedback, and the submitting user's
-- per-user DEK is unreadable by an admin. The attachment is NOT routed through the
-- user-DEK envelope. v1 = single file on the initial submission only (the immutable
-- thread SEED), so the pointer lives on the feedback row, not feedback_messages.
--
-- Additive + non-destructive: all columns nullable, existing rows read as
-- attachment-less. Auto-applied by deploy.sh (tracked migration).

ALTER TABLE feedback
  ADD COLUMN IF NOT EXISTS attachment_path     TEXT,   -- absolute on-disk path
  ADD COLUMN IF NOT EXISTS attachment_filename TEXT,   -- original upload filename
  ADD COLUMN IF NOT EXISTS attachment_mime     TEXT,   -- 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  ADD COLUMN IF NOT EXISTS attachment_size     INTEGER; -- bytes
