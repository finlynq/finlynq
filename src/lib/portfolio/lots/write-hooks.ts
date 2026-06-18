/**
 * DB-side write hooks for the lot-tracked cost-basis engine.
 *
 * Wraps the pure engine functions (engine.ts) with the DB I/O required
 * to persist lot rows + closure rows + qty_remaining updates. Every
 * `transactions` INSERT / UPDATE / DELETE site that touches
 * `portfolio_holding_id` must call exactly one of:
 *
 *   - openLotForBuyHook(tx, opts?)            on new buys / reinvested-div / split-adj
 *   - closeLotsForSellHook(tx, opts?)         on new sells
 *   - transferLotHook(sourceTx, destTx)       on in-kind transfer pairs
 *   - reverseLotsForDeleteHook(txId)          on UPDATE (reverse + redo) and DELETE
 *
 * Design choices:
 *
 *   1. Soft-fail by default. The lot-side is gated behind
 *      `portfolio_lots_status.enabled` for READS; WRITES happen
 *      unconditionally so a future flip flips to a populated table. But
 *      lot-side bugs should NOT compromise the underlying transactions
 *      operation — every hook wraps its body in a try/catch and logs the
 *      error rather than re-throwing. Failed lot rows become a TODO for
 *      backfill to reconcile.
 *
 *   2. Cash-leg auto-resolution. When `tx.trade_link_id` is set, we
 *      look up the matching cash-leg sibling (same userId + trade_link_id,
 *      qty=0, different id). Callers that already have the cash leg in
 *      hand (e.g. the import path's per-batch resolver) may pass it
 *      explicitly to skip the SELECT.
 *
 *   3. Dividend classification is the caller's job. The hook accepts a
 *      `categoryIsDividend` flag — set it via
 *      `categoryIsDividendForUser(userId, categoryId, dek)` in
 *      src/lib/dividends-category.ts. Reinvested dividends (qty>0 AND
 *      category=Dividends) open lots; cash dividends (qty=0) don't
 *      reach this hook because the caller filters on qty != 0.
 */

import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import {
  InvalidLinkPairError,
  closeLotsForSell,
  daysBetween,
  openLotForBuy,
  transferLot,
} from "./engine";
import { fxConversionHook, isFxConversionPair, type FxLegInfo } from "./fx-conversion";
import { selectLotsToClose } from "./selection";
import {
  closeCashLotsHook,
  inferCashCloseKind,
  openCashLotHook,
} from "./cash-hooks";
import {
  planLotReallocation,
  planLotReassignment,
  type DependentCloseInput,
} from "./replan";
import type {
  CashLegHint,
  HoldingLot,
  HoldingLotClosure,
  LotReallocationPreview,
  LotSelectionStrategy,
  TxRowForLots,
} from "./types";
import type { TransactionSource } from "@/lib/tx-source";

const HOOK_LABEL = "[portfolio.lots]";

/**
 * Toggle for tests that want to assert lot rows landed. When `true`,
 * write-hook errors throw instead of swallowing. Default `false` keeps
 * production soft-fail behavior. Tests set this via the exported setter.
 */
let strictMode = false;
export function __setLotWriteHookStrictMode(value: boolean): void {
  strictMode = value;
}

function softFail(err: unknown, label: string): void {
  // 2026-05-25 portfolio ops Phase 1 — data-integrity errors propagate.
  // Soft-fail is meant to absorb lot-side bugs that are recoverable via
  // backfill (the lot row didn't land but the underlying tx did, so
  // backfill can reconcile). An InvalidLinkPairError is NOT recoverable:
  // it means the caller created a `link_id` pair that doesn't match any
  // valid shape (in-kind transfer or FX). The user needs to see the
  // refusal so they can fix the input — silent log + soft-fail would
  // produce the exact bug we just patched on dev (AAPL paired with the
  // Cash sleeve via link_id, no lot effects, user sees no realized gain).
  if (err instanceof InvalidLinkPairError) throw err;

  console.error(`${HOOK_LABEL} ${label} failed:`, err);
  if (strictMode) throw err;
}

// ─── cash-leg resolver ───────────────────────────────────────────────────

/**
 * Looks up the paired cash-leg sibling via trade_link_id. Used by both
 * buy and sell hooks for issue #96 substitution. Returns null when the
 * tx has no trade_link_id or no matching sibling exists.
 *
 * Callers with a pre-built map (import-pipeline batch path) can pass the
 * resolved hint directly via the `cashLeg` option on each hook.
 */
export async function resolveCashLegForTx(
  tx: Pick<TxRowForLots, "id" | "userId" | "tradeLinkId">,
): Promise<CashLegHint | null> {
  if (!tx.tradeLinkId) return null;
  const rows = await db
    .select({
      enteredAmount: schema.transactions.enteredAmount,
      enteredCurrency: schema.transactions.enteredCurrency,
      amount: schema.transactions.amount,
      currency: schema.transactions.currency,
      tradeLinkId: schema.transactions.tradeLinkId,
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.userId, tx.userId),
        eq(schema.transactions.tradeLinkId, tx.tradeLinkId),
        ne(schema.transactions.id, tx.id),
        eq(sql`COALESCE(${schema.transactions.quantity}, 0)`, 0),
      ),
    )
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    enteredAmount: Number(r.enteredAmount ?? r.amount),
    enteredCurrency: r.enteredCurrency,
    amount: Number(r.amount),
    currency: r.currency ?? "USD",
    tradeLinkId: tx.tradeLinkId,
  };
}

// ─── openLotForBuyHook ────────────────────────────────────────────────────

export interface OpenLotForBuyHookOpts {
  /** Pre-resolved cash leg (overrides the auto-lookup). */
  cashLeg?: CashLegHint | null;
  /** Whether the row's category is the user's Dividends category (issue #84). */
  categoryIsDividend?: boolean;
  /** Holding's currency from portfolio_holdings.currency. */
  holdingCurrency: string;
  /** Override the origin (transfer_in / backfill / split_adj). */
  origin?: "buy" | "reinvest_div" | "transfer_in" | "split_adj" | "backfill";
  /** parent_lot_id for transfer-in legs / split adjustments. */
  parentLotId?: number | null;
}

/**
 * Persists a single lot row for a buy / reinvested-div / transfer-in.
 *
 * Caller must filter on `tx.quantity != null && tx.quantity > 0` before
 * calling. Returns the inserted lot's id on success; null on soft-fail.
 */
