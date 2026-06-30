/**
 * FINLYNQ — whole-ticker lot allocation editor (pure planner).
 *
 * The atomic, holding-wide successor to FINLYNQ-178's single-closure
 * `planLotReassignment`. Where reassignment re-points ONE sell, this plans
 * the allocation of EVERY editable sell on a (security, account) at once:
 * the user supplies, per sell, how many shares to close from each lot, and
 * this computes the resulting closures + opened shorts + restated realized
 * gain (total, long/short-term split, by calendar year).
 *
 * PURE — no DB I/O. The DB orchestrator `applyHoldingAllocation`
 * (write-hooks.ts) validates a spec through this, and on commit reverses
 * every editable sell then re-closes each via `closeLotsForSellHook`'s
 * `perLotQty` path. This planner MIRRORS that path exactly so preview ==
 * commit:
 *   - sells are processed in chronological order against a running
 *     per-lot remaining pool (a lot consumed by an earlier sell is gone for
 *     a later one);
 *   - for each (lot, qty) the closed portion is `min(remaining, qty)` and
 *     the realized gain is `(proceeds − cost) × closedQty`;
 *   - the per-sell overflow (Σ requested − Σ closable) opens ONE short lot
 *     at the sell's proceeds price (realizing 0 at open).
 *
 * Validation is STRICT (the orchestrator writes NOTHING when `ok=false`):
 *   - every sell's Σ requested qty must equal its total closed qty;
 *   - every referenced lot must be a known long lot in scope;
 *   - a lot may not be allocated to a sell dated BEFORE the lot opened (the
 *     out-of-order guard — allocating a future lot would re-create the
 *     phantom-short bug this whole feature exists to prevent).
 */

import { daysBetween } from "./engine";

const EPS = 1e-6;
const TERM_BOUNDARY_DAYS = 365;

/** A long lot available as an allocation target. `available` is the lot's
 *  capacity for SELL closures = qtyOriginal − Σ(non-sell closures on it). */
export interface AllocLot {
  id: number;
  openDate: string;
  available: number;
  costPerShare: number;
  currency: string;
}

/** One editable sell close-tx (a column in the matrix). `proceedsPerShare`
 *  is the per-share proceeds the engine recorded for this sell. */
export interface AllocSell {
  closeTxId: number;
  closeDate: string;
  proceedsPerShare: number;
  qty: number;
  currency: string;
}

/** spec[closeTxId] = the user's chosen per-lot allocation for that sell.
 *  A `lotId <= 0` entry is an EXPLICIT "open a short for this qty" — the way
 *  the matrix represents the short remainder of an oversell (and how the
 *  user flips long↔short). It mirrors `closeLotsForSellHook`'s perLotQty
 *  path, where a non-long lotId routes its qty straight to the short. */
export type AllocSpec = Record<number, Array<{ lotId: number; qty: number }>>;

/** Sentinel lotId for an explicit open-short allocation entry. */
export const SHORT_LOT_ID = 0;

export interface AllocClosure {
  closeTxId: number;
  /** The lot consumed; null when this row is a freshly-opened short. */
  lotId: number | null;
  qtyClosed: number;
  costPerShare: number;
  proceedsPerShare: number;
  realizedGain: number;
  term: "short" | "long";
  closeDate: string;
  isNewShort: boolean;
}

export type AllocErrorCode =
  | "qty_mismatch"
  | "lot_not_in_scope"
  | "lot_not_eligible"
  | "negative_qty";

export interface AllocPlan {
  ok: boolean;
  errors: string[];
  errorCode?: AllocErrorCode;
  closures: AllocClosure[];
  openedShorts: Array<{
    closeTxId: number;
    qty: number;
    costPerShare: number;
    currency: string;
  }>;
  totals: {
    realizedGain: number;
    longTerm: number;
    shortTerm: number;
    byYear: Record<string, number>;
    /** Σ over lots of the un-consumed remaining (still-open shares). */
    openShares: number;
  };
}

export interface PlanHoldingAllocationInput {
  lots: AllocLot[];
  sells: AllocSell[];
  spec: AllocSpec;
}

