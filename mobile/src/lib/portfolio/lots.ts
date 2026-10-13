// Sales of one position and the lots they used: pure helpers for the screen
// that changes which lots a sale was matched to.
//
// A sale can be matched to several lots (one closure per lot). The server
// re-points ONE sale at a time and insists the chosen quantities add up to
// exactly what was sold, so the numbers are worked out here before asking.

import type { HoldingLot, LotClosure } from "../../../../shared/types";

/** Share counts are compared to this tolerance (the server's own). */
export const LOT_EPS = 1e-6;

export interface LotSale {
  closeTxId: number;
  closeDate: string;
  /** "sell" can be re-matched; a transfer out or a short close cannot. */
  closeKind: string;
  qty: number;
  proceedsPerShare: number;
  realizedGain: number;
  currency: string;
  closures: LotClosure[];
}

/** Closures grouped into the sales that made them, newest sale first. */
export function groupSales(closures: readonly LotClosure[]): LotSale[] {
  const byTx = new Map<number, LotSale>();
  for (const c of closures) {
    let sale = byTx.get(c.closeTxId);
    if (!sale) {
      sale = {
        closeTxId: c.closeTxId,
        closeDate: c.closeDate,
        closeKind: c.closeKind,
        qty: 0,
        proceedsPerShare: c.proceedsPerShare,
        realizedGain: 0,
        currency: c.currency,
        closures: [],
      };
      byTx.set(c.closeTxId, sale);
    }
    sale.qty += c.qtyClosed;
    sale.realizedGain += c.realizedGain;
    sale.closures.push(c);
  }
  return [...byTx.values()].sort((a, b) =>
    a.closeDate === b.closeDate ? b.closeTxId - a.closeTxId : a.closeDate < b.closeDate ? 1 : -1,
  );
}

export const isReassignableSale = (sale: Pick<LotSale, "closeKind">) => sale.closeKind === "sell";

export interface SaleLotChoice {
  lot: HoldingLot;
  /** Shares this sale takes from the lot today. */
  current: number;
  /** The most this sale could take: what the lot still holds plus what the sale already uses. */
  available: number;
}

/**
 * The lots a sale can be matched to: long lots it already uses, plus long lots
 * bought on or before the sale date that still hold shares. Oldest first.
 *
 * A lot the sale has used up completely has nothing remaining, but it must
 * still be listed: taking shares back off it is the whole point of the screen.
 */
export function saleLotChoices(lots: readonly HoldingLot[], sale: LotSale): SaleLotChoice[] {
  const current = new Map<number, number>();
  for (const c of sale.closures) current.set(c.lotId, (current.get(c.lotId) ?? 0) + c.qtyClosed);

  const out: SaleLotChoice[] = [];
  for (const lot of lots) {
    if (lot.side !== "long") continue;
    const used = current.get(lot.id) ?? 0;
    const remaining = lot.status === "open" ? Math.max(lot.qtyRemaining, 0) : 0;
    if (used <= LOT_EPS && (remaining <= LOT_EPS || lot.openDate > sale.closeDate)) continue;
    out.push({ lot, current: used, available: remaining + used });
  }
  return out.sort((a, b) =>
    a.lot.openDate === b.lot.openDate ? a.lot.id - b.lot.id : a.lot.openDate < b.lot.openDate ? -1 : 1,
  );
}

/** The form's starting point: the sale's allocation as it stands, as text per lot. */
export function seedAllocation(sale: LotSale): Record<number, string> {
  const out: Record<number, string> = {};
  for (const c of sale.closures) {
    const next = (out[c.lotId] ? Number(out[c.lotId]) : 0) + c.qtyClosed;
    out[c.lotId] = String(Math.round(next * 1e6) / 1e6);
  }
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

/** True when nothing would change: the same lots with the same quantities. */
export function allocationUnchanged(alloc: Readonly<Record<number, string>>, sale: LotSale): boolean {
  const seed = seedAllocation(sale);
  const ids = new Set([...Object.keys(alloc), ...Object.keys(seed)]);
  for (const id of ids) {
    if (Math.abs(qtyOf(alloc[Number(id)]) - qtyOf(seed[Number(id)])) > LOT_EPS) return false;
  }
  return true;
}
