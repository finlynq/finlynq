-- Migration: drop user scoping from price_cache
--
-- Market data (Yahoo Finance, CoinGecko) is identical across users, so the
-- cache is conceptually global. Before this change the table had user_id
-- NOT NULL, but no write path ever supplied a user_id — every insert failed
-- inside a silent try/catch, leaving the cache permanently empty on all
-- environments. Dropping user_id lets writes succeed and makes the table
-- actually useful as a shared read-through cache.
--
-- Idempotent. Safe to re-run.
--
-- Apply before deploying code that removes user_id from the Drizzle schema,
-- so that `npm run db:push` sees no drift:
--
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-price-cache-global.sql
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-price-cache-global.sql
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-price-cache-global.sql

BEGIN;

-- Existing rows may be duplicated per (symbol, date) because the old schema
-- kept a copy per user_id. Collapse to one row per (symbol, date) — keep the
-- highest id (most recently inserted, so freshest price).
DELETE FROM price_cache a
USING price_cache b
WHERE a.id < b.id
  AND a.symbol = b.symbol
  AND a.date = b.date;

DROP INDEX IF EXISTS idx_price_cache_user_id;

ALTER TABLE price_cache DROP COLUMN IF EXISTS user_id;

CREATE INDEX IF NOT EXISTS idx_price_cache_symbol_date ON price_cache (symbol, date);

COMMIT;
