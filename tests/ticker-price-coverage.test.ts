/**
 * Unpriceable-ticker detection + advisory resolution.
 *
 * Covers the pure halves of the AMZN401K fix: which securities are even ASKED
 * "have you ever been priced?" (isPriceCoverageCandidate), what price_cache key
 * the answer is looked up under (priceCacheKeyFor), and which advisory the UI
 * ends up showing (resolveTickerAdvisory). The DB query itself
 * (findNeverPricedSecurityIds) is exercised end-to-end on dev, not here.
 */

import { describe, it, expect } from "vitest";

import {
  isPastGracePeriod,
  isPriceCoverageCandidate,
  priceCacheKeyFor,
  NEW_SECURITY_GRACE_MS,
  type PriceCoverageCandidate,
} from "@/lib/securities/price-coverage";
import {
  curatedAdvisorySymbols,
  getTickerAdvisory,
  resolveTickerAdvisory,
  unpricedTickerAdvisory,
} from "@/lib/securities/ticker-advisories";

function candidate(over: Partial<PriceCoverageCandidate> = {}): PriceCoverageCandidate {
  return {
    id: 1,
    symbol: "AMZN401K",
    isCash: false,
    isCrypto: false,
    priceSource: "auto",
    heldIn: 1,
    createdAt: new Date(Date.now() - 30 * 24 * 3600_000),
    ...over,
  };
}

describe("priceCacheKeyFor", () => {
  it("uses the symbol verbatim for equities (price-service writes it unchanged)", () => {
    expect(priceCacheKeyFor("AMZN", false)).toBe("AMZN");
    expect(priceCacheKeyFor("  SHOP.TO ", false)).toBe("SHOP.TO");
  });

  it("namespaces crypto under CRYPTO:<SYM> to match crypto-service", () => {
    expect(priceCacheKeyFor("btc", true)).toBe("CRYPTO:BTC");
  });

  it("detects crypto from the symbol even when the flag is off", () => {
    expect(priceCacheKeyFor("SOL", false)).toBe("CRYPTO:SOL");
  });
});

describe("isPriceCoverageCandidate", () => {
  it("flags a held, auto-priced ticker as answerable", () => {
    expect(isPriceCoverageCandidate(candidate())).toBe(true);
  });

  it("skips manual securities — an empty cache is the whole point of manual", () => {
    expect(isPriceCoverageCandidate(candidate({ priceSource: "manual" }))).toBe(false);
  });

  it("skips cash sleeves and symbol-less rows", () => {
    expect(isPriceCoverageCandidate(candidate({ isCash: true }))).toBe(false);
    expect(isPriceCoverageCandidate(candidate({ symbol: null }))).toBe(false);
    expect(isPriceCoverageCandidate(candidate({ symbol: "   " }))).toBe(false);
  });

  it("skips catalog-only entries nothing has ever asked to price", () => {
    expect(isPriceCoverageCandidate(candidate({ heldIn: 0 }))).toBe(false);
  });

  it("skips currency-code symbols — priced via fx_rates, not price_cache", () => {
    for (const sym of ["USD", "EUR", "XAU"]) {
      expect(isPriceCoverageCandidate(candidate({ symbol: sym }))).toBe(false);
    }
  });

  it("treats a null price_source (un-backfilled row) as auto", () => {
    expect(isPriceCoverageCandidate(candidate({ priceSource: null }))).toBe(true);
  });

  it("spares a just-added security — nothing has had a chance to price it yet", () => {
    expect(isPriceCoverageCandidate(candidate({ createdAt: new Date() }))).toBe(false);
  });
});

describe("isPastGracePeriod", () => {
  const now = Date.UTC(2026, 6, 27, 12, 0, 0);

  it("is false inside the window and true once past it", () => {
    expect(isPastGracePeriod(new Date(now - NEW_SECURITY_GRACE_MS + 1000), now)).toBe(false);
    expect(isPastGracePeriod(new Date(now - NEW_SECURITY_GRACE_MS - 1000), now)).toBe(true);
  });

  it("accepts an ISO string as well as a Date", () => {
    expect(isPastGracePeriod("2026-07-01T00:00:00Z", now)).toBe(true);
  });

  it("treats a missing or unparseable stamp as long-standing", () => {
    expect(isPastGracePeriod(null, now)).toBe(true);
    expect(isPastGracePeriod("not-a-date", now)).toBe(true);
  });
});

