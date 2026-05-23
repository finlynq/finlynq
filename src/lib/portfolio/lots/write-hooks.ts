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

import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import {
  closeLotsForSell,
  openLotForBuy,
  transferLot,
} from "./engine";
import { selectLotsToClose } from "./selection";
import type {
  CashLegHint,
  HoldingLot,
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
  // eslint-disable-next-line no-console
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

    const plan = openLotForBuy({
      tx,
      cashLeg: cashLeg ?? undefined,
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

    const lots: HoldingLot[] = lotRows.map(rowToLot);
    const plan = selectLotsToClose({
      strategy: opts.strategy ?? "FIFO",
      lots,
      targetQty: sellQty,
      lotIds: opts.lotIds,
    });

    if (!plan.success) {
      // Backfill is partial or out of sync — log + skip. The legacy
      // avg-cost path still handles this user's reads while the flag
      // is OFF; we don't want to error the underlying sell INSERT.
      // eslint-disable-next-line no-console
      console.warn(
        `${HOOK_LABEL} closeLotsForSellHook tx=${tx.id} shortfall=${plan.shortfall}; skipping closure write`,
      );
      return 0;
    }

    let cashLeg: CashLegHint | null = opts.cashLeg ?? null;
    if (cashLeg === null && tx.tradeLinkId) {
      cashLeg = await resolveCashLegForTx(tx);
    }

    const lotsById = new Map(lots.map((l) => [l.id, l]));
    const result = closeLotsForSell({
      tx,
      plan,
      cashLeg: cashLeg ?? undefined,
      holdingCurrency: opts.holdingCurrency,
      lotsById,
    });

    if (result.closures.length === 0) return 0;

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
    return result.closures.length;
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
    })
    .from(schema.portfolioHoldings)
    .where(eq(schema.portfolioHoldings.userId, userId));
  const map = new Map<number, string>();
  for (const h of holdings) map.set(h.id, h.currency);
  const dividendsCategoryId = await resolveDividendsCategoryId(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db as any,
    userId,
    dek,
  );
  return { holdingCurrencyById: map, dividendsCategoryId };
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
    source: row.source as TransactionSource,
  };
}