export function planHoldingAllocation(
  input: PlanHoldingAllocationInput,
): AllocPlan {
  const errors: string[] = [];
  let errorCode: AllocErrorCode | undefined;
  const setErr = (code: AllocErrorCode, msg: string) => {
    errorCode = errorCode ?? code;
    errors.push(msg);
  };

  const lotById = new Map(input.lots.map((l) => [l.id, l]));
  const remaining = new Map(input.lots.map((l) => [l.id, l.available]));

  const closures: AllocClosure[] = [];
  const openedShorts: AllocPlan["openedShorts"] = [];
  const byYear: Record<string, number> = {};
  let total = 0;
  let longTerm = 0;
  let shortTerm = 0;

  // Chronological — mirror the commit's re-close order so the running pool
  // depletes identically.
  const sells = [...input.sells].sort(
    (a, b) => a.closeDate.localeCompare(b.closeDate) || a.closeTxId - b.closeTxId,
  );

  for (const sell of sells) {
    const entries = (input.spec[sell.closeTxId] ?? []).filter(
      (e) => Math.abs(e.qty) > EPS,
    );

    const requested = entries.reduce((s, e) => s + e.qty, 0);
    if (Math.abs(requested - sell.qty) > EPS) {
      setErr(
        "qty_mismatch",
        `Sell #${sell.closeTxId}: allocated ${round(requested)} sh must equal ${round(sell.qty)} sh.`,
      );
    }

    let shortOverflow = 0;
    for (const e of entries) {
      if (e.qty < 0) {
        setErr("negative_qty", `Sell #${sell.closeTxId}: negative quantity.`);
        continue;
      }
      // Explicit "open short" entry — the matrix's short remainder. No lot
      // is consumed; the qty becomes part of this sell's short overflow.
      if (e.lotId <= SHORT_LOT_ID) {
        shortOverflow += e.qty;
        continue;
      }
      const lot = lotById.get(e.lotId);
      if (!lot) {
        setErr(
          "lot_not_in_scope",
          `Sell #${sell.closeTxId}: lot #${e.lotId} is not a long lot in this holding/account.`,
        );
        shortOverflow += e.qty;
        continue;
      }
      if (lot.openDate > sell.closeDate) {
        setErr(
          "lot_not_eligible",
          `Sell #${sell.closeTxId} (${sell.closeDate}): lot #${lot.id} opened later (${lot.openDate}) — it can't be sold before it was bought.`,
        );
        shortOverflow += e.qty;
        continue;
      }
      const rem = remaining.get(lot.id) ?? 0;
      const closeQty = Math.min(rem, e.qty);
      const overflow = e.qty - closeQty;
      if (closeQty > EPS) {
        const gain = (sell.proceedsPerShare - lot.costPerShare) * closeQty;
        const days = daysBetween(lot.openDate, sell.closeDate);
        const term: "short" | "long" =
          days > TERM_BOUNDARY_DAYS ? "long" : "short";
        closures.push({
          closeTxId: sell.closeTxId,
          lotId: lot.id,
          qtyClosed: closeQty,
          costPerShare: lot.costPerShare,
          proceedsPerShare: sell.proceedsPerShare,
          realizedGain: gain,
          term,
          closeDate: sell.closeDate,
          isNewShort: false,
        });
        total += gain;
        if (term === "long") longTerm += gain;
        else shortTerm += gain;
        const yr = sell.closeDate.slice(0, 4) || "unknown";
        byYear[yr] = (byYear[yr] ?? 0) + gain;
        remaining.set(lot.id, rem - closeQty);
      }
      shortOverflow += overflow;
    }

    if (shortOverflow > EPS) {
      openedShorts.push({
        closeTxId: sell.closeTxId,
        qty: shortOverflow,
        costPerShare: sell.proceedsPerShare,
        currency: sell.currency,
      });
      closures.push({
        closeTxId: sell.closeTxId,
        lotId: null,
        qtyClosed: shortOverflow,
        costPerShare: sell.proceedsPerShare,
        proceedsPerShare: sell.proceedsPerShare,
        realizedGain: 0,
        term: "short",
        closeDate: sell.closeDate,
        isNewShort: true,
      });
    }
  }

  let openShares = 0;
  for (const v of remaining.values()) if (v > EPS) openShares += v;

  return {
    ok: errors.length === 0,
    errors,
    errorCode,
    closures,
    openedShorts,
    totals: { realizedGain: total, longTerm, shortTerm, byYear, openShares },
  };
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
