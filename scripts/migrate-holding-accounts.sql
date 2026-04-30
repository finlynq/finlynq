-- holding_accounts (2026-04-30) — many-to-many between portfolio_holdings
-- and accounts. See issue #26 (Section G).
--
-- The legacy one-to-many column portfolio_holdings.account_id stays in
-- place during the Section F (issue #25) consumer migration. The row in
-- holding_accounts where is_primary=true mirrors that legacy column for
-- each holding. Once every aggregator + MCP tool reads from
-- holding_accounts (Section F's scope), a follow-up migration drops
-- portfolio_holdings.account_id.
--
-- Idempotent: every step uses IF NOT EXISTS / ON CONFLICT DO NOTHING.
-- Safe to re-run.
--
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-holding-accounts.sql
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-holding-accounts.sql
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-holding-accounts.sql

BEGIN;

-- 1. Table.
CREATE TABLE IF NOT EXISTS holding_accounts (
  holding_id  integer NOT NULL REFERENCES portfolio_holdings(id) ON DELETE CASCADE,
  account_id  integer NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id     text    NOT NULL,
  qty         double precision NOT NULL DEFAULT 0,
  cost_basis  double precision NOT NULL DEFAULT 0,
  is_primary  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (holding_id, account_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS holding_accounts_user_holding_idx
  ON holding_accounts (user_id, holding_id, account_id);

-- 2. Backfill from existing one-to-many rows. For each portfolio_holdings
--    row with a non-NULL account_id, insert a (holding_id, account_id)
--    pair flagged is_primary=true (since today every holding sits in
--    exactly one account). qty + cost_basis are derived from the
--    transactions in that holding:
--      qty        = SUM(quantity) over all txns referencing the holding
--      cost_basis = SUM(ABS(amount)) over txns where quantity > 0
--                   (the buy-leg pattern in src/lib/holdings-value.ts:113;
--                   matches the "qty>0 = buy regardless of amount sign"
--                   invariant in CLAUDE.md "Portfolio aggregation").
--
--    ON CONFLICT DO NOTHING keeps the migration idempotent — if a row
--    already exists for (holding_id, account_id) we leave its qty /
--    cost_basis alone (the user may have edited it via the new UI).
INSERT INTO holding_accounts (holding_id, account_id, user_id, qty, cost_basis, is_primary)
SELECT
  ph.id           AS holding_id,
  ph.account_id   AS account_id,
  ph.user_id      AS user_id,
  COALESCE(agg.total_qty,  0) AS qty,
  COALESCE(agg.total_cost, 0) AS cost_basis,
  true            AS is_primary
FROM portfolio_holdings ph
LEFT JOIN (
  SELECT
    t.portfolio_holding_id AS holding_id,
    SUM(COALESCE(t.quantity, 0))                                                  AS total_qty,
    SUM(CASE WHEN COALESCE(t.quantity, 0) > 0 THEN ABS(t.amount) ELSE 0 END)      AS total_cost
  FROM transactions t
  WHERE t.portfolio_holding_id IS NOT NULL
  GROUP BY t.portfolio_holding_id
) agg ON agg.holding_id = ph.id
WHERE ph.account_id IS NOT NULL
ON CONFLICT (holding_id, account_id) DO NOTHING;

-- 3. Sanity check — every holding with a non-NULL account_id should now
--    have at least one is_primary=true row. We RAISE NOTICE rather than
--    abort because future re-runs (after the user has manually toggled
--    is_primary in the UI) might legitimately leave a holding with
--    is_primary=false on its legacy-mirrored row.
DO $$
DECLARE
  holdings_with_account int;
  primary_rows int;
BEGIN
  SELECT COUNT(*) INTO holdings_with_account
    FROM portfolio_holdings WHERE account_id IS NOT NULL;
  SELECT COUNT(DISTINCT holding_id) INTO primary_rows
    FROM holding_accounts WHERE is_primary = true;
  IF primary_rows < holdings_with_account THEN
    RAISE NOTICE 'holding_accounts backfill: % holdings have account_id set but only % distinct holdings have is_primary rows', holdings_with_account, primary_rows;
  END IF;
END $$;

COMMIT;

-- Post-migration verification:
--   SELECT COUNT(*) FROM holding_accounts;
--   SELECT COUNT(*) FROM portfolio_holdings WHERE account_id IS NOT NULL;
--   -- (the two counts should match for a freshly-migrated env; on a
--   -- subsequent run they may diverge if the user has added pairings.)
