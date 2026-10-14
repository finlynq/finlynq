/**
 * Which lots ONE sale can be matched to. Pure and client-safe (no DB), so the
 * web Lot inspector's editor and the server's reassign check
 * (`reassignClosureLots`, behind REST `/lots/reassign` and MCP
 * `manage_lots(op:"reassign")`) apply the same rule.
 *
 * The rule (mirrored on mobile in `mobile/src/lib/portfolio/lots.ts`
 * `saleLotChoices`, keep the two in sync):
 *   - long lots only;
 *   - every lot the sale already uses is listed, even one it used up
 *     completely (status closed, nothing remaining): taking shares back off
 *     that lot is the commonest re-match there is;
 *   - other lots are listed when they still hold shares AND were bought on or
 *     before the sale date. A sale cannot use shares bought after it.
 *   - what the sale may take from a lot = what the lot still holds + what this
 *     sale already takes from it (reversing the sale gives those back).
 *
 * One exception to the date rule: trades entered out of date order can leave a
 * sale already matched to a lot bought AFTER it (the inspector's
 * `openAfterClose` warning). That lot stays listed so the sale can be fixed,
 * but it can only keep up to what it already takes, never more (the mobile
 * mirror applies the same cap since mobile 1.0.24).
 *
 * A sale that sold more than was held opened a SHORT lot for the rest
 * (`openTxId` = the sale). That part has no lot to take from: it is entered
 * as allocate.ts `SHORT_LOT_ID` (0), the whole-ticker matrix's convention, and the total
 * a re-match must reach is the WHOLE sale (from lots + sold short). Once a
 * later buy has closed some of that short, the sale can't be re-matched:
 * reversing it deletes the short lot and, by cascade, that buy's closing of
 * it, which nothing replays. `shortOpenedBySale` reports both.
 */

/** Share counts are compared to this tolerance (the reassign route's own). */
export const SALE_LOT_EPS = 1e-6;

/** The lot fields the rule reads. Both the inspector's rows and the engine's
 *  `HoldingLot` satisfy it. */
export interface ChoosableLot {
  id: number;
  openDate: string;
  side: string;
  status: string;
  qtyRemaining: number;
}

/** One closure of the sale: which lot, how many shares. */
export interface SaleClosureRef {
  lotId: number;
  qtyClosed: number;
}

export interface SaleLotChoice<L extends ChoosableLot> {
  lot: L;
  /** Shares this sale takes from the lot today. */
  current: number;
  /** The most this sale may take from the lot. */
  available: number;
  /** The lot was bought after the sale (an out-of-order leftover). */
  boughtAfterSale: boolean;
}

/** Shares the sale currently takes from each lot. */
export function sharesTakenByLot(closures: readonly SaleClosureRef[]): Map<number, number> {
  const taken = new Map<number, number>();
  for (const c of closures) taken.set(c.lotId, (taken.get(c.lotId) ?? 0) + c.qtyClosed);
  return taken;
}

/** The lots a sale can be matched to, oldest first (see the module comment). */
export function saleLotChoices<L extends ChoosableLot>(
  lots: readonly L[],
  sale: { closeDate: string; closures: readonly SaleClosureRef[] },
): SaleLotChoice<L>[] {
  const taken = sharesTakenByLot(sale.closures);
  const out: SaleLotChoice<L>[] = [];
  for (const lot of lots) {
    if (lot.side !== "long") continue;
    const current = taken.get(lot.id) ?? 0;
    const used = current > SALE_LOT_EPS;
    const boughtAfterSale = lot.openDate > sale.closeDate;
    if (boughtAfterSale) {
      if (used) out.push({ lot, current, available: current, boughtAfterSale });
      continue;
    }
    const remaining = lot.status === "open" ? Math.max(lot.qtyRemaining, 0) : 0;
    if (!used && remaining <= SALE_LOT_EPS) continue;
    out.push({ lot, current, available: remaining + current, boughtAfterSale });
  }
  return out.sort((a, b) =>
    a.lot.openDate === b.lot.openDate ? a.lot.id - b.lot.id : a.lot.openDate < b.lot.openDate ? -1 : 1,
  );
}

export interface LotBoughtAfterSale {
  lotId: number;
  lotOpenDate: string;
  closeDate: string;
  /** Shares asked of the lot (summed, in case the request names it twice). */
  requested: number;
  /** Shares the sale already takes from it: the most it may keep. */
  alreadyTaken: number;
}

/**
 * The first requested lot that was bought after the sale and is asked for more
 * than the sale already takes from it, or null when every choice is allowed.
 * Lots missing from `lots` are skipped (scope is checked separately).
 */
export function findLotBoughtAfterSale(args: {
  closeDate: string;
  lots: readonly { id: number; openDate: string }[];
  closures: readonly SaleClosureRef[];
  perLotQty: readonly { lotId: number; qty: number }[];
}): LotBoughtAfterSale | null {
  const openDateById = new Map(args.lots.map((l) => [l.id, l.openDate]));
  const taken = sharesTakenByLot(args.closures);
  const requested = new Map<number, number>();
  for (const p of args.perLotQty) {
    if (p.qty > SALE_LOT_EPS) requested.set(p.lotId, (requested.get(p.lotId) ?? 0) + p.qty);
  }
  for (const [lotId, qty] of requested) {
    const lotOpenDate = openDateById.get(lotId);
    if (lotOpenDate == null || lotOpenDate <= args.closeDate) continue;
    const alreadyTaken = taken.get(lotId) ?? 0;
    if (qty > alreadyTaken + SALE_LOT_EPS) {
      return {
        lotId,
        lotOpenDate,
        closeDate: args.closeDate,
        requested: Math.round(qty * 1e6) / 1e6,
        alreadyTaken: Math.round(alreadyTaken * 1e6) / 1e6,
      };
    }
  }
  return null;
}

export interface ShortOpenedBySale {
  /** Shares the sale sold beyond what was held (its short lots' original size). */
  qty: number;
  /** How many of those a later buy has already closed. */
  covered: number;
}

/** The short a sale opened for the part no lot covered (zeros when none). */
export function shortOpenedBySale(
  lots: readonly { openTxId: number; side: string; qtyOriginal: number; qtyRemaining: number }[],
  closeTxId: number,
): ShortOpenedBySale {
  let qty = 0;
  let covered = 0;
  for (const l of lots) {
    if (l.side !== "short" || l.openTxId !== closeTxId) continue;
    qty += l.qtyOriginal;
    covered += Math.max(0, l.qtyOriginal - l.qtyRemaining);
  }
  return { qty: Math.round(qty * 1e6) / 1e6, covered: Math.round(covered * 1e6) / 1e6 };
}
