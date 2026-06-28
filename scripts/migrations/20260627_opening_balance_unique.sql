-- FINLYNQ-206 — Opening balance backed by ONE linked transaction.
--
-- The displayed "opening balance" for a cash account is derived ENTIRELY from
-- a single transaction carrying kind='opening_balance' (no accounts column).
-- This migration makes that 1:1 guarantee enforceable:
--
--   1. add 'balance_adjustment' to transactions_kind_check
--   2. re-tag every account that VIOLATES the one-opening-balance-per-account
--      rule (>1 kind='opening_balance' row) so all its opening_balance rows
--      become kind='balance_adjustment'
--   3. create the partial unique index that enforces the rule going forward
--
-- Why step 2 (owner decision, FINLYNQ-206 2026-06-27): every multi-row
-- opening_balance account in prod/dev is an INVESTMENT account — the 20260603
-- backfill stamped kind='opening_balance' on the earliest 'buy' PER HOLDING,
-- so a multi-holding brokerage carries one per holding (e.g. prod acct 612 =
-- 15 distinct rows). v1's opening-balance feature is cash-only and never
-- touches those, but the partial unique index is account-wide (a Postgres
-- partial-index predicate can't reach accounts.is_investment), so it would
-- fail to build over the violating rows. We re-tag ALL of a violating
-- account's opening_balance rows to 'balance_adjustment' — kind-only change:
-- NO rows deleted (the no-programmatic-tx-delete invariant), amounts/quantity/
-- cost-basis untouched, balances byte-identical. Those accounts end with zero
-- opening_balance rows, so the index builds; accounts with exactly one
-- opening_balance row keep it.
--
-- 'balance_adjustment' is added to PAIRLESS_CANONICAL_KINDS in
-- src/lib/portfolio/backfill/types.ts so the re-tagged (pair-less) rows stay
-- canonical to the backfill planner/coverage and are NOT re-proposed.
--
-- The runner in deploy.sh wraps each migration file in a transaction
-- (psql --single-transaction with ON_ERROR_STOP=1); do NOT add BEGIN/COMMIT
-- here. If a step fails the whole file rolls back and the next deploy retries.

-- ─── Step 1: extend transactions_kind_check with 'balance_adjustment' ──────
-- Re-add the constraint from 20260603_opening_balance_kind.sql with one new
-- literal. All previously-allowed values preserved.

ALTER TABLE transactions
  DROP CONSTRAINT IF EXISTS transactions_kind_check;

ALTER TABLE transactions
  ADD CONSTRAINT transactions_kind_check
    CHECK (
      kind IS NULL OR kind IN (
        'buy', 'buy_cash_leg',
        'sell', 'sell_cash_leg',
        'in_kind_transfer_in', 'in_kind_transfer_out',
        'fx_from', 'fx_to', 'fx_fee',
        'portfolio_income', 'portfolio_expense',
        'brokerage_deposit_out', 'brokerage_deposit_in',
        'brokerage_withdrawal_out', 'brokerage_withdrawal_in',
        'dividend', 'interest',
        'opening_balance',
        'balance_adjustment'
      )
    );

-- ─── Step 2: re-tag opening_balance rows on VIOLATING accounts ─────────────
-- A (user_id, account_id) pair "violates" iff it has >1 kind='opening_balance'
-- row. Re-tag ALL of that account's opening_balance rows to balance_adjustment
-- (kind-only; updated_at bumped per the audit-trio invariant). No deletes; no
-- value change. Accounts with exactly one opening_balance row are left alone.

WITH violating AS (
  SELECT user_id, account_id
  FROM transactions
  WHERE kind = 'opening_balance'
    AND account_id IS NOT NULL
  GROUP BY user_id, account_id
  HAVING COUNT(*) > 1
)
UPDATE transactions t
SET kind = 'balance_adjustment',
    updated_at = NOW()
FROM violating v
WHERE t.user_id = v.user_id
  AND t.account_id = v.account_id
  AND t.kind = 'opening_balance';

-- ─── Step 3: enforce one opening_balance per (user, account) ───────────────
-- Partial unique index — the integrity guarantee between the opening-balance
-- field and its single backing transaction. After Step 2 no account has more
-- than one opening_balance row, so this builds cleanly.

CREATE UNIQUE INDEX IF NOT EXISTS transactions_one_opening_balance_per_account
  ON transactions (user_id, account_id)
  WHERE kind = 'opening_balance';
