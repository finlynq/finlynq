/**
 * Day buckets for the Transactions calendar view (in-app feedback 2026-10-07:
 * "a calendar view … click a date and it lists that day's transactions").
 * Pure + client-safe; the route does the SQL, this does the arithmetic.
 *
 * Money follows the Reports flow rules (FINLYNQ-123), so a day here agrees
 * with the same day in Reports / Categories:
 *   - income   = rows in an `I` category,
 *   - spending = rows in an `E` category, oriented POSITIVE (a refund in an
 *                expense category nets out of spending, as in Reports),
 *   - transfers (`R`) and uncategorized rows (investment trades, unfiled
 *     imports) are COUNTED but move neither total — a transfer between your
 *     own accounts is neither income nor spending.
 * Slice values arrive already in the display currency (the route runs each
 * (date, type, currency) group through `convertReportingSlice`).
 */
import { round2 } from "@/lib/utils/number";

export const CALENDAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** One SQL group: a day × category type × currency, already converted. */
export type CalendarSlice = {
  date: string;
  /** `categories.type` of the rows, or null for uncategorized. */
  categoryType: string | null;
  /** Signed SUM in the display currency. */
  value: number;
  count: number;
};

export type CalendarDay = { date: string; income: number; spending: number; count: number };

export type CalendarMonth = {
  days: CalendarDay[];
  totals: { income: number; spending: number; count: number };
};

/** First and last ISO date of a `YYYY-MM` month. */
export function monthBounds(month: string): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, "0")}` };
}

/** Fold SQL slices into per-day income / spending / count, plus month totals. */
export function buildCalendarMonth(slices: CalendarSlice[]): CalendarMonth {
  const byDate = new Map<string, CalendarDay>();
  for (const s of slices) {
    const day = byDate.get(s.date) ?? { date: s.date, income: 0, spending: 0, count: 0 };
    if (s.categoryType === "I") day.income += s.value;
    else if (s.categoryType === "E") day.spending -= s.value;
    day.count += s.count;
    byDate.set(s.date, day);
  }

  const days = [...byDate.values()]
    .filter((d) => d.count > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({ ...d, income: round2(d.income), spending: round2(d.spending) }));

  const totals = days.reduce(
    (t, d) => ({ income: t.income + d.income, spending: t.spending + d.spending, count: t.count + d.count }),
    { income: 0, spending: 0, count: 0 },
  );
  return { days, totals: { ...totals, income: round2(totals.income), spending: round2(totals.spending) } };
}

// ─── Week / month / year periods (week + year views, 2026-10-07) ───────────

export type CalendarMode = "week" | "month" | "year";

export const CALENDAR_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/** Longest range the route serves in one call — a (leap) year. */
export const MAX_CALENDAR_RANGE_DAYS = 366;

const DAY_MS = 24 * 60 * 60 * 1000;
const toUtc = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** `iso` shifted by `n` days (UTC, so never off by one across DST). */
export function addDays(iso: string, n: number): string {
  return fromUtc(toUtc(iso) + n * DAY_MS);
}

/** Whole days from `start` to `end`, inclusive of both. */
export function daysInRange(start: string, end: string): number {
  return Math.round((toUtc(end) - toUtc(start)) / DAY_MS) + 1;
}

/** The Sunday that starts `iso`'s week (the grids are Sunday-first). */
export function weekStart(iso: string): string {
  return addDays(iso, -new Date(toUtc(iso)).getUTCDay());
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
  return monthBounds(anchor.slice(0, 7));
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
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}-01`;
}

/** Roll a range's days up into `YYYY-MM` totals (the year view's tiles). */
export function rollupByMonth(days: CalendarDay[]): Map<string, { income: number; spending: number; count: number }> {
  const out = new Map<string, { income: number; spending: number; count: number }>();
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
