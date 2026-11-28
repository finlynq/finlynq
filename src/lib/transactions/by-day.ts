/**
 * The Transactions page's "By day" view (GH #465): the list grouped under one
 * header per day, each header carrying that day's totals. Pure + client-safe;
 * the server side (whole-day totals across every page) is
 * transactions/day-totals.ts.
 *
 * Money follows the same rules as the Calendar view and Reports
 * (transactions/calendar.ts, FINLYNQ-123): income = rows in an `I` category,
 * spending = rows in an `E` category with refunds netted, transfers / trades /
 * uncategorized rows counted but moving neither total, every amount already in
 * the display currency.
 */
import { formatCurrency } from "@/lib/currency";
import { round2 } from "@/lib/utils/number";
import type { TxSortPref } from "@/lib/transactions/build-query";
import { buildCalendarMonth, type CalendarSlice } from "@/lib/transactions/calendar";

/** One day's totals for the whole day, whatever page its rows are on. */
export type DayTotal = { date: string; income: number; spending: number; count: number };

/** What `GET /api/transactions?dayTotals=1` adds to the response. */
export type DayTotalsPayload = { displayCurrency: string; days: DayTotal[] };

export type DayGroup<T> = { date: string; rows: T[] };

/**
 * Split an already date-ordered page of rows into consecutive day groups,
 * keeping the rows' order (the server orders by date, then id).
 */
export function groupTransactionsByDay<T extends { date: string }>(rows: T[]): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && last.date === row.date) last.rows.push(row);
    else groups.push({ date: row.date, rows: [row] });
  }
  return groups;
}

/**
 * Per-day totals from the SQL slices (day × category type × currency, already
 * converted) plus each day's transaction count. The count comes from the
 * transactions themselves, not from the slices: a split transaction has one
 * slice row per part, and must still count once.
 */
export function buildDayTotals(slices: CalendarSlice[], counts: Map<string, number>): DayTotal[] {
  const money = new Map(buildCalendarMonth(slices).days.map((d) => [d.date, d]));
  return [...counts.entries()]
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => {
      const m = money.get(date);
      return { date, income: m?.income ?? 0, spending: m?.spending ?? 0, count };
    });
}

/** Sum of the given days (the "days on this page" line). */
export function sumDayTotals(days: DayTotal[]): Omit<DayTotal, "date"> {
  const t = days.reduce(
    (acc, d) => ({ income: acc.income + d.income, spending: acc.spending + d.spending, count: acc.count + d.count }),
    { income: 0, spending: 0, count: 0 },
  );
  return { income: round2(t.income), spending: round2(t.spending), count: t.count };
}

/**
 * The sort the By day view asks the server for. Grouping only makes sense
 * when rows arrive in date order: a date sort the user picked is kept (either
 * direction); any other sort falls back to the default, newest first, and
 * `overridden` says so, so the view can tell the user.
 */
export function byDaySort(sort: TxSortPref): { sort: TxSortPref; overridden: boolean } {
  if (sort.columnId === "date" && sort.direction) return { sort, overridden: false };
  if (!sort.columnId || !sort.direction) return { sort: { columnId: null, direction: null }, overridden: false };
  return { sort: { columnId: null, direction: null }, overridden: true };
}

/** "+$1,200.00", "−$84.10", "$0.00": a total with its direction spelled out. */
export function signedMoney(n: number, currency: string): string {
  const v = round2(n);
  if (v > 0) return `+${formatCurrency(v, currency)}`;
  if (v < 0) return `−${formatCurrency(-v, currency)}`;
  return formatCurrency(0, currency);
}

/** "Fri, Nov 27, 2026" for an ISO day (read as a calendar date, not a moment). */
export function formatDayHeading(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
