-- Kind override on refused `orphan_stock_leg` proposals — adds the
-- four columns the user picks from the override picker in the two-pane
-- review UI.
--
-- Context (plan `one-issue-add-option-majestic-bird.md`):
-- Refused `orphan_stock_leg` proposals (`confidence='refused'`, with a
-- `refusal_reason` like `no_cash_pair_found` / `combined_cash_leg` /
-- `cross_currency_trade` / `unmatched_candidate`) currently render a
-- read-only "Manual fix needed" yellow box. The apply path early-returns
-- with `code='refused_proposal'` so the row is never modified. The user
-- has surfaced multiple times — including the VWRD.L / ADA / SOL rows in
-- HANDOVER_2026-05-24_BACKFILL_ROUNDS_2-4.md — that they want an in-UI
-- override path: pick the canonical kind themselves (opening_balance /
-- dividend / interest / portfolio_income / portfolio_expense for
-- pair-less, or buy / sell / in_kind_transfer / fx / brokerage for
-- paired) and have apply do the right thing.
--
-- Pair-less kinds: apply does UPDATE-in-place on the orphan row and
-- replays `applyLotEffectsForTx`. No counterpart needed.
--
-- Paired kinds: apply mints a fresh trade_link_id or link_id and either
--   (a) links the orphan row to an existing unmatched counterpart row
--       (chosen_counterpart_mode='link_existing',
--        chosen_counterpart_tx_id=<id>), OR
--   (b) synthesizes a brand-new counterpart row tagged
--       source='backfill_synth' (chosen_counterpart_mode='synth_new',
--        chosen_counterpart_tx_id=NULL).
-- The companion `convertExisting*Pair` helpers in
-- pf-app/src/lib/portfolio/operations.ts own the kind-literal writes for
-- the paired kinds — apply.ts itself never writes 'buy' / 'sell' / etc.
-- literally (invariant #8 in pf-app/scripts/audit-invariants.ts).
--
-- `chosen_related_holding_id` carries the underlying stock when the user
-- picks `portfolio_income` / `portfolio_expense` (so the apply path can
-- swap the row onto the matching cash sleeve and stamp the related
-- holding for reporting — mirror of the existing `cash_dividend` branch
-- of `dividend_reinvestment`).
--
-- All four columns nullable. Apply path refuses with `kind_override_missing`
-- when the user APPROVEs an orphan_stock_leg proposal without picking a
-- chosen_kind; refuses with `counterpart_missing` for paired kinds
-- without a counterpart selection.
--
-- The runner in deploy.sh wraps each migration in a transaction
-- (psql --single-transaction with ON_ERROR_STOP=1); do NOT add
-- BEGIN/COMMIT here.

ALTER TABLE backfill_proposals
  ADD COLUMN IF NOT EXISTS chosen_kind TEXT
    CHECK (chosen_kind IS NULL OR chosen_kind IN (
      -- pair-less
      'opening_balance','dividend','interest','portfolio_income','portfolio_expense',
      -- paired (stock + cash)
      'buy','sell',
      -- paired (stock cross-account)
      'in_kind_transfer_in','in_kind_transfer_out',
      -- paired (cash cross-currency)
      'fx_from','fx_to',
      -- paired (cash cross-account)
      'brokerage_deposit_in','brokerage_deposit_out',
      'brokerage_withdrawal_in','brokerage_withdrawal_out'
    ));

ALTER TABLE backfill_proposals
  ADD COLUMN IF NOT EXISTS chosen_counterpart_tx_id INTEGER
    REFERENCES transactions(id) ON DELETE SET NULL;

ALTER TABLE backfill_proposals
  ADD COLUMN IF NOT EXISTS chosen_counterpart_mode TEXT
    CHECK (chosen_counterpart_mode IS NULL OR chosen_counterpart_mode IN (
      'link_existing','synth_new'
    ));

ALTER TABLE backfill_proposals
  ADD COLUMN IF NOT EXISTS chosen_related_holding_id INTEGER
    REFERENCES portfolio_holdings(id) ON DELETE SET NULL;

-- Index helps the apply route's per-proposal counterpart lookup. Filter
-- to non-null so we don't index the universal "no counterpart picked"
-- state. Mirrors the chosen_holding_idx pattern from 20260604.
CREATE INDEX IF NOT EXISTS backfill_proposals_chosen_counterpart_idx
  ON backfill_proposals (chosen_counterpart_tx_id)
  WHERE chosen_counterpart_tx_id IS NOT NULL;
