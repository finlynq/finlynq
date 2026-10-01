// Pure portfolio display helpers — JSX-free and unit-testable. Money always goes
// through the shared `formatCurrency`; these only decide precision + grouping.
import { formatCurrency } from "../format";

/**
 * Per-share price (lot cost, proceeds). Uses 2 decimals unless the value
 * genuinely carries more precision, up to 4 (sub-dollar stocks, crypto
 * fractions) — so `1.5` → "$1.50", `0.1234` → "$0.1234", and float noise past
 * the 4th decimal never leaks into the UI.
 */
export function formatPerShare(value: number, currency: string): string {
  if (!Number.isFinite(value)) return "—";
  const at4 = Math.round(value * 1e4) / 1e4;
  let decimals = 2;
  while (decimals < 4 && Math.round(at4 * 10 ** decimals) / 10 ** decimals !== at4) {
    decimals++;
  }
  return formatCurrency(value, currency, { decimals });
}

/** Share quantity: up to 6 decimals, trailing zeros trimmed (no float noise). */
export function formatQty(qty: number | null | undefined): string {
  if (qty == null || !Number.isFinite(qty)) return "0";
  const rounded = Math.round(qty * 1e6) / 1e6;
  return String(rounded === 0 ? 0 : rounded);
}

/**
 * Turn a per-currency totals map into a stable, sorted list (largest absolute
 * amount first, then code). Used wherever a total spans native currencies and
 * must NOT be summed under one symbol (FINLYNQ-123).
 */
export function currencyTotals<T>(
  byCurrency: Record<string, T> | null | undefined,
  amountOf: (v: T) => number
): { currency: string; amount: number }[] {
  return Object.entries(byCurrency ?? {})
    .map(([currency, v]) => ({ currency, amount: amountOf(v) }))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || a.currency.localeCompare(b.currency));
}

/** "+$1,234" / "-$1,234" — signed whole-unit money. */
export function signedMoney(v: number, currency: string, decimals = 0): string {
  return `${v >= 0 ? "+" : ""}${formatCurrency(v, currency, { decimals })}`;
}