export async function openLotForBuyHook(
  tx: TxRowForLots,
  opts: OpenLotForBuyHookOpts,
): Promise<number | null> {
  try {
    if (tx.portfolioHoldingId == null || tx.accountId == null) return null;
    if (tx.quantity == null || tx.quantity <= 0) return null;

    let cashLeg: CashLegHint | null = opts.cashLeg ?? null;
    if (cashLeg === null && tx.tradeLinkId) {
      cashLeg = await resolveCashLegForTx(tx);
    }

    // Phase 3: short-close-first. If there are open short lots on the
    // same (holding, account), FIFO-close them against this buy before
    // opening a new long lot. Returns the remaining buy qty (may be 0
    // if the buy fully covers existing shorts).
    const buyQty = tx.quantity;
    const cashAmount = cashLeg
      ? Math.abs(cashLeg.enteredAmount)
      : Math.abs(tx.enteredAmount ?? tx.amount);
    const buyPricePerShare = buyQty > 0 ? cashAmount / buyQty : 0;
    const proceedsCurrency =
      cashLeg?.enteredCurrency ??
      cashLeg?.currency ??
      tx.enteredCurrency ??
      tx.currency ??
      opts.holdingCurrency;

    const shortLotRows = await db
      .select()
      .from(schema.holdingLots)
      .where(
        and(
          eq(schema.holdingLots.userId, tx.userId),
          eq(schema.holdingLots.holdingId, tx.portfolioHoldingId),
          eq(schema.holdingLots.accountId, tx.accountId),
          eq(schema.holdingLots.status, "open"),
          eq(schema.holdingLots.side, "short"),
        ),
      );
    const shortLots = shortLotRows.map(rowToLot);
    // FIFO order
    shortLots.sort((a, b) => a.openDate.localeCompare(b.openDate) || a.id - b.id);

    let remaining = buyQty;
    if (shortLots.length > 0) {
      for (const lot of shortLots) {
        if (remaining <= 1e-9) break;
        const qtyToClose = Math.min(lot.qtyRemaining, remaining);
        // Inverse formula: gain when buy_price < short_open cost.
        const realizedGain = (lot.costPerShare - buyPricePerShare) * qtyToClose;
        const daysHeld = daysBetween(lot.openDate, tx.date);
        await db.insert(schema.holdingLotClosures).values({
          userId: tx.userId,
          lotId: lot.id,
          closeTxId: tx.id,
          closeDate: tx.date,
          qtyClosed: qtyToClose,
          proceedsPerShare: buyPricePerShare,
          costPerShare: lot.costPerShare,
          realizedGain,
          currency: proceedsCurrency,
          daysHeld,
          closeKind: "short_close",
          source: tx.source,
        });
        const newRemaining = lot.qtyRemaining - qtyToClose;
        const closed = newRemaining <= 1e-9;
        await db
          .update(schema.holdingLots)
          .set({
            qtyRemaining: newRemaining,
            status: closed ? "closed" : "open",
            updatedAt: sql`NOW()`,
          })
          .where(eq(schema.holdingLots.id, lot.id));
        remaining -= qtyToClose;
      }
    }

    // If the buy fully closed shorts and has nothing left, don't open a long.
    if (remaining <= 1e-9) return null;

    // Open a long lot for the remainder, with cost basis sized to the
    // remaining portion of the cash leg.
    const proratedCashAmount = (cashAmount * remaining) / buyQty;
    const partialTx: TxRowForLots = { ...tx, quantity: remaining };
    const partialCashLeg: CashLegHint | undefined = cashLeg
      ? { ...cashLeg, enteredAmount: proratedCashAmount, amount: proratedCashAmount }
      : undefined;

    const plan = openLotForBuy({
      tx: partialTx,
      cashLeg: partialCashLeg,
      categoryIsDividend: opts.categoryIsDividend,
      holdingCurrency: opts.holdingCurrency,
      originOverride: opts.origin,
      parentLotId: opts.parentLotId,
    });

    const inserted = await db
      .insert(schema.holdingLots)
      .values(plan.lot)
      .returning({ id: schema.holdingLots.id });
    return inserted[0]?.id ?? null;
  } catch (err) {
    softFail(err, `openLotForBuyHook tx=${tx.id}`);
    return null;
  }
}

// ─── closeLotsForSellHook ─────────────────────────────────────────────────

export interface CloseLotsForSellHookOpts {
  strategy?: LotSelectionStrategy; // default FIFO
  /** Specific lot ids when strategy='SPECIFIC'. */
  lotIds?: number[];
  /** Phase 3: per-lot qty overrides. When present, the hook closes
   *  EXACTLY this qty from each named lot (capping at the lot's open
   *  qty + accruing the rest into the overflow → short open). */
  perLotQty?: Array<{ lotId: number; qty: number }>;
  cashLeg?: CashLegHint | null;
  holdingCurrency: string;
}

/**
 * Persists closure rows + updates lot qty_remaining for a sell.
 *
 * No-ops on:
 *   - paired cash-leg sells (issue #128: trade_link_id IS NOT NULL AND
 *     amount == 0 OR quantity == 0)
 *   - rows without a portfolio_holding_id
 *
 * Caller must filter on `tx.quantity != null && tx.quantity < 0` before
 * calling. Returns the number of closure rows written on success; null
 * on soft-fail.
 */
