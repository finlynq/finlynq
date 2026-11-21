/**
 * Reports date-range presets: the ONE list behind the Reports page's Range
 * select, saved reports and saved Transactions views (GH #427), and the MCP
 * `get_saved_views` tool, which resolves a saved preset to today's dates.
 *
 * Pure (no DB), so the client page can import it.
 */
import { todayISO, localDateISO } from "@/lib/utils/date";
import { ALL_TIME_START } from "./period";

export const REPORT_DATE_PRESETS = [
  "mtd",
  "qtd",
  "ytd",
  "last-month",
  "last-quarter",
  "last-year",
  "last-12",
  "last-5-years",
  "all-time",
] as const;

export type ReportDatePreset = (typeof REPORT_DATE_PRESETS)[number];

export const REPORT_DATE_PRESET_LABELS: Record<ReportDatePreset, string> = {
  mtd: "Month to Date",
  qtd: "Quarter to Date",
  ytd: "Year to Date",
  "last-month": "Last Month",
  "last-quarter": "Last Quarter",
  "last-year": "Last Year",
  "last-12": "Last 12 Months",
  "last-5-years": "Last 5 Years",
  "all-time": "All Time",
};

export function isReportDatePreset(value: unknown): value is ReportDatePreset {
  return typeof value === "string" && (REPORT_DATE_PRESETS as readonly string[]).includes(value);
}

/** Build a `YYYY-MM-DD` string from LOCAL date components (avoids UTC timezone drift). */
function localDateStr(y: number, mo: number, d: number): string {
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Returns the `{ start, end }` date range for a named preset.
 *
 * `now` defaults to the current time; pass a fixed date for deterministic
 * results (tests, a saved view resolved for a given day). Without `now` the
 * open end is `todayISO()`, as it always was on the Reports page; with it, the
 * open end is that date's local day.
 */
export function getPresetRange(preset: string, now?: Date): { start: string; end: string } {
  const at = now ?? new Date();
  const y = at.getFullYear();
  const m = at.getMonth(); // 0-indexed
  const end = now ? localDateISO(now) : todayISO();

  switch (preset) {
    case "mtd":
      return { start: localDateStr(y, m + 1, 1), end };
    case "qtd": {
      const qStart = Math.floor(m / 3) * 3;
      return { start: localDateStr(y, qStart + 1, 1), end };
    }
    case "ytd":
      return { start: `${y}-01-01`, end };
    case "last-month": {
      const lm = m === 0 ? 11 : m - 1;
      const ly = m === 0 ? y - 1 : y;
      const days = new Date(ly, lm + 1, 0).getDate();
      return {
        start: localDateStr(ly, lm + 1, 1),
        end: localDateStr(ly, lm + 1, days),
      };
    }
    case "last-quarter": {
      const cq = Math.floor(m / 3);
      const lq = cq === 0 ? 3 : cq - 1;
      const lqy = cq === 0 ? y - 1 : y;
      const qsm = lq * 3;
      const qem = qsm + 2;
      const qed = new Date(lqy, qem + 1, 0).getDate();
      return {
        start: localDateStr(lqy, qsm + 1, 1),
        end: localDateStr(lqy, qem + 1, qed),
      };
    }
    case "last-year":
      return { start: `${y - 1}-01-01`, end: `${y - 1}-12-31` };
    case "last-12": {
      // end = last day of the prior (most recently completed) month.
      // new Date(y, m, 0) = day 0 of current month = last day of the prior month.
      const endD = new Date(y, m, 0);
      // start = first day of the month 12 months before the current month.
      // new Date(y, m - 12, 1) handles year roll-back and leap years natively.
      const startD = new Date(y, m - 12, 1);
      return {
        start: localDateStr(startD.getFullYear(), startD.getMonth() + 1, 1),
        end: localDateStr(endD.getFullYear(), endD.getMonth() + 1, endD.getDate()),
      };
    }
    case "last-5-years":
      // Five calendar years including the current one, through today.
      return { start: `${y - 4}-01-01`, end };
    case "all-time":
      return { start: ALL_TIME_START, end };
    default: {
      // Fallback: current year-to-date (same as "ytd") — safe, no partial months.
      return { start: `${y}-01-01`, end };
    }
  }
}
