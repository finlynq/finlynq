/**
 * Backfill — reconstruct lots + closures from pre-Phase-1 transaction history.
 *
 * Walks every user transaction in chronological order, grouped by
 * (holding, account). Opens lots from buys + reinvested dividends, runs
 * FIFO depletion on sells, writes transfer-out closures + transfer-in
 * lots on in-kind move pairs.
 *
 * Reuses the same engine functions as the live write-hooks so the
 * cost-basis substitution (#96), sell-branch skip (#128), per-currency
 * bucketing (#129), and qty>0 keying (#236) match. Diffing the result
 * against the legacy avg-cost aggregator (the verification step before
 * flag-flip) tells us how many users will see a different realized-gain
 * number — avg-cost ≠ FIFO on partial sells, so a non-zero delta is
 * expected and not a bug.
 *
 * Idempotent — the script wipes existing lot/closure rows for the target
 * user before writing fresh ones. Snapshots the legacy avg-cost realized
 * gain into `portfolio_legacy_realized_gain_snapshot` on first run.
 */

import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { resolveDividendsCategoryId } from "@/lib/dividends-category";
import {
  closeLotsForSell,
  daysBetween,
  openLotForBuy,
  transferLot,
} from "./engine";
import { inferCashCloseKind } from "./cash-hooks";
import { selectLotsToClose } from "./selection";
import type {
  CashLegHint,
  HoldingLot,
  HoldingLotClosure,
  TxRowForLots,
} from "./types";
import type { TransactionSource } from "@/lib/tx-source";

export interface BackfillResult {
  userId: string;
  lotsWritten: number;
  closuresWritten: number;
  txProcessed: number;
  errors: string[];
}

/**
 * Scope for a TARGETED rebuild (FINLYNQ — out-of-order-import fix). When
 * present, the replay touches ONLY the lots/closures for the given
 * security's positions within ONE account, and replays only that account's
 * transactions for those positions (plus their paired cash legs, needed for
 * the issue-#96 cost-basis substitution). Lots never cross accounts, so a
 * per-(security, account) wipe + replay is self-contained. A scoped run does
 * NOT touch `portfolio_lots_status` (that flag is user-level).
 */
export interface RebuildScope {
  /** Every portfolio_holding id that clusters under the target security. */
  holdingIds: number[];
  /** The single account whose lots are being rebuilt. */
  accountId: number;
}

/**
 * FINLYNQ-280 — classify a `link_id`-paired opposite-sign transaction pair
 * for the lot rebuild.
 *
 * A pair is an IN-KIND transfer (cost-basis carryover via `transferLot`) ONLY
 * when both legs reference the SAME `portfolio_holding_id` — the exact
 * condition the engine's `transferLot` guard requires (it throws
 * `InvalidLinkPairError` on mismatched holdings). Because a holding is
 * per-(account, security, currency), same-holding ⟹ same currency, so a
 * DIFFERENT-holding pair is by definition a cross-holding and/or
 * cross-currency move (a USD-cash → CAD-cash conversion, a cross-account
 * security move). Those must be replayed as TWO INDEPENDENT close+open legs
 * (fx-conversion-like), NOT an in-kind `transferLot`. Returns true iff the
 * pair is a same-holding in-kind transfer.
 */
export function isSameHoldingInKindPair(
  sourceHoldingId: number | null | undefined,
  siblingHoldingId: number | null | undefined,
): boolean {
  return (
    sourceHoldingId != null &&
    siblingHoldingId != null &&
    sourceHoldingId === siblingHoldingId
  );
}

/** Column projection shared by the whole-user and scoped tx loads. */
const TX_LOAD_COLS = {
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
  linkId: schema.transactions.linkId,
  source: schema.transactions.source,
  kind: schema.transactions.kind,
} as const;

