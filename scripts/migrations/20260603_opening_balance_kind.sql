-- Re-tag legacy opening-balance rows from kind='buy' to kind='opening_balance'
-- + extend transactions_kind_check to accept the full PAIRLESS_CANONICAL_KINDS set.
--
-- Context (HANDOVER_2026-06-02_BACKFILL_REVIEW_BUGS.md):
-- The first-pass backfill pipeline (commits e3487de → 92ed3a6) stamped
-- `kind='buy'` on rows surfaced as opening_balance proposals. That created
-- predicate divergence between the planner's `isAlreadyCanonical` (any
-- non-null kind = canonical) and the coverage endpoint's stricter rule
-- (kind + pair-less kind OR trade_link_id OR link_id). Symptom: coverage
-- reported N pending while planner returned 0 proposals.
--
-- Resolution: introduce 'opening_balance' as a distinct kind literal so
-- planner + coverage agree on canonical shape. While we're touching the
-- constraint, also add 'dividend' and 'interest' — both are in the
-- planner's PAIRLESS_CANONICAL_KINDS but were never in the CHECK enum
-- (latent bug: applying a dividend proposal would have failed the same
-- way opening_balance did, just hadn't been hit yet on dev).
--
-- Safety: we ONLY re-tag rows where the kind='buy' row is the EARLIEST
-- transaction for its (portfolio_holding_id, account_id) pair. This is
-- the same heuristic the planner uses in `isFirstTxForHolding`. A
-- kind='buy' row that is NOT the earliest for its holding is genuinely
-- a broken pair (no trade_link_id, no cash leg) — leaving it as 'buy'
-- means the next planner run will surface it as orphan_stock_leg, which
-- is correct.
--
-- Additional guard: limited to investment accounts only.
--
-- The runner in deploy.sh wraps each migration file in a transaction
-- (psql --single-transaction with ON_ERROR_STOP=1); do NOT add
-- BEGIN/COMMIT here. If a step below fails, the whole file rolls back
-- and schema_migrations is not updated, so the next deploy retries.

-- ─── Step 1: extend transactions_kind_check ───────────────────────────
-- Drop the constraint defined by 20260526_brokerage_deposit_withdrawal.sql
-- and re-add it with three additions: 'dividend', 'interest',
-- 'opening_balance'. All previously-allowed values preserved.

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
        'opening_balance'
      )
    );

-- ─── Step 2: re-tag legacy opening-balance rows ───────────────────────

WITH earliest_per_holding AS (
  SELECT
    t.id,
    ROW_NUMBER() OVER (
      PARTITION BY t.portfolio_holding_id, t.account_id
      ORDER BY t.date ASC, t.id ASC
    ) AS rn
  FROM transactions t
  JOIN accounts a ON a.id = t.account_id
  WHERE t.kind = 'buy'
    AND t.trade_link_id IS NULL
    AND t.link_id IS NULL
    AND t.portfolio_holding_id IS NOT NULL
    AND t.account_id IS NOT NULL
    AND a.is_investment = true
)
UPDATE transactions
SET kind = 'opening_balance',
    updated_at = NOW()
WHERE id IN (
  SELECT id FROM earliest_per_holding WHERE rn = 1
);