describe("resolveTickerAdvisory", () => {
  it("returns nothing for a healthy ticker", () => {
    expect(resolveTickerAdvisory("AMZN")).toBeNull();
    expect(resolveTickerAdvisory("AMZN", { neverPriced: false })).toBeNull();
  });

  it("surfaces a detected advisory for a never-priced ticker", () => {
    const a = resolveTickerAdvisory("AMZN401K", { neverPriced: true });
    expect(a?.kind).toBe("unpriced");
    expect(a?.symbol).toBe("AMZN401K");
    // No replacement exists for a user-invented symbol — the UI keys the
    // "Fix symbol" / "Use manual price" actions off its absence.
    expect(a?.suggestedSymbol).toBeUndefined();
    expect(a?.message).toContain("AMZN401K");
  });

  it("prefers the curated entry — it names a concrete replacement", () => {
    const a = resolveTickerAdvisory("pol", { neverPriced: true });
    expect(a?.kind).toBe("curated");
    expect(a?.suggestedSymbol).toBe("MATIC");
  });

  it("still returns the curated entry when nothing was detected", () => {
    expect(resolveTickerAdvisory("POL")?.suggestedSymbol).toBe("MATIC");
  });

  it("ignores blank symbols", () => {
    expect(resolveTickerAdvisory("", { neverPriced: true })).toBeNull();
    expect(resolveTickerAdvisory(null, { neverPriced: true })).toBeNull();
  });
});

describe("curated registry", () => {
  it("tags curated hits and is case-insensitive", () => {
    expect(getTickerAdvisory(" pol ")?.kind).toBe("curated");
    expect(getTickerAdvisory("AMZN401K")).toBeNull();
  });

  it("builds a detected advisory naming the offending symbol", () => {
    expect(unpricedTickerAdvisory(" FOO ").symbol).toBe("FOO");
  });
});

// ── 2026-10-31 batch: the tickers prod re-asked Yahoo for every 10 minutes ───
// Each replacement below was checked LIVE against Yahoo's chart API the day it
// was added; the asserted successor is what Yahoo priced, which is not always
// the obvious one (PARA now belongs to a different company; CTRA 404s).
describe("curated registry — renamed and re-notated tickers", () => {
  it.each([
    ["SQ", "XYZ"], // Block, Jan 2025
    ["VIAC", "PSKY"], // ViacomCBS → Paramount Global → Paramount Skydance
    ["HCP", "DOC"], // Healthpeak: HCP → PEAK → DOC
    ["03690", "3690.HK"], // Meituan: HK code needs .HK, no leading zero
    ["9633", "9633.HK"], // Nongfu Spring
  ])("%s → %s offers a one-click change", (from, to) => {
    const a = getTickerAdvisory(from);
    expect(a?.kind).toBe("curated");
    expect(a?.symbol).toBe(from);
    expect(a?.suggestedSymbol).toBe(to);
    expect(a?.message).toContain(to);
  });

  it("VIAC does NOT point at PARA — Yahoo now serves PARA as another company", () => {
    expect(getTickerAdvisory("VIAC")?.suggestedSymbol).not.toBe("PARA");
    // …and PARA itself is not curated: it prices (as Parabolic Technologies),
    // so a detected `unpriced` advisory would never fire for it either. A user
    // holding Paramount as PARA is silently mispriced — a follow-up, not this.
    expect(getTickerAdvisory("PARA")).toBeNull();
  });

  it("SWN names the successor and ratio but offers NO one-click swap (0.0867 EXE per share)", () => {
    const a = getTickerAdvisory("SWN");
    expect(a?.kind).toBe("curated");
    expect(a?.suggestedSymbol).toBeUndefined();
    expect(a?.message).toContain("EXE");
    expect(a?.message).toContain("0.0867");
    // Still wins over the detected advisory — it says exactly what to do.
    expect(resolveTickerAdvisory("swn", { neverPriced: true })?.kind).toBe("curated");
  });

  it("COG stays on the detected advisory — its successor CTRA 404'd on Yahoo when checked", () => {
    expect(getTickerAdvisory("COG")).toBeNull();
    expect(resolveTickerAdvisory("COG", { neverPriced: true })?.kind).toBe("unpriced");
  });

  it("delisted names with no successor stay on the detected advisory", () => {
    for (const sym of ["WE", "MULN", "AMRS", "IRNT", "HIL", "CPE"]) {
      expect(getTickerAdvisory(sym)).toBeNull();
      expect(resolveTickerAdvisory(sym, { neverPriced: true })?.kind).toBe("unpriced");
    }
  });

  it("curated beats detected for the whole batch, case-insensitively", () => {
    expect(resolveTickerAdvisory("sq", { neverPriced: true })?.suggestedSymbol).toBe("XYZ");
    expect(resolveTickerAdvisory(" viac ", { neverPriced: true })?.suggestedSymbol).toBe("PSKY");
    expect(resolveTickerAdvisory("03690")?.suggestedSymbol).toBe("3690.HK");
  });

  it("every entry is keyed by its own uppercased symbol and never suggests itself", () => {
    const keys = curatedAdvisorySymbols();
    expect(keys.length).toBeGreaterThanOrEqual(7);
    for (const key of keys) {
      const a = getTickerAdvisory(key)!;
      expect(key).toBe(key.toUpperCase());
      expect(a.symbol).toBe(key);
      expect(a.message.length).toBeGreaterThan(20);
      if (a.suggestedSymbol) {
        expect(a.suggestedSymbol).not.toBe(key);
        expect(a.suggestedSymbol).toBe(a.suggestedSymbol.trim().toUpperCase());
      }
    }
  });
});