export async function closeLotsForSellHook(
  tx: TxRowForLots,
  opts: CloseLotsForSellHookOpts,
): Promise<number | null> {
  try {
    if (tx.portfolioHoldingId == null || tx.accountId == null) return null;
    if (tx.quantity == null || tx.quantity >= 0) return null;

    // Issue #128 early-out — paired cash-leg sell.
    if (tx.tradeLinkId != null && (tx.amount === 0 || tx.quantity === 0)) {
      return 0;
    }

    const sellQty = Math.abs(tx.quantity);
    const lotRows = await db
      .select()
      .from(schema.holdingLots)
      .where(
        and(
          eq(schema.holdingLots.userId, tx.userId),
          eq(schema.holdingLots.holdingId, tx.portfolioHoldingId),
          eq(schema.holdingLots.accountId, tx.accountId),
          eq(schema.holdingLots.status, "open"),
        ),
      );

    // Phase 3: only LONG lots are closable by a Sell — shorts are closed
    // by Buys via the close-shorts-first path in openLotForBuyHook.
    const allLots: HoldingLot[] = lotRows.map(rowToLot);
    const lots: HoldingLot[] = allLots.filter((l) => l.side === "long");

    let cashLeg: CashLegHint | null = opts.cashLeg ?? null;
    if (cashLeg === null && tx.tradeLinkId) {
      cashLeg = await resolveCashLegForTx(tx);
    }

    const proceedsAmount = cashLeg
      ? Math.abs(cashLeg.enteredAmount)
      : Math.abs(tx.enteredAmount ?? tx.amount);
    const proceedsCurrency =
      cashLeg?.enteredCurrency ??
      cashLeg?.currency ??
      tx.enteredCurrency ??
      tx.currency ??
      opts.holdingCurrency;
    const proceedsPerShare = sellQty > 0 ? proceedsAmount / sellQty : 0;

    // Phase 3 per-lot qty path: when the form sends a {lotId, qty} list,
    // close EXACTLY that qty from each named lot (clamping at the lot's
    // open qty + routing overflow into a single short open).
    if (opts.perLotQty && opts.perLotQty.length > 0) {
      let closuresWritten = 0;
      const lotsById = new Map(allLots.map((l) => [l.id, l]));
      let totalShortOverflow = 0;
      for (const sel of opts.perLotQty) {
        const lot = lotsById.get(sel.lotId);
        if (!lot || lot.side !== "long") {
          totalShortOverflow += sel.qty;
          continue;
        }
        const closeQty = Math.min(lot.qtyRemaining, sel.qty);
        const lotOverflow = Math.max(0, sel.qty - lot.qtyRemaining);
        if (closeQty > 0) {
          const realizedGain = (proceedsPerShare - lot.costPerShare) * closeQty;
          const daysHeld = daysBetween(lot.openDate, tx.date);
          await db.insert(schema.holdingLotClosures).values({
            userId: tx.userId,
            lotId: lot.id,
            closeTxId: tx.id,
            closeDate: tx.date,
            qtyClosed: closeQty,
            proceedsPerShare,
            costPerShare: lot.costPerShare,
            realizedGain,
            currency: proceedsCurrency,
            daysHeld,
            closeKind: "sell",
            source: tx.source,
          });
          const newRemaining = lot.qtyRemaining - closeQty;
          const closed = newRemaining <= 1e-9;
          await db
            .update(schema.holdingLots)
            .set({
              qtyRemaining: newRemaining,
              status: closed ? "closed" : "open",
              updatedAt: sql`NOW()`,
            })
            .where(eq(schema.holdingLots.id, lot.id));
          closuresWritten += 1;
        }
        totalShortOverflow += lotOverflow;
      }
      if (totalShortOverflow > 0) {
        await db.insert(schema.holdingLots).values({
          userId: tx.userId,
          holdingId: tx.portfolioHoldingId,
          accountId: tx.accountId,
          openTxId: tx.id,
          openDate: tx.date,
          qtyOriginal: totalShortOverflow,
          qtyRemaining: totalShortOverflow,
          costPerShare: proceedsPerShare,
          currency: proceedsCurrency,
          fxToUsdAtOpen: null,
          origin: "buy",
          parentLotId: null,
          status: "open",
          side: "short",
          source: tx.source,
        });
      }
      return closuresWritten;
    }

    // Fallback: legacy FIFO / SPECIFIC-by-id path.
    const availableLong = lots.reduce((s, l) => s + l.qtyRemaining, 0);
    const closableQty = Math.min(sellQty, availableLong);
    const overflowQty = Math.max(0, sellQty - availableLong);

    let closuresWritten = 0;

    if (closableQty > 0 && lots.length > 0) {
      const plan = selectLotsToClose({
        strategy: opts.strategy ?? "FIFO",
        lots,
        targetQty: closableQty,
        lotIds: opts.lotIds,
      });
      if (plan.success) {
        const lotsById = new Map(lots.map((l) => [l.id, l]));
        // Override tx.quantity to the closable subset so the engine sizes
        // proceeds against the same shares it's closing. Cost basis math
        // uses Math.abs() so the sign convention is preserved.
        const partialProceeds = (proceedsAmount * closableQty) / sellQty;
        const partialTx: TxRowForLots = {
          ...tx,
          quantity: -closableQty,
          enteredAmount: tx.enteredAmount != null ? -partialProceeds : null,
          amount: -partialProceeds,
        };
        const partialCashLeg: CashLegHint | undefined = cashLeg
          ? { ...cashLeg, enteredAmount: partialProceeds, amount: partialProceeds }
          : undefined;
        const result = closeLotsForSell({
          tx: partialTx,
          plan,
          cashLeg: partialCashLeg,
          holdingCurrency: opts.holdingCurrency,
          lotsById,
        });
        if (result.closures.length > 0) {
          await db.insert(schema.holdingLotClosures).values(result.closures);
          for (const [lotId, delta] of result.qtyDeltas) {
            const lot = lotsById.get(lotId);
            if (!lot) continue;
            const newRemaining = lot.qtyRemaining - delta;
            const closed = newRemaining <= 1e-9;
            await db
              .update(schema.holdingLots)
              .set({
                qtyRemaining: newRemaining,
                status: closed ? "closed" : "open",
                updatedAt: sql`NOW()`,
              })
              .where(eq(schema.holdingLots.id, lotId));
          }
          closuresWritten += result.closures.length;
        }
      } else {

        console.warn(
          `${HOOK_LABEL} closeLotsForSellHook tx=${tx.id} SPECIFIC plan failed (shortfall=${plan.shortfall}); skipping long closure write`,
        );
      }
    }

    if (overflowQty > 0) {
      // Open a short lot for the excess at the sell price. cost_per_share
      // = proceedsPerShare so when a future buy at price P closes this
      // short, realized_gain = (proceeds - P) × qty.
      await db.insert(schema.holdingLots).values({
        userId: tx.userId,
        holdingId: tx.portfolioHoldingId,
        accountId: tx.accountId,
        openTxId: tx.id,
        openDate: tx.date,
        qtyOriginal: overflowQty,
        qtyRemaining: overflowQty,
        costPerShare: proceedsPerShare,
        currency: proceedsCurrency,
        fxToUsdAtOpen: null,
        origin: "buy",
        parentLotId: null,
        status: "open",
        side: "short",
        source: tx.source,
      });
    }

    return closuresWritten;
  } catch (err) {
    softFail(err, `closeLotsForSellHook tx=${tx.id}`);
    return null;
  }
}

// ─── transferLotHook ──────────────────────────────────────────────────────

export interface TransferLotHookOpts {
  holdingCurrency: string;
}

/**
 * In-kind transfer between two accounts. Source leg has qty<0, dest leg
 * has qty>0, both share the same `link_id`. Walks FIFO over the source
 * account's open lots, writes transfer_out closures and transfer_in
 * dest lots that inherit cost_per_share + open_date.
 *
 * The two transactions are typically inserted by `createTransferPair*`;
 * the hook reads `sourceTx` and `destTx` AFTER both are committed.
 *
 * Pure-cash transfers (qty=0 on both legs — the Cash-sleeve default for
 * non-investment movements) are filtered out — they're a legitimate
 * use case but don't affect lots.
 */
export async function transferLotHook(
  sourceTx: TxRowForLots,
  destTx: TxRowForLots,
  opts: TransferLotHookOpts,
): Promise<{ closuresWritten: number; destLotsWritten: number } | null> {
  try {
    if (
      sourceTx.quantity == null ||
      destTx.quantity == null ||
      sourceTx.quantity === 0 ||
      destTx.quantity === 0
    ) {
      // Pure-cash transfer — no lot motion.
      return { closuresWritten: 0, destLotsWritten: 0 };
    }
    if (
      sourceTx.portfolioHoldingId == null ||
      destTx.portfolioHoldingId == null ||
      sourceTx.accountId == null ||
      destTx.accountId == null
    ) {
      return null;
    }

    const sourceLots = (
      await db
        .select()
        .from(schema.holdingLots)
        .where(
          and(
            eq(schema.holdingLots.userId, sourceTx.userId),
            eq(schema.holdingLots.holdingId, sourceTx.portfolioHoldingId),
            eq(schema.holdingLots.accountId, sourceTx.accountId),
            eq(schema.holdingLots.status, "open"),
          ),
        )
    ).map(rowToLot);

    const result = transferLot({
      sourceTx,
      destTx,
      sourceLots,
      holdingCurrency: opts.holdingCurrency,
    });

    if (result.closures.length > 0) {
      await db.insert(schema.holdingLotClosures).values(result.closures);
    }
    if (result.destLots.length > 0) {
      await db.insert(schema.holdingLots).values(result.destLots);
    }

    const lotsById = new Map(sourceLots.map((l) => [l.id, l]));
    for (const [lotId, delta] of result.qtyDeltas) {
      const lot = lotsById.get(lotId);
      if (!lot) continue;
      const newRemaining = lot.qtyRemaining - delta;
      const closed = newRemaining <= 1e-9;
      await db
        .update(schema.holdingLots)
        .set({
          qtyRemaining: newRemaining,
          status: closed ? "transferred_out" : "open",
          updatedAt: sql`NOW()`,
        })
        .where(eq(schema.holdingLots.id, lotId));
    }

    return {
      closuresWritten: result.closures.length,
      destLotsWritten: result.destLots.length,
    };
  } catch (err) {
    softFail(err, `transferLotHook source=${sourceTx.id} dest=${destTx.id}`);
    return null;
  }
}

