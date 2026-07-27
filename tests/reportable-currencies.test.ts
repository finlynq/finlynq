/**
 * Guards the split between "can we report in it" and "is this ticker cash".
 *
 * WHY THIS EXISTS
 * ---------------
 * `SUPPORTED_CURRENCIES` does double duty: it gates FX lookups AND it decides
 * whether a portfolio holding whose symbol is a 3-letter code is foreign cash
 * rather than a stock (`isCurrencyCodeSymbol`, /api/portfolio/symbol-info,
 * /api/securities/define). Several currencies users legitimately want to report
 * in are ALSO live Yahoo tickers — `AED` is Aegon N.V. PERP CAP SECS, `SAR` is
 * Saratoga Investment Corp. Merging the reportable list into the supported list
 * would reclassify anyone holding those tickers as holding cash: the documented
 * "CAD -> Cadiz Inc" mispricing in reverse, a 100x-scale valuation error.
 *
 * So the invariant is: REPORTABLE may grow freely; SUPPORTED must not grow as a
 * side effect.
 */

import { describe, it, expect } from "vitest";
import {
  SUPPORTED_CURRENCIES,
  SUPPORTED_FIAT_CURRENCIES,
  ADDITIONAL_REPORTABLE_CURRENCIES,
  REPORTABLE_FIAT_CURRENCIES,
  isReportableCurrency,
  isSupportedCurrency,
  isCurrencyCodeSymbol,
  currencyLabel,
  CURRENCY_LABELS,
} from "@/lib/fx/supported-currencies";

describe("reportable vs supported currencies", () => {
  it("keeps the additional reportable codes OUT of the classification set", () => {
    const leaked = ADDITIONAL_REPORTABLE_CURRENCIES.filter((c) =>
      (SUPPORTED_CURRENCIES as readonly string[]).includes(c),
    );
    expect(
      leaked,
      "these would make a holding with that ticker read as foreign cash — " +
        "AED is an Aegon ETF, SAR is Saratoga Investment Corp:\n  " +
        leaked.join(", "),
    ).toEqual([]);
  });

  it("does not classify a reportable-only code as a currency ticker", () => {
    // The two named collisions, asserted explicitly: someone HOLDING these must
    // keep being priced as the security, not silently valued as cash.
    expect(isCurrencyCodeSymbol("AED")).toBe(false);
    expect(isCurrencyCodeSymbol("SAR")).toBe(false);
    // …while the genuine cash codes still classify.
    expect(isCurrencyCodeSymbol("CAD")).toBe(true);
    expect(isCurrencyCodeSymbol("XAU")).toBe(true);
  });

  it("reports on every built-in fiat currency plus the additions", () => {
    for (const c of SUPPORTED_FIAT_CURRENCIES) {
      expect(isReportableCurrency(c), `${c} must stay reportable`).toBe(true);
    }
    expect(isReportableCurrency("AED")).toBe(true);
    expect(isReportableCurrency("VND")).toBe(true);
    // Not reportable: measured as having no recent Yahoo quote (2026-07-27).
    // ANG was replaced by XCG; BGN retired when Bulgaria adopted the euro.
    expect(isReportableCurrency("ANG")).toBe(false);
    expect(isReportableCurrency("BGN")).toBe(false);
    // Crypto and metals are not offerable as a reporting currency.
    expect(isReportableCurrency("BTC")).toBe(false);
    expect(isReportableCurrency("XAU")).toBe(false);
    // …but they remain SUPPORTED, i.e. still valid as a holding's currency.
    expect(isSupportedCurrency("XAU")).toBe(true);
  });

  it("has no duplicates", () => {
    const all = [...REPORTABLE_FIAT_CURRENCIES];
    expect(all.length).toBe(new Set(all).size);
  });

  it("labels every reportable currency", () => {
    // The pickers are type-ahead and filter on the label, so a missing name
    // means that currency is only findable if you already know the ISO code.
    const unlabelled = REPORTABLE_FIAT_CURRENCIES.filter(
      (c) => !(c in CURRENCY_LABELS) || currencyLabel(c) === c,
    );
    expect(
      unlabelled,
      `add a CURRENCY_LABELS entry for:\n  ${unlabelled.join(", ")}`,
    ).toEqual([]);
  });

  it("uses well-formed ISO 4217 codes", () => {
    for (const c of REPORTABLE_FIAT_CURRENCIES) {
      expect(c, `${c} is not a 3-letter uppercase code`).toMatch(/^[A-Z]{3}$/);
    }
  });
});
