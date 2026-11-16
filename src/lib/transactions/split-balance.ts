/**
 * A transaction's split rows must add up to the transaction (2026-11-16).
 *
 * Split rows carry the transaction's sign: a -63.85 purchase splits into
 * -20.51 and -43.34. Reports count a split transaction through its split rows
 * (transaction_category_flows), so rows that don't add up would move money
 * between categories that the account never saw. Every split write checks this
 * one rule: REST POST /api/transactions/splits and MCP manage_splits.
 *
 * Pure and client-safe: the transaction dialog uses it too.
 */

/** Largest difference still treated as "adds up" (rounding on 2-decimal amounts). */
export const SPLIT_SUM_TOLERANCE = 0.01;

export type SplitMismatch = {
  /** The transaction's amount. */
  amount: number;
  /** What the split rows add up to. */
  splitTotal: number;
  /** amount - splitTotal: what is still left to split (negative = too much). */
  left: number;
};

const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * null when the split rows add up to the transaction (or there are none),
 * otherwise what they add up to and what is left.
 */
export function splitMismatch(amount: number, splitAmounts: readonly number[]): SplitMismatch | null {
  if (splitAmounts.length === 0) return null;
  const splitTotal = splitAmounts.reduce((s, a) => s + (Number.isFinite(a) ? a : 0), 0);
  const left = amount - splitTotal;
  if (Math.abs(left) <= SPLIT_SUM_TOLERANCE) return null;
  return { amount: cents(amount), splitTotal: cents(splitTotal), left: cents(left) };
}

/**
 * Split rows typed in the transaction's ENTERED currency (a USD purchase on a
 * CAD account) converted to the account currency splits are stored in:
 * amount = entered × enteredFxRate, rounded to cents. When those parts miss
 * the transaction only by their rounding (half a cent per row at most), the
 * row with the largest amount absorbs the difference so they add up exactly.
 */
export function enteredSplitsToAccount(
  enteredAmounts: readonly number[],
  enteredFxRate: number,
  accountAmount: number,
): number[] {
  const out = enteredAmounts.map((a) => cents(a * enteredFxRate));
  if (out.length === 0) return out;
  const diff = cents(accountAmount - out.reduce((s, a) => s + a, 0));
  if (diff !== 0 && Math.abs(diff) <= 0.005 * out.length + 1e-9) {
    let big = 0;
    for (let i = 1; i < out.length; i++) if (Math.abs(out[i]) > Math.abs(out[big])) big = i;
    out[big] = cents(out[big] + diff);
  }
  return out;
}

/** The refusal every write path returns, worded the same everywhere. */
export function splitMismatchMessage(m: SplitMismatch): string {
  const sameSign = m.amount === 0 || m.splitTotal === 0 || Math.sign(m.amount) === Math.sign(m.splitTotal);
  const hint = sameSign
    ? ""
    : " Split rows carry the transaction's sign (a negative transaction splits into negative rows).";
  return (
    `The split rows add up to ${m.splitTotal.toFixed(2)} but the transaction is ${m.amount.toFixed(2)} ` +
    `(${Math.abs(m.left).toFixed(2)} ${m.left > 0 ? "left to split" : "too much"}). ` +
    `Split rows must add up to the transaction.${hint}`
  );
}
