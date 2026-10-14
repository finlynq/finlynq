// Sales of one position and the lots they used: pure helpers for the screen
// that changes which lots a sale was matched to.
//
// A sale can be matched to several lots (one closure per lot). The server
// re-points ONE sale at a time and insists the chosen quantities add up to
// exactly what was sold, so the numbers are worked out here before asking.
//
// Mirrors the web's `pf-app/src/lib/portfolio/lots/sale-lot-choices.ts` (keep
// the two in sync). Two server rules from 2026-10-14 live here too:
//   - a lot bought AFTER the sale can't be newly chosen; one the sale already
//     uses (trades entered out of date order) may keep at most what it takes;
//   - a sale that sold more than was held opened a short for the rest. That
//     part has no lot: it is sent as lot 0 (`SHORT_LOT_ID`) and the total is
//     the WHOLE sale. Once a later purchase has closed any of that short the
//     server refuses to re-match the sale (it would undo that purchase).

import type { HoldingLot, LotClosure } from "../../../../shared/types";

/** Share counts are compared to this tolerance (the server's own). */
export const LOT_EPS = 1e-6;

/** Lot id for the part of a sale sold short (no lot to take it from). */
export const SHORT_LOT_ID = 0;

export interface LotSale {
  closeTxId: number;
  closeDate: string;
  /** "sell" can be re-matched; a transfer out or a short close cannot. */
  closeKind: string;
  /** Everything the sale sold: `fromLots` + `soldShort`. */
  qty: number;
  /** Units taken from lots (its closures). */
  fromLots: number;
  /** Units sold beyond what was held: the short the sale opened. */
  soldShort: number;
  /** How many of those a later purchase has already closed. */
  shortCovered: number;
  proceedsPerShare: number;
  realizedGain: number;
  currency: string;
  closures: LotClosure[];
}

/** The short a sale opened for the part no lot covered (zeros when none). */
export function shortOpenedBySale(
  lots: readonly Pick<HoldingLot, "openTxId" | "side" | "qtyOriginal" | "qtyRemaining">[],
  closeTxId: number,
): { qty: number; covered: number } {
  let qty = 0;
  let covered = 0;
  for (const l of lots) {
    if (l.side !== "short" || l.openTxId !== closeTxId) continue;
    qty += l.qtyOriginal;
    covered += Math.max(0, l.qtyOriginal - l.qtyRemaining);
  }
  return { qty: Math.round(qty * 1e6) / 1e6, covered: Math.round(covered * 1e6) / 1e6 };
}

/**
 * Closures grouped into the sales that made them, newest sale first. Pass the
 * position's lots so a sale that sold short counts that part too.
 */
export function groupSales(closures: readonly LotClosure[], lots: readonly HoldingLot[] = []): LotSale[] {
  const byTx = new Map<number, LotSale>();
  for (const c of closures) {
    let sale = byTx.get(c.closeTxId);
    if (!sale) {
      const short = shortOpenedBySale(lots, c.closeTxId);
      sale = {
        closeTxId: c.closeTxId,
        closeDate: c.closeDate,
        closeKind: c.closeKind,
        qty: short.qty,
        fromLots: 0,
        soldShort: short.qty,
        shortCovered: short.covered,
        proceedsPerShare: c.proceedsPerShare,
        realizedGain: 0,
        currency: c.currency,
        closures: [],
      };
      byTx.set(c.closeTxId, sale);
    }
    sale.qty += c.qtyClosed;
    sale.fromLots += c.qtyClosed;
    sale.realizedGain += c.realizedGain;
    sale.closures.push(c);
  }
  return [...byTx.values()].sort((a, b) =>
    a.closeDate === b.closeDate ? b.closeTxId - a.closeTxId : a.closeDate < b.closeDate ? 1 : -1,
  );
}

export const isReassignableSale = (sale: Pick<LotSale, "closeKind">) => sale.closeKind === "sell";

/** A later purchase has closed part of the short this sale opened: the server
 *  won't re-match it. */
export const shortAlreadyCovered = (sale: Pick<LotSale, "shortCovered">) => sale.shortCovered > LOT_EPS;