// ─── applyLotEffectsForLinkPair — link_id pair dispatcher ─────────────────
//
// Centralized entry point for the lot-engine side of a link_id-paired
// transaction (in-kind transfer or FX conversion). Replaces direct
// `transferLotHook` calls from callers that don't know which valid shape
// the pair is — the dispatcher reads the two holdings, classifies, and
// routes:
//
//   1. Same `portfolio_holding_id` on both legs (and neither is a cash
//      sleeve)               → transferLotHook (existing in-kind transfer)
//   2. Both legs reference cash sleeves (is_cash=TRUE on both holdings)
//                            → fxConversionHook (no lot writes)
//   3. Anything else         → throws InvalidLinkPairError
//
// The error propagates to the caller (route / operations.ts / MCP tool)
// so the user sees a clear "this is not a valid pairing" rather than a
// silent transfer_in lot on the wrong holding (the bug observed on dev
// 2026-05-23: AAPL paired with the Cash sleeve via link_id opened a
// nonsense $260/sh cash lot).
//
// Note: this is INTENTIONALLY hard-fail (the throw is not caught in
// softFail). Lot-side errors elsewhere are soft-failed because they're
// recoverable via backfill; an invalid link pair is a data-integrity
// issue that requires the caller's attention.

export interface LinkPairResult {
  shape: "in_kind_transfer" | "fx_conversion";
  closuresWritten: number;
  destLotsWritten: number;
  warning?: string;
}

export async function applyLotEffectsForLinkPair(
  sourceTx: TxRowForLots,
  destTx: TxRowForLots,
): Promise<LinkPairResult> {
  if (
    sourceTx.portfolioHoldingId == null ||
    destTx.portfolioHoldingId == null
  ) {
    throw new InvalidLinkPairError({
      sourceTxId: sourceTx.id,
      destTxId: destTx.id,
      sourceHoldingId: sourceTx.portfolioHoldingId,
      destHoldingId: destTx.portfolioHoldingId,
      reason: "Both legs of a link_id pair must reference a portfolio_holding_id.",
    });
  }

  // Look up both holdings (is_cash + currency) — needed for the
  // FX-vs-transfer classification.
  const holdingIds = [
    sourceTx.portfolioHoldingId,
    destTx.portfolioHoldingId,
  ];
  const holdingRows = await db
    .select({
      id: schema.portfolioHoldings.id,
      isCash: schema.portfolioHoldings.isCash,
      currency: schema.portfolioHoldings.currency,
    })
    .from(schema.portfolioHoldings)
    .where(inArray(schema.portfolioHoldings.id, holdingIds));

  const byId = new Map(holdingRows.map((h) => [h.id, h]));
  const sourceHolding = byId.get(sourceTx.portfolioHoldingId);
  const destHolding = byId.get(destTx.portfolioHoldingId);
  if (!sourceHolding || !destHolding) {
    throw new InvalidLinkPairError({
      sourceTxId: sourceTx.id,
      destTxId: destTx.id,
      sourceHoldingId: sourceTx.portfolioHoldingId,
      destHoldingId: destTx.portfolioHoldingId,
      reason: "Could not resolve one or both holdings for the link_id pair.",
    });
  }

  const sourceLeg: FxLegInfo = {
    isCash: Boolean(sourceHolding.isCash),
    currency: sourceHolding.currency,
  };
  const destLeg: FxLegInfo = {
    isCash: Boolean(destHolding.isCash),
    currency: destHolding.currency,
  };

  // Shape 1: in-kind transfer — same holding on both legs, neither is cash.
  if (
    sourceTx.portfolioHoldingId === destTx.portfolioHoldingId &&
    !sourceLeg.isCash &&
    !destLeg.isCash
  ) {
    const r = await transferLotHook(sourceTx, destTx, {
      holdingCurrency: sourceHolding.currency,
    });
    return {
      shape: "in_kind_transfer",
      closuresWritten: r?.closuresWritten ?? 0,
      destLotsWritten: r?.destLotsWritten ?? 0,
    };
  }

  // Shape 2: FX conversion — both legs are cash sleeves.
  if (isFxConversionPair(sourceLeg, destLeg)) {
    const r = fxConversionHook(sourceTx, destTx, sourceLeg, destLeg);
    // Phase 5c (2026-05-26): write cash-lot effects.
    //   - source leg FIFO-closes cash lots with closeKind='fx_conversion'
    //   - dest leg opens a fresh cash lot on the dest sleeve
    // The per-row realized gain in the source currency is 0; FX gain in
    // base currency surfaces via augmentWithBaseCurrency() downstream.
    const closuresWritten =
      (await closeCashLotsHook(sourceTx, {
        sleeveCurrency: sourceLeg.currency,
        closeKind: "fx_conversion",
      })) ?? 0;
    const destLotId = await openCashLotHook(destTx, {
      sleeveCurrency: destLeg.currency,
    });
    return {
      shape: "fx_conversion",
      closuresWritten,
      destLotsWritten: destLotId != null ? 1 : 0,
      warning: r.warning,
    };
  }

  // Shape 3: anything else — refuse.
  throw new InvalidLinkPairError({
    sourceTxId: sourceTx.id,
    destTxId: destTx.id,
    sourceHoldingId: sourceTx.portfolioHoldingId,
    destHoldingId: destTx.portfolioHoldingId,
    reason:
      "link_id pair is neither an in-kind transfer (same holding, non-cash) " +
      "nor an FX conversion (both cash sleeves). " +
      `Source holding ${sourceTx.portfolioHoldingId} (is_cash=${sourceLeg.isCash}, ${sourceLeg.currency}); ` +
      `dest holding ${destTx.portfolioHoldingId} (is_cash=${destLeg.isCash}, ${destLeg.currency}). ` +
      "If this is a swap between different securities, record it as a Sell + Buy (no link_id). " +
      "If this is converting a stock to cash, record it as a plain Sell.",
  });
}

// ─── reverseLotsForDeleteHook ─────────────────────────────────────────────

/**
 * Reverses every lot effect of a transaction before it's DELETEd.
 *
 *   1. Find every lot opened by this tx (holdingLots.openTxId = txId) and
 *      DELETE them (the ON DELETE CASCADE on holdingLots.openTxId would
 *      also do this, but we want explicit deletion so the cascade ordering
 *      isn't relied on). Their closures cascade-delete via the closure
 *      FK on lotId.
 *
 *   2. Find every closure that closed-into this tx (closures.closeTxId =
 *      txId) and:
 *      - Restore the lot's qty_remaining by adding back qty_closed
 *      - Flip status back to 'open' if needed
 *      - DELETE the closure row
 *
 * Called from the transactions DELETE site AND from the UPDATE site
 * (UPDATE = reverse + redo via the same opener / closer hook).
 */
