/**
 * Negative quote cache — the back-off behind price-service's "no live quote"
 * log line.
 *
 * Prod re-asked Yahoo for ~21 delisted / renamed tickers every 10 minutes for
 * days (2026-10-31). A 404 means the SYMBOL is unknown, so consecutive 404s
 * must back off (10 min doubling to a 24 h cap) while timeouts keep the plain
 * 10 min. The subtle part, pinned here: the strike count survives the entry's
 * expiry — otherwise every 404 after the first starts over at 10 min and the
 * back-off never happens — and any success forgets the symbol entirely.
 */
import { describe, it, expect } from "vitest";

import {
  NEGATIVE_QUOTE_NOT_FOUND_MAX_MS,
  NEGATIVE_QUOTE_TTL_MS,
  NegativeQuoteCache,
  negativeQuoteBackoffMs,
} from "@/lib/securities/negative-quote-cache";

const MIN = 60_000;

/** A cache on a hand-driven clock. */
function cacheAt(start = 1_000_000) {
  let t = start;
  const cache = new NegativeQuoteCache(() => t);
  return {
    cache,
    advance(ms: number) {
      t += ms;
    },
    get now() {
      return t;
    },
  };
}

describe("negativeQuoteBackoffMs", () => {
  it("doubles per consecutive 404 from the 10-minute base", () => {
    expect(negativeQuoteBackoffMs(1)).toBe(10 * MIN);
    expect(negativeQuoteBackoffMs(2)).toBe(20 * MIN);
    expect(negativeQuoteBackoffMs(3)).toBe(40 * MIN);
    expect(negativeQuoteBackoffMs(8)).toBe(1280 * MIN);
  });

  it("caps at 24 hours", () => {
    expect(negativeQuoteBackoffMs(9)).toBe(NEGATIVE_QUOTE_NOT_FOUND_MAX_MS);
    expect(negativeQuoteBackoffMs(100)).toBe(NEGATIVE_QUOTE_NOT_FOUND_MAX_MS);
    expect(negativeQuoteBackoffMs(10_000)).toBe(NEGATIVE_QUOTE_NOT_FOUND_MAX_MS);
    expect(NEGATIVE_QUOTE_NOT_FOUND_MAX_MS).toBe(24 * 60 * MIN);
  });

  it("falls back to the base TTL for a zero / garbage strike count", () => {
    expect(negativeQuoteBackoffMs(0)).toBe(NEGATIVE_QUOTE_TTL_MS);
    expect(negativeQuoteBackoffMs(-3)).toBe(NEGATIVE_QUOTE_TTL_MS);
    expect(negativeQuoteBackoffMs(Number.NaN)).toBe(NEGATIVE_QUOTE_TTL_MS);
    expect(NEGATIVE_QUOTE_TTL_MS).toBe(10 * MIN);
  });
});

