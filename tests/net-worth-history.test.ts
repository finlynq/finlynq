/**
 * Pure-unit tests for buildNetWorthHistory (plan/net-worth-over-time.md Part A
 * + plan/net-worth-cash-snapshots.md Phase 5).
 *
 * Self-contained: `@/lib/fx-service` is mocked so the suite never bootstraps
 * the Postgres harness. The mock mirrors the real convertWithRateMap math
 * (amount × rate, rounded to cents).
 *
 * The cash side now reads STORED per-account snapshots (same per-account
 * carry-forward machinery as the investment side) instead of live tx deltas.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/fx-service", () => ({
  convertWithRateMap: (amount: number, ccy: string, rateMap: Map<string, number>) =>
    Math.round(amount * (rateMap.get(String(ccy).toUpperCase()) ?? 1) * 100) / 100,
}));

import {
  buildNetWorthHistory,
  type AccountSnapshot,
  type LiveAccountValue,
} from "@/lib/net-worth-history";

const CAD = new Map<string, number>([["CAD", 1]]);

describe("buildNetWorthHistory", () => {
  it("carries cash forward across quiet days (all period)", () => {
    // One stored cash snapshot — carried forward across quiet days, exactly
    // like an investment snapshot.
    const cashSnapshots: AccountSnapshot[] = [
      { accountId: 1, snapDate: "2026-05-01", marketValue: 100, currency: "CAD" },
    ];
    const res = buildNetWorthHistory({
      period: "all",
      displayCurrency: "CAD",
      rateMap: CAD,
      cashSnapshots,
      snapshots: [],
      today: "2026-05-03",
    });
    expect(res.series).toEqual([
      { date: "2026-05-01", value: 100, breakdown: [{ accountId: 1, value: 100 }] },
      { date: "2026-05-02", value: 100, breakdown: [{ accountId: 1, value: 100 }] },
      { date: "2026-05-03", value: 100, breakdown: [{ accountId: 1, value: 100 }] },
    ]);
    expect(res.hasInvestmentData).toBe(false);
  });

  it("carries the last cash snapshot at-or-before the first day of a 6m window", () => {
    // A single old snapshot — by the time the 6m window starts, the carried
    // value must already be 500 (the builder writes a daily row; here a sparse
    // pre-window snapshot is carried forward).
    const cashSnapshots: AccountSnapshot[] = [
      { accountId: 1, snapDate: "2020-01-01", marketValue: 500, currency: "CAD" },
    ];
    const res = buildNetWorthHistory({
      period: "6m",
      displayCurrency: "CAD",
      rateMap: CAD,
      cashSnapshots,
      snapshots: [],
      today: "2026-06-02",
    });
    // 180 days back, inclusive → 181 points.
    expect(res.series.length).toBe(181);
    expect(res.series[0]).toEqual({
      date: "2025-12-04",
      value: 500,
      breakdown: [{ accountId: 1, value: 500 }],
    });
    expect(res.series[res.series.length - 1]).toEqual({
      date: "2026-06-02",
      value: 500,
      breakdown: [{ accountId: 1, value: 500 }],
    });
  });

  it("reads investment value from the nearest snapshot at-or-before each day", () => {
    const snapshots: AccountSnapshot[] = [
      { accountId: 1, snapDate: "2026-05-01", marketValue: 1000, currency: "CAD" },
      { accountId: 1, snapDate: "2026-05-03", marketValue: 1100, currency: "CAD" },
    ];
    const res = buildNetWorthHistory({
      period: "all",
      displayCurrency: "CAD",
      rateMap: CAD,
      cashSnapshots: [],
      snapshots,
      today: "2026-05-04",
    });
    expect(res.series).toEqual([
      { date: "2026-05-01", value: 1000, breakdown: [{ accountId: 1, value: 1000 }] },
      { date: "2026-05-02", value: 1000, breakdown: [{ accountId: 1, value: 1000 }] }, // carry-forward
      { date: "2026-05-03", value: 1100, breakdown: [{ accountId: 1, value: 1100 }] },
      { date: "2026-05-04", value: 1100, breakdown: [{ accountId: 1, value: 1100 }] }, // carry-forward
    ]);
    expect(res.hasInvestmentData).toBe(true);
  });

  it("converts per-account cash snapshots via the rate map (display-switch re-FX)", () => {
    const rateMap = new Map<string, number>([
      ["CAD", 1],
      ["USD", 1.4],
    ]);
    // Two accounts, one stored in each currency on the same day. The USD
    // snapshot re-bases at the current rate (the documented display-switch
    // discontinuity).
    const cashSnapshots: AccountSnapshot[] = [
      { accountId: 1, snapDate: "2026-05-01", marketValue: 100, currency: "CAD" },
      { accountId: 2, snapDate: "2026-05-01", marketValue: 50, currency: "USD" },
    ];
    const res = buildNetWorthHistory({
      period: "all",
      displayCurrency: "CAD",
      rateMap,
      cashSnapshots,
      snapshots: [],
      today: "2026-05-01",
    });
    // 100 CAD + 50 USD × 1.4 = 170
    expect(res.series).toEqual([
      {
        date: "2026-05-01",
        value: 170,
        breakdown: [
          { accountId: 1, value: 100 },
          { accountId: 2, value: 70 },
        ],
      },
    ]);
  });

  it("re-FXes a CAD-stored cash snapshot when displayCurrency switched to USD", () => {
    // Snapshot stored as CAD; user now displays USD → re-base at current rate.
    const rateMap = new Map<string, number>([
      ["USD", 1],
      ["CAD", 0.7],
    ]);
    const cashSnapshots: AccountSnapshot[] = [
      { accountId: 1, snapDate: "2026-05-01", marketValue: 100, currency: "CAD" },
    ];
    const res = buildNetWorthHistory({
      period: "all",
      displayCurrency: "USD",
      rateMap,
      cashSnapshots,
      snapshots: [],
      today: "2026-05-01",
    });
    expect(res.series).toEqual([
      { date: "2026-05-01", value: 70, breakdown: [{ accountId: 1, value: 70 }] },
    ]);
  });

  it("substitutes live cash balance on the final (today) grid point", () => {
    const cashSnapshots: AccountSnapshot[] = [
      { accountId: 1, snapDate: "2026-05-01", marketValue: 100, currency: "CAD" },
    ];
    const liveCashByAccount = new Map<number, LiveAccountValue>([
      [1, { value: 130, currency: "CAD" }],
    ]);
    const res = buildNetWorthHistory({
      period: "all",
      displayCurrency: "CAD",
      rateMap: CAD,
      cashSnapshots,
      liveCashByAccount,
      snapshots: [],
      today: "2026-05-02",
    });
    expect(res.series).toEqual([
      { date: "2026-05-01", value: 100, breakdown: [{ accountId: 1, value: 100 }] }, // historical snapshot
      { date: "2026-05-02", value: 130, breakdown: [{ accountId: 1, value: 130 }] }, // live override on today
    ]);
  });

  it("substitutes live holdings value on the final (today) grid point", () => {
    const snapshots: AccountSnapshot[] = [
      { accountId: 1, snapDate: "2026-05-01", marketValue: 1000, currency: "CAD" },
    ];
    const live = new Map([[1, { value: 1200, currency: "CAD" }]]);
    const res = buildNetWorthHistory({
      period: "all",
      displayCurrency: "CAD",
      rateMap: CAD,
      cashSnapshots: [],
      snapshots,
      liveInvestmentByAccount: live,
      today: "2026-05-02",
    });
    expect(res.series).toEqual([
      { date: "2026-05-01", value: 1000, breakdown: [{ accountId: 1, value: 1000 }] }, // historical snapshot
      { date: "2026-05-02", value: 1200, breakdown: [{ accountId: 1, value: 1200 }] }, // live override on today
    ]);
    expect(res.hasInvestmentData).toBe(true);
  });

  it("combines cash + investment with BOTH overridden live on today", () => {
    const cashSnapshots: AccountSnapshot[] = [
      { accountId: 1, snapDate: "2026-05-01", marketValue: 100, currency: "CAD" },
    ];
    const snapshots: AccountSnapshot[] = [
      { accountId: 2, snapDate: "2026-05-01", marketValue: 800, currency: "CAD" },
    ];
    const liveCashByAccount = new Map<number, LiveAccountValue>([
      [1, { value: 120, currency: "CAD" }],
    ]);
    const liveInvestmentByAccount = new Map<number, LiveAccountValue>([
      [2, { value: 850, currency: "CAD" }],
    ]);
    const res = buildNetWorthHistory({
      period: "all",
      displayCurrency: "CAD",
      rateMap: CAD,
      cashSnapshots,
      liveCashByAccount,
      snapshots,
      liveInvestmentByAccount,
      today: "2026-05-02",
    });
    expect(res.series).toEqual([
      {
        date: "2026-05-01",
        value: 900, // 100 cash + 800 investment (historical)
        breakdown: [
          { accountId: 1, value: 100 },
          { accountId: 2, value: 800 },
        ],
      },
      {
        date: "2026-05-02",
        value: 970, // 120 live cash + 850 live investment
        breakdown: [
          { accountId: 1, value: 120 },
          { accountId: 2, value: 850 },
        ],
      },
    ]);
    expect(res.hasInvestmentData).toBe(true);
  });

  it("excludes investment accounts from the cash sum — combines both sides", () => {
    const cashSnapshots: AccountSnapshot[] = [
      { accountId: 1, snapDate: "2026-05-01", marketValue: 250, currency: "CAD" },
    ];
    const snapshots: AccountSnapshot[] = [
      { accountId: 2, snapDate: "2026-05-01", marketValue: 800, currency: "CAD" },
    ];
    const res = buildNetWorthHistory({
      period: "all",
      displayCurrency: "CAD",
      rateMap: CAD,
      cashSnapshots,
      snapshots,
      today: "2026-05-01",
    });
    expect(res.series).toEqual([
      {
        date: "2026-05-01",
        value: 1050,
        breakdown: [
          { accountId: 1, value: 250 },
          { accountId: 2, value: 800 },
        ],
      },
    ]);
  });

  it("returns hasInvestmentData=false and a zero series when there is no data", () => {
    const res = buildNetWorthHistory({
      period: "all",
      displayCurrency: "CAD",
      rateMap: CAD,
      cashSnapshots: [],
      snapshots: [],
      today: "2026-05-01",
    });
    expect(res.series).toEqual([{ date: "2026-05-01", value: 0, breakdown: [] }]);
    expect(res.hasInvestmentData).toBe(false);
    expect(res.fxApproximation).toBe(true);
  });

  it("produces 366 points for a 1y window (365 days back, inclusive)", () => {
    const res = buildNetWorthHistory({
      period: "1y",
      displayCurrency: "CAD",
      rateMap: CAD,
      cashSnapshots: [],
      snapshots: [],
      today: "2026-06-02",
    });
    expect(res.series.length).toBe(366);
    expect(res.series[0].date).toBe("2025-06-02");
    expect(res.series[res.series.length - 1].date).toBe("2026-06-02");
  });
});

/**
 * FINLYNQ-303 — the `native` basis: each value read straight from the stored
 * native columns (the account's OWN currency) with no conversion at all.
 *
 * The rate map below is deliberately non-identity so a leaked conversion would
 * change a number rather than silently pass. Stored rows model a USD account
 * under a CAD reporting currency: `marketValue` is the CAD figure the builder
 * wrote, `nativeMarketValue` the USD one it used to produce it.
 */
