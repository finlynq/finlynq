// Home-screen month calendar: pure helpers behind <HomeCalendarCard>. The day
// totals come from GET /api/transactions/calendar (the same money rules as the
// Transactions calendar and Reports), already in the display currency.

import type { TransactionsCalendarDay } from "../../../shared/types";

/** How many shades of spending a day can show (0 = no spending). */
export const HEAT_LEVELS = 4;

/** Hex alpha appended to the spending colour for each level (index = level). */
const HEAT_ALPHA = ["00", "24", "45", "70", "B0"];

/** The month's biggest spending day (0 when nothing was spent). */
export function maxDailySpending(days: readonly Pick<TransactionsCalendarDay, "spending">[]): number {
  let max = 0;
  for (const d of days) if (d.spending > max) max = d.spending;
  return max;
}

/**
 * A day's spending shade, 0 to HEAT_LEVELS: 0 when nothing was spent, else its
 * share of the month's biggest day on a square-root scale. A linear scale lets
 * one large bill (rent, a car repair) wash every other day out to the palest
 * shade; the root keeps ordinary days telling apart.
 */
export function spendingLevel(spending: number, maxSpending: number): number {
  if (!(spending > 0) || !(maxSpending > 0)) return 0;
  const share = Math.min(spending / maxSpending, 1);
  return Math.max(1, Math.min(HEAT_LEVELS, Math.ceil(HEAT_LEVELS * Math.sqrt(share))));
}

/**
 * The spending colour at a level, as `#rrggbbaa`. Undefined for level 0, or for
 * a colour that is not plain 6-digit hex (no tint rather than a wrong one).
 */
export function heatColor(base: string, level: number): string | undefined {
  if (level <= 0 || !/^#[0-9a-f]{6}$/i.test(base)) return undefined;
  return base + HEAT_ALPHA[Math.min(level, HEAT_LEVELS)];
}

/** "3 transactions" / "1 transaction". */
export function transactionCountLabel(n: number): string {
  return `${n} transaction${n === 1 ? "" : "s"}`;
}

/** "YYYY-MM" moved by `delta` months. */
export function shiftMonthKey(monthKey: string, delta: number): string {
  const total = Number(monthKey.slice(0, 4)) * 12 + Number(monthKey.slice(5, 7)) - 1 + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}
