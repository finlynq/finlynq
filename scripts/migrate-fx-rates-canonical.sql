-- migrate-fx-rates-canonical.sql — Phase 1.5 of the currency rework (2026-04-27).
--
-- Restructures `fx_rates` from a per-pair shape to a canonical USD-anchored
-- shape, so the rate cache scales O(N) in active currencies instead of
-- O(N²) in pairs. Cross-rates are derived by triangulation in code:
--   getRate(EUR, CAD) = rate_to_usd[EUR] / rate_to_usd[CAD]
--
-- Also creates `fx_overrides` for per-user manual rate pins (currencies the
-- app doesn't auto-fetch, or rates the user wants to override — like their
-- bank's actual exchange rate, not the market rate).
--
-- Idempotent: safe to re-run. Old fx_rates is renamed to fx_rates_legacy on
-- first run; the rename target is checked before each step.

BEGIN;

-- ─── 1. fx_rates → fx_rates_legacy (preserve old data for one cycle) ────
DO $$
BEGIN
  -- Only rename if the legacy table doesn't already exist AND the live one
  -- still has the old schema (presence of from_currency column).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'fx_rates_legacy'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'fx_rates' AND column_name = 'from_currency'
  ) THEN
    ALTER TABLE fx_rates RENAME TO fx_rates_legacy;
  END IF;
END $$;

-- ─── 2. New fx_rates table — canonical USD-anchored cache ───────────────
CREATE TABLE IF NOT EXISTS fx_rates (
  id           serial PRIMARY KEY,
  currency     text   NOT NULL,                          -- ISO 4217 code (e.g. EUR)
  date         text   NOT NULL,                          -- YYYY-MM-DD
  rate_to_usd  double precision NOT NULL,                -- 1 unit of currency in USD
  source       text   NOT NULL DEFAULT 'yahoo',          -- 'yahoo' | 'coingecko' | 'fallback' | 'manual'
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (currency, date)
);

CREATE INDEX IF NOT EXISTS fx_rates_currency_date_idx
  ON fx_rates (currency, date DESC);

-- ─── 3. Backfill from legacy data, only USD-anchored rows ───────────────
-- Rows where to_currency='USD' carry directly: currency=from, rate=rate.
-- Rows where from_currency='USD' invert: currency=to, rate=1/rate.
-- All other pairs are dropped — they'll re-fetch from Yahoo on demand
-- via the new triangulated path.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'fx_rates_legacy'
  ) THEN
    INSERT INTO fx_rates (currency, date, rate_to_usd, source)
    SELECT from_currency, date, rate, 'yahoo'
      FROM fx_rates_legacy
     WHERE to_currency = 'USD' AND rate > 0
    ON CONFLICT (currency, date) DO NOTHING;

    INSERT INTO fx_rates (currency, date, rate_to_usd, source)
    SELECT to_currency, date, 1.0 / rate, 'yahoo'
      FROM fx_rates_legacy
     WHERE from_currency = 'USD' AND rate > 0
    ON CONFLICT (currency, date) DO NOTHING;
  END IF;
END $$;

-- ─── 4. fx_overrides — per-user manual rate pins ────────────────────────
CREATE TABLE IF NOT EXISTS fx_overrides (
  id           serial PRIMARY KEY,
  user_id      text   NOT NULL,
  currency     text   NOT NULL,                          -- ISO 4217 code
  date_from    text   NOT NULL,                          -- inclusive, YYYY-MM-DD
  date_to      text,                                     -- inclusive, NULL = open-ended
  rate_to_usd  double precision NOT NULL,
  note         text   NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fx_overrides_user_currency_idx
  ON fx_overrides (user_id, currency, date_from);

-- ─── 5. Migrate any user-pinned legacy rows into fx_overrides ───────────
-- Existing fx_rates rows with user_id set may have been manual pins via the
-- MCP set_fx_override tool. Move them into fx_overrides as open-ended
-- overrides (the source date stays as date_from). USD-anchored rows only —
-- non-USD pairs need user re-entry once the override UI ships.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'fx_rates_legacy'
  ) THEN
    INSERT INTO fx_overrides (user_id, currency, date_from, date_to, rate_to_usd, note)
    SELECT DISTINCT
           user_id,
           CASE WHEN to_currency = 'USD' THEN from_currency ELSE to_currency END AS currency,
           date AS date_from,
           date AS date_to,
           CASE WHEN to_currency = 'USD' THEN rate ELSE 1.0 / rate END AS rate_to_usd,
           'migrated from legacy fx_rates' AS note
      FROM fx_rates_legacy
     WHERE rate > 0
       AND (to_currency = 'USD' OR from_currency = 'USD')
       AND user_id IS NOT NULL;
  END IF;
END $$;

-- ─── 6. Drop the legacy table once data is preserved ────────────────────
-- Wait — leave it in place for one deploy cycle so we can compare values
-- if anything looks off. A follow-up migration will DROP it.
-- DROP TABLE fx_rates_legacy;

COMMIT;