export interface SaleLotChoice {
  lot: HoldingLot;
  /** Shares this sale takes from the lot today. */
  current: number;
  /** The most this sale may take: what the lot still holds plus what the sale
   *  already uses, or, for a lot bought after the sale, only what it uses. */
  available: number;
  /** Bought after the sale (an out-of-order leftover the sale already uses). */
  boughtAfterSale: boolean;
}

/**
 * The lots a sale can be matched to: long lots it already uses, plus long lots
 * bought on or before the sale date that still hold shares. Oldest first.
 *
 * A lot the sale has used up completely has nothing remaining, but it must
 * still be listed: taking shares back off it is the whole point of the screen.
 * A lot bought after the sale is listed only when the sale already uses it,
 * and may keep at most that much (the server refuses more).
 */
export function saleLotChoices(
  lots: readonly HoldingLot[],
  sale: Pick<LotSale, "closeDate" | "closures">,
): SaleLotChoice[] {
  const current = new Map<number, number>();
  for (const c of sale.closures) current.set(c.lotId, (current.get(c.lotId) ?? 0) + c.qtyClosed);

  const out: SaleLotChoice[] = [];
  for (const lot of lots) {
    if (lot.side !== "long") continue;
    const used = current.get(lot.id) ?? 0;
    const boughtAfterSale = lot.openDate > sale.closeDate;
    if (boughtAfterSale) {
      if (used > LOT_EPS) out.push({ lot, current: used, available: used, boughtAfterSale });
      continue;
    }
    const remaining = lot.status === "open" ? Math.max(lot.qtyRemaining, 0) : 0;
    if (used <= LOT_EPS && remaining <= LOT_EPS) continue;
    out.push({ lot, current: used, available: remaining + used, boughtAfterSale });
  }
  return out.sort((a, b) =>
    a.lot.openDate === b.lot.openDate ? a.lot.id - b.lot.id : a.lot.openDate < b.lot.openDate ? -1 : 1,
  );
}

/** The form's starting point: the sale's allocation as it stands, as text per
 *  lot, with any part sold short under `SHORT_LOT_ID`. */
export function seedAllocation(sale: Pick<LotSale, "closures" | "soldShort">): Record<number, string> {
  const out: Record<number, string> = {};
  for (const c of sale.closures) {
    const next = (out[c.lotId] ? Number(out[c.lotId]) : 0) + c.qtyClosed;
    out[c.lotId] = String(Math.round(next * 1e6) / 1e6);
  }
  if (sale.soldShort > LOT_EPS) out[SHORT_LOT_ID] = String(sale.soldShort);
  return out;
}

const qtyOf = (text: string | undefined) => {
  const n = Number((text ?? "").trim().replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Shares chosen across all lots. */
export function allocationTotal(alloc: Readonly<Record<number, string>>): number {
  return Object.values(alloc).reduce((s, v) => s + qtyOf(v), 0);
}

/** The request's per-lot quantities: every lot with a positive figure. */
export function buildPerLotQty(alloc: Readonly<Record<number, string>>): { lotId: number; qty: number }[] {
  return Object.entries(alloc)
    .map(([lotId, v]) => ({ lotId: Number(lotId), qty: qtyOf(v) }))
    .filter((p) => p.qty > LOT_EPS);
}

/** True when the chosen shares add up to exactly what the sale sold. */
export function allocationMatches(alloc: Readonly<Record<number, string>>, sale: Pick<LotSale, "qty">): boolean {
  return Math.abs(allocationTotal(alloc) - sale.qty) <= LOT_EPS;
}

/** A lot bought after the sale asked for more than the sale already takes
 *  from it: the server would refuse, so the form must not send it. */
export function laterLotOverLimit(
  alloc: Readonly<Record<number, string>>,
  choices: readonly SaleLotChoice[],
): boolean {
  return choices.some((ch) => ch.boughtAfterSale && qtyOf(alloc[ch.lot.id]) > ch.available + LOT_EPS);
}

/** True when nothing would change: the same lots with the same quantities. */
export function allocationUnchanged(
  alloc: Readonly<Record<number, string>>,
  sale: Pick<LotSale, "closures" | "soldShort">,
): boolean {
  const seed = seedAllocation(sale);
  const ids = new Set([...Object.keys(alloc), ...Object.keys(seed)]);
  for (const id of ids) {
    if (Math.abs(qtyOf(alloc[Number(id)]) - qtyOf(seed[Number(id)])) > LOT_EPS) return false;
  }
  return true;
}
