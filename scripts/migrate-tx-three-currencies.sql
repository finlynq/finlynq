-- migrate-tx-three-currencies.sql — Phase 2 of the currency rework (2026-04-27).
--
-- Adds the entered/account/reporting trilogy to transactions + transaction_splits:
--   entered_amount    — what the user typed in (trade currency)
--   entered_currency  — the user's currency at entry time
--   entered_fx_rate   — rate used to convert to account currency, LOCKED at entry
--   entered_at        — when the row was created (used to detect future-dated)
--
-- The existing `currency` + `amount` columns now carry "account currency" semantics
-- — the settlement amount that affects the account's balance.
--
-- Reporting currency is computed at view time and is NOT stored.
--
-- Cross-currency legacy rows (where transactions.currency != accounts.currency)
-- are flagged in tx_currency_audit so the user can review/convert/keep them
-- without us silently mutating historical balances.
--
-- Idempotent. NOT NULL deferred to a follow-up cutover.

BEGIN;

-- ─── transactions: add entered fields + entered_at ──────────────────────
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS entered_currency text,
  ADD COLUMN IF NOT EXISTS entered_amount   double precision,
  ADD COLUMN IF NOT EXISTS entered_fx_rate  double precision,
  ADD COLUMN IF NOT EXISTS entered_at       timestamptz NOT NULL DEFAULT now();

-- Backfill clean rows: where transactions.currency == accounts.currency,
-- the entered amount is the same as the recorded amount (no conversion needed).
UPDATE transactions t
   SET entered_currency = t.currency,
       entered_amount   = t.amount,
       entered_fx_rate  = 1
  FROM accounts a
 WHERE t.account_id = a.id
   AND t.entered_currency IS NULL
   AND t.currency = a.currency;

-- Backfill orphan rows (no account FK) — same trivial conversion.
UPDATE transactions
   SET entered_currency = currency,
       entered_amount   = amount,
       entered_fx_rate  = 1
 WHERE entered_currency IS NULL
   AND account_id IS NULL;

-- ─── tx_currency_audit: flag pre-existing cross-currency rows ───────────
-- Flag rows where transactions.currency != accounts.currency. These rows
-- have always been ambiguous — they were entered in a different currency
-- than the account, but no rate was ever applied. We don't auto-convert
-- (would mutate balances retroactively); the audit UI lets the user
-- choose Convert / Keep / Edit per row.
CREATE TABLE IF NOT EXISTS tx_currency_audit (
  id                serial PRIMARY KEY,
  transaction_id    integer NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  user_id           text NOT NULL,
  account_currency  text NOT NULL,
  recorded_currency text NOT NULL,
  recorded_amount   double precision NOT NULL,
  flagged_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  resolution        text                                 -- 'converted' | 'kept' | 'edited'
);

CREATE INDEX IF NOT EXISTS tx_currency_audit_user_unresolved_idx
  ON tx_currency_audit (user_id) WHERE resolved_at IS NULL;

INSERT INTO tx_currency_audit (transaction_id, user_id, account_currency, recorded_currency, recorded_amount)
SELECT t.id, t.user_id, a.currency, t.currency, t.amount
  FROM transactions t
  JOIN accounts a ON t.account_id = a.id
 WHERE t.currency <> a.currency
   AND NOT EXISTS (SELECT 1 FROM tx_currency_audit WHERE transaction_id = t.id);

-- After flagging, populate entered fields with the recorded values so reads
-- don't error. The user reviews + resolves later.
UPDATE transactions
   SET entered_currency = currency,
       entered_amount   = amount,
       entered_fx_rate  = 1
 WHERE entered_currency IS NULL;

-- ─── transaction_splits: same fields ────────────────────────────────────
ALTER TABLE transaction_splits
  ADD COLUMN IF NOT EXISTS entered_currency text,
  ADD COLUMN IF NOT EXISTS entered_amount   double precision,
  ADD COLUMN IF NOT EXISTS entered_fx_rate  double precision;

UPDATE transaction_splits ts
   SET entered_currency = (SELECT currency FROM transactions WHERE id = ts.transaction_id),
       entered_amount   = ts.amount,
       entered_fx_rate  = 1
 WHERE ts.entered_currency IS NULL;

COMMIT;
