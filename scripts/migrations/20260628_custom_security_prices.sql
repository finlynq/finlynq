-- Manual / custom pricing for user-defined securities.
-- Plan: finlynq-cloud/app-plan/architecture/securities.md (manual-price model).
--
-- Adds:
--   1. securities.price_source ('auto' | 'manual') — the per-security flag that
--      excludes a security from the Yahoo/CoinGecko price API and routes its
--      valuation through the custom_security_prices marks instead. Default
--      'auto' so every existing security is byte-identical.
--   2. custom_security_prices — per-user effective-from price marks, keyed by
--      security_id. The "effective price at date D" is the row with the latest
--      date <= D (forward-fill); before the first mark the holding values at 0.
--
-- Fully additive + idempotent. price is a plain number (no DEK / encryption),
-- so the read/write paths are DEK-free.

ALTER TABLE securities
  ADD COLUMN IF NOT EXISTS price_source TEXT NOT NULL DEFAULT 'auto';

-- Widen-safe CHECK (only added if not already present).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'securities_price_source_check'
  ) THEN
    ALTER TABLE securities
      ADD CONSTRAINT securities_price_source_check
      CHECK (price_source IN ('auto', 'manual'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS custom_security_prices (
  id          SERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL,
  security_id INTEGER NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,                 -- YYYY-MM-DD, effective-from
  price       DOUBLE PRECISION NOT NULL,     -- in the security's currency
  currency    TEXT NOT NULL,                 -- = securities.currency
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One mark per (user, security, date). Backs the POST upsert (ON CONFLICT).
CREATE UNIQUE INDEX IF NOT EXISTS custom_security_prices_user_sec_date_idx
  ON custom_security_prices (user_id, security_id, date);
CREATE INDEX IF NOT EXISTS custom_security_prices_user_sec_idx
  ON custom_security_prices (user_id, security_id);
