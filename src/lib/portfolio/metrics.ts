/**
 * The consolidation. Replaces the avg-cost math duplicated across the
 * three portfolio aggregators (REST /api/portfolio/overview,
 * src/lib/holdings-value.ts, MCP HTTP register-tools-pg.ts::aggregateHoldings)
 * with a single source of truth that reads from holding_lots +
 * holding_lot_closures.
 *
 * Pure function — caller assembles the inputs (lots, closures, dividends
 * map, prices map, FX converter, asOfDate). Returns one row per
 * (holdingId, accountId) pair in the input.
 *
 * Reporting-currency conversion is the caller's job. The metrics layer
 * returns values in the HOLDING's currency (mirrors lots.currency,
 * matches the issue #129 normalization). The three aggregators each
 * apply their own reporting-currency FX hop downstream — REST sums to
 * the user's display currency, holdings-value.ts converts to the
 * account currency, the MCP HTTP variant respects the tool's
 * `reportingCurrency` param.
 *
 * Coverage of load-bearing invariants:
 *   #25   per-(holding, account) grain — the input arrays are pre-scoped;
 *         the function does NOT pool across accounts (no ACB pooling).
 *   #84   dividends are NOT lot-derived — they come from the caller's
 *         category-id aggregation of `transactions`. Lots only carry
 *         cost basis + realized gain.
 *   #96   #128  #129  #236 — already baked into the closures' stored
 *         realized_gain (engine.ts handles substitution + skip + per-ccy
 *         + qty>0 keying).
 */

import type {
  HoldingLot,
  HoldingLotClosure,
  PerHoldingMetrics,
} from "./lots/types";

/**
 * FX converter signature. Sync — callers pre-resolve every needed
 * (from, to) pair into a Map and pass a lookup closure here. Returns 1
 * when from === to.
 */
export type FxConverter = (
  amount: number,
  from: string,
  to: string,
) => number;

/**
 * Caller-supplied dividends. Keyed by `${holdingId}:${accountId}`. Values
 * are in the HOLDING's currency (caller FX-converts before bucketing).
 *
 * `ytd` is the calendar-year-to-date sum (transactions.date >= Jan 1 of
 * asOfDate's year); `allTime` is everything <= asOfDate.
 */
export type DividendsMap = Map<
  string,
  { ytd: number; allTime: number; currency: string }
>;

/**
 * Caller-supplied market prices keyed by holdingId. Values are in
 * `currency` (typically the holding's currency, but the metrics layer
 * FXes if not).
 */
export type PriceMap = Map<number, { price: number; currency: string }>;

export interface ComputeHoldingMetricsInput {
  lots: HoldingLot[];
  closures: HoldingLotClosure[];
  dividends: DividendsMap;
  prices: PriceMap;
  fx: FxConverter;
  /** YYYY-MM-DD; lots opened after this date are excluded (backfill / historical snapshots). */
  asOfDate: string;
  /** Holding-id → holding-currency map (so we can pin output currency). */
  holdingCurrencies: Map<number, string>;
  /**
   * FINLYNQ-279: when set, each open lot's cost basis is ALSO valued in this
   * currency at the historical rate on the lot's `open_date` via `fxAtDate`,
   * summed into `PerHoldingMetrics.costBasisReporting`. Omit to make
   * costBasisReporting === costBasis (native), a byte-identical no-op for the
   * callers that don't need the reporting-currency (FX-on-cost) basis.
   */
  reportingCurrency?: string;
  /**
   * Historical FX converter: rate on a SPECIFIC date (the lot's open date),
   * used only for `costBasisReporting`. Callers pre-resolve every distinct
   * (lotCcy, reportingCcy, openDate) triple into a map and pass a lookup here.
   */
  fxAtDate?: (amount: number, from: string, to: string, date: string) => number;
}

