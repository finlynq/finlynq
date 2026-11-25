/**
 * The period picker on the dashboard Insights section (GH #457 draft).
 *
 * One choice drives Top Merchants (spending in the period) and Category
 * Trends (the period against the same number of months just before it), and
 * both cards name the months they cover. Whole calendar months only, so a
 * comparison never sets a part month against a full one, except "This month"
 * and "This year so far", which say "so far".
 *
 * Pure, client-safe; the route validates with `isInsightPeriod`.
 */

export const INSIGHT_PERIODS = [
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "last_3", label: "Last 3 months" },
  { key: "last_6", label: "Last 6 months" },
  { key: "last_12", label: "Last 12 months" },
  { key: "ytd", label: "This year so far" },
] as const;

export type InsightPeriodKey = (typeof INSIGHT_PERIODS)[number]["key"];
export const DEFAULT_INSIGHT_PERIOD: InsightPeriodKey = "last_3";

export function isInsightPeriod(v: unknown): v is InsightPeriodKey {
  return typeof v === "string" && INSIGHT_PERIODS.some((p) => p.key === v);
}

export type ResolvedInsightPeriod = {
  key: InsightPeriodKey;
  /** Months in the period, oldest first, "YYYY-MM". */
  months: string[];
  /** The same number of months just before, oldest first. */
  previousMonths: string[];
  /** First and last day covered (the last day is today for a period still running). */
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  /** "Sep – Nov 2026", "Nov 2026 so far". */
  label: string;
  previousLabel: string;
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const idx = y * 12 + (m - 1) + delta;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

function monthRange(first: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => shiftMonth(first, i));
}

function lastDayOf(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${String(d).padStart(2, "0")}`;
}

function monthLabel(ym: string, withYear: boolean): string {
  const [y, m] = ym.split("-").map(Number);
  return withYear ? `${MONTH_NAMES[m - 1]} ${y}` : MONTH_NAMES[m - 1];
}

/** "Sep – Nov 2026", "Dec 2025 – Feb 2026", "Nov 2026". */
export function rangeLabel(months: string[], soFar = false): string {
  if (months.length === 0) return "";
  const first = months[0];
  const last = months[months.length - 1];
  const tail = soFar ? " so far" : "";
  if (first === last) return `${monthLabel(first, true)}${tail}`;
  const sameYear = first.slice(0, 4) === last.slice(0, 4);
  return `${monthLabel(first, !sameYear)} – ${monthLabel(last, true)}${tail}`;
}

/** Resolve a period against `today` ("YYYY-MM-DD"). */
export function resolveInsightPeriod(key: InsightPeriodKey, today: string): ResolvedInsightPeriod {
  const current = today.slice(0, 7);
  let months: string[];
  let running = false;
  switch (key) {
    case "this_month":
      months = [current];
      running = true;
      break;
    case "last_month":
      months = [shiftMonth(current, -1)];
      break;
    case "last_3":
      months = monthRange(shiftMonth(current, -3), 3);
      break;
    case "last_6":
      months = monthRange(shiftMonth(current, -6), 6);
      break;
    case "last_12":
      months = monthRange(shiftMonth(current, -12), 12);
      break;
    case "ytd": {
      const jan = `${current.slice(0, 4)}-01`;
      const count = Number(current.slice(5, 7));
      months = monthRange(jan, count);
      running = true;
      break;
    }
  }
  const previousMonths = monthRange(shiftMonth(months[0], -months.length), months.length);
  return {
    key,
    months,
    previousMonths,
    from: `${months[0]}-01`,
    to: running ? today : lastDayOf(months[months.length - 1]),
    previousFrom: `${previousMonths[0]}-01`,
    previousTo: lastDayOf(previousMonths[previousMonths.length - 1]),
    label: rangeLabel(months, running),
    previousLabel: rangeLabel(previousMonths),
  };
}
