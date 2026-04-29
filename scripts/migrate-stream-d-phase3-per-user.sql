-- Stream D Phase 3 — per-user lazy variant (replaces migrate-stream-d-phase3-null.sql).
--
-- Schema-only prep for the per-user lazy NULL cutover. The actual data NULLing
-- is done one-user-at-a-time on each successful login, gated on (a) the user's
-- own backfill being complete and (b) a sample-row decrypt succeeding with the
-- cached DEK. See src/lib/crypto/stream-d-phase3-null.ts.
--
-- This migration only:
--   1. Drops NOT NULL from the six plaintext name columns so per-user UPDATEs
--      can set name = NULL on individual rows.
--   2. Adds users.plaintext_nulled_at — the per-user "Phase 3 done" flag.
--
-- Idempotent — safe to re-run. Safe to apply on prod even though prod already
-- ran the eager variant; the IF NOT EXISTS / DROP NOT NULL statements no-op.
--
-- Apply order: prod (no-op, optional) → staging → dev.

BEGIN;

-- 1. Drop NOT NULL once at schema level. The encrypted row (where name_ct IS
-- NOT NULL) becomes the authoritative source after the per-user helper runs.
ALTER TABLE accounts            ALTER COLUMN name DROP NOT NULL;
ALTER TABLE categories          ALTER COLUMN name DROP NOT NULL;
ALTER TABLE goals               ALTER COLUMN name DROP NOT NULL;
ALTER TABLE loans               ALTER COLUMN name DROP NOT NULL;
ALTER TABLE subscriptions       ALTER COLUMN name DROP NOT NULL;
-- portfolio_holdings.name is already nullable in some envs; handle idempotently.
DO $$ BEGIN
  ALTER TABLE portfolio_holdings ALTER COLUMN name DROP NOT NULL;
EXCEPTION WHEN others THEN NULL; END $$;

-- 2. Per-user "Phase 3 done" flag. ISO-text matches the rest of the users table
-- (last_login_at, created_at, updated_at).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS plaintext_nulled_at text;

COMMIT;

-- Verification queries (run manually after deploy):
--   SELECT COUNT(*) FROM users WHERE plaintext_nulled_at IS NOT NULL; -- starts at 0, climbs as users log in
--   SELECT id, username, plaintext_nulled_at FROM users ORDER BY plaintext_nulled_at NULLS LAST;
