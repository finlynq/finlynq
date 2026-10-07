// Month-grid date math behind <MonthCalendar> (components/MonthCalendar.tsx),
// shared by the Subscriptions and Transactions calendars. Pure + UTC, so a grid
// never shifts a day across a timezone boundary. Months are 0-based (January =
// 0) to match `Date`; `isoDay` mirrors the web helper in
// src/components/month-calendar.tsx.

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
