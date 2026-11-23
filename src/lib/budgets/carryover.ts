/**
 * Rollover ("carryover") for one budget line. Pure.
 *
 *   carried_in(m) = left(m − 1)
 *   left(m)       = carried_in(m) + budgeted(m) − spent(m)
 *
 * With `negative: "reset"` an overspent month carries 0 instead of the
 * negative. Nothing is stored per month: the walk starts at the user's latest
 * reset or edit (`sets`) at or before the target month, whose amount is what
 * that month carries in. Turning rollover on writes a set of 0 for the month
 * it is turned on in, so history before it is never pulled in. No set at or
 * before the month means nothing carries yet.
 *
 * A set of `null` means rollover was turned OFF from that month: a month rolls
 * over only when the latest set at or before it is a number. Turning rollover
 * on or off writes a set for the month being viewed, so earlier months keep
 * what they had.
 */
import { monthRange } from "./lines";

export type RolloverNegative = "carry" | "reset";

export interface CarryMonth {
  budgeted: number;
  /** Positive = money out of the line. */
  spent: number;
}

export interface CarryResult {
  carriedIn: number;
  left: number;
  /** The set the walk started from, or null when nothing carries yet. */
  startMonth: string | null;
}

/** Month → what carries in from there, or null = rollover off from there. */
export type CarrySets = Readonly<Record<string, number | null>>;

const round2 = (n: number) => Math.round(n * 100) / 100;

export function latestSetAtOrBefore(sets: CarrySets, month: string): string | null {
  let best: string | null = null;
  for (const m of Object.keys(sets)) if (m <= month && (best == null || m > best)) best = m;
  return best;
}

/** Whether the line rolls over in `month`. */
export function rolloverOnIn(sets: CarrySets, month: string): boolean {
  const start = latestSetAtOrBefore(sets, month);
  return start != null && sets[start] != null;
}

export function walkCarryover(opts: {
  target: string;
  sets: CarrySets;
  months: Readonly<Record<string, CarryMonth>>;
  negative: RolloverNegative;
}): CarryResult {
  const { target, sets, months, negative } = opts;
  const here = months[target] ?? { budgeted: 0, spent: 0 };
  const start = latestSetAtOrBefore(sets, target);
  const startAmount = start == null ? null : sets[start];
  if (start == null || startAmount == null) {
    return { carriedIn: 0, left: round2(here.budgeted - here.spent), startMonth: null };
  }
  let carry = startAmount;
  for (const m of monthRange(start, target)) {
    const d = months[m] ?? { budgeted: 0, spent: 0 };
    const left = carry + d.budgeted - d.spent;
    if (m === target) return { carriedIn: round2(carry), left: round2(left), startMonth: start };
    carry = negative === "reset" ? Math.max(0, left) : left;
  }
  return { carriedIn: 0, left: round2(here.budgeted - here.spent), startMonth: start };
}