export async function reverseLotsForDeleteHook(
  userId: string,
  txId: number,
): Promise<{ lotsDeleted: number; closuresReversed: number } | null> {
  try {
    // 1. Lots opened by this tx.
    const openedLots = await db
      .select({ id: schema.holdingLots.id })
      .from(schema.holdingLots)
      .where(
        and(
          eq(schema.holdingLots.userId, userId),
          eq(schema.holdingLots.openTxId, txId),
        ),
      );
    const lotsDeleted = openedLots.length;
    if (lotsDeleted > 0) {
      // DELETE the lots; their closures (closures.lotId FK ON DELETE
      // CASCADE) cascade-delete in the same statement.
      await db
        .delete(schema.holdingLots)
        .where(
          and(
            eq(schema.holdingLots.userId, userId),
            eq(schema.holdingLots.openTxId, txId),
          ),
        );
    }

    // 2. Closures that closed INTO this tx (sell side).
    const closures = await db
      .select({
        id: schema.holdingLotClosures.id,
        lotId: schema.holdingLotClosures.lotId,
        qtyClosed: schema.holdingLotClosures.qtyClosed,
      })
      .from(schema.holdingLotClosures)
      .where(
        and(
          eq(schema.holdingLotClosures.userId, userId),
          eq(schema.holdingLotClosures.closeTxId, txId),
        ),
      );

    for (const c of closures) {
      // Restore qty_remaining; flip status back to 'open'.
      await db
        .update(schema.holdingLots)
        .set({
          qtyRemaining: sql`${schema.holdingLots.qtyRemaining} + ${c.qtyClosed}`,
          status: "open",
          updatedAt: sql`NOW()`,
        })
        .where(
          and(
            eq(schema.holdingLots.userId, userId),
            eq(schema.holdingLots.id, c.lotId),
          ),
        );
    }

    if (closures.length > 0) {
      await db
        .delete(schema.holdingLotClosures)
        .where(
          and(
            eq(schema.holdingLotClosures.userId, userId),
            eq(schema.holdingLotClosures.closeTxId, txId),
          ),
        );
    }

    return { lotsDeleted, closuresReversed: closures.length };
  } catch (err) {
    softFail(err, `reverseLotsForDeleteHook tx=${txId}`);
    return null;
  }
}

// ─── applyLotEffectsForTx — high-level dispatcher ─────────────────────────

export interface LotContext {
  /** Holding-id → currency map, for the holdingCurrency arg on each hook. */
  holdingCurrencyById: Map<number, string>;
  /** Phase 5c (2026-05-26): holding-id → is_cash flag. Cash sleeves take
   *  the cash-lot path; non-cash holdings take the stock-lot path. */
  isCashHoldingById: Map<number, boolean>;
  /** User's Dividends category id, null if not configured. */
  dividendsCategoryId: number | null;
}

/**
 * Builds the per-request lot context. One DB round-trip on holdings,
 * one on the Dividends category. Callers in the hot path (REST POST one
 * tx) cache nothing; batch callers (import-pipeline, bulk_record_transactions)
 * build once per batch.
 */
export async function buildLotContext(
  userId: string,
  dek: Buffer | null,
): Promise<LotContext> {
  const { resolveDividendsCategoryId } = await import(
    "@/lib/dividends-category"
  );
  const holdings = await db
    .select({
      id: schema.portfolioHoldings.id,
      currency: schema.portfolioHoldings.currency,
      isCash: schema.portfolioHoldings.isCash,
    })
    .from(schema.portfolioHoldings)
    .where(eq(schema.portfolioHoldings.userId, userId));
  const map = new Map<number, string>();
  const isCashMap = new Map<number, boolean>();
  for (const h of holdings) {
    map.set(h.id, h.currency);
    isCashMap.set(h.id, Boolean(h.isCash));
  }
  const dividendsCategoryId = await resolveDividendsCategoryId(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db as any,
    userId,
    dek,
  );
  return {
    holdingCurrencyById: map,
    isCashHoldingById: isCashMap,
    dividendsCategoryId,
  };
}

/**
 * High-level dispatcher: route a freshly-INSERTed `transactions` row to
 * the right lot hook based on its shape.
 *
 *   - qty > 0  AND portfolio_holding_id != null  → openLotForBuyHook
 *   - qty < 0  AND portfolio_holding_id != null  → closeLotsForSellHook
 *   - qty == 0  OR portfolio_holding_id == null → no-op
 *
 * Transfer pairs (both legs of an in-kind move) are NOT routed through
 * this dispatcher — they go via `transferLotHook(sourceTx, destTx)`
 * because the lot inheritance shape needs both legs together.
 *
 * Caller is responsible for invoking this AFTER the underlying INSERT
 * is committed; the hook reads `tx.id` to set `open_tx_id`.
 */
export async function applyLotEffectsForTx(
  tx: TxRowForLots,
  ctx: LotContext,
  opts?: {
    cashLeg?: CashLegHint | null;
    /** Strategy + lotIds for sells; defaults to FIFO. */
    sellStrategy?: LotSelectionStrategy;
    sellLotIds?: number[];
    /** Override origin (used by import for backfill rows; rarely needed). */
    origin?: "buy" | "reinvest_div" | "transfer_in" | "split_adj" | "backfill";
  },
): Promise<void> {
  if (tx.portfolioHoldingId == null || tx.accountId == null) return;
  if (tx.quantity == null || tx.quantity === 0) return;

  const holdingCurrency =
    ctx.holdingCurrencyById.get(tx.portfolioHoldingId) ??
    tx.currency ??
    "USD";
  const isCashSleeve = ctx.isCashHoldingById.get(tx.portfolioHoldingId) ?? false;

  // Phase 5c (2026-05-26): cash sleeves get their own lot tracking. Every
  // inflow opens a cash lot at fxToUsdAtOpen=null (aggregator fills via
  // historical lookup); every outflow FIFO-closes them with closeKind
  // inferred from the tx's `kind`. The realized-gain in the sleeve
  // currency is always 0 (cost=1, proceeds=1); the augmentWithBaseCurrency
  // path uses the open/close FX rates to surface the currency-on-currency
  // FX gain in the user's base currency.
  if (isCashSleeve) {
    if (tx.quantity > 0) {
      await openCashLotHook(tx, { sleeveCurrency: holdingCurrency });
    } else {
      await closeCashLotsHook(tx, {
        sleeveCurrency: holdingCurrency,
        closeKind: inferCashCloseKind(tx.kind),
      });
    }
    return;
  }

  // Non-cash holdings: existing stock-lot dispatch. The `_cash_leg` kinds
  // should never reach this branch (cash legs land on cash sleeves, which
  // were routed above) — but a defensive skip stays for legacy / data-bug
  // rows where a cash_leg kind landed on a non-cash holding.
  if (tx.kind && /_cash_leg$/.test(tx.kind)) {

    console.warn(
      `${HOOK_LABEL} applyLotEffectsForTx tx=${tx.id} kind='${tx.kind}' landed on a non-cash holding (${tx.portfolioHoldingId}); skipping lot effects. Likely a data-integrity issue — investigate.`,
    );
    return;
  }

  if (tx.quantity > 0) {
    const categoryIsDividend =
      ctx.dividendsCategoryId != null &&
      tx.categoryId === ctx.dividendsCategoryId;
    await openLotForBuyHook(tx, {
      cashLeg: opts?.cashLeg ?? null,
      categoryIsDividend,
      holdingCurrency,
      origin: opts?.origin,
    });
  } else {
    await closeLotsForSellHook(tx, {
      strategy: opts?.sellStrategy ?? "FIFO",
      lotIds: opts?.sellLotIds,
      cashLeg: opts?.cashLeg ?? null,
      holdingCurrency,
    });
  }
}

