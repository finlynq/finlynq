/**
 * FINLYNQ-176 — lot reallocation re-plan core.
 *
 * When a user edits or deletes a buy / transfer-in whose opened lot has
 * since been consumed by one or more closures (sells / transfer-outs),
 * the old behavior was to HARD-BLOCK (`canEditPortfolioRow` → 409
 * `portfolio_edit_blocked`). FINLYNQ-176 replaces that dead-end with a
 * warn-and-reallocate flow: reverse the target row's lots, then re-plan
 * (re-FIFO) the dependent closures against the REMAINING inventory; when
 * no long inventory is left to absorb a closure, open a SHORT lot (the
 * same auto-short the live oversell path already does — FINLYNQ-162
 * precedent). This keeps position qty (live `SUM(quantity)`) invariant.
 *
 * `planLotReallocation` is PURE — no DB I/O. It takes the post-mutation
 * lot snapshot (the caller has already removed the target tx's opened
 * lots and restored the qty its closures consumed) plus the dependent
 * close-txs to replay, and returns a `LotReallocationPreview`: the
 * proposed closures, any short lots that would open, and the
 * realized-gain delta bucketed by calendar year (so the confirm dialog
 * can warn which years restate).
 *
 * The DB-bound orchestrator (`replanLotsAfterMutation`, write-hooks.ts)
 * wires this to actual reverse → redo → re-close writes inside one
 * transaction; the dry-run path returns this preview and writes nothing.
 *
 * Load-bearing rules honored here:
 *   - Re-close is FIFO over the holding's remaining LONG lots, matching
 *     `closeLotsForSellHook`'s default. Shorts are never closed by a sell.
 *   - Overflow (insufficient long inventory) opens ONE short lot at the
 *     closure's proceeds price — identical to closeLotsForSellHook's
 *     `overflowQty` branch (write-hooks.ts L469-490).
 *   - Realized gain = (proceeds − cost) × qty in the closure's currency;
 *     transfer_out closures realize 0 (cost == proceeds).
 *   - Position qty comes from live `SUM(quantity)` (issue #128), so the
 *     reallocation only moves lot/closure rows; it must NOT change the
 *     implied net long-minus-short position vs. the pre-plan state.
 */

import { daysBetween } from "./engine";
import { selectLotsToClose } from "./selection";
import type {
  HoldingLot,
  HoldingLotClosure,
  LotReallocationPreview,
  ProposedClosure,
  TxRowForLots,
} from "./types";

const EPS = 1e-9;

/**
 * Minimal close-tx shape the re-plan needs. Built from the dependent
 * `transactions` rows (the sell / transfer-out legs) plus the original
 * stored closure rows (to recover proceeds + close kind, since a
 * transfer_out tx's `amount` is not a cash proceed).
 */
export interface DependentCloseInput {
  tx: TxRowForLots;
  /** The stored closure rows for this close-tx (pre-mutation), used to
   *  recover total qty closed, proceeds-per-share, and the close kind so
   *  the re-plan reproduces the same economics on the new lots. */
  originalClosures: HoldingLotClosure[];
}

export interface PlanLotReallocationInput {
  /** edit redoes the target's lots before replay; delete just removes them. */
  mutation: { op: "edit" | "delete"; targetTxId: number };
  /**
   * Post-mutation LONG+SHORT lot snapshot for every affected holding.
   * The caller has ALREADY reversed the target tx (removed its opened
   * lots; restored qty_remaining its closures had consumed) and, for an
   * edit, re-opened the edited buy's lot. Re-plan only re-closes the
   * DEPENDENT closures against this snapshot.
   */
  lots: HoldingLot[];
  /** The dependent sells/transfers to replay, chronological (oldest first). */
  dependentCloses: DependentCloseInput[];
}

/**
 * Pure re-plan. Returns the proposed closures + opened shorts + the
 * realized-gain delta per calendar year. Mutates nothing.
 */
