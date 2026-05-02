-- Multi-currency trade pair linker (issue #96).
--
-- Adds a nullable `trade_link_id text` column to `transactions`. Used to
-- group the two legs of a multi-currency stock trade booked as a *pair*
-- of separate transactions:
--   1. Cash-out leg (qty=0 or NULL, amount<0) on the source account
--   2. Stock-in  leg (qty>0,        amount<0) on the same brokerage account
-- so the four cost-basis aggregators can pull the cash leg's
-- `entered_amount` (the broker's actual settlement at IBKR's FX rate) as
-- the cost basis for the stock leg, instead of the stock leg's own amount
-- (which uses Finlynq's live FX rate and under-counts the spread).
--
-- IMPORTANT — DO NOT REUSE `link_id`:
-- `link_id` is reserved for `record_transfer` siblings under the four-check
-- transfer-pair rule (CLAUDE.md). Trade pairs have looser semantics
-- (single-account, both legs negative, asymmetric quantity) so they live
-- on a separate column.
--
-- Server-generated ONLY: like `link_id`, the UUID is minted by the writer
-- (`record_transaction` / `bulk_record_transactions`); never accepted from
-- a client field.
--
-- Idempotent — safe to re-run. Applied to prod/staging/dev prior to code
-- deploy.

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS trade_link_id text;

CREATE INDEX IF NOT EXISTS idx_transactions_trade_link_id
  ON transactions (user_id, trade_link_id)
  WHERE trade_link_id IS NOT NULL;