describe("buildNetWorthHistory — native basis", () => {
  const RATES = new Map<string, number>([["CAD", 1], ["USD", 1.4]]);

  const dualCash: AccountSnapshot[] = [
    {
      accountId: 1,
      snapDate: "2026-05-01",
      marketValue: 140,
      currency: "CAD",
      nativeMarketValue: 100,
      nativeCurrency: "USD",
    },
  ];

  it("reads the native column verbatim and labels the account currency", () => {
    const res = buildNetWorthHistory({
      period: "all",
      displayCurrency: "CAD",
      basis: "native",
      rateMap: RATES,
      cashSnapshots: dualCash,
      snapshots: [],
      today: "2026-05-02",
    });
    expect(res.basisUsed).toBe("native");
    expect(res.seriesCurrency).toBe("USD");
    // 100 (native), NOT 140 (reporting) and NOT 140×1.4 (a double conversion).
    expect(res.series.map((p) => p.value)).toEqual([100, 100]);
  });

  it("still returns the reporting figures when basis is omitted", () => {
    const res = buildNetWorthHistory({
      period: "all",
      displayCurrency: "CAD",
      rateMap: RATES,
      cashSnapshots: dualCash,
      snapshots: [],
      today: "2026-05-01",
    });
    expect(res.basisUsed).toBe("reporting");
    expect(res.seriesCurrency).toBe("CAD");
    expect(res.series[0].value).toBe(140);
  });

  it("downgrades to reporting when any row lacks a native value", () => {
    // A partially-backfilled range. Honouring native here would draw one line
    // whose points are partly USD and partly CAD, so the whole series falls
    // back rather than mixing currencies point-to-point.
    const mixed: AccountSnapshot[] = [
      ...dualCash,
      { accountId: 1, snapDate: "2026-05-02", marketValue: 210, currency: "CAD" },
    ];
    const res = buildNetWorthHistory({
      period: "all",
      displayCurrency: "CAD",
      basis: "native",
      rateMap: RATES,
      cashSnapshots: mixed,
      snapshots: [],
      today: "2026-05-02",
    });
    expect(res.basisUsed).toBe("reporting");
    expect(res.seriesCurrency).toBe("CAD");
    expect(res.series.map((p) => p.value)).toEqual([140, 210]);
  });

  it("takes the live-today override in native currency without converting", () => {
    // LiveAccountValue is already in account currency, so native must use it
    // verbatim — converting it here is what would break the tie-out with the
    // account page's Balance tile.
    const res = buildNetWorthHistory({
      period: "all",
      displayCurrency: "CAD",
      basis: "native",
      rateMap: RATES,
      cashSnapshots: dualCash,
      liveCashByAccount: new Map([[1, { value: 250, currency: "USD" }]]),
      snapshots: [],
      today: "2026-05-02",
    });
    expect(res.series[res.series.length - 1].value).toBe(250);
  });

  it("reports a cash-only native series as FX-exact, investments as approximate", () => {
    const cashOnly = buildNetWorthHistory({
      period: "all",
      displayCurrency: "CAD",
      basis: "native",
      rateMap: RATES,
      cashSnapshots: dualCash,
      snapshots: [],
      today: "2026-05-01",
    });
    // Cash is a pure cumulative SUM in the account currency — nothing was ever
    // converted, so the approximation flag clears.
    expect(cashOnly.fxApproximation).toBe(false);

    const withInvestments = buildNetWorthHistory({
      period: "all",
      displayCurrency: "CAD",
      basis: "native",
      rateMap: RATES,
      cashSnapshots: [],
      snapshots: [
        {
          accountId: 2,
          snapDate: "2026-05-01",
          marketValue: 1400,
          currency: "CAD",
          nativeMarketValue: 1000,
          nativeCurrency: "USD",
        },
      ],
      today: "2026-05-01",
    });
    // Holdings were already converted holding→account at build time; native
    // removes only the account→reporting leg, so this stays approximate.
    expect(withInvestments.basisUsed).toBe("native");
    expect(withInvestments.fxApproximation).toBe(true);
  });
});
