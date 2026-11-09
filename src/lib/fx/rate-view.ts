/**
 * How an exchange rate is SHOWN to the user — pure, client-safe (2026-11-09).
 *
 * Every web surface that prints a rate goes through `formatFxRate`, so it
 * always names the pair ("1 IDR = 0.0000554354 USD") and honours the user's
 * "show rates inverted" preference ("1 USD = 18,039 IDR"). Inverting is a VIEW
 * only: stored rates, overrides and every calculation are unchanged.
 *
 * Small rates keep 6 significant digits rather than a fixed number of decimal
 * places, so 0.0000834 never collapses to "0.000083" or "0.0001".
 */

/** settings key holding "true" / "false". Absent = not inverted. */
export const FX_RATES_INVERTED_KEY = "fx_rates_inverted";

/**
 * A rate value at 6 significant digits, never rounding away whole digits:
 * 0.0000834091, 0.735294, 1.1197, 150.123, 18,039, 1,234,567.
 */
export function formatRateNumber(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  const intDigits = n >= 1 ? Math.floor(Math.log10(n)) + 1 : 0;
  return n.toLocaleString("en-US", { maximumSignificantDigits: Math.min(21, Math.max(6, intDigits)) });
}

export interface RateView {
  base: string;
  quote: string;
  value: number;
}

/**
 * `rate` is units of `to` per 1 unit of `from` (the /api/fx/preview contract).
 * Inverted, it reads as units of `from` per 1 unit of `to`.
 */
export function rateView(rate: number, from: string, to: string, inverted: boolean): RateView {
  if (!inverted || !(rate > 0)) return { base: from, quote: to, value: rate };
  return { base: to, quote: from, value: 1 / rate };
}

/** "1 FROM = X TO", or "1 TO = 1/X FROM" when inverted. */
export function formatFxRate(rate: number, from: string, to: string, inverted: boolean): string {
  const v = rateView(rate, from, to, inverted);
  return `1 ${v.base} = ${formatRateNumber(v.value)} ${v.quote}`;
}
