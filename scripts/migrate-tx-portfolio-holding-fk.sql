-- transactions.portfolio_holding_id (2026-04-26)
--
-- Phase 1 of the holding-FK rollout. Adds a nullable integer FK column on
-- transactions referencing portfolio_holdings(id). The existing encrypted
-- text column transactions.portfolio_holding stays in place — Phase 2-4
-- dual-write both, Phase 5 (separate later deploy) NULLs out plaintext on
-- backfilled rows and drops portfolio_holding from TX_ENCRYPTED_FIELDS.
--
-- Why FK at all: portfolio_holdings.name is encrypted (Stream D), so the
-- aggregator currently decrypts every tx in memory and groups by plaintext
-- name. That's O(N) AES-GCM per page load and it orphans transactions when
-- a holding is renamed. An integer FK fixes both — SQL GROUP BY runs on
-- plaintext metadata, and renames cascade automatically.
--
-- ON DELETE SET NULL: cascading delete to transactions would destroy data;
-- restricting the delete would block the existing /portfolio "delete a
-- holding" flow. SET NULL is no worse than today (deleted holdings already
-- orphan their txs in the aggregator).
--
-- All statements are idempotent — safe to re-run on any env. The FK
-- constraint is introspected by (table, column) in pg_constraint rather
-- than by name, because drizzle-kit push generates a constraint with its
-- own auto-derived name (transactions_portfolio_holding_id_portfolio_holdings_id_fk)
-- while a hand-written ALTER would default to ..._fkey. Same pattern as
-- migrate-tx-splits-cascade.sql.
--
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-tx-portfolio-holding-fk.sql
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-tx-portfolio-holding-fk.sql
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-tx-portfolio-holding-fk.sql

BEGIN;

-- 1. New nullable FK column on transactions.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS portfolio_holding_id integer;

-- 2. FK constraint — only add if NOT already present on (transactions,
--    portfolio_holding_id) → portfolio_holdings. Tolerates either ordering:
--    db:push created its drizzle-named one, or this migration creating one
--    first. Either way the constraint exists at the end with ON DELETE SET NULL.
DO $$
DECLARE
  existing_conname text;
  existing_deltype "char";
BEGIN
  SELECT c.conname, c.confdeltype
    INTO existing_conname, existing_deltype
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_class r ON r.oid = c.confrelid
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
  WHERE c.contype = 'f'
    AND t.relname = 'transactions'
    AND r.relname = 'portfolio_holdings'
    AND a.attname = 'portfolio_holding_id';

  IF existing_conname IS NULL THEN
    -- No FK yet (this run beat db:push). Create our own.
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_portfolio_holding_id_fkey
      FOREIGN KEY (portfolio_holding_id)
      REFERENCES portfolio_holdings(id)
      ON DELETE SET NULL;
  ELSIF existing_deltype <> 'n' THEN
    -- Exists but not SET NULL ('n'). Drop + recreate with SET NULL.
    EXECUTE format('ALTER TABLE transactions DROP CONSTRAINT %I', existing_conname);
    EXECUTE format(
      'ALTER TABLE transactions ADD CONSTRAINT %I FOREIGN KEY (portfolio_holding_id) REFERENCES portfolio_holdings(id) ON DELETE SET NULL',
      existing_conname
    );
  END IF;
END $$;

-- 3. Partial index for the per-user JOIN/GROUP BY hot path. Most txs don't
--    have a portfolio_holding_id (only investment txs do), so partial keeps
--    the index small.
CREATE INDEX IF NOT EXISTS transactions_user_portfolio_holding_id_idx
  ON transactions (user_id, portfolio_holding_id)
  WHERE portfolio_holding_id IS NOT NULL;

-- 4. UNIQUE partial index on portfolio_holdings — prevents the resolver
--    from creating duplicate (account, name) pairs under concurrent imports.
--    Stream D already created portfolio_holdings_user_name_lookup_idx as
--    NON-unique on (user_id, name_lookup) because the same NAME can exist
--    across different brokerage accounts (e.g. "Cash" in TFSA and "Cash"
--    in RRSP). This new index scopes to (user, account, name_lookup) and
--    IS unique, which is what we actually want for the resolver.
CREATE UNIQUE INDEX IF NOT EXISTS portfolio_holdings_user_account_lookup_uniq
  ON portfolio_holdings (user_id, account_id, name_lookup)
  WHERE name_lookup IS NOT NULL AND account_id IS NOT NULL;

COMMIT;
