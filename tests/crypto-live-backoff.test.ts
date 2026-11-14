/**
 * Valuing held crypto honours the Yahoo negative cache (2026-11-13).
 *
 * crypto-service priced every held coin with `fetchQuoteLive`, which skips the
 * negative cache on purpose (it also serves lookups of what a user types). So
 * pairs Yahoo refuses (FTM-USD, UNI-USD, MATIC-USD) were re-asked on every
 * portfolio load before CoinGecko answered: dozens of 404s an hour in the
 * outbound log. `getCryptoPrices` now uses `fetchQuoteLiveBackoff`.
 *
 * Driven against an empty in-memory `@/db` and a stubbed global `fetch`. The
 * negative cache is module-level, so each test uses its own symbols.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
  and: () => ({}),
  inArray: () => ({}),
  gte: () => ({}),
  lte: () => ({}),
}));

vi.mock("@/db", () => {
  const select = () => {
    const chain = {
      from: () => chain,
      where: () => chain,
      get: async () => null,
      then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
    };
    return chain;
  };
  const insert = () => ({ values: async () => undefined });
  return { db: { select, insert }, schema: { priceCache: { symbol: {}, date: {}, id: {} } } };
});

import { fetchQuoteLive, fetchQuoteLiveBackoff } from "@/lib/price-service";

const refused = (status: number) => ({ ok: false, status, json: async () => ({}) });
const live = (price: number) => ({
  ok: true,
  status: 200,
  json: async () => ({
    chart: { result: [{ meta: { regularMarketPrice: price, previousClose: price, currency: "USD" } }] },
  }),
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

describe("fetchQuoteLiveBackoff", () => {
  it("does not ask Yahoo again for a pair it just refused", async () => {
    fetchSpy.mockResolvedValueOnce(refused(404));
    expect(await fetchQuoteLiveBackoff("CLB1-USD")).toBeNull();
    expect(await fetchQuoteLiveBackoff("CLB1-USD")).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns the quote and keeps asking for a pair Yahoo prices", async () => {
    fetchSpy.mockResolvedValue(live(2.5));
    expect((await fetchQuoteLiveBackoff("CLB2-USD"))?.price).toBe(2.5);
    expect((await fetchQuoteLiveBackoff("CLB2-USD"))?.price).toBe(2.5);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("plain fetchQuoteLive stays side-effect free (a typed lookup never blocks a real one)", async () => {
    fetchSpy.mockResolvedValueOnce(refused(404)).mockResolvedValueOnce(live(9));
    expect(await fetchQuoteLive("CLB3-USD")).toBeNull();
    expect((await fetchQuoteLiveBackoff("CLB3-USD"))?.price).toBe(9);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("getCryptoPrices values held coins through the back-off", () => {
  it("uses fetchQuoteLiveBackoff, not fetchQuoteLive", () => {
    const src = readFileSync(join(__dirname, "..", "src/lib/crypto-service.ts"), "utf8");
    const start = src.indexOf("export async function getCryptoPrices(");
    const end = src.indexOf("\n}\n", start);
    const body = src.slice(start, end);
    expect(body).toContain("fetchQuoteLiveBackoff(");
    expect(body).not.toMatch(/fetchQuoteLive\(/);
  });
});
