/**
 * Money rounding helpers — central precision contract for MCP responses
 * and the MCP write boundary.
 *
 * Issue #208 — IEEE-754 leaks through MCP read tools (`balance: -3.6e-11`,
 * `5598.589999990002`) and FX-revaluation `transactions` rows persisted with
 * 4-8 decimal `amount` values that compound on every aggregator's
 * `SUM(t.amount)`. The fix is two-part: (a) round at every MCP response
 * shaper that emits a money number, and (b) round at the MCP write boundary
 * so we stop persisting drift.
 *
 * Internal aggregators (`holdings-value.ts`, `accumulate()` in
 * `register-tools-pg.ts`, `/api/portfolio/overview`) MUST keep computing in
 * full precision; round only at the API response boundary. Per-step rounding
 * compounds errors over many rows.
 *
 * Display path (`formatCurrency` → `Intl.NumberFormat`) already rounds at
 * display time, so the UI hides this. MCP responses do not — Claude reads
 * the raw JSON.
 */

// ISO 4217 zero-fraction currencies. Conservative set — extend only when an
// account in scope uses one. Today (2026-05-09) Finlynq has no JPY-denominated
// accounts in production; this is plumbing for when one materializes.
const ZERO_DP_CURRENCIES = new Set(["JPY", "KRW", "VND", "IDR", "CLP"]);

// Sub-epsilon clamp — IEEE-754 noise like `-3.637978807091713e-11` reads as
// a tiny negative; collapse to exactly 0 so MCP responses don't leak the noise.
const EPSILON = 1e-6;

/**
 * Round a money amount to its currency's decimal precision.
 *
 * - 2dp default (USD/CAD/EUR/GBP/...).
 * - 0dp for ISO zero-fraction currencies (JPY/KRW/VND/IDR/CLP).
 * - Sub-epsilon (`|x| < 1e-6`) clamped to 0 to crush IEEE-754 noise.
 * - `NaN` / `Infinity` returns 0 (defensive — never poison the response).
 *
 * Use this at every MCP response shaper that emits a money number. The helper
 * `tagAmount()` in `mcp-server/currency-tagging.ts` already does the same 2dp
 * rounding for tagged amounts; this helper covers the bypassed callsites.
 */
export function roundMoney(amount: number, currency: string | null | undefined): number {
  if (!Number.isFinite(amount)) return 0;
  const ccy = (currency ?? "").toUpperCase();
  const decimals = ZERO_DP_CURRENCIES.has(ccy) ? 0 : 2;
  const factor = 10 ** decimals;
  const rounded = Math.round(amount * factor) / factor;
  return Math.abs(rounded) < EPSILON ? 0 : rounded;
}

/**
 * Alias for `roundMoney` that names intent at the callsite — when a value is
 * being rounded into a reporting (display-currency) precision rather than its
 * own native currency, use this so the reader sees the contract.
 */
export function roundReporting(amount: number, reportingCurrency: string): number {
  return roundMoney(amount, reportingCurrency);
}

/**
 * Round an FX rate to the bank-standard 8 decimal places.
 *
 * FX rates are NOT money amounts — they're divisors / cross-rates. They
 * carry more precision than the currencies they convert between. Use this
 * for surface display only (`get_fx_rate.rate`, `convert_amount.rate`); do
 * NOT round persisted `entered_fx_rate` values — every downstream consumer
 * treats that column as a full-precision float divisor.
 */
export function roundFxRate(rate: number): number {
  if (!Number.isFinite(rate)) return 0;
  return Math.round(rate * 1e8) / 1e8;
}
