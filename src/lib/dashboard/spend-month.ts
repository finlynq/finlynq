/**
 * GH #447: the dashboard's Available to Spend card can show the last complete
 * month (the default, closed figures) or the current month so far. Pure, so the
 * card and its tests share one rule.
 */

export type SpendMonthMode = "last" | "current";

export type SpendMonthFigures = { month: string; income: number; expenses: number };

export const SPEND_MONTH_STORAGE_KEY = "pf-available-to-spend-month";

/**
 * From the dashboard's ascending "YYYY-MM" income/expense rows, the newest
 * month before `currentMonthKey` (null when there is none, e.g. a brand-new
 * user) and the current month (zeros when nothing was booked in it yet).
 */
export function splitSpendMonths(
  rows: readonly SpendMonthFigures[],
  currentMonthKey: string,
): { last: SpendMonthFigures | null; current: SpendMonthFigures } {
  let last: SpendMonthFigures | null = null;
  let current: SpendMonthFigures = { month: currentMonthKey, income: 0, expenses: 0 };
  for (const r of rows) {
    if (r.month === currentMonthKey) current = { month: r.month, income: r.income, expenses: r.expenses };
    else if (r.month < currentMonthKey && (!last || r.month > last.month)) {
      last = { month: r.month, income: r.income, expenses: r.expenses };
    }
  }
  return { last, current };
}

/** A stored choice, or the default (last complete month) for anything else. */
export function parseSpendMonthMode(value: string | null | undefined): SpendMonthMode {
  return value === "current" ? "current" : "last";
}