export function planLotReallocation(
  input: PlanLotReallocationInput,
): LotReallocationPreview {
  const { dependentCloses } = input;

  // Working copy of remaining LONG inventory per holding, keyed by lot id.
  // We mutate `qtyRemaining` as we consume; shorts are never closed here.
  const workingLots = input.lots.map((l) => ({ ...l }));
  const longByHolding = new Map<number, typeof workingLots>();
  for (const l of workingLots) {
    if (l.side !== "long" || l.status !== "open" || l.qtyRemaining <= EPS) {
      continue;
    }
    const arr = longByHolding.get(l.holdingId) ?? [];
    arr.push(l);
    longByHolding.set(l.holdingId, arr);
  }

  const proposedClosures: ProposedClosure[] = [];
  const openedShortLots: LotReallocationPreview["openedShortLots"] = [];
  const affectedHoldingIds = new Set<number>();
  const dependentCloseTxIds: number[] = [];

  // Realized-gain delta accounting: sum the OLD realized gain (from the
  // original closures) and the NEW realized gain (from the proposal),
  // bucketed by close_date's calendar year.
  const oldGainByYear = new Map<string, number>();
  const newGainByYear = new Map<string, number>();
  const addGain = (m: Map<string, number>, date: string, g: number) => {
    const year = (date ?? "").slice(0, 4) || "unknown";
    m.set(year, (m.get(year) ?? 0) + g);
  };

  // Negative placeholder ids for short lots opened mid-plan (preview only).
  let shortPlaceholderId = -1;

  // Replay each dependent close-tx, in chronological order.
  for (const dep of dependentCloses) {
    const { tx, originalClosures } = dep;
    if (originalClosures.length === 0) continue;
    dependentCloseTxIds.push(tx.id);

    const holdingId = tx.portfolioHoldingId;
    const accountId = tx.accountId;
    if (holdingId == null || accountId == null) continue;
    affectedHoldingIds.add(holdingId);

    // Tally the OLD realized gain for this close-tx, by year.
    for (const oc of originalClosures) {
      addGain(oldGainByYear, oc.closeDate, oc.realizedGain);
    }

    // Recover the close economics from the original closures. All closures
    // of one close-tx share proceedsPerShare, currency, kind, closeDate.
    const totalQty = originalClosures.reduce((s, c) => s + c.qtyClosed, 0);
    const ref = originalClosures[0];
    const proceedsPerShare = ref.proceedsPerShare;
    const currency = ref.currency;
    const closeKind = ref.closeKind;
    const closeDate = ref.closeDate;
    const isTransferOut = closeKind === "transfer_out";

    // FIFO re-close against this holding's remaining long inventory.
    const longLots = longByHolding.get(holdingId) ?? [];
    const plan = selectLotsToClose({
      strategy: "FIFO",
      lots: longLots,
      targetQty: totalQty,
    });

    let remaining = totalQty;
    for (const leg of plan.legs) {
      const lot = longLots.find((l) => l.id === leg.lotId);
      if (!lot) continue;
      const qty = leg.qty;
      // transfer_out realizes 0 by construction (proceeds == cost basis).
      const effProceeds = isTransferOut ? lot.costPerShare : proceedsPerShare;
      const realizedGain = (effProceeds - lot.costPerShare) * qty;
      proposedClosures.push({
        closeTxId: tx.id,
        lotId: lot.id,
        qtyClosed: qty,
        costPerShare: lot.costPerShare,
        proceedsPerShare: effProceeds,
        realizedGain,
        closeKind,
        isNewShortLot: false,
        closeDate,
      });
      addGain(newGainByYear, closeDate, realizedGain);
      lot.qtyRemaining -= qty;
      remaining -= qty;
    }

    // Overflow → open ONE short lot at the closure's proceeds price (mirror
    // of closeLotsForSellHook's overflow branch). A transfer_out can't go
    // short — guard defensively (in practice a transfer-out never overflows
    // because its source lots are the ones being reversed, not depleted).
    if (remaining > EPS && !isTransferOut) {
      const shortCost = proceedsPerShare;
      proposedClosures.push({
        closeTxId: tx.id,
        lotId: shortPlaceholderId,
        qtyClosed: remaining,
        costPerShare: shortCost,
        proceedsPerShare,
        // Opening a short realizes nothing — the gain is booked when a
        // future buy closes it (short_close). Matches the live path.
        realizedGain: 0,
        closeKind,
        isNewShortLot: true,
        closeDate,
      });
      openedShortLots.push({
        holdingId,
        accountId,
        qty: remaining,
        costPerShare: shortCost,
        currency,
      });
      shortPlaceholderId -= 1;
      remaining = 0;
    }
  }

  // realizedGainDeltaByYear = new − old, dropping zero-delta years.
  const years = new Set<string>([
    ...oldGainByYear.keys(),
    ...newGainByYear.keys(),
  ]);
  const realizedGainDeltaByYear: Record<string, number> = {};
  for (const y of years) {
    const delta = (newGainByYear.get(y) ?? 0) - (oldGainByYear.get(y) ?? 0);
    if (Math.abs(delta) > EPS) {
      // Round to cents to avoid float dust in the surfaced figure.
      realizedGainDeltaByYear[y] = Math.round(delta * 100) / 100;
    }
  }

  return {
    affectedHoldingIds: Array.from(affectedHoldingIds).sort((a, b) => a - b),
    dependentCloseTxIds,
    proposedClosures,
    openedShortLots,
    realizedGainDeltaByYear,
  };
}

