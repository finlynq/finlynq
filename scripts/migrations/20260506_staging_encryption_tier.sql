-- Staged-transactions encryption tier marker (2026-05-06).
--
-- Today every row in `staged_transactions` is encrypted with the server-side
-- service key (`PF_STAGING_KEY`, `sv1:` envelope). Threat: a server admin
-- with env + DB can decrypt every staged row.
--
-- This migration adds an `encryption_tier` column so an upgrade job (run on
-- user login when the DEK is available) can re-encrypt that user's staging
-- rows under their own DEK (`v1:` envelope), dropping the service-key
-- dependency for active users. Read paths branch on the column to pick the
-- right decrypt helper.
--
-- Existing rows default to 'service' (matches what's actually in the DB
-- today). New email-webhook inserts continue to write 'service' since the
-- DEK is unavailable at ingest. The login-time upgrade job is what flips
-- rows to 'user'.
--
-- Idempotent: safe to re-run. The runner in deploy.sh wraps the file in a
-- transaction with the schema_migrations bookkeeping insert — do NOT add
-- a BEGIN/COMMIT block here.

ALTER TABLE staged_transactions
  ADD COLUMN IF NOT EXISTS encryption_tier TEXT NOT NULL DEFAULT 'service';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'staged_transactions_encryption_tier_check'
  ) THEN
    ALTER TABLE staged_transactions
      ADD CONSTRAINT staged_transactions_encryption_tier_check
      CHECK (encryption_tier IN ('service','user'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_staged_tx_user_tier
  ON staged_transactions (user_id, encryption_tier);
