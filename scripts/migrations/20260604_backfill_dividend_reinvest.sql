-- Phase 2 (backfill DRIP support): add chosen_holding_id column to
-- backfill_proposals so the apply path can read the user's pick for a
-- `dividend_reinvestment` proposal.
--
-- Context (HANDOVER_2026-06-02_BACKFILL_REVIEW_BUGS.md + plan
-- `ok-bug-one-fixed-floofy-hopper.md`): rows that look like dividend
-- reinvestments (DRIP) — category=Dividends, qty>0, qty≈amount, ticker
-- blank — currently have their `portfolio_holding_id` pointing to a
-- cash sleeve or to the wrong stock. They surface as
-- `dividend_reinvestment` proposals in the planner; the user picks the
-- correct underlying stock holding in the two-pane review UI; the apply
-- path UPDATEs portfolio_holding_id to the picked id + stamps
-- kind='dividend' + opens a lot via applyLotEffectsForTx replay.
--
-- Schema change:
-- - Add `chosen_holding_id INTEGER` (nullable) to backfill_proposals.
--   Analogous to the existing `variant_choice TEXT` column used by
--   drift proposals. Apply route refuses with
--   `holding_choice_missing` (mirroring `drift_variant_missing`) when
--   applying a `dividend_reinvestment` proposal with NULL choice.
--
-- The runner in deploy.sh wraps each migration file in a transaction
-- (psql --single-transaction with ON_ERROR_STOP=1); do NOT add
-- BEGIN/COMMIT here.

ALTER TABLE backfill_proposals
  ADD COLUMN IF NOT EXISTS chosen_holding_id INTEGER;

-- Pre-suggested holdings for the picker UI. Planner emits the list of
-- non-cash holdings in the same account as the displaced row; the UI
-- pre-selects the top one and shows the rest as alternatives. Empty
-- array means the user must pick from the full holdings list. INTEGER[]
-- matches portfolio_holdings.id (serial).
ALTER TABLE backfill_proposals
  ADD COLUMN IF NOT EXISTS candidate_holding_ids INTEGER[]
    NOT NULL DEFAULT '{}';

-- Index helps the apply route's per-proposal lookup. Filter to
-- non-null so we don't index the universal "not picked yet" state.
CREATE INDEX IF NOT EXISTS backfill_proposals_chosen_holding_idx
  ON backfill_proposals (chosen_holding_id)
  WHERE chosen_holding_id IS NOT NULL;
