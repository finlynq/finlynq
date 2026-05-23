/**
 * Lot-tracked cost basis — pure depletion engine.
 *
 * No DB I/O. Takes inputs (existing lots, the close-tx row, optional
 * cash-leg hint) and returns:
 *   - a list of closure rows to insert (HoldingLotClosure shape with id=0)
 *   - per-lot qty-remaining deltas to apply
 *
 * Wired to the DB layer by src/lib/portfolio/lots/write-hooks.ts.
 *
 * Load-bearing invariants honored here (see plan/portfolio-lots-and-performance.md):
 *
 *   #96   paired cash-leg substitution — `openLotForBuy(stockLeg, cashLegHint?)`
 *         takes the optional cash leg; when present, the lot's
 *         `cost_per_share` is `ABS(cashLeg.entered_amount) / stockLeg.quantity`
 *         in `cashLeg.entered_currency` (the holding's currency, by
 *         construction of how the import paths pair them).
 *
 *   #128  sell-branch cash-leg skip — `closeLotsForSell` early-returns
 *         when the close-tx is itself a paired cash leg (qty=0 or
 *         trade_link_id IS NOT NULL AND amount == 0). The stock leg is
 *         the only row that drives lot depletion.
 *
 *   #84   dividend-by-category — `openLotForBuy` accepts a
 *         `categoryIsDividend` flag. When true AND qty>0, the lot is
 *         opened with origin='reinvest_div'; the cash dividend row
 *         (qty=0, category=Dividends) never reaches this function
 *         because the caller filters on `qty != 0`.
 *
 *   #236  no amount<0 prefilter — lot opening keys on `qty > 0`, not
 *         `amount > 0`. WP-imported buys with `amt>0, qty>0` open lots
 *         cleanly.
 */

import type {
  CashLegHint,
  HoldingLot,
  HoldingLotClosure,
  LotClosurePlan,
  LotOrigin,
  TxRowForLots,
} from "./types";

// ─── InvalidLinkPairError ────────────────────────────────────────────────
//
// Raised when the engine encounters a link_id pair that doesn't match any
// of the two valid shapes:
//   (a) same portfolio_holding_id on both legs → in-kind transfer
//   (b) both legs reference is_cash=TRUE sleeves → FX conversion
// Anything else (stock paired with a different stock, stock paired with a
// cash sleeve, etc.) gets this error. Callers should let it propagate so
// the user sees a clear refusal rather than silent corruption (a
// transfer_in lot on the wrong holding).

export interface InvalidLinkPairErrorContext {
  sourceTxId: number | string;
  destTxId: number | string;
  sourceHoldingId: number | null;
  destHoldingId: number | null;
  reason: string;
}

export class InvalidLinkPairError extends Error {
  readonly code = "invalid_link_pair" as const;
  readonly context: InvalidLinkPairErrorContext;
  constructor(context: InvalidLinkPairErrorContext) {
    super(
      `InvalidLinkPairError: ${context.reason} ` +
        `(source tx=${context.sourceTxId} holding=${context.sourceHoldingId}, ` +
        `dest tx=${context.destTxId} holding=${context.destHoldingId})`,
    );
    this.name = "InvalidLinkPairError";
    this.context = context;
  }
}

// ─── openLotForBuy ────────────────────────────────────────────────────────

export interface OpenLotPlan {
  /** Insert-shape: id=0 placeholder, fxToUsdAtOpen optional. */
  lot: Omit<HoldingLot, "id" | "status" | "qtyRemaining"> & {
    qtyRemaining: number;
  };
}

export interface OpenLotForBuyInput {
  tx: TxRowForLots;
  /** Optional paired cash-leg for multi-currency trades (issue #96). */
  cashLeg?: CashLegHint;
  /** When true, the row is a dividend reinvestment — origin='reinvest_div'. */
  categoryIsDividend?: boolean;
  /** Holding's reporting currency from portfolio_holdings.currency. */
  holdingCurrency: string;
  /** Snapshot of FX rate (cost-basis currency → USD) at open time; null OK. */
  fxToUsdAtOpen?: number | null;
  /** Origin override (e.g. 'transfer_in', 'backfill'); defaults inferred from tx. */
  originOverride?: LotOrigin;
  /** parent_lot_id for transfer-in legs. */
  parentLotId?: number | null;
}

