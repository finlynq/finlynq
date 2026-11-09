/**
 * Today's FX rate is read at full precision (2026-11-09, GH #397).
 *
 * Yahoo rounds `meta.regularMarketPrice` to 4 decimal places on every currency
 * quote. The live branch used to trust it, so IDR (≈0.0000554 USD) and UZS
 * (≈0.0000834) were stored as 0.0001, and "1 USD = 10,000 UZS" reached every
 * balance. The payloads below are the shapes Yahoo returned on 2026-11-09.
 *
 * Every DB read misses (empty `@/db`), so the only way to a rate is a fetch.
 * The negative cache is module-level, so each test uses its own currency.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("drizzle-orm", () => {
  const op = () => ({});
  return { and: op, eq: op, desc: op, gte: op, lte: op, isNull: op, or: op, sql: op, inArray: op };
});

vi.mock("@/db", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "from", "where", "orderBy", "limit", "insert", "values", "onConflictDoUpdate"]) {
    chain[m] = () => chain;
  }
  chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve);
  chain.catch = () => Promise.resolve();
  return {
    db: new Proxy({}, { get: (_t, prop) => chain[prop as string] }),
    schema: new Proxy({}, { get: () => new Proxy({}, { get: () => ({}) }) }),
  };
});

import { getRateToUsdDetailed, isRoundedSmallRate } from "@/lib/fx-service";
import { todayISO } from "@/lib/utils/date";

const NOW_S = Math.floor(Date.now() / 1000);

function chartBody(meta: number | undefined, closes: Array<number | null>) {
  return {
    chart: {
      result: [
        {
          meta: meta === undefined ? {} : { regularMarketPrice: meta },
          timestamp: closes.map((_, i) => NOW_S - (closes.length - 1 - i) * 86400),
          indicators: { quote: [{ close: closes }] },
        },
      ],
    },
  };
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("live FX rate uses the unrounded close", () => {
  it("UZS: meta rounded to 0.0001 → the close is used", async () => {
    fetchSpy.mockResolvedValueOnce(ok(chartBody(0.0001, [8.638966392027214e-5, 8.340909698745236e-5])));
    const r = await getRateToUsdDetailed("UZS", todayISO(), "u1");
    expect(r.source).toBe("yahoo");
    expect(r.rate).toBe(8.340909698745236e-5);
    expect(1 / r.rate).toBeCloseTo(11989.1, 0);
  });

  it("IDR: meta rounded to 0.0001 → the close is used", async () => {
    fetchSpy.mockResolvedValueOnce(ok(chartBody(0.0001, [5.543544466490857e-5])));
    const r = await getRateToUsdDetailed("IDR", todayISO(), "u1");
    expect(r.rate).toBe(5.543544466490857e-5);
  });

  it("a large currency also takes the close (meta has 4 decimals)", async () => {
    fetchSpy.mockResolvedValueOnce(ok(chartBody(1.1197, [1.1196954250335693])));
    const r = await getRateToUsdDetailed("EUR", todayISO(), "u1");
    expect(r.rate).toBe(1.1196954250335693);
  });

  it("VND: meta rounded to 0 → the close is used (unchanged behaviour)", async () => {
    fetchSpy.mockResolvedValueOnce(ok(chartBody(0, [3.79e-5])));
    const r = await getRateToUsdDetailed("VND", todayISO(), "u1");
    expect(r.rate).toBe(3.79e-5);
  });

  it("skips null closes and takes the latest positive one", async () => {
    fetchSpy.mockResolvedValueOnce(ok(chartBody(0.0003, [3.19e-4, 3.2e-4, null])));
    const r = await getRateToUsdDetailed("COP", todayISO(), "u1");
    expect(r.rate).toBe(3.2e-4);
  });

  it("falls back to meta only when close[] is empty", async () => {
    fetchSpy.mockResolvedValueOnce(ok(chartBody(0.735, [null])));
    const r = await getRateToUsdDetailed("CAD", todayISO(), "u1");
    expect(r).toMatchObject({ rate: 0.735, source: "yahoo" });
  });

  it("isRoundedSmallRate flags only 4-decimal values under 0.001", () => {
    for (const r of [0.0001, 0.0003, 0.0006, 0.0007]) expect(isRoundedSmallRate(r)).toBe(true);
    for (const r of [5.543544466490857e-5, 8.340909698745236e-5, 3.79e-5, 3.197e-4, 0.001, 0.0105, 1.1197, 0, -0.0001]) {
      expect(isRoundedSmallRate(r)).toBe(false);
    }
  });

  it("neither close nor meta → not a yahoo rate", async () => {
    fetchSpy.mockResolvedValueOnce(ok(chartBody(undefined, [null])));
    const r = await getRateToUsdDetailed("KRW", todayISO(), "u1");
    expect(r.source).not.toBe("yahoo");
  });
});
