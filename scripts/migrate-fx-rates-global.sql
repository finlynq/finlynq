-- Migration: drop user scoping from fx_rates
--
-- FX rates (USD->CAD, EUR->CAD, etc.) are identical across users — Yahoo
-- Finance returns the same number regardless of who asks. Before this change
-- the table had user_id NOT NULL and the code worked around it by writing
-- with DEFAULT_USER_ID as a fallback. Dropping user_id removes the workaround
-- and makes fx_rates a true shared global cache (same shape as price_cache
-- after migrate-price-cache-global.sql).
--
-- Idempotent. Safe to re-run.
--
-- Apply before deploying code that removes user_id from the Drizzle schema,
-- so that `npm run db:push` sees no drift:
--
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-fx-rates-global.sql
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-fx-rates-global.sql
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-fx-rates-global.sql

BEGIN;

-- Existing rows may be duplicated per (from_currency, to_currency, date)
-- because the old schema kept a copy per user_id. Collapse to one row per
-- (from, to, date) — keep the highest id (most recently inserted, so freshest
-- rate).
DELETE FROM fx_rates a
USING fx_rates b
WHERE a.id < b.id
  AND a.from_currency = b.from_currency
  AND a.to_currency = b.to_currency
  AND a.date = b.date;

DROP INDEX IF EXISTS idx_fx_rates_user_id;

ALTER TABLE fx_rates DROP COLUMN IF EXISTS user_id;

CREATE INDEX IF NOT EXISTS idx_fx_rates_pair_date ON fx_rates (from_currency, to_currency, date);

COMMIT;