describe("NegativeQuoteCache", () => {
  it("knows nothing about a symbol it has never seen", () => {
    const { cache } = cacheAt();
    expect(cache.isCached("AAPL")).toBe(false);
    expect(cache.peek("AAPL")).toBeUndefined();
  });

  it("caches a timeout for exactly 10 minutes and never escalates it", () => {
    const { cache, advance } = cacheAt();
    for (let i = 0; i < 5; i++) {
      const mark = cache.markMiss("SLOW", null);
      expect(mark).toEqual({ ttlMs: 10 * MIN, notFoundStrikes: 0 });
      expect(cache.isCached("SLOW")).toBe(true);
      advance(10 * MIN);
      expect(cache.isCached("SLOW")).toBe(true); // boundary: until is inclusive
      advance(1);
      expect(cache.isCached("SLOW")).toBe(false);
    }
  });

  it("forgets an expired transient miss outright (no entry lingers)", () => {
    const { cache, advance } = cacheAt();
    cache.markMiss("SLOW", null);
    advance(10 * MIN + 1);
    expect(cache.isCached("SLOW")).toBe(false);
    expect(cache.size).toBe(0);
  });

  it("treats 400 / 429 / 500 like a timeout — only 404 is evidence about the symbol", () => {
    const { cache } = cacheAt();
    for (const status of [400, 429, 500, 503, 200]) {
      expect(cache.markMiss(`S${status}`, status)).toEqual({ ttlMs: 10 * MIN, notFoundStrikes: 0 });
    }
  });

  it("doubles the back-off on each consecutive 404", () => {
    const { cache, advance } = cacheAt();
    const expected = [10, 20, 40, 80, 160, 320, 640, 1280, 1440, 1440];
    expected.forEach((minutes, i) => {
      const mark = cache.markMiss("SQ", 404);
      expect(mark.ttlMs).toBe(minutes * MIN);
      expect(mark.notFoundStrikes).toBe(i + 1);
      expect(cache.isCached("SQ")).toBe(true);
      advance(minutes * MIN + 1);
      expect(cache.isCached("SQ")).toBe(false);
    });
  });

  it("keeps the strike count across expiry — the whole point of the back-off", () => {
    const { cache, advance } = cacheAt();
    cache.markMiss("WE", 404);
    advance(10 * MIN + 1);
    expect(cache.isCached("WE")).toBe(false);
    // The expired entry is retained, strikes intact…
    expect(cache.peek("WE")?.notFoundStrikes).toBe(1);
    expect(cache.size).toBe(1);
    // …so the next 404 is strike 2, not a fresh 10 minutes.
    expect(cache.markMiss("WE", 404)).toEqual({ ttlMs: 20 * MIN, notFoundStrikes: 2 });
  });

  it("a timeout mid-run uses 10 minutes but neither resets nor extends the strikes", () => {
    const { cache, advance } = cacheAt();
    cache.markMiss("MULN", 404);
    advance(10 * MIN + 1);
    cache.markMiss("MULN", 404);
    advance(20 * MIN + 1);
    expect(cache.markMiss("MULN", 404).ttlMs).toBe(40 * MIN);
    advance(40 * MIN + 1);

    const timeout = cache.markMiss("MULN", null);
    expect(timeout).toEqual({ ttlMs: 10 * MIN, notFoundStrikes: 3 });
    advance(10 * MIN + 1);
    expect(cache.isCached("MULN")).toBe(false);
    expect(cache.peek("MULN")?.notFoundStrikes).toBe(3); // a timeout-only entry would have been dropped

    // The run resumes where it left off.
    expect(cache.markMiss("MULN", 404)).toEqual({ ttlMs: 80 * MIN, notFoundStrikes: 4 });
  });

  it("a success clears everything, so a later 404 starts over at 10 minutes", () => {
    const { cache, advance } = cacheAt();
    for (let i = 0; i < 4; i++) {
      cache.markMiss("NEWCO", 404);
      advance(negativeQuoteBackoffMs(i + 1) + 1);
    }
    expect(cache.peek("NEWCO")?.notFoundStrikes).toBe(4);

    cache.clear("NEWCO");
    expect(cache.isCached("NEWCO")).toBe(false);
    expect(cache.peek("NEWCO")).toBeUndefined();
    expect(cache.markMiss("NEWCO", 404)).toEqual({ ttlMs: 10 * MIN, notFoundStrikes: 1 });
  });

  it("while a back-off is active, isCached stays true right up to the deadline", () => {
    const { cache, advance } = cacheAt();
    cache.markMiss("IRNT", 404);
    advance(10 * MIN + 1);
    cache.markMiss("IRNT", 404); // 20 min
    advance(19 * MIN);
    expect(cache.isCached("IRNT")).toBe(true);
    advance(1 * MIN);
    expect(cache.isCached("IRNT")).toBe(true);
    advance(1);
    expect(cache.isCached("IRNT")).toBe(false);
  });

  it("tracks symbols independently", () => {
    const { cache } = cacheAt();
    cache.markMiss("A", 404);
    cache.markMiss("A", 404);
    expect(cache.markMiss("B", 404).notFoundStrikes).toBe(1);
    expect(cache.peek("A")?.notFoundStrikes).toBe(2);
  });

  it("uses the real clock by default", () => {
    const cache = new NegativeQuoteCache();
    const before = Date.now();
    cache.markMiss("X", null);
    const until = cache.peek("X")!.until;
    expect(until).toBeGreaterThanOrEqual(before + 10 * MIN);
    expect(until).toBeLessThanOrEqual(Date.now() + 10 * MIN);
  });
});