/**
 * Builds an `OpenLotPlan` from a buy / reinvest_div / transfer_in row.
 *
 * Throws if `tx.quantity` is null or non-positive — the caller is expected
 * to filter on `quantity > 0` before this fires. Throws if
 * `tx.portfolioHoldingId` or `tx.accountId` is null (lots can't be opened
 * without both).
 */
export function openLotForBuy(input: OpenLotForBuyInput): OpenLotPlan {
  const { tx, cashLeg, categoryIsDividend, holdingCurrency } = input;

  if (tx.quantity == null || tx.quantity <= 0) {
    throw new Error(
      `openLotForBuy: tx.id=${tx.id} has non-positive quantity ${tx.quantity}; caller must filter`,
    );
  }
  if (tx.portfolioHoldingId == null) {
    throw new Error(
      `openLotForBuy: tx.id=${tx.id} has null portfolio_holding_id`,
    );
  }
  if (tx.accountId == null) {
    throw new Error(`openLotForBuy: tx.id=${tx.id} has null account_id`);
  }

  // Issue #96: paired cash-leg substitution. When the buy row has a
  // sibling cash leg, the lot's cost basis comes from the cash-leg's
  // entered_amount (broker's actual settlement at IBKR FX). Otherwise we
  // fall back to the stock leg's own entered_amount / amount.
  const costAmount = cashLeg
    ? Math.abs(cashLeg.enteredAmount)
    : Math.abs(tx.enteredAmount ?? tx.amount);

  // The cost currency is the cash leg's entered_currency when present,
  // else the stock leg's entered_currency, else its account currency.
  // Both legs of a paired trade are expected to be in the holding's
  // currency by construction (issue #129 normalization). The metrics
  // layer FX-converts at read time if they're not.
  const costCurrency =
    cashLeg?.enteredCurrency ??
    cashLeg?.currency ??
    tx.enteredCurrency ??
    tx.currency ??
    holdingCurrency;

  const costPerShare = costAmount / tx.quantity;

  let origin: LotOrigin;
  if (input.originOverride) {
    origin = input.originOverride;
  } else if (categoryIsDividend) {
    origin = "reinvest_div";
  } else {
    origin = "buy";
  }

  return {
    lot: {
      userId: tx.userId,
      holdingId: tx.portfolioHoldingId,
      accountId: tx.accountId,
      openTxId: tx.id,
      openDate: tx.date,
      qtyOriginal: tx.quantity,
      qtyRemaining: tx.quantity,
      costPerShare,
      currency: costCurrency,
      fxToUsdAtOpen: input.fxToUsdAtOpen ?? null,
      origin,
      parentLotId: input.parentLotId ?? null,
      source: tx.source,
    },
  };
}

// ─── closeLotsForSell ─────────────────────────────────────────────────────

export interface CloseLotsResult {
  closures: Array<Omit<HoldingLotClosure, "id">>;
  /**
   * Per-lot decrement to apply to `qty_remaining`. Keyed by lot id; the
   * write-hook layer turns this into a single UPDATE per lot.
   */
  qtyDeltas: Map<number, number>;
  /** Lots whose qty_remaining reaches 0 and should be set to status='closed'. */
  closedLotIds: number[];
}

export interface CloseLotsForSellInput {
  /** The sell transaction (qty<0). */
  tx: TxRowForLots;
  /** Plan from selectLotsToClose() — the engine consumes its `legs`. */
  plan: LotClosurePlan;
  /** Optional paired cash-leg for multi-currency sells (issue #96). */
  cashLeg?: CashLegHint;
  /** Holding's reporting currency from portfolio_holdings.currency. */
  holdingCurrency: string;
  /** Snapshot of qty_remaining for each lot mentioned in plan.legs. */
  lotsById: Map<number, HoldingLot>;
}

/**
 * Builds the closure rows + qty deltas for a sell.
 *
 * Issue #128: when `tx` is itself a paired cash leg
 * (`trade_link_id != null AND amount == 0`), this is a no-op — the stock
 * leg is the only row that drives lot depletion.
 *
 * Throws if `plan.success=false` — the caller decides whether to skip
 * the close entirely (transitional rollouts where backfill is partial)
 * or surface an error.
 */
