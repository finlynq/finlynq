/**
 * Shared types for the lot-tracked cost-basis engine
 * (plan/portfolio-lots-and-performance.md Phase 1).
 *
 * Kept in their own file so the pure modules (engine.ts, selection.ts,
 * metrics.ts) can be tested without importing the Drizzle schema.
 */

import type { TransactionSource } from "@/lib/tx-source";

/**
 * Origin of an open lot. Mirrors the SQL CHECK enum.
 *
 *   'buy'           direct buy transaction
 *   'reinvest_div'  dividend reinvestment (qty>0 AND category = Dividends)
 *   'transfer_in'   destination leg of an in-kind transfer; parent_lot_id
 *                   points back to the closed-out source lot
 *   'split_adj'     forward split adjustment
 *   'backfill'      written by scripts/backfill-portfolio-lots.ts for
 *                   pre-Phase-1 transactions
 */
export type LotOrigin =
  | "buy"
  | "reinvest_div"
  | "transfer_in"
  | "split_adj"
  | "backfill";

/**
 * Lifecycle of a lot. Mirrors the SQL CHECK enum.
 *
 *   'open'              qty_remaining > 0
 *   'closed'            qty_remaining = 0 via sell
 *   'transferred_out'   full transfer-out leg; closure was written with
 *                       close_kind='transfer_out', realized_gain=0
 */
export type LotStatus = "open" | "closed" | "transferred_out";

/** 'long' (default) or 'short'. Short lots are opened when a Sell
 *  exceeds available long inventory; subsequent Buys close shorts
 *  before opening fresh long lots. */
export type LotSide = "long" | "short";

/**
 * Open lot — `qty_remaining > 0` if status='open'.
 *
 * `cost_per_share` is in `currency` (the holding's currency). The stored
 * value is post-issue-#96 paired-cash-leg substitution: paired
 * multi-currency buys record the cash leg's `entered_amount / qty` here,
 * NOT the stock leg's amount.
 */
export interface HoldingLot {
  id: number;
  userId: string;
  holdingId: number;
  accountId: number;
  openTxId: number;
  openDate: string; // YYYY-MM-DD
  qtyOriginal: number;
  qtyRemaining: number;
  costPerShare: number;
  currency: string;
  fxToUsdAtOpen: number | null;
  origin: LotOrigin;
  parentLotId: number | null;
  status: LotStatus;
  side: LotSide;
  source: TransactionSource;
}

/**
 * Closure row — one per (close_tx, lot) pair.
 *
 * `realized_gain = (proceeds_per_share − cost_per_share) × qty_closed`,
 * in `currency`. Positive = gain, negative = loss. `close_kind='transfer_out'`
 * always has `realized_gain = 0` by construction.
 */
export interface HoldingLotClosure {
  id: number;
  userId: string;
  lotId: number;
  closeTxId: number;
  closeDate: string; // YYYY-MM-DD
  qtyClosed: number;
  proceedsPerShare: number;
  costPerShare: number;
  realizedGain: number;
  currency: string;
  daysHeld: number;
  closeKind:
    | "sell"
    | "transfer_out"
    | "swap_out"
    | "fx_conversion"
    | "income_expense"
    | "buy_sell"
    | "short_open"
    | "short_close";
  source: TransactionSource;
}

/**
 * Lot-selection strategy. Default is FIFO (oldest lots deplete first);
 * HIFO depletes highest-cost lots first to maximize realized losses /
 * minimize realized gains; SPECIFIC requires `lotIds` so the caller
 * picks exactly which lots to close.
 */
export type LotSelectionStrategy = "FIFO" | "HIFO" | "SPECIFIC";

/**
 * Planned depletion of lots to satisfy a sell of `targetQty` shares.
 *
 * `legs` always sums to exactly `targetQty` when `success=true`. If the
 * sum of `qty_remaining` across selectable lots is less than `targetQty`,
 * the result is `{ success: false }` with `shortfall` populated — the
 * caller decides whether to skip writing closures (transitional rollouts
 * where backfill is partial) or surface an error (post-rollout).
 */
export interface LotClosurePlan {
  success: boolean;
  legs: Array<{
    lotId: number;
    qty: number;
    costPerShare: number;
    openDate: string;
    currency: string;
  }>;
  /** Set when `success=false`; difference between targetQty and available qty. */
  shortfall?: number;
  /** Strategy used; echoed for audit logs. */
  strategy: LotSelectionStrategy;
}

// ─── FINLYNQ-176 — lot reallocation preview shapes ───────────────────────
//
// When a user edits/deletes a buy/transfer-in whose opened lot has since
// been consumed by a sell/transfer-out closure, the engine re-plans the
// dependent closures against the post-mutation inventory (re-FIFO; overflow
// opens a short lot) rather than hard-blocking. `planLotReallocation`
// (replan.ts) is the pure core that produces this preview; the DB-bound
// `replanLotsAfterMutation` orchestrator turns it into writes.

