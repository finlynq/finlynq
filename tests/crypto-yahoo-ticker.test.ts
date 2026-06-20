/**
 * Pure-unit tests for `cryptoSymbolToYahooTicker` — the base-symbol → Yahoo
 * crypto ticker resolver used by the >365-day historical tier (Yahoo serves
 * crypto daily history back to ~2014 via "<SYM>-USD"). Default is "<SYM>-USD";
 * an override map covers any symbol whose Yahoo ticker differs.
 *
 * `@/db` + `@/lib/price-service` are stubbed so importing crypto-service.ts
 * never touches Postgres or the network; the function under test is pure.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@/db", () => ({ db: {}, schema: { priceCache: {} } }));
vi.mock("@/lib/price-service", () => ({
  isPriceCacheRowStale: () => false,
  fetchYahooDailyCloses: async () => [],
}));

import { cryptoSymbolToYahooTicker } from "@/lib/crypto-service";

describe("cryptoSymbolToYahooTicker", () => {
  it("maps a base symbol to <SYM>-USD", () => {
    expect(cryptoSymbolToYahooTicker("BTC")).toBe("BTC-USD");
    expect(cryptoSymbolToYahooTicker("ETH")).toBe("ETH-USD");
    expect(cryptoSymbolToYahooTicker("SOL")).toBe("SOL-USD");
  });

  it("uppercases and strips an existing -USD/-CAD suffix", () => {
    expect(cryptoSymbolToYahooTicker("btc")).toBe("BTC-USD");
    expect(cryptoSymbolToYahooTicker("ETH-CAD")).toBe("ETH-USD");
    expect(cryptoSymbolToYahooTicker("doge-usd")).toBe("DOGE-USD");
  });

  it("handles the MATIC/POL rebrand pair (both resolve to their own -USD)", () => {
    expect(cryptoSymbolToYahooTicker("MATIC")).toBe("MATIC-USD");
    expect(cryptoSymbolToYahooTicker("POL")).toBe("POL-USD");
  });

  it("is null-safe", () => {
    expect(cryptoSymbolToYahooTicker("")).toBe("-USD");
  });
});
