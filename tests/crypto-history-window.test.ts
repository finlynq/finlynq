/**
 * Pure-unit tests for `isWithinCryptoHistoryWindow` — the guard that stops
 * `getCryptoPricesAtDate` from firing a doomed CoinGecko market_chart request
 * for dates older than the free tier's ~365-day history window (one wasted call
 * per old date per coin during a multi-year snapshot rebuild). Out-of-window
 * dates fall through to the cache-first spot approximation instead.
 *
 * `@/db` is stubbed so importing crypto-service.ts never touches Postgres; the
 * function under test is pure (no DB, no clock — `today` is injected).
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@/db", () => ({ db: {}, schema: { priceCache: {} } }));

import { isWithinCryptoHistoryWindow, CRYPTO_FREE_HISTORY_DAYS } from "@/lib/crypto-service";

const TODAY = "2026-06-20";

describe("isWithinCryptoHistoryWindow", () => {
  it("allows recent dates within the window", () => {
    expect(isWithinCryptoHistoryWindow("2026-06-19", TODAY)).toBe(true); // 1 day
    expect(isWithinCryptoHistoryWindow("2026-03-20", TODAY)).toBe(true); // ~92 days
    expect(isWithinCryptoHistoryWindow("2025-06-21", TODAY)).toBe(true); // 364 days
  });

  it("rejects dates at/older than the 365-day boundary (strict <)", () => {
    expect(isWithinCryptoHistoryWindow("2025-06-20", TODAY)).toBe(false); // exactly 365 days
    expect(isWithinCryptoHistoryWindow("2024-01-01", TODAY)).toBe(false); // way out of window
    expect(isWithinCryptoHistoryWindow("2023-12-13", TODAY)).toBe(false); // pathfinder's oldest crypto date
  });

  it("treats today/future as in-window (caller routes those to live spot first anyway)", () => {
    expect(isWithinCryptoHistoryWindow(TODAY, TODAY)).toBe(true); // age 0
    expect(isWithinCryptoHistoryWindow("2026-06-25", TODAY)).toBe(true); // future → negative age
  });

  it("is null-safe: malformed dates return false (never attempts a fetch)", () => {
    expect(isWithinCryptoHistoryWindow("not-a-date", TODAY)).toBe(false);
    expect(isWithinCryptoHistoryWindow("2026-06-19", "garbage")).toBe(false);
  });

  it("honors a custom window size", () => {
    expect(CRYPTO_FREE_HISTORY_DAYS).toBe(365);
    expect(isWithinCryptoHistoryWindow("2026-06-10", TODAY, 5)).toBe(false); // 10 days, max 5
    expect(isWithinCryptoHistoryWindow("2026-06-17", TODAY, 5)).toBe(true); // 3 days, max 5
  });
});
