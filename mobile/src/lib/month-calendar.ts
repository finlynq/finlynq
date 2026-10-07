// Month-grid date math behind <MonthCalendar> (components/MonthCalendar.tsx),
// shared by the Subscriptions and Transactions calendars. Pure + UTC, so a grid
// never shifts a day across a timezone boundary. Months are 0-based (January =
// 0) to match `Date`; `isoDay` mirrors the web helper in
// src/components/month-calendar.tsx.

import { addDays } from "./subscriptions";

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Number of days in a (year, 0-based month). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** Weekday of the month's 1st, Sunday = 0 (the grid's leading blanks). */
export function firstWeekday(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 1)).getUTCDay();
}

/** `YYYY-MM-DD` for a day of a (year, 0-based month). */
export function isoDay(year: number, month: number, day: number): string {
  return `${year}-${pad2(month + 1)}-${pad2(day)}`;
}

/** `YYYY-MM` for a (year, 0-based month). */
export function monthKeyOf(year: number, month: number): string {
  return `${year}-${pad2(month + 1)}`;
}

/** (year, 0-based month) moved by `delta` months; crosses year boundaries. */
export function shiftYearMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const total = year * 12 + month + delta;
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 };
}

/** Split a `YYYY-MM-DD` into (year, 0-based month, day). */
export function datePartsOf(iso: string): { year: number; month: number; day: number } {
  return { year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)) - 1, day: Number(iso.slice(8, 10)) };
}

/** Grid title, e.g. "July 2026". */
export function monthTitle(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 1)).toLocaleDateString("en-CA", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Selected-day heading, e.g. "Saturday, July 4". */
export function dayTitle(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month, day)).toLocaleDateString("en-CA", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

// ─── Week / month / year periods (week + year views) ────────────────────────
// Mirrors web src/lib/transactions/calendar.ts. Anchors are any ISO day inside
// the visible period; all math is UTC.

export type CalendarMode = "week" | "month" | "year";

/** The Sunday that starts `iso`'s week (the grids are Sunday-first). */
export function weekStart(iso: string): string {
  const p = datePartsOf(iso);
  return addDays(iso, -new Date(Date.UTC(p.year, p.month, p.day)).getUTCDay());
}

/** The week / month / year containing `anchor`, as an inclusive ISO range. */
export function periodRange(mode: CalendarMode, anchor: string): { start: string; end: string } {
  if (mode === "week") {
    const start = weekStart(anchor);
    return { start, end: addDays(start, 6) };
  }
  if (mode === "year") {
    const y = anchor.slice(0, 4);
    return { start: `${y}-01-01`, end: `${y}-12-31` };
  }
  const p = datePartsOf(anchor);
  return { start: isoDay(p.year, p.month, 1), end: isoDay(p.year, p.month, daysInMonth(p.year, p.month)) };
}

/**
 * Move `anchor` by `delta` weeks / months / years. Month and year shifts land
 * on the 1st, so stepping from Jan 31 never skips February.
 */
export function shiftAnchor(mode: CalendarMode, anchor: string, delta: number): string {
  if (mode === "week") return addDays(anchor, delta * 7);
  const y = Number(anchor.slice(0, 4));
  const m = Number(anchor.slice(5, 7)) - 1;
  const total = mode === "year" ? (y + delta) * 12 + m : y * 12 + m + delta;
  return `${Math.floor(total / 12)}-${pad2((total % 12) + 1)}-01`;
}

export interface PeriodTotals {
  income: number;
  spending: number;
  count: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Roll a range's days up into `YYYY-MM` totals (the year view's tiles). */
export function rollupByMonth(days: Array<PeriodTotals & { date: string }>): Map<string, PeriodTotals> {
  const out = new Map<string, PeriodTotals>();
  for (const d of days) {
    const key = d.date.slice(0, 7);
    const m = out.get(key) ?? { income: 0, spending: 0, count: 0 };
    m.income += d.income;
    m.spending += d.spending;
    m.count += d.count;
    out.set(key, m);
  }
  for (const m of out.values()) {
    m.income = round2(m.income);
    m.spending = round2(m.spending);
  }
  return out;
}

const shortDate = (iso: string, withYear: boolean) => {
  const p = datePartsOf(iso);
  return new Date(Date.UTC(p.year, p.month, p.day)).toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });
};

/** Heading for the visible period: "Jun 28 – Jul 4, 2026" / "July 2026" / "2026". */
export function periodTitle(mode: CalendarMode, anchor: string): string {
  if (mode === "year") return anchor.slice(0, 4);
  const p = datePartsOf(anchor);
  if (mode === "month") return monthTitle(p.year, p.month);
  const { start, end } = periodRange("week", anchor);
  return `${shortDate(start, false)} – ${shortDate(end, true)}`;
}
