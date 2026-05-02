-- holding-accounts-backfill-orphans (2026-05-01) — issue #95.
--
-- Repair pass for the bug where MCP `add_portfolio_holding` (HTTP + stdio)
-- inserted a `portfolio_holdings` row without the matching
-- `holding_accounts` pairing. Every portfolio aggregator (issue #25) JOINs
-- through `holding_accounts` on (holding_id, account_id, user_id), so any
-- such holding is silently invisible to `get_portfolio_analysis`,
-- `get_portfolio_performance`, and `analyze_holding`.
--
-- This script ONLY backfills holdings that have ZERO `holding_accounts`
-- rows. Existing pairings are left untouched (use the sibling
-- `migrate-holding-accounts-repair-divergence.sql` for the
-- account-divergence repair).
--
-- Idempotent (`ON CONFLICT DO NOTHING`). Safe to re-run.
--
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-holding-accounts-backfill-orphans.sql
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-holding-accounts-backfill-orphans.sql
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-holding-accounts-backfill-orphans.sql

BEGIN;

-- 1. Audit: how many holdings are currently missing the pairing.
SELECT COUNT(*) AS missing_pairings
FROM portfolio_holdings ph
LEFT JOIN holding_accounts ha ON ha.holding_id = ph.id
WHERE ha.holding_id IS NULL;

-- 2. Backfill — only holdings that have ZERO holding_accounts rows.
--    is_primary=true because every backfilled row is the holding's only
--    pairing (the legacy portfolio_holdings.account_id mirror invariant).
--    qty=0 / cost_basis=0 match the same defaults the original
--    migrate-holding-accounts.sql backfill used for fresh rows; aggregators
--    derive live qty/cost from `transactions`, so 0/0 is correct on insert.
INSERT INTO holding_accounts (holding_id, account_id, user_id, qty, cost_basis, is_primary)
SELECT ph.id, ph.account_id, ph.user_id, 0, 0, true
FROM portfolio_holdings ph
LEFT JOIN holding_accounts ha ON ha.holding_id = ph.id
WHERE ha.holding_id IS NULL
  AND ph.account_id IS NOT NULL
ON CONFLICT (holding_id, account_id) DO NOTHING;

-- 3. Verify: should be 0 after the backfill.
SELECT COUNT(*) AS still_missing
FROM portfolio_holdings ph
LEFT JOIN holding_accounts ha ON ha.holding_id = ph.id
WHERE ha.holding_id IS NULL;

COMMIT;

-- Post-migration spot-checks:
--   -- Every holding with a non-NULL account_id now has at least one pairing.
--   SELECT COUNT(*) FROM portfolio_holdings WHERE account_id IS NOT NULL;
--   SELECT COUNT(DISTINCT holding_id) FROM holding_accounts;
--   -- Drill down on any specific holding to confirm:
--   SELECT ph.id, ph.name, ph.symbol, ph.account_id, ha.account_id, ha.is_primary
--   FROM portfolio_holdings ph
--   LEFT JOIN holding_accounts ha ON ha.holding_id = ph.id
--   WHERE ph.id IN (539, 540, 541);
