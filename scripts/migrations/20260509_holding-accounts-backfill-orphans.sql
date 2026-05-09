-- 20260509_holding-accounts-backfill-orphans.sql — issue #205.
--
-- Repairs the cohort of orphan portfolio_holdings rows created since the
-- 2026-05-01 backfill (loose script: scripts/migrate-holding-accounts-backfill-orphans.sql)
-- by the 8 INSERT paths that were not yet dual-writing into holding_accounts.
-- Closes the issue #95 follow-up cohort by combining an in-place code fix
-- across the 8 sites with this one-shot SQL repair for any orphans created
-- between 2026-05-01 and the deploy that ships this migration.
--
-- Idempotent (`ON CONFLICT (holding_id, account_id) DO NOTHING`). Safe to
-- re-run.
--
-- Runner contract: deploy.sh wraps this file in a transaction with the
-- schema_migrations bookkeeping INSERT — do NOT add an inner BEGIN/COMMIT.
-- Filename charset is [A-Za-z0-9_-].

INSERT INTO holding_accounts (holding_id, account_id, user_id, qty, cost_basis, is_primary)
SELECT ph.id, ph.account_id, ph.user_id, 0, 0, true
FROM portfolio_holdings ph
LEFT JOIN holding_accounts ha
  ON ha.holding_id = ph.id AND ha.account_id = ph.account_id
WHERE ha.holding_id IS NULL
  AND ph.account_id IS NOT NULL
ON CONFLICT (holding_id, account_id) DO NOTHING;
