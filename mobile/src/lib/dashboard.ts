// Pure helpers behind the Home dashboard. Kept free of React / the API client so
// both `composeDashboard()` (api/client.ts) and DashboardScreen can use them and
// they stay unit-testable.

import type { BudgetWithSpending, HealthScoreData } from "../../../shared/types";

/** Default reporting currency when the server omits one. USD, never CAD (FINLYNQ-183). */
export const DEFAULT_DISPLAY_CURRENCY = "USD";

/** "YYYY-MM" for the given date (local time). */
export function monthKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export interface IncomeExpenseRow {
  month: string;
  type: "I" | "E" | string | null;
  total: number;
}

export interface ReferenceMonth {
  month: string;
  income: number;
  /** Magnitude (always >= 0). */
  expenses: number;
}

/**
 * Pick the month the "Income / Expenses" tiles summarize. Mirrors web
 * dashboard/page.tsx (FINLYNQ-291 C1): the newest tracked month is usually the
 * CURRENT calendar month, which is incomplete mid-month (before payroll lands
 * its income reads $0), so step back to the last COMPLETE month when the newest
 * entry is the current month and an earlier one exists. A brand-new user with
 * only the current month still sees it. Returns null with no rows at all.
 */
export function pickReferenceMonth(
  rows: ReadonlyArray<IncomeExpenseRow>,
  currentMonth: string = monthKey(),
): ReferenceMonth | null {
  const byMonth = new Map<string, { income: number; expenses: number }>();
  for (const row of rows) {
    if (!row || typeof row.month !== "string") continue;
    const entry = byMonth.get(row.month) ?? { income: 0, expenses: 0 };
    const total = Number(row.total) || 0;
    if (row.type === "I") entry.income += total;
    else if (row.type === "E") entry.expenses += Math.abs(total);
    byMonth.set(row.month, entry);
  }
  const months = Array.from(byMonth.keys()).sort();
  if (months.length === 0) return null;
  let idx = months.length - 1;
  if (idx > 0 && months[idx] === currentMonth) idx -= 1;
  const month = months[idx];
  const entry = byMonth.get(month)!;
  return { month, income: entry.income, expenses: entry.expenses };
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2026-09" → "September 2026". Unparseable input is returned unchanged. */
export function formatMonthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  const idx = Number(m[2]) - 1;
  if (idx < 0 || idx > 11) return month;
  return `${MONTH_NAMES[idx]} ${m[1]}`;
}

/** spent / budget for a budget row (display-currency converted when present). */
export function budgetRatio(b: BudgetWithSpending): number {
  const spent = b.convertedSpent ?? 0;
  const budget = b.convertedAmount ?? b.amount;
  if (!budget || budget <= 0) return spent > 0 ? Number.POSITIVE_INFINITY : 0;
  return spent / budget;
}

/**
 * Order budgets most-at-risk first (highest spent/budget ratio), so an
 * over-budget category is never hidden behind the "+N more" cut. Stable for
 * equal ratios (keeps server order).
 */
export function sortBudgetsByRisk<T extends BudgetWithSpending>(budgets: ReadonlyArray<T>): T[] {
  return budgets
    .map((b, i) => ({ b, i, r: budgetRatio(b) }))
    .sort((x, y) => (y.r === x.r ? x.i - y.i : y.r - x.r))
    .map((x) => x.b);
}

export interface SavingsRateView {
  /** Rounded percent; may be negative. */
  pct: number;
  /** Human label for the period the rate covers. */
  period: string;
}

/**
 * The savings rate the dashboard shows. Prefers the health score's 3-month
 * `savingsRatePct` (the same figure the web Key Metrics strip shows); a
 * negative rate is returned as-is. `null` from the server means "no income to
 * divide by" → nothing to show. Only when the health payload is missing (fetch
 * failed / older server without the field) does it fall back to the reference
 * month's own rate.
 */
export function resolveSavingsRate(
  health: Pick<HealthScoreData, "savingsRatePct"> | null | undefined,
  fallback: { savingsRate: number; monthlyIncome: number; referenceMonth: string | null } | null,
): SavingsRateView | null {
  if (health && health.savingsRatePct !== undefined) {
    if (health.savingsRatePct === null || !Number.isFinite(health.savingsRatePct)) return null;
    return { pct: Math.round(health.savingsRatePct), period: "last 3 months" };
  }
  if (fallback && fallback.monthlyIncome > 0 && Number.isFinite(fallback.savingsRate)) {
    return {
      pct: Math.round(fallback.savingsRate),
      period: fallback.referenceMonth ? formatMonthLabel(fallback.referenceMonth) : "this month",
    };
  }
  return null;
}
