/**
 * A holding's average cost, cost basis and realized gain under either
 * cost-basis method (2026-10-13). Pure — no DB, no fetch.
 *
 * The three MCP portfolio read tools (get_portfolio_analysis,
 * get_portfolio_performance, analyze_holding) each carried their own copy of
 * the simple formula and none of them followed the user's method, so an
 * assistant kept reporting the simple average after the user had switched to
 * lot allocation. They all call `costMetrics` now.
 */

import { isDustQuantity } from "./dust";

/** Buy/sell tallies of one holding, as the aggregators already produce them. */
export type TradeTallies = {
  buyQty: number;
  buyAmt: number;
  sellQty: number;
  sellAmt: number;
  /** Shares still held (net quantity). */
  remainingQty: number;
};

/** What the lots say about one holding: shares still held, their cost, and gains realized so far. */
export type LotCost = {
  qty: number;
  costBasis: number;
  realizedGain: number;
  /** Cost of the lots still held in the reporting currency, each lot at the
   *  rate on its own open date. Present only when the loader was asked for it. */
  costBasisReporting?: number;
};

export type CostMetrics = {
  avgCost: number | null;
  costBasis: number | null;
  realizedGain: number;
};

export type CostBasisMethod = "simple_average" | "advanced_lot_allocation";

/**
 * Simple method: the average price of EVERY purchase, including shares since
 * sold. Cost basis is that average times the shares held; a sale's gain is its
 * proceeds less the same average.
 */
export function simpleCostMetrics(t: TradeTallies): CostMetrics {
  const avgCost = t.buyQty > 0 ? t.buyAmt / t.buyQty : null;
  return {
    avgCost,
    costBasis: avgCost !== null && t.remainingQty > 0 ? t.remainingQty * avgCost : null,
    realizedGain: avgCost !== null ? t.sellAmt - t.sellQty * avgCost : 0,
  };
}

/**
 * The figures for one holding. With `lot` (the user is on lot allocation and
 * this holding has lots) cost basis is the cost of the lots still held and the
 * realized gain is what its sales actually closed; a position with no shares
 * left has no cost basis. Without `lot` it is the simple method.
 *
 * Same rule as `/api/portfolio/overview`, so the page and the tools agree.
 */
export function costMetrics(t: TradeTallies, lot?: LotCost): CostMetrics {
  if (!lot) return simpleCostMetrics(t);
  const held = lot.qty > 1e-9;
  return {
    avgCost: held ? lot.costBasis / lot.qty : null,
    costBasis: held ? lot.costBasis : null,
    realizedGain: lot.realizedGain,
  };
}

/**
 * Lot figures carried into another currency at one rate. Lots are kept in the
 * position row's own currency, so a caller that sets them against a market
 * value quoted in a different currency (a Toronto-listed fund held on a USD
 * row) converts them first. Share counts have no currency and stay as they are.
 */
export function lotCostInCurrency(lot: LotCost, rate: number): LotCost {
  if (rate === 1) return lot;
  // The reporting-currency cost does not depend on the holding's currency.
  return {
    qty: lot.qty,
    costBasis: lot.costBasis * rate,
    realizedGain: lot.realizedGain * rate,
    costBasisReporting: lot.costBasisReporting,
  };
}

/**
 * Lot figures for a holding that spans several position rows (one name held in
 * two accounts). Undefined unless EVERY row has lot figures: mixing a lot-based
 * row with a simple one would give a number that is neither.
 */
export function combineLotCost(
  byHolding: ReadonlyMap<number, LotCost> | null,
  holdingIds: readonly number[],
): LotCost | undefined {
  if (!byHolding || holdingIds.length === 0) return undefined;
  const out: LotCost = { qty: 0, costBasis: 0, realizedGain: 0 };
  for (const id of holdingIds) {
    const lot = byHolding.get(id);
    if (!lot) return undefined;
    out.qty += lot.qty;
    out.costBasis += lot.costBasis;
    out.realizedGain += lot.realizedGain;
  }
  return out;
}

/**
 * A rounding leftover is a closed position (rule in `dust.ts`, the same one
 * the Portfolio page applies): quantity 0, no cost basis, no average cost.
 * Realized gain is a flow and stays as computed. The MCP tools have no live
 * price, so the average purchase price stands in for the value test.
 */
export function closeDustPosition(
  netQty: number,
  metrics: CostMetrics,
  avgPurchasePrice: number | null,
): CostMetrics & { remainingQty: number } {
  const dust = netQty !== 0 && isDustQuantity(netQty, { price: metrics.avgCost ?? avgPurchasePrice });
  return dust
    ? { ...metrics, avgCost: null, costBasis: null, remainingQty: 0 }
    : { ...metrics, remainingQty: netQty };
}
