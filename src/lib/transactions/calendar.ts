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
