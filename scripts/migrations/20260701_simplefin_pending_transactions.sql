-- SimpleFIN pending-transactions snapshot (2026-07-01).
--
-- Holds / not-yet-posted charges from the SimpleFIN feed are NOT imported into
-- the ledger (they're volatile — a hold clears and is re-sent as a distinct
-- posted transaction). Instead we snapshot them here so a future report /
-- notification can surface "you have N pending charges". The table is REFRESHED
-- per-account on every sync (delete + re-insert), so it always reflects the
-- CURRENT set of pending transactions for each synced account.
--
-- payee/description are DEK-encrypted at rest (v1: envelope), like
-- bank_transactions.payee/note; amount/date/currency/fit_id stay plaintext.
CREATE TABLE IF NOT EXISTS simplefin_pending_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id integer REFERENCES accounts(id) ON DELETE CASCADE,
  external_account_id text NOT NULL,
  fit_id text NOT NULL,
  date text NOT NULL DEFAULT '',
  amount double precision NOT NULL,
  currency text NOT NULL,
  payee text,
  description text,
  encryption_tier text NOT NULL DEFAULT 'user',
  synced_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS simplefin_pending_user_account_idx
  ON simplefin_pending_transactions (user_id, account_id);
