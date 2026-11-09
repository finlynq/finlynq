/**
 * Pure-unit tests for the Yahoo-first crypto pricing mapping helpers added when
 * Yahoo became the primary crypto price source (live + historical) and CoinGecko
 * the fallback only for coins Yahoo can't price:
 *   - `coinGeckoIdToSymbol` — reverse of SYMBOL_TO_COINGECKO, first-wins so the
 *     matic-network collision (MATIC + POL) resolves to MATIC (Yahoo's deep
 *     history is under MATIC-USD). A coin id with no entry → null (routes to the
 *     CoinGecko fallback).
 *   - `cryptoSymbolToYahooTicker` — POL override points at MATIC-USD.
 *   - `stripYahooCryptoNameSuffix` — Yahoo names crypto "<Name> USD"; strip it.
 *
 * `@/db` is stubbed so importing crypto-service.ts never touches Postgres; the
 * functions under test are pure.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@/db", () => ({ db: {}, schema: { priceCache: {} } }));

import {
  coinGeckoIdToSymbol,
  cryptoSymbolToYahooTicker,
  stripYahooCryptoNameSuffix,
  symbolToCoinGeckoId,
} from "@/lib/crypto-service";
import { isCryptoSymbol } from "@/lib/fx/supported-currencies";

describe("tokenized gold (GH #395)", () => {
  it("prices PAXG and XAUT when the holding is marked crypto, with or without a pair suffix", () => {
    expect(symbolToCoinGeckoId("PAXG")).toBe("pax-gold");
    expect(symbolToCoinGeckoId("paxg-usd")).toBe("pax-gold");
    expect(symbolToCoinGeckoId("XAUT")).toBe("tether-gold");
    expect(symbolToCoinGeckoId("XAUT-USD")).toBe("tether-gold");
  });

  it("asks Yahoo for PAXG-USD / XAUT-USD", () => {
    expect(cryptoSymbolToYahooTicker(coinGeckoIdToSymbol("pax-gold")!)).toBe("PAXG-USD");
    expect(cryptoSymbolToYahooTicker(coinGeckoIdToSymbol("tether-gold")!)).toBe("XAUT-USD");
  });

  it("never treats them as crypto by symbol alone (a bare PAXG on Yahoo is a stock)", () => {
    expect(isCryptoSymbol("PAXG")).toBe(false);
    expect(isCryptoSymbol("XAUT")).toBe(false);
  });
});

describe("coinGeckoIdToSymbol", () => {
  it("maps known coin ids back to their base symbol", () => {
    expect(coinGeckoIdToSymbol("bitcoin")).toBe("BTC");
    expect(coinGeckoIdToSymbol("ethereum")).toBe("ETH");
  });

  it("resolves the matic-network collision to MATIC (first-wins), not POL", () => {
    // Both MATIC and POL map to matic-network; the reverse map must pick MATIC
    // so the Yahoo ticker resolves to MATIC-USD (which has the deep history).
    expect(coinGeckoIdToSymbol("matic-network")).toBe("MATIC");
  });

  it("returns null for an unmapped coin id (→ CoinGecko fallback)", () => {
    expect(coinGeckoIdToSymbol("some-obscure-coin")).toBeNull();
  });
});

describe("cryptoSymbolToYahooTicker", () => {
  it("defaults to <SYM>-USD", () => {
    expect(cryptoSymbolToYahooTicker("BTC")).toBe("BTC-USD");
    expect(cryptoSymbolToYahooTicker("eth")).toBe("ETH-USD");
  });

  it("routes POL to MATIC-USD (Polygon rename — Yahoo history under MATIC)", () => {
    expect(cryptoSymbolToYahooTicker("POL")).toBe("MATIC-USD");
  });

  it("strips an existing pair suffix before mapping", () => {
    expect(cryptoSymbolToYahooTicker("BTC-CAD")).toBe("BTC-USD");
  });
});

describe("stripYahooCryptoNameSuffix", () => {
  it("strips the trailing currency suffix Yahoo appends", () => {
    expect(stripYahooCryptoNameSuffix("Bitcoin USD")).toBe("Bitcoin");
    expect(stripYahooCryptoNameSuffix("Polygon Ecosystem Token USD")).toBe("Polygon Ecosystem Token");
    expect(stripYahooCryptoNameSuffix("Ethereum-USD")).toBe("Ethereum");
  });

  it("leaves a clean name untouched and is null-safe", () => {
    expect(stripYahooCryptoNameSuffix("Bitcoin")).toBe("Bitcoin");
    expect(stripYahooCryptoNameSuffix(null)).toBe("");
    expect(stripYahooCryptoNameSuffix(undefined)).toBe("");
  });
});