// ─── FINLYNQ-178 — SPECIFIC manual reassignment ──────────────────────────
//
// Manual lot reassignment lets the user re-point a SINGLE closure (one
// sell / transfer-out tx) onto lots of their choosing, rather than the
// automatic FIFO `planLotReallocation` does. The engine foundation already
// supports it (`selectLotsToClose({ strategy:"SPECIFIC", lotIds })` + the
// `closeLotsForSellHook` `perLotQty` path); this pure core mirrors them so
// the inspector can PREVIEW the user's pick before committing.
//
// STRICT contract (validated by the caller, asserted here too): the sum of
// `perLotQty.qty` MUST equal the closure's total qty. The plan closes
// EXACTLY the requested qty from each named lot (clamped at the lot's open
// qty) and routes any overflow (requesting more than a lot holds, or naming
// a lot with no/insufficient long inventory) into ONE short lot at the
// closure's proceeds price — identical to `closeLotsForSellHook`'s overflow
// branch (write-hooks.ts ~L388) and `planLotReallocation`'s short branch.
//
// Only the named closure's realized gain restates; the caller reverses ONLY
// that one close-tx's closures before redo, so sibling closures stay
// byte-identical (load-bearing FINLYNQ-178 invariant).

export interface PlanLotReassignmentInput {
  /** The close-tx being reassigned (the sell / transfer-out leg). */
  closeTx: TxRowForLots;
  /** That close-tx's ORIGINAL stored closures — recovers total qty,
   *  proceeds-per-share, currency, kind, close date, and the OLD realized
   *  gain for the delta accounting. */
  originalClosures: HoldingLotClosure[];
  /** User-chosen allocation: close `qty` from `lotId`, in priority order.
   *  Σ qty must equal the closure total (caller validates STRICT). */
  perLotQty: Array<{ lotId: number; qty: number }>;
  /**
   * Post-reversal LONG+SHORT lot snapshot for the holding. The caller has
   * ALREADY reversed THIS close-tx's closures (restored the qty they
   * consumed); no other tx is touched.
   */
  lots: HoldingLot[];
}

/**
 * Pure SPECIFIC reassignment planner. Drives the lot pick from `perLotQty`
 * instead of re-FIFO. Returns a `LotReallocationPreview` (proposed
 * closures + opened shorts + realized-gain delta by calendar year). Mutates
 * nothing.
 */
