/**
 * A refused HISTORICAL lookup must not stop the LIVE price (2026-11-07).
 *
 * Prod's daily check found ~250 Yahoo 400s in one minute: a user typing a year
 * into the Reports start date asked for prices at 0002-01-01, 0020-01-01 and
 * 0201-01-01, and every refusal went into the one per-symbol negative cache
 * the live quote also reads. AAPL, MSFT, SPY and about 80 other tickers then
 * got no fresh price for any user for 10 minutes. History misses now have their
 * own cache; history lookups still honour live misses.
 *
 * Driven against an empty in-memory `@/db` (every read misses the cache) and a
 * stubbed global `fetch`. The negative caches are module-level, so each test
 * uses its own symbols.
 */

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
  const update = () => {
    const chain = {
      set: () => chain,
      where: () => chain,
      returning: async () => [],
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
    };
    return chain;
  };
  const insert = () => ({ values: async () => undefined });
  return {
    db: { select, update, insert },
    schema: { priceCache: { symbol: {}, date: {}, id: {} } },
  };
});

import {
  fetchQuote,
  fetchMultipleQuotes,
  fetchQuoteAtDate,
  fetchYahooDailyCloses,
} from "@/lib/price-service";
import { todayISO } from "@/lib/utils/date";

function liveBody(price: number) {
  return {
    chart: { result: [{ meta: { regularMarketPrice: price, previousClose: price, currency: "USD" } }] },
  };
}

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

const refused = (status: number) => ({ ok: false, status, json: async () => ({}) });
const live = (price: number) => ({ ok: true, status: 200, json: async () => liveBody(price) });

describe("history misses stay out of the live quote", () => {
  it("a refused historical lookup does not block fetchQuote", async () => {
    fetchSpy.mockResolvedValueOnce(refused(400));
    expect(await fetchQuoteAtDate("HMI1", "2010-01-04")).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockResolvedValueOnce(live(101.5));
    const q = await fetchQuote("HMI1");
    expect(fetchSpy).toHaveBeenCalledTimes(2); // the live fetch WAS made
    expect(q?.price).toBe(101.5);
  });

  it("a refused historical lookup does not block fetchMultipleQuotes", async () => {
    fetchSpy.mockResolvedValueOnce(refused(400));
    await fetchQuoteAtDate("HMI2", "2010-01-04");

    fetchSpy.mockResolvedValueOnce(live(42));
    const out = await fetchMultipleQuotes(["HMI2"]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(out.get("HMI2")?.price).toBe(42);
  });

  it("a refused daily-closes lookup does not block the live quote either", async () => {
    fetchSpy.mockResolvedValueOnce(refused(400));
    expect(await fetchYahooDailyCloses("HMI3", "2010-01-04", todayISO())).toEqual([]);

    fetchSpy.mockResolvedValueOnce(live(7));
    expect((await fetchQuote("HMI3"))?.price).toBe(7);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("history lookups keep their own back-off", () => {
  it("a refused historical lookup still skips the next one (rebuild walk)", async () => {
    fetchSpy.mockResolvedValueOnce(refused(400));
    await fetchQuoteAtDate("HMI4", "2010-01-04");
    expect(await fetchQuoteAtDate("HMI4", "2010-01-05")).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("a live miss still skips history lookups (Yahoo doesn't know the ticker)", async () => {
    fetchSpy.mockResolvedValueOnce(refused(404));
    expect(await fetchQuote("HMI5")).toBeNull();
    expect(await fetchQuoteAtDate("HMI5", "2010-01-04")).toBeNull();
    expect(await fetchYahooDailyCloses("HMI5", "2010-01-04", todayISO())).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("dates Yahoo has no data for are not asked about", () => {
  it("skips a window that starts before 1970 and an unparseable date", async () => {
    expect(await fetchQuoteAtDate("HMI6", "1970-01-01")).toBeNull();
    expect(await fetchQuoteAtDate("HMI6", "0002-01-01")).toBeNull();
    expect(await fetchQuoteAtDate("HMI6", "not-a-date")).toBeNull();
    expect(await fetchYahooDailyCloses("HMI6", "1965-06-01", todayISO())).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a skipped pre-1970 date does not count as a miss", async () => {
    await fetchQuoteAtDate("HMI7", "0002-01-01");
    fetchSpy.mockResolvedValueOnce(refused(400));
    await fetchQuoteAtDate("HMI7", "2010-01-04");
    expect(fetchSpy).toHaveBeenCalledTimes(1); // the 2010 lookup still went out
  });
});
