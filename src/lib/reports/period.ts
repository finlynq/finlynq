/**
 * Report period granularities — the single list behind the Reports page's
 * Period select and `GET /api/reports/trends?period=`. Pure (no DB), so the
 * client page can import it. `shared/types.ts` `ReportPeriod` mirrors this
 * union for the mobile app; keep the two in sync.
 */
export const REPORT_PERIODS = ["daily", "weekly", "monthly", "quarterly", "yearly"] as const;

export type ReportPeriod = (typeof REPORT_PERIODS)[number];

export const REPORT_PERIOD_LABELS: Record<ReportPeriod, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
};

export function isReportPeriod(value: unknown): value is ReportPeriod {
  return typeof value === "string" && (REPORT_PERIODS as readonly string[]).includes(value);
}

/**
 * Range presets wide enough that a monthly breakdown is unreadable (60+
 * columns). Picking one switches the Period select to Yearly.
 */
export const MULTI_YEAR_PRESETS: readonly string[] = ["last-5-years", "all-time"];

/**
 * Start date for the "All Time" preset. `transactions.date` is TEXT
 * `YYYY-MM-DD` compared lexically, so any date earlier than the first
 * transaction works; periods only appear where rows exist.
 */
export const ALL_TIME_START = "1970-01-01";

/**
 * True for a date a report can be run for: a real `YYYY-MM-DD` calendar date
 * no earlier than ALL_TIME_START. The Reports page sends a date only once this
 * holds, and `GET /api/reports` answers 400 otherwise.
 *
 * A browser date input reports every keystroke of the year, so typing "2010"
 * produces 0002-01-01, 0020-01-01 and 0201-01-01 on the way. Each of those is a
 * real calendar date, which is why the floor is needed as well as the format
 * check: before it, every keystroke ran a report that priced the user's
 * holdings at year 2 (2026-11-07). The round-trip is the same one as
 * `parseYmdSafe` in mcp-server/lib/date-validators.ts, kept here because that
 * module pulls in zod and this one is imported by the client page.
 */
export function isReportDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) return false;
  return value >= ALL_TIME_START;
}