/**
 * Walks the user's transaction history and rebuilds holding_lots +
 * holding_lot_closures from scratch. Marks `portfolio_lots_status.backfill_done = TRUE`
 * on success but does NOT flip `enabled` — that's a manual decision after
 * a canary diff against the legacy aggregator.
 *
 * Pass `scope` to rebuild only one (security, account) — see RebuildScope.
 * `rebuildLotsForPosition` is the public scoped entry point.
 */
export async function buildLotsForUser(
  userId: string,
  dek: Buffer | null,
  scope: RebuildScope | null = null,
): Promise<BackfillResult> {
  const errors: string[] = [];
  let lotsWritten = 0;
  let closuresWritten = 0;
  let txProcessed = 0;

  // 1. Wipe prior lot output. Idempotent re-run. Scoped → only this
  //    (security, account); whole-user → everything for the user.
  if (scope) {
    const scopedLots = await db
      .select({ id: schema.holdingLots.id })
      .from(schema.holdingLots)
      .where(
        and(
          eq(schema.holdingLots.userId, userId),
          inArray(schema.holdingLots.holdingId, scope.holdingIds),
          eq(schema.holdingLots.accountId, scope.accountId),
        ),
      );
    const scopedLotIds = scopedLots.map((l) => l.id);
    if (scopedLotIds.length > 0) {
      await db
        .delete(schema.holdingLotClosures)
        .where(
          and(
            eq(schema.holdingLotClosures.userId, userId),
            inArray(schema.holdingLotClosures.lotId, scopedLotIds),
          ),
        );
    }
    await db
      .delete(schema.holdingLots)
      .where(
        and(
          eq(schema.holdingLots.userId, userId),
          inArray(schema.holdingLots.holdingId, scope.holdingIds),
          eq(schema.holdingLots.accountId, scope.accountId),
        ),
      );
  } else {
    await db
      .delete(schema.holdingLotClosures)
      .where(eq(schema.holdingLotClosures.userId, userId));
    await db
      .delete(schema.holdingLots)
      .where(eq(schema.holdingLots.userId, userId));
  }

  // 2. Load the transactions to replay, in chronological order.
  //    Whole-user → every investment row. Scoped → the target security's
  //    legs in the target account, PLUS their paired cash-leg companions
  //    (same trade_link_id, same account) so the #96 cost substitution
  //    still has its hint. Cross-account transfer siblings are deliberately
  //    excluded so the replay only ever writes inside the wiped bucket.
  const loadScopedTx = async (s: RebuildScope) => {
    const securityLegs = await db
      .select(TX_LOAD_COLS)
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, userId),
          eq(schema.transactions.accountId, s.accountId),
          inArray(schema.transactions.portfolioHoldingId, s.holdingIds),
        ),
      )
      .orderBy(schema.transactions.date, schema.transactions.id);
    const tradeLinkIds = [
      ...new Set(
        securityLegs
          .map((r) => r.tradeLinkId)
          .filter((v): v is string => v != null && v !== ""),
      ),
    ];
    const cashLegs =
      tradeLinkIds.length > 0
        ? await db
            .select(TX_LOAD_COLS)
            .from(schema.transactions)
            .where(
              and(
                eq(schema.transactions.userId, userId),
                eq(schema.transactions.accountId, s.accountId),
                inArray(schema.transactions.tradeLinkId, tradeLinkIds),
                or(
                  isNull(schema.transactions.quantity),
                  eq(schema.transactions.quantity, 0),
                ),
              ),
            )
        : [];
    const seen = new Set(securityLegs.map((r) => r.id));
    return [...securityLegs, ...cashLegs.filter((r) => !seen.has(r.id))].sort(
      (a, b) => a.date.localeCompare(b.date) || a.id - b.id,
    );
  };
  const loadWholeUserTx = () =>
    db
      .select(TX_LOAD_COLS)
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, userId),
          isNotNull(schema.transactions.portfolioHoldingId),
        ),
      )
      .orderBy(schema.transactions.date, schema.transactions.id);

  const txRows = scope ? await loadScopedTx(scope) : await loadWholeUserTx();

  // 3. Build cash-leg map (trade_link_id → cash leg) for issue #96 substitution.
  const cashLegByTradeLinkId = new Map<string, CashLegHint>();
  for (const r of txRows) {
    if (
      r.tradeLinkId &&
      (r.quantity == null || r.quantity === 0) &&
      r.amount !== 0
    ) {
      cashLegByTradeLinkId.set(r.tradeLinkId, {
        enteredAmount: Number(r.enteredAmount ?? r.amount),
        enteredCurrency: r.enteredCurrency,
        amount: Number(r.amount),
        currency: r.currency ?? "USD",
        tradeLinkId: r.tradeLinkId,
      });
    }
  }

  // 4. Holding currency map (+ FINLYNQ-278: which holdings are cash sleeves).
  const holdingRows = await db
    .select({
      id: schema.portfolioHoldings.id,
      currency: schema.portfolioHoldings.currency,
      isCash: schema.portfolioHoldings.isCash,
    })
    .from(schema.portfolioHoldings)
    .where(eq(schema.portfolioHoldings.userId, userId));
  const holdingCurrencies = new Map<number, string>();
  const cashHoldingIds = new Set<number>();
  for (const h of holdingRows) {
    holdingCurrencies.set(h.id, h.currency);
    if (h.isCash) cashHoldingIds.add(h.id);
  }

  // 5. Dividends category id (issue #84).
  const dividendsCategoryId = await resolveDividendsCategoryId(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db as any,
    userId,
    dek,
  );

  // 6. Per-(holding, account) running lot map kept in-memory through the walk.
  //    Each lot has a synthetic in-memory id; we re-assign after the bulk
  //    INSERT once the DB hands us serial ids.
  type InMemLot = Omit<HoldingLot, "id" | "status"> & {
    tmpId: number;
    status: HoldingLot["status"];
  };
  let nextTmpId = 1;
  const lotsByKey = new Map<string, InMemLot[]>();

  type ClosureToWrite = Omit<HoldingLotClosure, "id"> & { tmpLotId: number };
  const pendingClosures: ClosureToWrite[] = [];
  const pendingLots: InMemLot[] = [];

  const keyOf = (h: number, a: number) => `${h}:${a}`;

  // Group rows by link_id for transfer-pair processing.
  const byLinkId = new Map<string, typeof txRows>();
  for (const r of txRows) {
    if (r.linkId) {
      const arr = byLinkId.get(r.linkId) ?? ([] as typeof txRows);
      arr.push(r);
      byLinkId.set(r.linkId, arr);
    }
  }
  const processedTransferIds = new Set<number>();

  for (const r of txRows) {
    if (r.portfolioHoldingId == null || r.accountId == null) continue;
    if (processedTransferIds.has(r.id)) {
      txProcessed++;
      continue;
    }

    // Paired cash leg — skipped from depletion (issue #128) and contributes
    // only as a cost-basis hint via `cashLegByTradeLinkId` to its sibling.
    if (
      r.tradeLinkId &&
      (r.quantity == null || r.quantity === 0)
    ) {
      txProcessed++;
      continue;
    }

    const txRow: TxRowForLots = {
      id: r.id,
      userId: r.userId,
      date: r.date,
      amount: Number(r.amount),
      currency: r.currency ?? "USD",
      enteredAmount: r.enteredAmount,
      enteredCurrency: r.enteredCurrency,
      quantity: r.quantity,
      accountId: r.accountId,
      categoryId: r.categoryId,
      portfolioHoldingId: r.portfolioHoldingId,
      tradeLinkId: r.tradeLinkId,
      source: (r.source as TransactionSource) ?? "import",
    };

    const holdingCurrency =
      holdingCurrencies.get(r.portfolioHoldingId) ?? txRow.currency;
    const key = keyOf(r.portfolioHoldingId, r.accountId);

    // Transfer-pair detection — same link_id with TWO legs, opposite-sign qty.
    //
    // FINLYNQ-280: ONLY a SAME-holding pair is an in-kind `transferLot`
    // (cost-basis carryover). The engine's transferLot guard REQUIRES
    // identical holdingIds and throws InvalidLinkPairError otherwise, so a
    // link_id pair whose legs sit on DIFFERENT holdings and/or currencies (a
    // USD-cash → CAD-cash conversion, a cross-account security move) must NOT
    // reach transferLot. Such a pair is a cross-currency transfer /
    // fx-conversion: we DON'T enter the transfer branch and instead let EACH
    // leg fall through to be visited independently by the main loop — a
    // cash-sleeve leg through the FINLYNQ-278 close+open cash path, a security
    // leg through the buy/sell path — i.e. two independent close+open legs.
    // Same-holding pairs stay byte-identical (still route to transferLot /
    // defer).
    let isInKindTransfer = false;
    if (r.linkId && (r.quantity ?? 0) !== 0) {
      const peers = byLinkId.get(r.linkId) ?? [];
      const sibling = peers.find(
        (p) =>
          p.id !== r.id &&
          (p.quantity ?? 0) !== 0 &&
          Math.sign(p.quantity ?? 0) !== Math.sign(r.quantity ?? 0),
      );
      const sameHoldingInKind =
        sibling != null &&
        isSameHoldingInKindPair(
          r.portfolioHoldingId,
          sibling.portfolioHoldingId,
        );
      if (sibling && !sameHoldingInKind && r.quantity != null && r.quantity < 0) {
        // Cross-currency / different-holding link_id transfer. Warn ONCE (on
        // the source, qty<0, leg) for a NON-cash pair, where replaying as
        // sell+buy loses in-kind cost-basis carryover; a both-cash
        // fx-conversion is faithfully reproduced by the two independent legs,
        // so stay silent. Both legs then fall through to be processed
        // independently (no defer, no processed-mark).
        const bothCash =
          r.portfolioHoldingId != null &&
          cashHoldingIds.has(r.portfolioHoldingId) &&
          sibling.portfolioHoldingId != null &&
          cashHoldingIds.has(sibling.portfolioHoldingId);
        if (!bothCash) {
          errors.push(
            `tx ${r.id} (${r.date}): different-holding link_id transfer ` +
              `(holding ${r.portfolioHoldingId} → ${sibling.portfolioHoldingId}) — ` +
              `replayed as two independent close+open legs; in-kind cost-basis ` +
              `carryover not inherited, verify the move.`,
          );
        }
      } else if (sibling && sameHoldingInKind && r.quantity != null && r.quantity < 0) {
        // r is the source (qty<0); sibling is the dest (qty>0).
        const destTxRow: TxRowForLots = {
          id: sibling.id,
          userId: sibling.userId,
          date: sibling.date,
          amount: Number(sibling.amount),
          currency: sibling.currency ?? "USD",
          enteredAmount: sibling.enteredAmount,
          enteredCurrency: sibling.enteredCurrency,
          quantity: sibling.quantity,
          accountId: sibling.accountId,
          categoryId: sibling.categoryId,
          portfolioHoldingId: sibling.portfolioHoldingId,
          tradeLinkId: sibling.tradeLinkId,
          source: (sibling.source as TransactionSource) ?? "import",
        };
        const sourceLots = (lotsByKey.get(key) ?? []).map((l) => ({
          ...l,
          id: l.tmpId,
        })) as HoldingLot[];
        const result = transferLot({
          sourceTx: txRow,
          destTx: destTxRow,
          sourceLots,
          holdingCurrency,
        });
        for (const cl of result.closures) {
          pendingClosures.push({ ...cl, tmpLotId: cl.lotId });
        }
        // Map qty deltas back to in-mem lots.
        const arr = lotsByKey.get(key) ?? [];
        for (const [lotIdTmp, delta] of result.qtyDeltas) {
          const lot = arr.find((l) => l.tmpId === lotIdTmp);
          if (lot) {
            lot.qtyRemaining -= delta;
            if (lot.qtyRemaining <= 1e-9) {
              lot.status = "transferred_out";
              lot.qtyRemaining = 0;
            }
          }
        }
        // Open dest lots in the dest (holding, account) bucket.
        if (destTxRow.portfolioHoldingId != null && destTxRow.accountId != null) {
          const destKey = keyOf(destTxRow.portfolioHoldingId, destTxRow.accountId);
          const destArr = lotsByKey.get(destKey) ?? [];
          for (const dl of result.destLots) {
            const tmpId = nextTmpId++;
            destArr.push({ ...dl, tmpId, status: "open" });
            pendingLots.push({ ...dl, tmpId, status: "open" });
          }
          lotsByKey.set(destKey, destArr);
        }
        processedTransferIds.add(sibling.id);
        isInKindTransfer = true;
      } else if (sibling && sameHoldingInKind && r.quantity != null && r.quantity > 0) {
        // Same-holding in-kind: the dest side is being visited first — defer;
        // the source-side iteration handles the pair. A DIFFERENT-holding
        // dest leg is NOT deferred (falls through to process independently).
        processedTransferIds.add(r.id);
        txProcessed++;
        continue;
      }
    }

    if (isInKindTransfer) {
      txProcessed++;
      continue;
    }

    // Scoped rebuild only: a security leg paired by link_id whose counterpart
    // lives in another account can't be reconstructed as an in-kind transfer
    // here (we wiped/loaded only this account), so it falls through to the
    // buy/sell path. Warn so the user can verify the cross-account move.
    if (scope && r.linkId && (r.quantity ?? 0) !== 0) {
      errors.push(
        `tx ${r.id} (${r.date}): in-kind transfer leg with no counterpart in this account — ` +
          `rebuilt as a plain ${(r.quantity ?? 0) < 0 ? "sell" : "buy"} within this account; verify the cross-account move.`,
      );
    }

    // FINLYNQ-278: cash sleeves reconcile with SHORT lots. A cash INFLOW closes
    // open SHORT lots FIFO (short_close, in-currency realized 0) then opens a
    // long for the remainder; a cash OUTFLOW closes open LONG lots FIFO then
    // opens a SHORT for any shortfall. This mirrors the live cash-hooks so a
    // rebuild of a sleeve that ever went net-negative reconciles (open long −
    // open short = ledger balance) instead of DROPPING the shortfall — the drift
    // the old rebuild left, which FINLYNQ-277 had to mask with a display peg.
    // Cost is always 1; the FX gain is deferred to augmentWithBaseCurrency
    // (short/long openDate vs closeDate). Runs for cash-sleeve rows only, then
    // `continue`s past the generic buy/sell path. Transfer-paired rows were
    // already handled + continued above.
    if (r.portfolioHoldingId != null && cashHoldingIds.has(r.portfolioHoldingId) && r.quantity != null && r.quantity !== 0) {
      const arr = lotsByKey.get(key) ?? [];
      const mkCashLot = (qty: number, side: "long" | "short"): InMemLot => {
        const tmpId = nextTmpId++;
        return {
          userId: r.userId,
          holdingId: r.portfolioHoldingId!,
          accountId: r.accountId!,
          openTxId: r.id,
          openDate: r.date,
          qtyOriginal: qty,
          qtyRemaining: qty,
          costPerShare: 1,
          currency: holdingCurrency,
          fxToUsdAtOpen: null,
          origin: "backfill",
          parentLotId: null,
          side,
          source: txRow.source,
          tmpId,
          status: "open",
        };
      };
      let remaining = Math.abs(r.quantity);
      const inflow = r.quantity > 0;
      // Cover the opposite side FIFO first.
      const coverSide: "long" | "short" = inflow ? "short" : "long";
      const closeKind = inflow ? "short_close" : inferCashCloseKind(r.kind);
      const openLots = arr
        .filter((l) => l.side === coverSide && l.status === "open" && l.qtyRemaining > 1e-9)
        .sort((a, b) => a.openDate.localeCompare(b.openDate) || a.tmpId - b.tmpId);
      for (const lot of openLots) {
        if (remaining <= 1e-9) break;
        const closeQty = Math.min(lot.qtyRemaining, remaining);
        pendingClosures.push({
          userId: r.userId,
          lotId: 0,
          tmpLotId: lot.tmpId,
          closeTxId: r.id,
          closeDate: r.date,
          qtyClosed: closeQty,
          proceedsPerShare: 1,
          costPerShare: 1,
          realizedGain: 0,
          currency: holdingCurrency,
          daysHeld: daysBetween(lot.openDate, r.date),
          closeKind,
          source: txRow.source,
        });
        lot.qtyRemaining -= closeQty;
        if (lot.qtyRemaining <= 1e-9) {
          lot.status = "closed";
          lot.qtyRemaining = 0;
        }
        remaining -= closeQty;
      }
      // Remainder opens a new lot on the flow's own side.
      if (remaining > 1e-9) {
        const lot = mkCashLot(remaining, inflow ? "long" : "short");
        pendingLots.push(lot);
        arr.push(lot);
      }
      lotsByKey.set(key, arr);
      txProcessed++;
      continue;
    }

    // Regular buy / dividend-reinvest / sell.
    if (r.quantity != null && r.quantity > 0) {
      const cashLeg = r.tradeLinkId
        ? cashLegByTradeLinkId.get(r.tradeLinkId) ?? undefined
        : undefined;
      const categoryIsDividend =
        dividendsCategoryId != null && r.categoryId === dividendsCategoryId;
      const plan = openLotForBuy({
        tx: txRow,
        cashLeg,
        categoryIsDividend,
        holdingCurrency,
        originOverride: "backfill",
      });
      const tmpId = nextTmpId++;
      const lot: InMemLot = { ...plan.lot, tmpId, status: "open", side: "long" };
      pendingLots.push(lot);
      const arr = lotsByKey.get(key) ?? [];
      arr.push(lot);
      lotsByKey.set(key, arr);
    } else if (r.quantity != null && r.quantity < 0) {
      // Paired cash-leg already filtered above.
      const cashLeg = r.tradeLinkId
        ? cashLegByTradeLinkId.get(r.tradeLinkId) ?? undefined
        : undefined;
      const arr = (lotsByKey.get(key) ?? []).map((l) => ({
        ...l,
        id: l.tmpId,
      })) as HoldingLot[];
      const plan = selectLotsToClose({
        strategy: "FIFO",
        lots: arr,
        targetQty: Math.abs(r.quantity),
      });
      if (!plan.success) {
        errors.push(
          `tx ${r.id} (${r.date}): sell shortfall ${plan.shortfall} — no matching open lot`,
        );
        txProcessed++;
        continue;
      }
      const lotsById = new Map(arr.map((l) => [l.id, l]));
      const result = closeLotsForSell({
        tx: txRow,
        plan,
        cashLeg,
        holdingCurrency,
        lotsById,
      });
      for (const cl of result.closures) {
        pendingClosures.push({ ...cl, tmpLotId: cl.lotId });
      }
      const sourceArr = lotsByKey.get(key) ?? [];
      for (const [lotIdTmp, delta] of result.qtyDeltas) {
        const lot = sourceArr.find((l) => l.tmpId === lotIdTmp);
        if (lot) {
          lot.qtyRemaining -= delta;
          if (lot.qtyRemaining <= 1e-9) {
            lot.status = "closed";
            lot.qtyRemaining = 0;
          }
        }
      }
    }
    txProcessed++;
  }

  // 7. Bulk insert lots, then map tmpId → real id, then insert closures.
  if (pendingLots.length > 0) {
    const lotValues = pendingLots.map((l) => ({
      userId: l.userId,
      holdingId: l.holdingId,
      accountId: l.accountId,
      openTxId: l.openTxId,
      openDate: l.openDate,
      qtyOriginal: l.qtyOriginal,
      qtyRemaining: l.qtyRemaining,
      costPerShare: l.costPerShare,
      currency: l.currency,
      fxToUsdAtOpen: l.fxToUsdAtOpen,
      origin: l.origin,
      parentLotId: null, // parent_lot_id is also tmp — TODO post-Phase-1 fixup
      status: l.status,
      source: l.source,
    }));
    const inserted = await db
      .insert(schema.holdingLots)
      .values(lotValues)
      .returning({ id: schema.holdingLots.id });
    lotsWritten = inserted.length;
    // Map tmpId → real id in input order (PG INSERT RETURNING preserves order).
    const tmpToReal = new Map<number, number>();
    for (let i = 0; i < pendingLots.length; i++) {
      tmpToReal.set(pendingLots[i].tmpId, inserted[i].id);
    }

    if (pendingClosures.length > 0) {
      const closureValues = pendingClosures.map((c) => ({
        userId: c.userId,
        lotId: tmpToReal.get(c.tmpLotId) ?? 0,
        closeTxId: c.closeTxId,
        closeDate: c.closeDate,
        qtyClosed: c.qtyClosed,
        proceedsPerShare: c.proceedsPerShare,
        costPerShare: c.costPerShare,
        realizedGain: c.realizedGain,
        currency: c.currency,
        daysHeld: c.daysHeld,
        closeKind: c.closeKind,
        source: c.source,
      }));
      // Drop closures whose lot didn't make it into the DB (shouldn't happen).
      const valid = closureValues.filter((c) => c.lotId > 0);
      if (valid.length > 0) {
        await db.insert(schema.holdingLotClosures).values(valid);
        closuresWritten = valid.length;
      }
    }
  }

  // 8. Mark backfill done — WHOLE-USER ONLY. A scoped rebuild rewrites one
  //    (security, account) and must not stamp the user-level status flag.
  if (!scope) {
    await db
      .insert(schema.portfolioLotsStatus)
      .values({
        userId,
        backfillDone: true,
        backfilledAt: sql`NOW()`,
        enabled: false,
        notes: `Backfilled ${lotsWritten} lots, ${closuresWritten} closures from ${txProcessed} transactions${errors.length ? ` (${errors.length} non-fatal errors)` : ""}`,
      })
      .onConflictDoUpdate({
        target: schema.portfolioLotsStatus.userId,
        set: {
          backfillDone: true,
          backfilledAt: sql`NOW()`,
          notes: `Re-backfilled ${lotsWritten} lots, ${closuresWritten} closures from ${txProcessed} transactions${errors.length ? ` (${errors.length} non-fatal errors)` : ""}`,
        },
      });
  }

  return { userId, lotsWritten, closuresWritten, txProcessed, errors };
}

/**
 * FINLYNQ — targeted rebuild for ONE (security, account). The public entry
 * point behind the Lot Inspector "Rebuild lots" button. Wipes + replays only
 * that position's lots/closures in chronological order, which is the cure for
 * out-of-order imports (a sell recorded before its buy opened a phantom
 * short; replaying in date order opens the long first, so the sell closes it
 * as a long). Deletes ONLY holding_lots / holding_lot_closures — never any
 * `transactions` row. Returns the same shape as buildLotsForUser; `errors`
 * carries any sell shortfalls (genuine oversells) + cross-account-transfer
 * warnings.
 *
 * @param holdingIds every portfolio_holding id clustering under the target
 *   security (resolve from securities/cluster); usually one for a single
 *   account, but a security can back >1 position row in an account.
 */
export async function rebuildLotsForPosition(
  userId: string,
  dek: Buffer | null,
  scope: RebuildScope,
): Promise<BackfillResult> {
  if (scope.holdingIds.length === 0) {
    return { userId, lotsWritten: 0, closuresWritten: 0, txProcessed: 0, errors: [] };
  }
  return buildLotsForUser(userId, dek, scope);
}
