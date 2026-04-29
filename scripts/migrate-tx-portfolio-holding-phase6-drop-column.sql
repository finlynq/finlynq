-- transactions.portfolio_holding Phase 6 — DROP COLUMN.
--
-- Phase 5 (2026-04-29) NULL'd the legacy text column on every backfilled
-- row, removed it from TX_ENCRYPTED_FIELDS, deleted every orphan-fallback
-- read path, and stopped writing the column from REST + import + seed.
-- Phase 6 retires the column entirely. The FK `portfolio_holding_id` →
-- portfolio_holdings.id is the sole source of truth going forward.
--
-- ORDER OF OPERATIONS — code BEFORE migration. Unlike additive migrations
-- (Phase 5.1, Stream D), a DROP COLUMN is backwards-incompatible: the old
-- running app SELECTs that column. Deploy the matching code release first
-- so every running process has stopped referencing portfolio_holding, then
-- run this migration.
--
-- Idempotent — re-running on a column-already-dropped DB is a no-op
-- thanks to IF EXISTS.

BEGIN;

-- Defensive sanity check: by Phase 5 every row should have FK set or be
-- a non-investment cash leg with FK NULL. If we still have rows with
-- non-NULL plaintext, the migration that should have NULL'd them was
-- skipped — abort rather than lose data.
DO $$
DECLARE
  remaining int;
BEGIN
  SELECT COUNT(*) INTO remaining FROM transactions WHERE portfolio_holding IS NOT NULL;
  IF remaining > 0 THEN
    RAISE EXCEPTION 'transactions: % rows still have non-NULL portfolio_holding text — run migrate-tx-portfolio-holding-phase5-null.sql first', remaining;
  END IF;
END $$;

ALTER TABLE transactions DROP COLUMN IF EXISTS portfolio_holding;

COMMIT;

-- Post-migration verification:
--   \d transactions
--   -- column "portfolio_holding" should no longer appear
