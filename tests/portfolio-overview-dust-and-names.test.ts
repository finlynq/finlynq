/**
 * Portfolio overview (2026-10-14, owner report from prod):
 *
 *   1. A rounding leftover is a CLOSED position. A fund bought in fractional
 *      units (6 decimals) and sold at 4 decimals can end at -0.000049 units.
 *      It showed as "-0" flagged Short, with an average cost of -C$8.8M and
 *      -100% unrealized. It now reads 0 units, no cost basis, no unrealized,
 *      so Hide empty hides it. Rule: src/lib/portfolio/dust.ts.
 *   2. All Holdings names the fund the way Holdings by Account does. Yahoo's
 *      long name only arrives on a LIVE quote; on a warm price cache the row
 *      read "--" while By Account showed the stored name.
 *
 * DB-gated (real Postgres): runs in CI's `finlynq_test` lane, skips locally
 * without a `*_test` DATABASE_URL. Prices, FX and auth are stubbed; the
 * transactions, holdings and the overview's own SQL are real.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import {
  TEST_DEK,
  bootstrapTestDb,
  resetTestDb,
  shutdownTestDb,
  createTestUser,
  createAccount,
  createHolding,
  recordTransaction,
} from "./helpers/portfolio-fixtures";

const auth = vi.hoisted(() => ({ userId: "" }));

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({
    authenticated: true,
    context: { userId: auth.userId, sessionId: "test", method: "passphrase" as const, mfaVerified: false, dek: TEST_DEK },
  })),
}));

// A warm price cache: the quote's name is just the symbol echoed back.
vi.mock("@/lib/price-service", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/price-service")>();
  const PRICES: Record<string, number> = { LEIG: 612.24, "VCN.TO": 50 };
  return {
    ...real,
    fetchMultipleQuotes: vi.fn(async (symbols: string[]) => {
      const m = new Map<string, { price: number; currency: string; change: number; changePct: number; name: string }>();
      for (const s of symbols) {
        if (PRICES[s] != null) m.set(s, { price: PRICES[s], currency: "CAD", change: 0, changePct: 0, name: s });
      }
      return m;
    }),
  };
});

vi.mock("@/lib/fx-service", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/fx-service")>();
  return {
    ...real,
    getLatestFxRate: vi.fn(async () => 1),
    getRate: vi.fn(async () => 1),
    getDisplayCurrency: vi.fn(async () => "CAD"),
  };
});

vi.mock("@/lib/crypto-service", () => ({
  getCryptoPrices: vi.fn(async () => []),
  symbolToCoinGeckoId: vi.fn(() => null),
}));

import { GET as overviewGET } from "@/app/api/portfolio/overview/route";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

type OverviewBody = {
  holdings: Array<{
    symbol: string | null;
    quantity: number | null;
    totalCostBasis: number | null;
    avgCostPerShare: number | null;
    marketValue: number | null;
    unrealizedGain: number | null;
  }>;
  byHolding: Array<{ symbol: string | null; description: string | null; totalQty: number; costBasisDisplay: number }>;
};

async function overview(): Promise<OverviewBody> {
  const req = { nextUrl: { searchParams: new URLSearchParams() } } as unknown as Parameters<typeof overviewGET>[0];
  const res = await overviewGET(req);
  return (await res.json()) as OverviewBody;
}

describeDb("portfolio overview: rounding leftovers and fund names", () => {
  beforeAll(async () => {
    await bootstrapTestDb();
  });
  afterAll(async () => {
    await shutdownTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    auth.userId = await createTestUser();
    const accountId = await createAccount({ userId: auth.userId, name: "CanadaLife", currency: "CAD", isInvestment: true });
    const leig = await createHolding({
      userId: auth.userId, accountId, name: "Canadian Equity Index (Mackenzie)", symbol: "LEIG", currency: "CAD",
    });
    // Bought 0.981651 units, sold 0.9817 (4 decimals): 0.000049 oversold.
    for (const [date, qty, amount] of [
      ["2026-02-09", 0.5, -320],
      ["2026-03-09", 0.481651, -340],
      ["2026-09-02", -0.354, 253.59],
      ["2026-09-02", -0.6277, 449.63],
    ] as const) {
      await recordTransaction({ userId: auth.userId, accountId, currency: "CAD", amount, quantity: qty, portfolioHoldingId: leig, kind: qty > 0 ? "buy" : "sell", date });
    }
    const vcn = await createHolding({
      userId: auth.userId, accountId, name: "Vanguard FTSE Canada All Cap Index ETF", symbol: "VCN.TO", currency: "CAD",
    });
    await recordTransaction({ userId: auth.userId, accountId, currency: "CAD", amount: -480, quantity: 10, portfolioHoldingId: vcn, kind: "buy", date: "2026-01-05" });
  });

  it("treats the 0.000049-unit leftover as a closed position", async () => {
    const body = await overview();
    const leig = body.holdings.find((h) => h.symbol === "LEIG")!;
    expect(leig).toMatchObject({ quantity: 0, totalCostBasis: null, avgCostPerShare: null, marketValue: null, unrealizedGain: null });
    const row = body.byHolding.find((r) => r.symbol === "LEIG")!;
    expect(row.totalQty).toBe(0);
    expect(row.costBasisDisplay).toBe(0);
  });

  it("leaves a real position alone", async () => {
    const vcn = (await overview()).holdings.find((h) => h.symbol === "VCN.TO")!;
    expect(vcn.quantity).toBe(10);
    expect(vcn.marketValue).toBe(500);
  });

  it("names each fund on All Holdings from its stored name when the quote has none", async () => {
    const body = await overview();
    expect(body.byHolding.find((r) => r.symbol === "VCN.TO")?.description).toBe("Vanguard FTSE Canada All Cap Index ETF");
    expect(body.byHolding.find((r) => r.symbol === "LEIG")?.description).toBe("Canadian Equity Index (Mackenzie)");
  });
});
