-- FINLYNQ-204: intraday price refresh — give "today's" price_cache row a 30-min TTL.
--
-- Adds `fetched_at` so the read paths can tell when a today-dated cache row was
-- last refreshed from the upstream quote API (Yahoo / CoinGecko). A today-row
-- older than PRICE_CACHE_TODAY_TTL_MS (30 min) is treated as stale and lazily
-- re-fetched on read; historical rows (date != today) stay immutable forever.
--
-- Additive + non-destructive: existing rows backfill to now(), so they read as
-- fresh for 30 minutes after deploy and then refresh on next access. Auto-applied
-- by deploy.sh (tracked migration). The (symbol, date) index is NON-unique and
-- prod already has duplicate (symbol, date) rows, so the refresh write is an
-- explicit UPDATE ... WHERE symbol=? AND date=? (never an ON CONFLICT upsert).

ALTER TABLE price_cache
  ADD COLUMN IF NOT EXISTS fetched_at TIMESTAMPTZ NOT NULL DEFAULT now();
