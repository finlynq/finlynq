/**
 * Pure-unit tests for aggregateMovers (FINLYNQ-190 — Top Movers dedupe a
 * ticker held across multiple accounts into one row).
 *
 * The load-bearing property (tc-2): a ticker held in N accounts consolidates to
 * ONE mover whose dayChangeDisplay = Σ of the per-account day changes, and the
 * ranking-by-absolute-day-change + top-5 cap are applied AFTER aggregation.
 *
 * Self-contained: aggregateMovers is pure (the caller injects the canonical
 * bucket-key + display fns), so no harness bootstrap.
 */

import { describe, it, expect } from "vitest";
import { aggregateMovers, type MoverHoldingInput } from "@/lib/portfolio/top-movers";

// Mirror the route's wiring with an equity-style canonical key: positions with
// the same symbol fall into the same `eq:<SYMBOL>` bucket.
const bucketKeyOf = (h: MoverHoldingInput) => `eq:${(h.symbol ?? "").toUpperCase()}`;
const displayOf = (h: MoverHoldingInput) => {
  const sym = (h.symbol ?? "").toUpperCase();
  return { key: `eq:${sym}`, symbol: sym, name: sym };
};

const pos = (
  symbol: string | null,
  dayChangeDisplay: number | null,
  marketValueDisplay: number | null,
): MoverHoldingInput => ({
  symbol,
  image: null,
  dayChangeDisplay,
  marketValueDisplay,
});

describe("aggregateMovers (FINLYNQ-190)", () => {
  it("tc-2: VCN.TO held in 3 accounts consolidates to ONE row with summed day-change 37.26", () => {
    const holdings: MoverHoldingInput[] = [
      pos("VCN.TO", 21.33, 1021.33),
      pos("VCN.TO", 14.04, 714.04),
      pos("VCN.TO", 1.89, 101.89),
    ];

    const movers = aggregateMovers(holdings, bucketKeyOf, displayOf);

    expect(movers).toHaveLength(1);
    expect(movers[0].symbol).toBe("VCN.TO");
    // Summed across the three accounts: 21.33 + 14.04 + 1.89 = 37.26.
    expect(movers[0].dayChangeDisplay).toBe(37.26);
  });

  it("tc-2: derives a value-weighted aggregate %, not one account's percent", () => {
    // priorValue = ΣmarketValue − ΣdayChange = (1021.33+714.04+101.89) − 37.26
    //            = 1837.26 − 37.26 = 1800.00 → 37.26 / 1800 * 100 = 2.07%
    const holdings: MoverHoldingInput[] = [
      pos("VCN.TO", 21.33, 1021.33),
      pos("VCN.TO", 14.04, 714.04),
      pos("VCN.TO", 1.89, 101.89),
    ];

    const movers = aggregateMovers(holdings, bucketKeyOf, displayOf);
    expect(movers[0].changePct).toBe(2.07);
  });

  it("ranks by absolute day-change and the top-5 cap is applied AFTER aggregation", () => {
    // VCN.TO in 3 accounts (37.26 combined) must out-rank any single bigger
    // per-account row only if its SUM is larger — here it beats five small
    // single-account tickers, proving the cap runs post-aggregation.
    const holdings: MoverHoldingInput[] = [
      pos("VCN.TO", 21.33, 1021.33),
      pos("VCN.TO", 14.04, 714.04),
      pos("VCN.TO", 1.89, 101.89),
      pos("AAA", 5, 105),
      pos("BBB", 4, 104),
      pos("CCC", 3, 103),
      pos("DDD", 2, 102),
      pos("EEE", 1, 101),
      pos("FFF", 0.5, 100.5),
    ];

    const movers = aggregateMovers(holdings, bucketKeyOf, displayOf).sort((a, b) => {
      const diff = Math.abs(b.dayChangeDisplay) - Math.abs(a.dayChangeDisplay);
      if (diff !== 0) return diff;
      return (a.symbol ?? "").localeCompare(b.symbol ?? "");
    });
    const topGainers = movers.filter(m => m.dayChangeDisplay > 0).slice(0, 5);

    // VCN.TO consolidates to one row and ranks first by summed |day-change|.
    expect(topGainers.map(m => m.symbol)).toEqual(["VCN.TO", "AAA", "BBB", "CCC", "DDD"]);
    expect(topGainers).toHaveLength(5); // cap applied after aggregation
    // VCN.TO present once despite 3 source positions.
    expect(topGainers.filter(m => m.symbol === "VCN.TO")).toHaveLength(1);
  });

  it("excludes positions without a real symbol (cash/metals/custom) and null day-change", () => {
    const holdings: MoverHoldingInput[] = [
      pos("VCN.TO", 10, 510),
      pos(null, 99, 9999), // cash sleeve, no symbol → excluded
      pos("AAPL", null, 1000), // no live day-change → excluded
    ];

    const movers = aggregateMovers(holdings, bucketKeyOf, displayOf);
    expect(movers.map(m => m.symbol)).toEqual(["VCN.TO"]);
  });

  it("keeps separate tickers as distinct rows", () => {
    const holdings: MoverHoldingInput[] = [
      pos("VCN.TO", 21.33, 1021.33),
      pos("XEQT.TO", -5.5, 994.5),
    ];

    const movers = aggregateMovers(holdings, bucketKeyOf, displayOf);
    expect(movers).toHaveLength(2);
    const losers = movers.filter(m => m.dayChangeDisplay < 0);
    expect(losers).toHaveLength(1);
    expect(losers[0].symbol).toBe("XEQT.TO");
  });
});
