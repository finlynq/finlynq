/**
 * Pure-unit tests for the Yahoo-first crypto pricing mapping helpers added when
 * Yahoo became the primary crypto price source (live + historical) and CoinGecko
 * the fallback only for coins Yahoo can't price:
 *   - `coinGeckoIdToSymbol` — reverse of SYMBOL_TO_COINGECKO, first-wins so the
 *     MATIC + POL shared coin id resolves to MATIC. A coin id with no entry →
 *     null (routes to the CoinGecko fallback).
 *   - `cryptoSymbolToYahooTicker` — overrides for coins whose Yahoo ticker
 *     differs (id-suffixed clashes, renames); null = no Yahoo listing.
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

  it("resolves the MATIC/POL shared coin id to MATIC (first-wins), not POL", () => {
    // Both price as POL; MATIC wins the reverse lookup so the live path keeps
    // the CRYPTO:MATIC cache key it always wrote.
    expect(symbolToCoinGeckoId("MATIC")).toBe("polygon-ecosystem-token");
    expect(symbolToCoinGeckoId("POL")).toBe("polygon-ecosystem-token");
    expect(coinGeckoIdToSymbol("polygon-ecosystem-token")).toBe("MATIC");
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

  it("routes MATIC and POL to POL28321-USD (Yahoo dropped MATIC-USD and POL-USD)", () => {
    expect(cryptoSymbolToYahooTicker("POL")).toBe("POL28321-USD");
    expect(cryptoSymbolToYahooTicker("MATIC")).toBe("POL28321-USD");
  });

  // Checked live 2026-11-14: Yahoo appends an id to a coin whose ticker clashes
  // with another coin. Plain ARB-USD is "ARbit" at a fraction of a cent, so an
  // Arbitrum holding was valued near zero with no fallback.
  it("uses Yahoo's id-suffixed tickers for clashing or renamed coins", () => {
    expect(cryptoSymbolToYahooTicker("ARB")).toBe("ARB11841-USD");
    expect(cryptoSymbolToYahooTicker("APT")).toBe("APT21794-USD");
    expect(cryptoSymbolToYahooTicker("SUI")).toBe("SUI20947-USD");
    expect(cryptoSymbolToYahooTicker("UNI-USD")).toBe("UNI7083-USD");
    expect(cryptoSymbolToYahooTicker("S")).toBe("S32684-USD");
  });

  it("returns null for a coin Yahoo has no listing for (FTM → CoinGecko only)", () => {
    expect(cryptoSymbolToYahooTicker("FTM")).toBeNull();
    expect(cryptoSymbolToYahooTicker("ftm-usd")).toBeNull();
  });

  it("does not treat inherited object keys as overrides", () => {
    expect(cryptoSymbolToYahooTicker("constructor")).toBe("CONSTRUCTOR-USD");
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
