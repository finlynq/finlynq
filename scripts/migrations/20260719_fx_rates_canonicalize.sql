-- FINLYNQ-130 — canonicalize the global FX cache.
--
-- The runtime stores one USD-anchored row per (currency, date), but older
-- environments still have the legacy per-pair shape (from_currency,
-- to_currency, rate). Preserve the legacy table, backfill USD-anchored rows,
-- and leave cross-rates to the application triangulation path.
--
-- deploy.sh wraps this file in one transaction and records it in
-- schema_migrations. No BEGIN/COMMIT belongs here.

DO $$
BEGIN
  -- Rename only when the live table is still the legacy per-pair shape. If a
  -- prior operator already preserved it as fx_rates_legacy, this is a no-op.
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'fx_rates_legacy'
  ) AND EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'fx_rates'
       AND column_name = 'from_currency'
  ) THEN
    ALTER TABLE fx_rates RENAME TO fx_rates_legacy;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS fx_rates (
  id           serial PRIMARY KEY,
  currency     text NOT NULL,
  date         text NOT NULL,
  rate_to_usd  double precision NOT NULL,
  source       text NOT NULL DEFAULT 'yahoo',
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (currency, date)
);

CREATE INDEX IF NOT EXISTS fx_rates_currency_date_idx
  ON fx_rates (currency, date DESC);

-- Preserve only USD-anchored legacy rows. Non-USD pairs are derived by
-- triangulation and must not be copied as duplicate canonical facts.
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

CREATE TABLE IF NOT EXISTS fx_overrides (
  id           serial PRIMARY KEY,
  user_id      text NOT NULL,
  currency     text NOT NULL,
  date_from    text NOT NULL,
  date_to      text,
  rate_to_usd  double precision NOT NULL,
  note         text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fx_overrides_user_currency_idx
  ON fx_overrides (user_id, currency, date_from);

-- Preserve legacy user-pinned USD-anchored rows without duplicating an
-- identical override on a re-run or partial prior manual migration.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'fx_rates_legacy'
  ) THEN
    INSERT INTO fx_overrides (user_id, currency, date_from, date_to, rate_to_usd, note)
    SELECT DISTINCT
      legacy.user_id,
      CASE WHEN legacy.to_currency = 'USD' THEN legacy.from_currency ELSE legacy.to_currency END,
      legacy.date,
      legacy.date,
      CASE WHEN legacy.to_currency = 'USD' THEN legacy.rate ELSE 1.0 / legacy.rate END,
      'migrated from legacy fx_rates'
    FROM fx_rates_legacy legacy
    WHERE legacy.user_id IS NOT NULL
      AND legacy.rate > 0
      AND (legacy.to_currency = 'USD' OR legacy.from_currency = 'USD')
      AND NOT EXISTS (
        SELECT 1
          FROM fx_overrides existing
         WHERE existing.user_id = legacy.user_id
           AND existing.currency = CASE WHEN legacy.to_currency = 'USD' THEN legacy.from_currency ELSE legacy.to_currency END
           AND existing.date_from = legacy.date
           AND existing.date_to = legacy.date
      );
  END IF;
END $$;