// ─── replanLotsAfterMutation — FINLYNQ-176 reallocation orchestrator ──────
//
// Warn-and-reallocate replacement for the hard `portfolio_edit_blocked`
// 409. When the user confirms editing/deleting a buy/transfer-in whose lot
// has been consumed, this re-plans the dependent closures against the
// post-mutation inventory (re-FIFO; overflow auto-opens a short lot).
//
//   dryRun=true  — read lots + dependent close-txs, run the PURE
//                  planLotReallocation core, return the preview. Writes
//                  NOTHING (issue: must be safe to call before confirm).
//   dryRun=false — STRICT, all-or-nothing. Reverses the dependent
//                  closures' lot effects + the target's lot effects, then
//                  (edit only) re-applies the edited target, then re-closes
//                  every dependent in chronological order via the existing
//                  closeLotsForSellHook (FIFO + auto-short). The caller MUST
//                  invoke this inside the same logical unit as the tx
//                  edit/delete; lot-hook strict mode is forced ON so any
//                  failure throws and the caller rolls back.
//
// IMPORTANT: this reuses the existing hooks (which bind to the module-level
// `db`) the same way the backfill replay does — there is no tx-handle
// threading in the lot layer. The caller (the transactions route) performs
// the actual `transactions` UPDATE/DELETE; this only owns the lot+closure
// rows. NEVER DELETE+INSERT a `transactions` row here (backfill invariant).

const LOT_TX_SELECT = {
  id: schema.transactions.id,
  userId: schema.transactions.userId,
  date: schema.transactions.date,
  amount: schema.transactions.amount,
  currency: schema.transactions.currency,
  enteredAmount: schema.transactions.enteredAmount,
  enteredCurrency: schema.transactions.enteredCurrency,
  quantity: schema.transactions.quantity,
  accountId: schema.transactions.accountId,
  categoryId: schema.transactions.categoryId,
  portfolioHoldingId: schema.transactions.portfolioHoldingId,
  tradeLinkId: schema.transactions.tradeLinkId,
  source: schema.transactions.source,
  kind: schema.transactions.kind,
} as const;

function txRowToLots(
  r: Record<string, unknown>,
): TxRowForLots {
  return {
    id: r.id as number,
    userId: r.userId as string,
    date: r.date as string,
    amount: Number(r.amount ?? 0),
    currency: (r.currency as string) ?? "USD",
    enteredAmount: r.enteredAmount == null ? null : Number(r.enteredAmount),
    enteredCurrency: (r.enteredCurrency as string | null) ?? null,
    quantity: r.quantity == null ? null : Number(r.quantity),
    accountId: (r.accountId as number | null) ?? null,
    categoryId: (r.categoryId as number | null) ?? null,
    portfolioHoldingId: (r.portfolioHoldingId as number | null) ?? null,
    tradeLinkId: (r.tradeLinkId as string | null) ?? null,
    source: ((r.source as string) ?? "manual") as TransactionSource,
    kind: (r.kind as string | null) ?? null,
  };
}

/** Load the dependent close-tx rows + their stored closures, for the pure
 *  re-plan. Closures are read BEFORE any reversal. */
async function loadDependentCloses(
  userId: string,
  closeTxIds: number[],
): Promise<DependentCloseInput[]> {
  if (closeTxIds.length === 0) return [];
  const txRows = await db
    .select(LOT_TX_SELECT)
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.userId, userId),
        inArray(schema.transactions.id, closeTxIds),
      ),
    );
  const closureRows = await db
    .select()
    .from(schema.holdingLotClosures)
    .where(
      and(
        eq(schema.holdingLotClosures.userId, userId),
        inArray(schema.holdingLotClosures.closeTxId, closeTxIds),
      ),
    );
  const closuresByTx = new Map<number, HoldingLotClosure[]>();
  for (const c of closureRows) {
    const arr = closuresByTx.get(c.closeTxId) ?? [];
    arr.push({
      id: c.id,
      userId: c.userId,
      lotId: c.lotId,
      closeTxId: c.closeTxId,
      closeDate: c.closeDate,
      qtyClosed: Number(c.qtyClosed),
      proceedsPerShare: Number(c.proceedsPerShare),
      costPerShare: Number(c.costPerShare),
      realizedGain: Number(c.realizedGain),
      currency: c.currency,
      daysHeld: Number(c.daysHeld),
      closeKind: c.closeKind as HoldingLotClosure["closeKind"],
      source: c.source as TransactionSource,
    });
    closuresByTx.set(c.closeTxId, arr);
  }
  // Chronological order (oldest close first), id tiebreaker.
  const deps: DependentCloseInput[] = txRows
    .map((r) => txRowToLots(r))
    .map((tx) => ({ tx, originalClosures: closuresByTx.get(tx.id) ?? [] }))
    .sort(
      (a, b) =>
        a.tx.date.localeCompare(b.tx.date) || a.tx.id - b.tx.id,
    );
  return deps;
}

/** Snapshot the user's current lots (long+short, open) for the holdings
 *  touched by the dependent closes — the pure re-plan input. */
async function loadLotsForHoldings(
  userId: string,
  holdingIds: number[],
): Promise<HoldingLot[]> {
  if (holdingIds.length === 0) return [];
  const rows = await db
    .select()
    .from(schema.holdingLots)
    .where(
      and(
        eq(schema.holdingLots.userId, userId),
        inArray(schema.holdingLots.holdingId, holdingIds),
      ),
    );
  return rows.map(rowToLot);
}

export interface ReplanArgs {
  op: "edit" | "delete";
  targetTxId: number;
  /** The dependent closure tx ids from canEditPortfolioRow(targetTxId). */
  dependentCloseTxIds: number[];
  /** Lot context (holding currencies + dividends category) for the redo. */
  ctx?: LotContext;
}

/**
 * FINLYNQ-176 — re-plan + (optionally) reallocate dependent closures after
 * the target tx is edited/deleted.
 *
 * dryRun=true returns the preview and writes nothing.
 * dryRun=false runs STRICT (lot hooks throw on error) and must be called
 *   AFTER the caller has applied the target `transactions` UPDATE (edit) or
 *   immediately BEFORE the caller deletes the target row (delete): see the
 *   sequence note above. On any error it throws — the caller rolls back.
 */
