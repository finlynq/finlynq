-- FINLYNQ-228: allow attaching one file on EVERY feedback message (user reply +
-- admin reply), not just the initial submission.
--
-- v1 (FINLYNQ-226) put the attachment pointer on the `feedback` row (the
-- immutable thread seed). v2 mirrors those four pointer columns onto
-- `feedback_messages` so each reply can carry its own attachment. Same storage
-- model: the file is PLAINTEXT on disk under the durable uploads root
-- (<root>/uploads/feedback/<ownerUserId>/<uuid>.<ext>, OUTSIDE .next), keyed on
-- the thread OWNER's userId for every message; authorship is the existing
-- `author_role`/`author_id` columns. Plaintext is deliberate — feedback must be
-- maintainer-readable and the per-user DEK is unreadable by an admin.
--
-- Additive + non-destructive: all columns nullable, existing rows read as
-- attachment-less. Auto-applied by deploy.sh (tracked migration).

ALTER TABLE feedback_messages
  ADD COLUMN IF NOT EXISTS attachment_path     TEXT,    -- absolute on-disk path
  ADD COLUMN IF NOT EXISTS attachment_filename TEXT,    -- original upload filename
  ADD COLUMN IF NOT EXISTS attachment_mime     TEXT,    -- e.g. 'image/png' | 'application/pdf'
  ADD COLUMN IF NOT EXISTS attachment_size     INTEGER; -- bytes