export function closeLotsForSell(input: CloseLotsForSellInput): CloseLotsResult {
  const { tx, plan, cashLeg, holdingCurrency, lotsById } = input;

  // Issue #128: paired cash-leg sell. The stock leg captures the trade
  // economics; this row contributes nothing. The aggregator excludes it
  // from the realized-gain branch via the same predicate.
  if (tx.tradeLinkId != null && (tx.amount === 0 || tx.quantity === 0)) {
    return { closures: [], qtyDeltas: new Map(), closedLotIds: [] };
  }

  if (!plan.success) {
    throw new Error(
      `closeLotsForSell: plan.success=false (shortfall=${plan.shortfall}); ` +
        `caller must decide whether to skip or error`,
    );
  }

  if (tx.quantity == null) {
    throw new Error(
      `closeLotsForSell: tx.id=${tx.id} has null quantity`,
    );
  }
  const sellQty = Math.abs(tx.quantity);
  if (sellQty <= 0) {
    return { closures: [], qtyDeltas: new Map(), closedLotIds: [] };
  }

  // Issue #96: paired sell uses the cash-leg's entered_amount as
  // proceeds, NOT the stock leg's amount. Matches the buy-branch
  // substitution in openLotForBuy so cost basis and proceeds are both
  // booked at the broker's actual FX rate.
  const proceedsAmount = cashLeg
    ? Math.abs(cashLeg.enteredAmount)
    : Math.abs(tx.enteredAmount ?? tx.amount);
  const proceedsCurrency =
    cashLeg?.enteredCurrency ??
    cashLeg?.currency ??
    tx.enteredCurrency ??
    tx.currency ??
    holdingCurrency;
  const proceedsPerShare = sellQty > 0 ? proceedsAmount / sellQty : 0;

  const closures: Array<Omit<HoldingLotClosure, "id">> = [];
  const qtyDeltas = new Map<number, number>();
  const closedLotIds: number[] = [];

  for (const leg of plan.legs) {
    const lot = lotsById.get(leg.lotId);
    if (!lot) {
      throw new Error(
        `closeLotsForSell: plan references unknown lot id=${leg.lotId}`,
      );
    }
    const realizedGain = (proceedsPerShare - leg.costPerShare) * leg.qty;
    const daysHeld = daysBetween(leg.openDate, tx.date);
    closures.push({
      userId: tx.userId,
      lotId: leg.lotId,
      closeTxId: tx.id,
      closeDate: tx.date,
      qtyClosed: leg.qty,
      proceedsPerShare,
      costPerShare: leg.costPerShare,
      realizedGain,
      currency: proceedsCurrency,
      daysHeld,
      closeKind: "sell",
      source: tx.source,
    });
    qtyDeltas.set(leg.lotId, (qtyDeltas.get(leg.lotId) ?? 0) + leg.qty);
    if (lot.qtyRemaining - leg.qty <= 1e-9) {
      closedLotIds.push(leg.lotId);
    }
  }

  return { closures, qtyDeltas, closedLotIds };
}

// ─── transferLot — close source lot, open dest lot inheriting cost ───────

export interface TransferLotResult {
  closures: Array<Omit<HoldingLotClosure, "id">>;
  destLots: Array<Omit<HoldingLot, "id" | "status">>;
  qtyDeltas: Map<number, number>;
  closedLotIds: number[];
}

export interface TransferLotInput {
  sourceTx: TxRowForLots; // qty<0 leg
  destTx: TxRowForLots;   // qty>0 leg (matched by createTransferPair)
  /** Source-side lots, FIFO order. */
  sourceLots: HoldingLot[];
  /** Holding's reporting currency. */
  holdingCurrency: string;
}

/**
 * In-kind transfer (issue load-bearing: transfer-pair carryover).
 *
 * Walks the source-side open lots in FIFO order until `|destTx.quantity|`
 * shares have been transferred. For each consumed source lot:
 *   - Writes a closure row with close_kind='transfer_out', realized_gain=0,
 *     proceeds_per_share=cost_per_share (no realization).
 *   - Opens a corresponding dest lot with origin='transfer_in',
 *     parent_lot_id=source.id, open_date=source.open_date (NOT the
 *     transfer date — load-bearing for tax-lot age), cost_per_share =
 *     source.cost_per_share.
 *
 * Partial transfers (`|destTx.quantity| < sum(source qty_remaining)`)
 * only close enough source lots to match; the remainder stays open.
 */
