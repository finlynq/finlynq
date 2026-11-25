/**
 * Month-end points for the dashboard's Total Net Worth line (2026-11-24).
 *
 * The hero line used to be a running total of transaction amounts per month
 * (`getNetWorthOverTime`), which counts an investment account at the money put
 * in, never at market value, and skips months with no transactions. On the dev
 * demo it ended at -14,099 under a hero number of 3,315.68 (the gap was the
 * unrealized gains) and its first two points were seven months apart.
 *
 * It now reads the accurate daily history (`/api/net-worth-history`, the same
 * series as the Net Worth chart: cash from snapshots, investments at market,
 * today live), reduced here to the LAST day of each calendar month. The final
 * point is today's live value, so the line ends on the hero number.
 *
 * Pure and client-safe.
 */

export interface DailyNetWorthPoint {
  date: string; // YYYY-MM-DD
  value: number;
}

export interface MonthEndNetWorthPoint {
  month: string; // YYYY-MM
  date: string; // the day the value is from (month end, or today)
  value: number;
}

/**
 * One point per calendar month: that month's last day in the series. Leading
 * zero days (before any account had a balance) are dropped so the line starts
 * where the user's history does. Keeps the newest `maxMonths`.
 */
export function monthEndPoints(
  series: readonly DailyNetWorthPoint[],
  maxMonths = 12,
): MonthEndNetWorthPoint[] {
  const sorted = [...series].sort((a, b) => a.date.localeCompare(b.date));
  const start = sorted.findIndex((p) => p.value !== 0);
  if (start < 0) return [];
  const byMonth = new Map<string, MonthEndNetWorthPoint>();
  for (const p of sorted.slice(start)) {
    const month = p.date.slice(0, 7);
    byMonth.set(month, { month, date: p.date, value: p.value });
  }
  return Array.from(byMonth.values()).slice(-Math.max(1, maxMonths));
}

export interface NetWorthChange {
  /** Latest point minus the previous month's end. */
  change: number;
  /**
   * Percent of last month's value, or null when last month was zero or
   * negative (a percent of a debt-heavy balance reads backwards).
   */
  pct: number | null;
}

/** Change from the previous month's end to the latest point; null if < 2 points. */
export function monthOverMonth(points: readonly MonthEndNetWorthPoint[]): NetWorthChange | null {
  if (points.length < 2) return null;
  const current = points[points.length - 1].value;
  const prev = points[points.length - 2].value;
  const change = current - prev;
  return { change, pct: prev > 0 ? (change / prev) * 100 : null };
}
