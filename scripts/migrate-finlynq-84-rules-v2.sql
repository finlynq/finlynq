-- FINLYNQ-84 — Transaction rules v2: multi-condition + richer actions.
--
-- DESTRUCTIVE MIGRATION — DO NOT MOVE THIS FILE TO scripts/migrations/.
-- The plan-author's first draft put this at scripts/migrations/20260521_...sql,
-- which would have been auto-applied by deploy.sh. Per workspace CLAUDE.md:
-- "Destructive migrations (DROP COLUMN, NULL-out plaintext after a code-first
--  cutover, etc.) still need the manual 'code FIRST, then SQL' flow per
--  docs/migrations.md — leave those out of scripts/migrations/."
--
-- Manual sequence (run AFTER the new bundle has fully deployed on dev/prod):
--   1. Confirm the new bundle (schema.ts JSONB conditions/actions + new code
--      paths) is live and serving traffic on the target env.
--   2. Connect as the env's DB user and run this file in psql:
--        psql "$DATABASE_URL" -f pf-app/scripts/migrate-finlynq-84-rules-v2.sql
--   3. Wrap manually in BEGIN/COMMIT for atomic apply (no schema_migrations
--      bookkeeping — that's only for the auto-runner).
--
-- TRUNCATE per user decision 2026-05-21 — wipe-and-replace, no backfill.
-- Row count today is low; users re-enter rules on first /settings/rules visit.

BEGIN;

TRUNCATE transaction_rules;

ALTER TABLE transaction_rules
  DROP COLUMN match_field,
  DROP COLUMN match_type,
  DROP COLUMN match_value,
  DROP COLUMN assign_category_id,
  DROP COLUMN assign_tags,
  DROP COLUMN rename_to,
  ADD  COLUMN conditions jsonb NOT NULL,
  ADD  COLUMN actions    jsonb NOT NULL,
  ADD  COLUMN updated_at timestamptz NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS transaction_rules_user_active_priority_idx
  ON transaction_rules (user_id, is_active, priority DESC);

COMMIT;