/**
 * One dependent closure after re-planning. `lotId` is the lot the closure
 * now lands on; in a preview, a freshly-opened short lot is referenced by a
 * negative placeholder id (`isNewShortLot=true`). `realizedGain` is the
 * NEW realized gain in the closure's currency.
 */
export interface ProposedClosure {
  closeTxId: number;
  lotId: number;
  qtyClosed: number;
  costPerShare: number;
  proceedsPerShare: number;
  realizedGain: number;
  closeKind: HoldingLotClosure["closeKind"];
  /** True when this closure forced a short-lot open (no long inventory left). */
  isNewShortLot: boolean;
  /** YYYY-MM-DD close date — used to bucket the realized-gain delta by year. */
  closeDate: string;
}

/**
 * Result of re-planning the dependent closures of a target tx mutation.
 * Returned by both the dry-run preview path and consumed by the commit
 * path. Empty (all arrays empty, `realizedGainDeltaByYear={}`) when the
 * target tx has no dependent closures (no reallocation needed).
 */
export interface LotReallocationPreview {
  affectedHoldingIds: number[];
  /** The sell/transfer tx ids whose closures get replayed. */
  dependentCloseTxIds: number[];
  proposedClosures: ProposedClosure[];
  openedShortLots: Array<{
    holdingId: number;
    accountId: number;
    qty: number;
    costPerShare: number;
    currency: string;
  }>;
  /** Σ(new realizedGain) − Σ(old realizedGain) bucketed by close_date's
   *  calendar year ("YYYY"). Surfaced in the confirm dialog so the user
   *  sees which years' realized gains restate. Omits zero-delta years. */
  realizedGainDeltaByYear: Record<string, number>;
}

/**
 * Per-(holding, account) metrics returned by computeHoldingMetricsFromLots.
 * Replaces the inline avg-cost computation in the three aggregators.
 *
 * `realizedGainYtd` is the sum of `realized_gain` over closures with
 * `close_date >= <asOfDate's Jan 1>` (Calendar year). Tax-year filtering
 * is independent and lives on the Phase 2 dashboard route, not here.
 *
 * `dividendsYtd` / `dividendsAllTime` are NOT computed from lots — they
 * come from transactions where category_id = (user's Dividends category).
 * The aggregator passes them in via the `dividendsByHoldingAndAccount`
 * map.
 */
export interface PerHoldingMetrics {
  holdingId: number;
  accountId: number;
  qty: number;
  costBasis: number;
  unrealizedGain: number;
  marketValue: number;
  realizedGainYtd: number;
  realizedGainAllTime: number;
  dividendsYtd: number;
  dividendsAllTime: number;
  /** Holding's currency. */
  currency: string;
  /** Oldest open_date across the user's lots for this (holding, account). */
  firstPurchaseDate: string | null;
  /** Days from firstPurchaseDate to asOfDate; null when firstPurchaseDate is null. */
  daysHeld: number | null;
}

/**
 * Hint passed by import / approve / MCP paths that have already paired a
 * trade's stock leg with its cash leg (via `trade_link_id`). When set,
 * the lot's `cost_per_share` is computed from `cashLeg.entered_amount /
 * stockLeg.quantity` rather than `stockLeg.amount / stockLeg.quantity`.
 *
 * The map is shared between the live write-hooks and the backfill so
 * the same #96 substitution applies. Helper at
 * `src/lib/portfolio/lots/cash-leg.ts::buildCashLegMap`.
 */
export interface CashLegHint {
  enteredAmount: number;
  enteredCurrency: string | null;
  amount: number;
  currency: string;
  tradeLinkId: string;
}

/**
 * Minimal shape of a transactions row needed by the lot-write hooks.
 * Avoids pulling the full Drizzle inferred type to keep the engine
 * portable across the runtime + test paths.
 */
export interface TxRowForLots {
  id: number;
  userId: string;
  date: string;
  amount: number;
  currency: string;
  enteredAmount: number | null;
  enteredCurrency: string | null;
  quantity: number | null;
  accountId: number | null;
  categoryId: number | null;
  portfolioHoldingId: number | null;
  tradeLinkId: string | null;
  source: TransactionSource;
  /**
   * Portfolio-ops discriminator (Phase 1 of the 2026-05-25 refactor).
   * Optional because legacy callers (pre-Phase-1 rows, backfill scripts)
   * don't carry it. Used by `applyLotEffectsForTx` to skip rows that are
   * `*_cash_leg` siblings — those are paired with their stock leg, which
   * is the one that drives the lot write.
   */
  kind?: string | null;
}