export async function replanLotsAfterMutation(
  userId: string,
  args: ReplanArgs,
  opts: { dryRun: boolean; dek?: Buffer | null },
): Promise<LotReallocationPreview> {
  const { targetTxId, dependentCloseTxIds } = args;

  // No dependents → nothing to reallocate (empty preview / no-op).
  if (dependentCloseTxIds.length === 0) {
    return {
      affectedHoldingIds: [],
      dependentCloseTxIds: [],
      proposedClosures: [],
      openedShortLots: [],
      realizedGainDeltaByYear: {},
    };
  }

  const deps = await loadDependentCloses(userId, dependentCloseTxIds);
  const holdingIds = Array.from(
    new Set(
      deps
        .map((d) => d.tx.portfolioHoldingId)
        .filter((h): h is number => h != null),
    ),
  );

  // ─── dry-run: simulate the post-reversal inventory, run the pure core ──
  if (opts.dryRun) {
    // Post-reversal snapshot: drop lots opened by the target tx and add
    // back the qty its closures consumed (the pure mirror of
    // reverseLotsForDeleteHook). We do NOT touch the DB.
    const liveLots = await loadLotsForHoldings(userId, holdingIds);

    // Lots opened by the target (removed on reversal).
    const targetOpenedLotIds = new Set(
      liveLots.filter((l) => l.openTxId === targetTxId).map((l) => l.id),
    );
    // Closures written BY the target tx restore qty on the lots they closed.
    const targetClosures = await db
      .select({
        lotId: schema.holdingLotClosures.lotId,
        qtyClosed: schema.holdingLotClosures.qtyClosed,
      })
      .from(schema.holdingLotClosures)
      .where(
        and(
          eq(schema.holdingLotClosures.userId, userId),
          eq(schema.holdingLotClosures.closeTxId, targetTxId),
        ),
      );
    const restoreByLot = new Map<number, number>();
    for (const c of targetClosures) {
      restoreByLot.set(
        c.lotId,
        (restoreByLot.get(c.lotId) ?? 0) + Number(c.qtyClosed),
      );
    }
    // The dependent closures also currently consume inventory; the re-plan
    // replays them from scratch, so strip their consumption from the
    // baseline (add their qtyClosed back to the lots they sit on).
    const depCloseTxIdSet = new Set(dependentCloseTxIds);
    for (const d of deps) {
      for (const c of d.originalClosures) {
        if (!depCloseTxIdSet.has(c.closeTxId)) continue;
        restoreByLot.set(
          c.lotId,
          (restoreByLot.get(c.lotId) ?? 0) + c.qtyClosed,
        );
      }
    }

    const postReversal: HoldingLot[] = liveLots
      .filter((l) => !targetOpenedLotIds.has(l.id))
      .map((l) => {
        const restore = restoreByLot.get(l.id) ?? 0;
        const qtyRemaining = l.qtyRemaining + restore;
        return {
          ...l,
          qtyRemaining,
          status: qtyRemaining > 1e-9 ? "open" : l.status,
        };
      });

    return planLotReallocation({
      mutation: { op: args.op, targetTxId },
      lots: postReversal,
      dependentCloses: deps,
    });
  }

  // ─── commit: strict, all-or-nothing reverse → redo → re-close ──────────
  const ctx = args.ctx ?? (await buildLotContext(userId, opts.dek ?? null));
  const prevStrict = strictMode;
  __setLotWriteHookStrictMode(true);
  try {
    // 1. Reverse the dependent closures' lot effects FIRST (restores the
    //    lots they consumed; deletes their closure rows).
    for (const d of deps) {
      await reverseLotsForDeleteHook(userId, d.tx.id);
    }
    // 2. Reverse the target's lot effects (delete its opened lots — their
    //    surviving closures cascade; restore any qty it consumed). For a
    //    DELETE the caller removes the tx row afterward; for an EDIT the
    //    caller has already UPDATEd the row, so we redo it below.
    await reverseLotsForDeleteHook(userId, targetTxId);

    // 3. EDIT only — re-apply the edited target row so its (possibly
    //    changed) lot re-opens before the dependents re-close against it.
    if (args.op === "edit") {
      const targetRows = await db
        .select(LOT_TX_SELECT)
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.userId, userId),
            eq(schema.transactions.id, targetTxId),
          ),
        );
      const t = targetRows[0];
      if (
        t &&
        t.portfolioHoldingId != null &&
        t.quantity != null &&
        Number(t.quantity) !== 0
      ) {
        await applyLotEffectsForTx(txRowToLots(t), ctx);
      }
    }

    // 4. Re-close every dependent in chronological order. closeLotsForSellHook
    //    FIFO-closes remaining long lots and auto-opens a short on overflow.
    for (const d of deps) {
      const t = d.tx;
      if (t.portfolioHoldingId == null || t.quantity == null) continue;
      await applyLotEffectsForTx(t, ctx);
    }

    // Return the realized preview so the caller can echo affected years.
    const liveLots = await loadLotsForHoldings(userId, holdingIds);
    return {
      affectedHoldingIds: holdingIds.sort((a, b) => a - b),
      dependentCloseTxIds,
      proposedClosures: [],
      openedShortLots: liveLots
        .filter((l) => l.side === "short" && l.qtyRemaining > 1e-9)
        .map((l) => ({
          holdingId: l.holdingId,
          accountId: l.accountId,
          qty: l.qtyRemaining,
          costPerShare: l.costPerShare,
          currency: l.currency,
        })),
      realizedGainDeltaByYear: {},
    };
  } finally {
    __setLotWriteHookStrictMode(prevStrict);
  }
}

// ─── reassignClosureLots — FINLYNQ-178 manual lot reassignment ────────────
//
// Fast-follow to FINLYNQ-176. Lets the user re-point a SINGLE closure (one
// sell / transfer-out tx) onto lots of their choosing, instead of the
// automatic FIFO `replanLotsAfterMutation` does. Reuses the engine
// foundation: the pure `planLotReassignment` (preview) + the existing
// `closeLotsForSellHook` `perLotQty` path (commit).
//
//   dryRun=true  — read the close-tx's lots + its closures, simulate the
//                  post-reversal inventory (restore ONLY this close-tx's
//                  consumed qty), run the pure core, return the preview.
//                  Writes NOTHING.
//   dryRun=false — STRICT, all-or-nothing. Reverse ONLY this close-tx's
//                  closures (restoring the lots they consumed; deleting any
//                  short lots it opened), then re-close it via
//                  closeLotsForSellHook's `perLotQty` path (close exactly the
//                  named qty per lot; overflow → one short). lot-hook strict
//                  mode is forced ON so any failure throws and the caller
//                  rolls back.
//
// Load-bearing: only THIS close-tx is reversed/redone, so sibling closures
// stay byte-identical (their realized gains do not restate). Position qty
// stays live SUM(quantity) — only lot/closure rows move. NEVER DELETE+INSERTs
// a `transactions` row. Same-account-only: the route guards that every
// chosen lot belongs to the same (holding, account) as the close-tx.

export interface ReassignResult {
  /** The preview the pure core produced (proposed closures + opened shorts
   *  + realized-gain delta by year). On commit, `proposedClosures` /
   *  `openedShortLots` reflect the dry-run plan (the committed writes mirror
   *  it). */
  preview: LotReallocationPreview;
}

export type ReassignError =
  | { ok: false; code: "close_tx_not_found" }
  | { ok: false; code: "no_closures" }
  | { ok: false; code: "not_reassignable"; closeKind: string }
  | { ok: false; code: "qty_mismatch"; expected: number; got: number }
  | { ok: false; code: "lot_not_in_scope"; lotId: number };

