// Pure date-range helpers for the Reports filters. Mirrors the web
// /reports `getPresetRange` exactly (MTD/QTD/YTD/last-month/-quarter/-year/12mo)
// so mobile + web show identical ranges. No date library — plain Date math.
// `now` is injectable so the preset math is deterministically unit-testable.
//
// Every date is the device's LOCAL calendar day. `toISOString()` is UTC, so
// for a user ahead of UTC (e.g. UTC+10 at 08:00 on the 1st) it returned the
// PREVIOUS day as "today" while the start was built from local components —
// MTD/QTD/YTD came out with start > end.
import { localDateISO } from "../subscriptions";

export type DateRange = { start: string; end: string };

export interface PresetDef {
  key: string;
  label: string;
}

// Order shown as chips. "custom" is handled by the picker, not getPresetRange.
export const RANGE_PRESETS: PresetDef[] = [
  { key: "mtd", label: "MTD" },
  { key: "qtd", label: "QTD" },
  { key: "ytd", label: "YTD" },
  { key: "last-month", label: "Last month" },
  { key: "last-quarter", label: "Last quarter" },
  { key: "last-year", label: "Last year" },
  { key: "last-12", label: "12 mo" },
];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** First/last day of a calendar month. month is 0-based. */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/**
 * Resolve a preset key to a concrete { start, end } range. Mirrors the web
 * reports page `getPresetRange`. Unknown keys fall through to "last-12".
 */
export function getPresetRange(preset: string, now: Date = new Date()): DateRange {
  const end = localDateISO(now);
  const y = now.getFullYear();
  const m = now.getMonth();

  switch (preset) {
    case "mtd":
      return { start: `${y}-${pad2(m + 1)}-01`, end };
    case "qtd": {
      const qStart = Math.floor(m / 3) * 3;
      return { start: `${y}-${pad2(qStart + 1)}-01`, end };
    }
    case "ytd":
      return { start: `${y}-01-01`, end };
    case "last-month": {
      const lm = m === 0 ? 11 : m - 1;
      const ly = m === 0 ? y - 1 : y;
      const days = lastDayOfMonth(ly, lm);
      return { start: `${ly}-${pad2(lm + 1)}-01`, end: `${ly}-${pad2(lm + 1)}-${pad2(days)}` };
    }
    case "last-quarter": {
      const cq = Math.floor(m / 3);
      const lq = cq === 0 ? 3 : cq - 1;
      const lqy = cq === 0 ? y - 1 : y;
      const qsm = lq * 3;
      const qem = qsm + 2;
      const qed = lastDayOfMonth(lqy, qem);
      return { start: `${lqy}-${pad2(qsm + 1)}-01`, end: `${lqy}-${pad2(qem + 1)}-${pad2(qed)}` };
    }
    case "last-year":
      return { start: `${y - 1}-01-01`, end: `${y - 1}-12-31` };
    case "last-12":
    default: {
      // 12 COMPLETE months (web parity): first day of the month 12 months
      // before the current one → last day of the previous month. Date's own
      // month arithmetic handles the year roll-back.
      const startD = new Date(y, m - 12, 1);
      const endD = new Date(y, m, 0); // day 0 of this month = last day of the prior one
      return { start: localDateISO(startD), end: localDateISO(endD) };
    }
  }
}

export interface MonthOption {
  value: string; // "YYYY-MM"
  label: string; // "Jun 2026"
}

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Last `count` months as picker options, newest first. */
export function recentMonths(count = 36, now: Date = new Date()): MonthOption[] {
  const out: MonthOption[] = [];
  let y = now.getFullYear();
  let m = now.getMonth();
  for (let i = 0; i < count; i++) {
    out.push({ value: `${y}-${pad2(m + 1)}`, label: `${MONTH_NAMES[m]} ${y}` });
    m -= 1;
    if (m < 0) {
      m = 11;
      y -= 1;
    }
  }
  return out;
}

/** First day of a "YYYY-MM" month. */
export function monthStart(ym: string): string {
  return `${ym}-01`;
}

/** Last day of a "YYYY-MM" month. */
export function monthEnd(ym: string): string {
  const [y, m] = ym.split("-").map((x) => parseInt(x, 10));
  return `${ym}-${pad2(lastDayOfMonth(y, m - 1))}`;
}

/** Human label for a concrete range, e.g. "Jan 2026 – Jun 2026". */
export function formatRangeLabel(start: string, end: string): string {
  const fmt = (d: string) => {
    const [y, m] = d.split("-");
    const mi = parseInt(m, 10) - 1;
    return `${MONTH_NAMES[mi] ?? m} ${y}`;
  };
  return `${fmt(start)} – ${fmt(end)}`;
}
