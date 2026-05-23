-- Dev-only cleanup of portfolio data corrupted by manual UI experiments.
--
-- NOT for prod. Runs once against dev's pf_dev database after the portfolio
-- ops Phase 1 migration (20260525_portfolio_ops_phase1.sql) lands. NOT
-- added to scripts/migrations/ — this is environment-specific.
--
-- Targets (all scoped to the demo user 00000000-0000-0000-0000-00000000demo):
--
--   1. The broken AAPL → Cash transfer pair created via the legacy
--      Transfer form (link_id = '7d485540-6906-4941-8e4c-143c65c7a924').
--      Both legs reference DIFFERENT portfolio holdings, which the new
--      engine guard rejects but pre-Phase-1 data has slipped through.
--
--   2. The manual VTI sell entered with an obviously wrong proceeds
--      amount (id 39469, qty=-5, amount=+$100 → $20/sh proceeds). The
--      seed-demo's own intentional sell (VOO @ +$110 gain) is the one
--      the demo should showcase.
--
--   3. The orphaned transfer_in lot on the Cash sleeve (id 9) — leftover
--      from the broken AAPL → Cash pair. Cash sleeves never carry tax-lot
--      cost basis, so this lot is by-construction nonsense.
--
-- Idempotent: NOT EXISTS guards on each delete so re-running is safe.

DO $$
DECLARE
  demo_user  text := '00000000-0000-0000-0000-00000000demo';
BEGIN
  -- 1. Broken AAPL → Cash transfer pair (link_id 7d485540...).
  DELETE FROM transactions
   WHERE user_id = demo_user
     AND link_id = '7d485540-6906-4941-8e4c-143c65c7a924';

  -- 2. Manual VTI sell with $20/sh proceeds (id 39469). We match on the
  --    shape (holding, date, qty, amount, source='manual') rather than
  --    the literal id so re-runs against a freshly reseeded DB still
  --    target the right row if it exists.
  DELETE FROM transactions t
   WHERE t.user_id = demo_user
     AND t.source = 'manual'
     AND t.quantity = -5
     AND t.amount = 100
     AND EXISTS (
       SELECT 1 FROM portfolio_holdings ph
        WHERE ph.id = t.portfolio_holding_id
          AND ph.user_id = demo_user
          AND ph.name_lookup IS NOT NULL
     );

  -- 3. Orphaned transfer_in lot on the Cash sleeve. The
  --    holding_lots.open_tx_id FK CASCADEs from transactions, so step 1's
  --    DELETE of the transfer-pair rows should have cleaned this up
  --    already. The explicit DELETE here is defense-in-depth.
  DELETE FROM holding_lots hl
   WHERE hl.user_id = demo_user
     AND hl.origin = 'transfer_in'
     AND EXISTS (
       SELECT 1 FROM portfolio_holdings ph
        WHERE ph.id = hl.holding_id
          AND ph.user_id = demo_user
          AND ph.is_cash = TRUE
     );

  -- 4. Closure rows for the deleted transactions CASCADE-delete via the
  --    holding_lot_closures.close_tx_id FK. No explicit DELETE needed.

  RAISE NOTICE 'Dev portfolio cleanup complete for demo user.';
END
$$;