export function planLotReassignment(
  input: PlanLotReassignmentInput,
): LotReallocationPreview {
  const { closeTx, originalClosures, perLotQty, lots } = input;

  const empty: LotReallocationPreview = {
    affectedHoldingIds: [],
    dependentCloseTxIds: [],
    proposedClosures: [],
    openedShortLots: [],
    realizedGainDeltaByYear: {},
  };
  if (originalClosures.length === 0) return empty;

  const holdingId = closeTx.portfolioHoldingId;
  const accountId = closeTx.accountId;
  if (holdingId == null || accountId == null) return empty;

  // Recover the close economics from the original closures (all share
  // proceedsPerShare, currency, kind, closeDate).
  const ref = originalClosures[0];
  const proceedsPerShare = ref.proceedsPerShare;
  const currency = ref.currency;
  const closeKind = ref.closeKind;
  const closeDate = ref.closeDate;
  const isTransferOut = closeKind === "transfer_out";

  // Working copy of the holding's LONG inventory keyed by lot id (shorts are
  // never closed by a sell). qtyRemaining is depleted as we consume.
  const longById = new Map<number, HoldingLot>();
  for (const l of lots) {
    if (
      l.holdingId === holdingId &&
      l.side === "long" &&
      l.status === "open" &&
      l.qtyRemaining > EPS
    ) {
      longById.set(l.id, { ...l });
    }
  }

  const proposedClosures: ProposedClosure[] = [];
  const openedShortLots: LotReallocationPreview["openedShortLots"] = [];

  const oldGainByYear = new Map<string, number>();
  const newGainByYear = new Map<string, number>();
  const addGain = (m: Map<string, number>, date: string, g: number) => {
    const year = (date ?? "").slice(0, 4) || "unknown";
    m.set(year, (m.get(year) ?? 0) + g);
  };
  for (const oc of originalClosures) {
    addGain(oldGainByYear, oc.closeDate, oc.realizedGain);
  }

  let shortOverflow = 0;
  // Walk the user-chosen lots in priority order, closing EXACTLY the named
  // qty from each (clamped at the lot's open qty). A lot that's unknown /
  // short / fully consumed contributes its whole requested qty to overflow.
  for (const sel of perLotQty) {
    if (sel.qty <= EPS) continue;
    const lot = longById.get(sel.lotId);
    if (!lot) {
      shortOverflow += sel.qty;
      continue;
    }
    const closeQty = Math.min(lot.qtyRemaining, sel.qty);
    const lotOverflow = Math.max(0, sel.qty - lot.qtyRemaining);
    if (closeQty > EPS) {
      // transfer_out realizes 0 (proceeds forced to the lot's cost basis).
      const effProceeds = isTransferOut ? lot.costPerShare : proceedsPerShare;
      const realizedGain = (effProceeds - lot.costPerShare) * closeQty;
      proposedClosures.push({
        closeTxId: closeTx.id,
        lotId: lot.id,
        qtyClosed: closeQty,
        costPerShare: lot.costPerShare,
        proceedsPerShare: effProceeds,
        realizedGain,
        closeKind,
        isNewShortLot: false,
        closeDate,
      });
      addGain(newGainByYear, closeDate, realizedGain);
      lot.qtyRemaining -= closeQty;
    }
    shortOverflow += lotOverflow;
  }

  // Overflow → ONE short lot at the proceeds price (mirror of
  // closeLotsForSellHook / planLotReallocation). transfer_out can't short.
  if (shortOverflow > EPS && !isTransferOut) {
    proposedClosures.push({
      closeTxId: closeTx.id,
      lotId: -1, // negative placeholder for the preview
      qtyClosed: shortOverflow,
      costPerShare: proceedsPerShare,
      proceedsPerShare,
      realizedGain: 0, // opening a short realizes nothing
      closeKind,
      isNewShortLot: true,
      closeDate,
    });
    openedShortLots.push({
      holdingId,
      accountId,
      qty: shortOverflow,
      costPerShare: proceedsPerShare,
      currency,
    });
  }

  const years = new Set<string>([
    ...oldGainByYear.keys(),
    ...newGainByYear.keys(),
  ]);
  const realizedGainDeltaByYear: Record<string, number> = {};
  for (const y of years) {
    const delta = (newGainByYear.get(y) ?? 0) - (oldGainByYear.get(y) ?? 0);
    if (Math.abs(delta) > EPS) {
      realizedGainDeltaByYear[y] = Math.round(delta * 100) / 100;
    }
  }

  return {
    affectedHoldingIds: [holdingId],
    dependentCloseTxIds: [closeTx.id],
    proposedClosures,
    openedShortLots,
    realizedGainDeltaByYear,
  };
}

/**
 * Helper kept here (not engine.ts) because it's re-plan-specific: re-export
 * daysBetween so the DB orchestrator computing `daysHeld` for the new
 * closures shares the engine's calendar-day math.
 */
export { daysBetween };
