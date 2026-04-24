-- Groups multi-leg transactions so the UI can show siblings of a transfer /
-- same-account conversion / liquidation as linked pairs. Populated by the
-- WealthPosition ZIP importer (every #SPLIT# group shares one link_id) and
-- safe to set manually via the transactions API. Nullable so existing rows
-- and single-leg imports continue to have no group.
--
-- Idempotent — safe to re-run. Applied to prod/staging/dev prior to code
-- deploy so `npm run db:push` sees no drift.

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS link_id text;

CREATE INDEX IF NOT EXISTS idx_transactions_link_id
  ON transactions (link_id)
  WHERE link_id IS NOT NULL;