export type ReassignOutcome =
  | ({ ok: true } & ReassignResult)
  | ReassignError;

const REASSIGN_EPS = 1e-6;

/**
 * Reassign a single closure's lot allocation. Pure-validated + DB-bound.
 *
 * `perLotQty` is the user's chosen allocation; Σ qty MUST equal the
 * closure's total qty (STRICT — else `{ ok:false, code:"qty_mismatch" }`,
 * no write). Every named lot must belong to the same (holding, account) as
 * the close-tx (else `{ ok:false, code:"lot_not_in_scope" }`).
 */
export async function reassignClosureLots(
  userId: string,
  args: {
    holdingId: number;
    closeTxId: number;
    perLotQty: Array<{ lotId: number; qty: number }>;
  },
  opts: { dryRun: boolean; dek?: Buffer | null },
): Promise<ReassignOutcome> {
  const { holdingId, closeTxId, perLotQty } = args;

  // 1. Load the close-tx (owner + holding scoped).
  const closeTxRows = await db
    .select(LOT_TX_SELECT)
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.userId, userId),
        eq(schema.transactions.id, closeTxId),
        eq(schema.transactions.portfolioHoldingId, holdingId),
      ),
    );
  const closeTxRow = closeTxRows[0];
  if (!closeTxRow) return { ok: false, code: "close_tx_not_found" };
  const closeTx = txRowToLots(closeTxRow);
  const accountId = closeTx.accountId;
  if (accountId == null) return { ok: false, code: "close_tx_not_found" };

  // 2. Load this close-tx's ORIGINAL closures (before any reversal).
  const closureRows = await db
    .select()
    .from(schema.holdingLotClosures)
    .where(
      and(
        eq(schema.holdingLotClosures.userId, userId),
        eq(schema.holdingLotClosures.closeTxId, closeTxId),
      ),
    );
  if (closureRows.length === 0) return { ok: false, code: "no_closures" };

  // Only plain SELL closures are reassignable: the commit path replays via
  // closeLotsForSellHook's `perLotQty` branch, which stamps closeKind='sell'
  // + sizes proceeds from the sell's cash leg. transfer_out / swap_out /
  // fx_conversion / short_* closures carry different economics that this
  // path would corrupt — refuse cleanly rather than mis-write.
  const distinctKinds = new Set(closureRows.map((c) => c.closeKind));
  if (!(distinctKinds.size === 1 && distinctKinds.has("sell"))) {
    return {
      ok: false,
      code: "not_reassignable",
      closeKind: closureRows[0].closeKind as string,
    };
  }

  const originalClosures: HoldingLotClosure[] = closureRows.map((c) => ({
    id: c.id,
    userId: c.userId,
    lotId: c.lotId,
    closeTxId: c.closeTxId,
    closeDate: c.closeDate,
    qtyClosed: Number(c.qtyClosed),
    proceedsPerShare: Number(c.proceedsPerShare),
    costPerShare: Number(c.costPerShare),
    realizedGain: Number(c.realizedGain),
    currency: c.currency,
    daysHeld: Number(c.daysHeld),
    closeKind: c.closeKind as HoldingLotClosure["closeKind"],
    source: c.source as TransactionSource,
  }));

  // 3. STRICT qty validation: Σ perLotQty == closure total.
  const closureTotal = originalClosures.reduce((s, c) => s + c.qtyClosed, 0);
  const requestedTotal = perLotQty.reduce((s, p) => s + p.qty, 0);
  if (Math.abs(requestedTotal - closureTotal) > REASSIGN_EPS) {
    return {
      ok: false,
      code: "qty_mismatch",
      expected: Math.round(closureTotal * 1e6) / 1e6,
      got: Math.round(requestedTotal * 1e6) / 1e6,
    };
  }

  // 4. Same-account-only scope: every named lot must belong to this
  //    (user, holding, account). (Reading all the holding's lots once.)
  const liveLots = await loadLotsForHoldings(userId, [holdingId]);
  const lotsInScope = new Map(
    liveLots
      .filter((l) => l.accountId === accountId)
      .map((l) => [l.id, l]),
  );
  for (const sel of perLotQty) {
    if (sel.qty <= REASSIGN_EPS) continue;
    if (!lotsInScope.has(sel.lotId)) {
      return { ok: false, code: "lot_not_in_scope", lotId: sel.lotId };
    }
  }

  // 5. Post-reversal inventory: restore the qty THIS close-tx's closures
  //    consumed (mirror of reverseLotsForDeleteHook, in memory) and drop any
  //    SHORT lot this close-tx opened (its overflow lot, if any). No other
  //    tx is touched, so siblings are untouched.
  const restoreByLot = new Map<number, number>();
  for (const c of originalClosures) {
    if (c.lotId > 0) {
      restoreByLot.set(c.lotId, (restoreByLot.get(c.lotId) ?? 0) + c.qtyClosed);
    }
  }
  const postReversal: HoldingLot[] = liveLots
    .filter((l) => l.openTxId !== closeTxId) // drop the short this close opened
    .map((l) => {
      const restore = restoreByLot.get(l.id) ?? 0;
      const qtyRemaining = l.qtyRemaining + restore;
      return {
        ...l,
        qtyRemaining,
        status: qtyRemaining > 1e-9 ? "open" : l.status,
      };
    });

  const preview = planLotReassignment({
    closeTx,
    originalClosures,
    perLotQty,
    lots: postReversal,
  });

  // ─── dry-run: return the preview, write nothing ───────────────────────
  if (opts.dryRun) {
    return { ok: true, preview };
  }

  // ─── commit: STRICT reverse → redo via the perLotQty path ─────────────
  const ctx = await buildLotContext(userId, opts.dek ?? null);
  const holdingCurrency =
    ctx.holdingCurrencyById.get(holdingId) ?? closeTx.currency ?? "USD";
  const prevStrict = strictMode;
  __setLotWriteHookStrictMode(true);
  try {
    // Reverse ONLY this close-tx's lot effects (restores the lots it
    // consumed; deletes its closure rows + any short lot it opened).
    await reverseLotsForDeleteHook(userId, closeTxId);

    // Re-close via the existing perLotQty path: close EXACTLY the named qty
    // from each named lot; overflow → one short at the proceeds price.
    await closeLotsForSellHook(closeTx, {
      perLotQty,
      holdingCurrency,
    });

    return { ok: true, preview };
  } finally {
    __setLotWriteHookStrictMode(prevStrict);
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

function rowToLot(row: typeof schema.holdingLots.$inferSelect): HoldingLot {
  return {
    id: row.id,
    userId: row.userId,
    holdingId: row.holdingId,
    accountId: row.accountId,
    openTxId: row.openTxId,
    openDate: row.openDate,
    qtyOriginal: Number(row.qtyOriginal),
    qtyRemaining: Number(row.qtyRemaining),
    costPerShare: Number(row.costPerShare),
    currency: row.currency,
    fxToUsdAtOpen: row.fxToUsdAtOpen,
    origin: row.origin as HoldingLot["origin"],
    parentLotId: row.parentLotId,
    status: row.status as HoldingLot["status"],
    side: ((row as { side?: string | null }).side ?? "long") as HoldingLot["side"],
    source: row.source as TransactionSource,
  };
}
