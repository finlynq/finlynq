// Home-screen month calendar: pure helpers behind <HomeCalendarCard>. The day
// totals come from GET /api/transactions/calendar (the same money rules as the
// Transactions calendar and Reports), already in the display currency.

import type { TransactionsCalendarDay } from "../../../shared/types";
import { addDays, buildScheduleEvents, type RecurringRow, type ScheduleEvent, type SubscriptionRow } from "./subscriptions";
import { daysInMonth, isoDay } from "./month-calendar";

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

// ─── Expected payments (owner request 2026-10-15) ───────────────────────────
// The calendar also shows what is still to come: subscriptions and the
// recurring series detected in past transactions, the same schedule the
// Subscriptions calendar draws (buildScheduleEvents). Only days AFTER today
// get them: today and earlier already show the real transactions, and a
// projection on top of those would count a payment twice.

/** Expected payments in the month `monthKey` (`YYYY-MM`), after `today`, by date. */
export function expectedForMonth(
  subs: SubscriptionRow[],
  recurring: RecurringRow[],
  monthKey: string,
  today: string,
): Map<string, ScheduleEvent[]> {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7)) - 1;
  const monthStart = isoDay(year, month, 1);
  const monthEnd = isoDay(year, month, daysInMonth(year, month));
  const tomorrow = addDays(today, 1);
  const start = tomorrow > monthStart ? tomorrow : monthStart;
  const byDate = new Map<string, ScheduleEvent[]>();
  if (start > monthEnd) return byDate;
  for (const e of buildScheduleEvents(subs, recurring, start, monthEnd)) {
    const list = byDate.get(e.date);
    if (list) list.push(e);
    else byDate.set(e.date, [e]);
  }
  return byDate;
}

/** Bills and income still expected, summed in the display currency. */
export function expectedTotals(byDate: Map<string, ScheduleEvent[]>): { bills: number; income: number; count: number } {
  let bills = 0;
  let income = 0;
  let count = 0;
  for (const list of byDate.values()) {
    for (const e of list) {
      count += 1;
      if (e.type === "income") income += e.displayAmount;
      else bills += e.displayAmount;
    }
  }
  return { bills, income, count };
}
