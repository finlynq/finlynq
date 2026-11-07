/**
 * A failed HISTORICAL rate lookup must not stop TODAY's rate (2026-11-07).
 *
 * Same fault as price-service's: a half-typed Reports date asked Yahoo for
 * HKDUSD=X and CNYUSD=X at year 2, the refusals went into the one per-currency
 * negative cache, and prod's journal then showed "live rate fetch for HKD
 * failed — skipping live fetch for 10m". Historical misses now have their own
 * key, and dates before 1970 are not asked about at all.
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

import { getRateToUsdDetailed } from "@/lib/fx-service";
import { todayISO } from "@/lib/utils/date";

const rateBody = (rate: number) => ({
  chart: { result: [{ meta: { regularMarketPrice: rate } }] },
});

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

const refused = { ok: false, status: 400, json: async () => ({}) };

describe("fx history misses stay out of today's rate", () => {
  it("a failed historical lookup does not block today's rate", async () => {
    fetchSpy.mockResolvedValueOnce(refused);
    const past = await getRateToUsdDetailed("HKD", "2010-01-04", "u1");
    expect(past.source).not.toBe("yahoo");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, json: async () => rateBody(0.128) });
    const now = await getRateToUsdDetailed("HKD", todayISO(), "u1");
    expect(fetchSpy).toHaveBeenCalledTimes(2); // today's fetch WAS made
    expect(now).toMatchObject({ rate: 0.128, source: "yahoo" });
  });

  it("a failed historical lookup still skips the next historical one", async () => {
    fetchSpy.mockResolvedValueOnce(refused);
    await getRateToUsdDetailed("CNY", "2010-01-04", "u1");
    await getRateToUsdDetailed("CNY", "2011-06-01", "u1");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("a failed live lookup still skips historical ones (the upstream is down)", async () => {
    fetchSpy.mockResolvedValueOnce(refused);
    await getRateToUsdDetailed("SGD", todayISO(), "u1");
    await getRateToUsdDetailed("SGD", "2010-01-04", "u1");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not ask about dates before 1970", async () => {
    await getRateToUsdDetailed("INR", "0002-01-01", "u1");
    await getRateToUsdDetailed("INR", "1969-12-25", "u1");
    expect(fetchSpy).not.toHaveBeenCalled();
    // ...and skipping them is not a miss: a real date still goes out.
    fetchSpy.mockResolvedValueOnce(refused);
    await getRateToUsdDetailed("INR", "2010-01-04", "u1");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
