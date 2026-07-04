/**
 * Shared numeric utilities.
 *
 * Canonical home for `round2` — the half-up-to-2-decimals helper used across
 * write paths, aggregators, and API routes. Historically every module that
 * needed it declared its own private `const round2 = (n) => Math.round(n*100)/100`;
 * FINLYNQ-145 consolidated them here. `currency-conversion.ts` re-exports this
 * so existing `import { round2 } from "@/lib/currency-conversion"` callsites keep
 * working unchanged.
 *
 * NOTE: `src/lib/loan-calculator.ts` intentionally keeps its OWN private copy —
 * it is bundled into the MCP build and must stay dependency-free. Do not point
 * it here.
 */

/** Round a number to 2 decimal places (currency precision). */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Upper magnitude bound for any user-supplied financial figure (amount,
 * quantity, price). A trillion in any currency is already absurd for a
 * personal-finance ledger; values past this (e.g. `1e29` from a malformed
 * import file) are rejected at the import preview boundary rather than
 * silently accepted and stored. FINLYNQ-159.
 */
export const MAX_REASONABLE_AMOUNT = 1e12;

/**
 * True when `n` is a finite number within the sane magnitude bound
 * (|n| <= {@link MAX_REASONABLE_AMOUNT}). Rejects NaN, ±Infinity, and
 * out-of-range magnitudes. Use at the import parse/preview boundary to
 * flag garbage numeric fields before they reach the ledger. FINLYNQ-159.
 */
export const isReasonableAmount = (n: number): boolean =>
  Number.isFinite(n) && Math.abs(n) <= MAX_REASONABLE_AMOUNT;

/**
 * Compact chart-axis abbreviation — the SINGLE source of truth for
 * "k"/"m" Y-axis tick formatting (FINLYNQ-247). Deliberately bare (NO
 * currency symbol — currency belongs on a chart-level label/subtitle, not
 * every tick) so it composes with any chart regardless of currency.
 *
 * Rules (mirrors the pre-existing `net-worth-history-chart.tsx` `fmtAxis`):
 *   - |n| >= 1e6 → "<n/1e6 to 1 decimal>m"  (e.g. 1_240_000 → "1.2m")
 *   - |n| >= 1e4 → "<n/1e3 to 0 decimals>k" (e.g. 572345 → "572k")
 *   - |n| >= 1e3 → "<n/1e3 to 1 decimal>k"  (e.g. 1500 → "1.5k")
 *   - else       → the rounded value as a plain string (e.g. 850 → "850")
 * Negative-safe (sign carried through, magnitude rules applied to |n|) and
 * 0-safe ("0").
 */
export function formatCompactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}m`;
  if (abs >= 1000) return `${(value / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
  return `${Math.round(value)}`;
}
