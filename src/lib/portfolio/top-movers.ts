/**
 * Top Movers aggregation (FINLYNQ-190).
 *
 * The Portfolio "Top Movers" cards (Top Gainers / Top Losers) must list a
 * ticker ONCE even when it is held across multiple accounts. The per-position
 * `enrichedHoldings` array carries one entry per `portfolio_holdings` row (i.e.
 * per account), so a ticker held in N accounts would otherwise surface N times.
 *
 * This helper aggregates movers BY canonical security key (the SAME key the
 * All-Holdings `byHoldingMap` groups on — the caller supplies the bucket-key
 * function so there is no second grouping path) BEFORE the top-5 slice:
 *   - sums `dayChangeDisplay` (the display-currency day-change $) across accounts,
 *   - computes a VALUE-WEIGHTED aggregate `changePct` from the aggregate
 *     (Σ day-change ÷ Σ prior-day value, mirroring the portfolio-total
 *     `totalDayChangePct`), NOT one account's percent.
 *
 * Pure + display-only. Ranking (by absolute day-change) + the top-5 cap are
 * applied by the caller AFTER aggregation.
 */

/**
 * Minimal per-position shape the aggregation reads. The display name is NOT
 * here — it comes from `displayOf` (the canonical row's name), so the route can
 * pass `enrichedHoldings` (whose `name` is `string | null`) without a cast.
 */
export interface MoverHoldingInput {
  symbol: string | null;
  image: string | null;
  /** Display-currency day-change $ contribution of this position. */
  dayChangeDisplay: number | null;
  /** Display-currency market value of this position (today's value). */
  marketValueDisplay: number | null;
}

/** One consolidated mover row (one per ticker / canonical security key). */
export interface Mover {
  /** Canonical security key (stable React key — NOT a per-position id). */
  key: string;
  symbol: string | null;
  name: string;
  image: string | null;
  /** Σ of the member positions' display-currency day-change $. */
  dayChangeDisplay: number;
  /** Value-weighted aggregate % = Σ day-change ÷ Σ prior-day value × 100. */
  changePct: number | null;
}

/**
 * Aggregate per-position holdings into one mover row per canonical security key.
 *
 * Positions without a real `symbol` or without a `dayChangeDisplay` are excluded
 * (cash sleeves / metals / custom holdings have no live day-change to rank).
 *
 * `bucketKeyOf` MUST return the SAME canonical bucket key the caller uses for
 * the All-Holdings rollup (`byHoldingMap`) so movers and All-Holdings agree;
 * `displayOf` returns the canonical display fields (symbol + name) for that key.
 */
export function aggregateMovers<T extends MoverHoldingInput>(
  holdings: readonly T[],
  bucketKeyOf: (h: T) => string,
  displayOf: (h: T) => { key: string; symbol: string | null; name: string },
): Mover[] {
  type Accum = {
    key: string;
    symbol: string | null;
    name: string;
    image: string | null;
    dayChangeDisplay: number;
    marketValueDisplay: number;
  };
  const map = new Map<string, Accum>();
  for (const h of holdings) {
    if (h.dayChangeDisplay === null || !h.symbol) continue;
    const bucketKey = bucketKeyOf(h);
    let acc = map.get(bucketKey);
    if (!acc) {
      const d = displayOf(h);
      acc = {
        key: d.key,
        symbol: d.symbol,
        name: d.name,
        // First member with an image wins (members of an eq:/crypto: key
        // share a ticker, so any member's icon describes the whole row).
        image: h.image ?? null,
        dayChangeDisplay: 0,
        marketValueDisplay: 0,
      };
      map.set(bucketKey, acc);
    }
    if (acc.image == null && h.image) acc.image = h.image;
    acc.dayChangeDisplay += h.dayChangeDisplay;
    acc.marketValueDisplay += h.marketValueDisplay ?? 0;
  }

  return Array.from(map.values()).map(a => {
    // Prior-day value = today's value − the day-change. Weighted % mirrors the
    // portfolio-total dayChangePct so the consolidated row's % is consistent.
    const priorValue = a.marketValueDisplay - a.dayChangeDisplay;
    const changePct = priorValue > 0
      ? Math.round((a.dayChangeDisplay / priorValue) * 100 * 100) / 100
      : null;
    return {
      key: a.key,
      symbol: a.symbol,
      name: a.name,
      image: a.image,
      dayChangeDisplay: Math.round(a.dayChangeDisplay * 100) / 100,
      changePct,
    };
  });
}