export function computeHoldingMetricsFromLots(
  input: ComputeHoldingMetricsInput,
): PerHoldingMetrics[] {
  const { lots, closures, dividends, prices, fx, asOfDate, holdingCurrencies, reportingCurrency, fxAtDate } = input;
  const yearStart = `${asOfDate.slice(0, 4)}-01-01`;

  // Group lots + closures by (holdingId, accountId). Both arrays are
  // pre-scoped to the user; the function does no user filtering.
  const byKey = new Map<
    string,
    {
      holdingId: number;
      accountId: number;
      lots: HoldingLot[];
      closures: HoldingLotClosure[];
    }
  >();

  const keyOf = (h: number, a: number) => `${h}:${a}`;

  // O(N) index for closure → lot lookup. Closures carry lot_id only;
  // we need (holding, account) to bucket them.
  const lotsById = new Map<number, HoldingLot>();
  for (const l of lots) lotsById.set(l.id, l);

  for (const l of lots) {
    if (l.openDate > asOfDate) continue;
    const k = keyOf(l.holdingId, l.accountId);
    let cell = byKey.get(k);
    if (!cell) {
      cell = {
        holdingId: l.holdingId,
        accountId: l.accountId,
        lots: [],
        closures: [],
      };
      byKey.set(k, cell);
    }
    cell.lots.push(l);
  }
  for (const c of closures) {
    if (c.closeDate > asOfDate) continue;
    const lot = lotsById.get(c.lotId);
    if (!lot) continue; // orphan closure (shouldn't happen — defensive)
    const k = keyOf(lot.holdingId, lot.accountId);
    let cell = byKey.get(k);
    if (!cell) {
      cell = {
        holdingId: lot.holdingId,
        accountId: lot.accountId,
        lots: [],
        closures: [],
      };
      byKey.set(k, cell);
    }
    cell.closures.push(c);
  }

  // Now also pull in (holding, account) pairs from `dividends` and
  // `prices` that have no lots/closures yet — e.g. a cash dividend on a
  // holding the user has never bought (rare, defensive).
  for (const [k, _] of dividends) {
    if (byKey.has(k)) continue;
    const [hStr, aStr] = k.split(":");
    const holdingId = Number(hStr);
    const accountId = Number(aStr);
    if (!Number.isFinite(holdingId) || !Number.isFinite(accountId)) continue;
    byKey.set(k, { holdingId, accountId, lots: [], closures: [] });
  }

  const out: PerHoldingMetrics[] = [];

  for (const cell of byKey.values()) {
    const holdingCurrency =
      holdingCurrencies.get(cell.holdingId) ??
      cell.lots[0]?.currency ??
      cell.closures[0]?.currency ??
      dividends.get(keyOf(cell.holdingId, cell.accountId))?.currency ??
      "USD";

    // Qty + cost basis from open lots only. We FX-convert each lot's
    // (qtyRemaining × costPerShare) from the lot's currency to the
    // holding's reporting currency; in the common single-currency case
    // fx returns 1.
    let qty = 0;
    let costBasisInHolding = 0;
    // FINLYNQ-279: cost basis in the reporting currency, each open lot valued
    // at the historical rate on its OWN open date. Falls back to the native
    // holding-currency conversion when no reportingCurrency/fxAtDate is passed,
    // so `costBasisReporting === costBasis` for those callers.
    let costBasisReporting = 0;
    let firstPurchaseDate: string | null = null;
    for (const l of cell.lots) {
      if (l.status !== "open" || l.qtyRemaining <= 0) continue;
      qty += l.qtyRemaining;
      const lotCost = l.qtyRemaining * l.costPerShare;
      costBasisInHolding += fx(lotCost, l.currency, holdingCurrency);
      costBasisReporting += reportingCurrency && fxAtDate
        ? fxAtDate(lotCost, l.currency, reportingCurrency, l.openDate)
        : fx(lotCost, l.currency, holdingCurrency);
      if (firstPurchaseDate == null || l.openDate < firstPurchaseDate) {
        firstPurchaseDate = l.openDate;
      }
    }

    // Realized gain — closures are the source of truth.
    let realizedGainAllTime = 0;
    let realizedGainYtd = 0;
    for (const c of cell.closures) {
      if (c.closeKind !== "sell") continue; // transfer_out is not realization
      const gainInHolding = fx(c.realizedGain, c.currency, holdingCurrency);
      realizedGainAllTime += gainInHolding;
      if (c.closeDate >= yearStart) {
        realizedGainYtd += gainInHolding;
      }
    }

    // Dividends from caller-supplied map.
    const dKey = keyOf(cell.holdingId, cell.accountId);
    const dRow = dividends.get(dKey);
    const dividendsAllTime = dRow
      ? fx(dRow.allTime, dRow.currency, holdingCurrency)
      : 0;
    const dividendsYtd = dRow
      ? fx(dRow.ytd, dRow.currency, holdingCurrency)
      : 0;

    // Market value — caller supplies price; we FX to holding currency.
    const priceRow = prices.get(cell.holdingId);
    const marketValue = priceRow
      ? fx(priceRow.price * qty, priceRow.currency, holdingCurrency)
      : 0;

    const unrealizedGain = marketValue - costBasisInHolding;

    const daysHeld = firstPurchaseDate
      ? Math.max(
          0,
          Math.floor(
            (Date.parse(`${asOfDate}T00:00:00Z`) -
              Date.parse(`${firstPurchaseDate}T00:00:00Z`)) /
              86400000,
          ),
        )
      : null;

    out.push({
      holdingId: cell.holdingId,
      accountId: cell.accountId,
      qty,
      costBasis: costBasisInHolding,
      costBasisReporting,
      unrealizedGain,
      marketValue,
      realizedGainYtd,
      realizedGainAllTime,
      dividendsYtd,
      dividendsAllTime,
      currency: holdingCurrency,
      firstPurchaseDate,
      daysHeld,
    });
  }

  return out;
}
