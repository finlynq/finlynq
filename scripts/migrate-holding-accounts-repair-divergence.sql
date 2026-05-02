-- holding-accounts-repair-divergence (2026-05-01) — issue #95.
--
-- Repair pass for the second symptom flagged in the source review: a
-- `holding_accounts` row whose `account_id` differs from
-- `portfolio_holdings.account_id` for the same `holding_id`. Example:
-- holding 428 (VUN.TO) — `holding_accounts.account_id=600` (Mimi TFSA)
-- but `portfolio_holdings.account_id=614` (IBKR TFSA), with every
-- transaction living on 614. The aggregators JOIN through
-- `holding_accounts.(holding_id, account_id)` so the leg is filtered out.
--
-- The fix only touches `is_primary=true` rows (the legacy
-- portfolio_holdings.account_id mirror). Non-primary rows are intentional
-- multi-account pairings and must not be modified.
--
-- WARNING — composite-PK collision: this UPDATE rewrites the
-- (holding_id, account_id) PK value. If a holding already has a separate
-- `holding_accounts(holding_id, account_id=ph.account_id)` row at the
-- target pair, the UPDATE will fail with 23505 (unique_violation). Run the
-- audit step (1) first and inspect; if any holding shows a collision, the
-- operator must DELETE the orphan or merge qty/cost_basis manually before
-- running step 2.
--
-- Idempotent on re-runs after a successful repair (no rows match the
-- predicate).
--
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-holding-accounts-repair-divergence.sql
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-holding-accounts-repair-divergence.sql
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-holding-accounts-repair-divergence.sql

BEGIN;

-- 1. Audit: every primary-flagged row whose holding_accounts.account_id
--    diverges from portfolio_holdings.account_id. Inspect this output
--    before continuing — if any holding_id shows up here AND already has a
--    separate non-primary pairing at the target ph.account_id, the
--    UPDATE in step 2 will collide on the composite PK.
SELECT ha.holding_id, ha.user_id,
       ha.account_id AS ha_account_id,
       ph.account_id AS ph_account_id,
       ph.name       AS holding_name,
       ph.symbol     AS holding_symbol
FROM holding_accounts ha
JOIN portfolio_holdings ph ON ph.id = ha.holding_id
WHERE ha.account_id != ph.account_id
  AND ha.is_primary = true
ORDER BY ha.holding_id;

-- 1b. Collision pre-check: if any holding_id has BOTH a divergent primary
--     row AND a separate row at the target ph.account_id, abort manually.
--     Expected: 0 rows. If non-zero, do NOT continue with step 2 — the
--     UPDATE will fail and rollback.
SELECT ha.holding_id,
       ha.account_id AS divergent_primary_account,
       ph.account_id AS target_account
FROM holding_accounts ha
JOIN portfolio_holdings ph ON ph.id = ha.holding_id
WHERE ha.account_id != ph.account_id
  AND ha.is_primary = true
  AND EXISTS (
    SELECT 1 FROM holding_accounts ha2
    WHERE ha2.holding_id = ha.holding_id
      AND ha2.account_id = ph.account_id
  );

-- 2. Repair: align ha.account_id with ph.account_id for the primary row.
--    Skip non-primary rows — those are intentional multi-account pairings.
UPDATE holding_accounts ha
SET account_id = ph.account_id
FROM portfolio_holdings ph
WHERE ha.holding_id = ph.id
  AND ha.account_id != ph.account_id
  AND ha.is_primary = true;

-- 3. Verify: should be 0 after the repair.
SELECT COUNT(*) AS still_diverged
FROM holding_accounts ha
JOIN portfolio_holdings ph ON ph.id = ha.holding_id
WHERE ha.account_id != ph.account_id
  AND ha.is_primary = true;

COMMIT;

-- Post-migration spot-check (example — holding 428 / VUN.TO):
--   SELECT ph.id, ph.name, ph.account_id AS ph_account, ha.account_id AS ha_account, ha.is_primary
--   FROM portfolio_holdings ph
--   JOIN holding_accounts ha ON ha.holding_id = ph.id
--   WHERE ph.id = 428;
--   -- Expect ph_account == ha_account (both 614 IBKR TFSA, not 600 Mimi TFSA).