export function transferLot(input: TransferLotInput): TransferLotResult {
  const { sourceTx, destTx, sourceLots, holdingCurrency } = input;

  if (destTx.quantity == null || destTx.quantity <= 0) {
    throw new Error(
      `transferLot: destTx.id=${destTx.id} has non-positive quantity ${destTx.quantity}`,
    );
  }
  if (destTx.portfolioHoldingId == null || destTx.accountId == null) {
    throw new Error(
      `transferLot: destTx.id=${destTx.id} missing holdingId or accountId`,
    );
  }

  // 2026-05-25 portfolio ops Phase 1 — engine-level guard. In-kind
  // transfers are only valid when both legs reference the SAME
  // portfolio_holding_id (e.g., VTI in TFSA → VTI in RRSP, cost basis
  // carries over). A pair with different holdings (AAPL → MSFT,
  // AAPL → USD-cash sleeve, etc.) is not a transfer — it's a swap or a
  // sell, which the write-hook layer should route through
  // closeLotsForSell + openLotForBuy instead. Refusing here is
  // defense-in-depth: the new form layer can't produce different-holding
  // pairs, but legacy/API/MCP callers might, and we want loud refusal
  // rather than silent transfer_in lots on the wrong holding.
  if (sourceTx.portfolioHoldingId != null && destTx.portfolioHoldingId != null) {
    if (sourceTx.portfolioHoldingId !== destTx.portfolioHoldingId) {
      throw new InvalidLinkPairError({
        sourceTxId: sourceTx.id,
        destTxId: destTx.id,
        sourceHoldingId: sourceTx.portfolioHoldingId,
        destHoldingId: destTx.portfolioHoldingId,
        reason:
          "In-kind transfer requires the same portfolio_holding_id on both legs. " +
          "For different holdings, use a swap (sell + buy) or stock→cash sell instead.",
      });
    }
  }

  const ordered = sourceLots
    .filter((l) => l.status === "open" && l.qtyRemaining > 0)
    .slice()
    .sort(
      (a, b) =>
        a.openDate.localeCompare(b.openDate) || (a.id - b.id),
    );

  const closures: Array<Omit<HoldingLotClosure, "id">> = [];
  const destLots: Array<Omit<HoldingLot, "id" | "status">> = [];
  const qtyDeltas = new Map<number, number>();
  const closedLotIds: number[] = [];

  let remaining = destTx.quantity;
  for (const src of ordered) {
    if (remaining <= 0) break;
    const qty = Math.min(src.qtyRemaining, remaining);
    if (qty <= 0) continue;

    closures.push({
      userId: sourceTx.userId,
      lotId: src.id,
      closeTxId: sourceTx.id,
      closeDate: sourceTx.date,
      qtyClosed: qty,
      proceedsPerShare: src.costPerShare,
      costPerShare: src.costPerShare,
      realizedGain: 0,
      currency: src.currency,
      daysHeld: daysBetween(src.openDate, sourceTx.date),
      closeKind: "transfer_out",
      source: sourceTx.source,
    });

    destLots.push({
      userId: destTx.userId,
      holdingId: destTx.portfolioHoldingId,
      accountId: destTx.accountId,
      openTxId: destTx.id,
      openDate: src.openDate, // inherit
      qtyOriginal: qty,
      qtyRemaining: qty,
      costPerShare: src.costPerShare, // inherit
      currency: src.currency, // inherit; metrics layer FXes to holdingCurrency at read time
      fxToUsdAtOpen: src.fxToUsdAtOpen,
      origin: "transfer_in",
      parentLotId: src.id,
      source: destTx.source,
    });

    qtyDeltas.set(src.id, (qtyDeltas.get(src.id) ?? 0) + qty);
    if (src.qtyRemaining - qty <= 1e-9) {
      closedLotIds.push(src.id);
    }
    remaining -= qty;
  }

  // Note: holdingCurrency parameter unused today — kept for future
  // cross-currency transfers where the dest holding's currency differs
  // from the source holding's currency. Currently both legs are
  // expected to share a holding currency (in-kind transfer of the same
  // security).
  void holdingCurrency;

  return { closures, destLots, qtyDeltas, closedLotIds };
}

// ─── helpers ─────────────────────────────────────────────────────────────

/**
 * Calendar-day delta between two YYYY-MM-DD strings. Returns 0 when
 * `from > to` (defensive — caller is expected to pass open_date <= close_date).
 */
export function daysBetween(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return 0;
  const delta = Math.floor((toMs - fromMs) / 86400000);
  return delta > 0 ? delta : 0;
}
