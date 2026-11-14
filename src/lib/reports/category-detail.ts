/**
 * Category detail ("category view") — pure builder.
 *
 * Feeds `GET /api/reports/category` and through it the `/categories/[id]`
 * page: one category's amounts month by month (`buildCategoryDetail`) or
 * calendar year by year (`buildCategoryYearly`, 2026-11-13, in-app feedback),
 * its average and comparisons, budget history, top payees and recent
 * transactions. The monthly "usual month" rule is shared with the categories
 * overview (a test pins the two), so the yearly view is a separate builder and
 * leaves the monthly one untouched.
 *
 * Pure (no db, no fetch): the route does the queries and hands in rows plus a
 * `toDisplay` converter, so every number here is in the display currency and
 * the math is unit-testable (tests/category-detail.test.ts).
 *
 * Orientation: amounts are reported POSITIVE in the category's natural
 * direction — money spent for an expense category, money received for an
 * income one. A refund in an expense category therefore reduces its spend.
 */

import { round2 } from "@/lib/utils/number";
import { ALL_TIME_START } from "@/lib/reports/period";

import type { CategoryType } from "@/lib/categories/category-type";
export type { CategoryType };

export interface CategoryTxRow {
  id: number;
  date: string;
  /** Decrypted payee; null when it couldn't be decrypted. */
  payee: string | null;
  /** Signed, account currency. */
  amount: number;
  currency: string;
  reportingAmount: number | null;
  reportingCurrency: string | null;
  accountName: string | null;
}

export interface CategoryMonth {
  month: string; // YYYY-MM
  amount: number;
  count: number;
  /** Budget for that month in the display currency, when one is set. */
  budget: number | null;
  /** The current, still-running month. */
  partial: boolean;
}

export interface CategoryPayee {
  payee: string;
  amount: number;
  count: number;
  /** Share of the category's total over the window (0..1). */
  share: number;
}

export interface CategoryRecentTx {
  id: number;
  date: string;
  payee: string | null;
  /** NATIVE signed amount, shown in `currency`. */
  amount: number;
  currency: string;
  accountName: string | null;
}

export interface CategoryDetail {
  months: CategoryMonth[];
  stats: {
    thisMonth: number;
    lastMonth: number;
    sameMonthLastYear: number;
    /** Mean of COMPLETE months since the category's first activity in the window. */
    averageMonthly: number | null;
    medianMonthly: number | null;
    highestMonth: { month: string; amount: number } | null;
    total: number;
    transactionCount: number;
    averageTransaction: number | null;
    /** Category total ÷ total of every category of the same type (0..1). */
    shareOfType: number | null;
  };
  hasBudget: boolean;
  topPayees: CategoryPayee[];
  recent: CategoryRecentTx[];
}

export const CATEGORY_WINDOWS = [6, 12, 24] as const;
export type CategoryWindow = (typeof CATEGORY_WINDOWS)[number];
/** Yearly view ranges, in calendar years ending with the current one. */
export const CATEGORY_YEAR_WINDOWS = [3, 5, 10] as const;
export type CategoryYearWindow = (typeof CATEGORY_YEAR_WINDOWS)[number];
/** A range is a count from the lists above, or the whole history. */
export type CategoryRange = number | "all";

export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

/** `YYYY-MM` shifted by `delta` months. */
export function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

/** Months from `fromMonth` through `toMonth`, inclusive; 1 when reversed. */
export function monthsBetween(fromMonth: string, toMonth: string): number {
  const [fy, fm] = fromMonth.split("-").map(Number);
  const [ty, tm] = toMonth.split("-").map(Number);
  return Math.max(1, ty * 12 + tm - (fy * 12 + fm) + 1);
}

/** Earliest date the all-time views reach back to (bad or epoch dates floor here). */
function allTimeFloor(firstDate: string | null): string | null {
  if (!firstDate) return null;
  return firstDate < ALL_TIME_START ? ALL_TIME_START : firstDate;
}

/**
 * Length of the monthly "All" range: from the category's first transaction to
 * today's month. 12 when the category has none, so the page still shows a year.
 */
export function allTimeMonths(today: string, firstDate: string | null): number {
  const first = allTimeFloor(firstDate);
  if (!first || first > today) return 12;
  return monthsBetween(monthKey(first), monthKey(today));
}

/** Length of the yearly "All" range: first transaction's year to this year (>= 1). */
export function allTimeYears(today: string, firstDate: string | null): number {
  const first = allTimeFloor(firstDate);
  if (!first || first > today) return 1;
  return Number(today.slice(0, 4)) - Number(first.slice(0, 4)) + 1;
}

/**
 * Window boundaries for a `months`-long view ending in today's month.
 * `queryStart` reaches back at least 12 months so the current month always
 * has a same-month-last-year comparison, even in the 6-month view.
 */
export function categoryWindow(today: string, months: number) {
  const current = monthKey(today);
  const windowStartMonth = shiftMonth(current, -(months - 1));
  const queryStartMonth = shiftMonth(current, -Math.max(months - 1, 12));
  return {
    currentMonth: current,
    windowStartMonth,
    windowStart: `${windowStartMonth}-01`,
    queryStart: `${queryStartMonth}-01`,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Top payees over `rows`, case-insensitive, missing payees labelled. */
function topPayeesOf(
  rows: CategoryTxRow[],
  sign: number,
  toDisplay: (row: CategoryTxRow) => number,
  total: number,
  limit: number,
): CategoryPayee[] {
  const payees = new Map<string, { payee: string; amount: number; count: number }>();
  for (const r of rows) {
    const label = (r.payee ?? "").trim() || "(no payee)";
    const key = label.toLowerCase();
    const e = payees.get(key) ?? { payee: label, amount: 0, count: 0 };
    e.amount += sign * toDisplay(r);
    e.count += 1;
    payees.set(key, e);
  }
  return [...payees.values()]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit)
    .map((p) => ({
      payee: p.payee,
      amount: round2(p.amount),
      count: p.count,
      share: total !== 0 ? p.amount / total : 0,
    }));
}

/** Newest transactions first, in their own currency. */
function recentOf(rows: CategoryTxRow[], limit: number): CategoryRecentTx[] {
  return [...rows]
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      date: r.date,
      payee: r.payee,
      amount: r.amount,
      currency: r.currency,
      accountName: r.accountName,
    }));
}

export function buildCategoryDetail(input: {
  type: CategoryType;
  rows: CategoryTxRow[];
  /** month → budget already converted to the display currency. */
  budgets: Map<string, number>;
  today: string;
  months: number;
  /** Row → display-currency signed amount (stored reporting amount, else current rate). */
  toDisplay: (row: CategoryTxRow) => number;
  /** Total of all categories of the same type over the window, positively oriented. */
  typeTotal: number;
  topPayeeLimit?: number;
  recentLimit?: number;
}): CategoryDetail {
  const { type, rows, budgets, today, months, toDisplay, typeTotal } = input;
  const sign = type === "I" ? 1 : -1;
  const { currentMonth, windowStartMonth } = categoryWindow(today, months);

  const byMonth = new Map<string, { amount: number; count: number }>();
  for (const r of rows) {
    if (r.date > today) continue;
    const k = monthKey(r.date);
    const e = byMonth.get(k) ?? { amount: 0, count: 0 };
    e.amount += sign * toDisplay(r);
    e.count += 1;
    byMonth.set(k, e);
  }
  const amountOf = (k: string) => round2(byMonth.get(k)?.amount ?? 0);

  const series: CategoryMonth[] = [];
  for (let k = windowStartMonth; k <= currentMonth; k = shiftMonth(k, 1)) {
    const b = budgets.get(k);
    series.push({
      month: k,
      amount: amountOf(k),
      count: byMonth.get(k)?.count ?? 0,
      budget: b != null ? round2(b) : null,
      partial: k === currentMonth,
    });
  }

  // Averages use COMPLETE months only, starting at the category's first
  // activity in the window — zero months before it existed would dilute the
  // average, but zero months after it started are real.
  const complete = series.filter((m) => !m.partial);
  const firstActive = complete.findIndex((m) => m.count > 0);
  const active = firstActive >= 0 ? complete.slice(firstActive) : [];
  const activeAmounts = active.map((m) => m.amount);
  const highest = active.reduce<CategoryMonth | null>((best, m) => (!best || m.amount > best.amount ? m : best), null);

  const windowRows = rows.filter((r) => r.date <= today && monthKey(r.date) >= windowStartMonth);
  const total = round2(series.reduce((s, m) => s + m.amount, 0));
  const transactionCount = windowRows.length;

  const topPayees = topPayeesOf(windowRows, sign, toDisplay, total, input.topPayeeLimit ?? 8);
  const recent = recentOf(windowRows, input.recentLimit ?? 10);

  const averageMonthly = activeAmounts.length ? round2(activeAmounts.reduce((s, v) => s + v, 0) / activeAmounts.length) : null;
  const med = median(activeAmounts);

  return {
    months: series,
    stats: {
      thisMonth: amountOf(currentMonth),
      lastMonth: amountOf(shiftMonth(currentMonth, -1)),
      sameMonthLastYear: amountOf(shiftMonth(currentMonth, -12)),
      averageMonthly,
      medianMonthly: med != null ? round2(med) : null,
      highestMonth: highest ? { month: highest.month, amount: highest.amount } : null,
      total,
      transactionCount,
      averageTransaction: transactionCount > 0 ? round2(total / transactionCount) : null,
      shareOfType: typeTotal > 0 ? total / typeTotal : null,
    },
    hasBudget: series.some((m) => m.budget != null),
    topPayees,
    recent,
  };
}

// ── Yearly view ─────────────────────────────────────────────────────────────

export interface CategoryYear {
  year: string; // YYYY
  amount: number;
  count: number;
  /** Sum of that year's monthly budgets (display currency), when any is set. */
  budget: number | null;
  /** The current, still-running year. */
  partial: boolean;
}

export interface CategoryYearlyDetail {
  years: CategoryYear[];
  stats: {
    thisYear: number;
    lastYear: number;
    /** Last year from 1 January to today's date a year ago: like for like with thisYear. */
    samePeriodLastYear: number;
    /** Mean of COMPLETE years since the category's first activity in the window. */
    averageYearly: number | null;
    medianYearly: number | null;
    highestYear: { year: string; amount: number } | null;
    total: number;
    transactionCount: number;
    averageTransaction: number | null;
    shareOfType: number | null;
  };
  hasBudget: boolean;
  topPayees: CategoryPayee[];
  recent: CategoryRecentTx[];
}

/**
 * Window for a `years`-long yearly view: whole calendar years ending with the
 * current one. `queryStart` always reaches last year so "last year" and "same
 * point last year" resolve even in a one-year view.
 */
export function categoryYearWindow(today: string, years: number) {
  const currentYear = Number(today.slice(0, 4));
  const startYear = currentYear - (Math.max(1, years) - 1);
  return {
    currentYear: String(currentYear),
    startYear: String(startYear),
    windowStart: `${startYear}-01-01`,
    windowStartMonth: `${startYear}-01`,
    queryStart: `${Math.min(startYear, currentYear - 1)}-01-01`,
  };
}

export function buildCategoryYearly(input: {
  type: CategoryType;
  rows: CategoryTxRow[];
  /** month → budget already converted to the display currency. */
  budgets: Map<string, number>;
  today: string;
  years: number;
  toDisplay: (row: CategoryTxRow) => number;
  /** Total of all categories of the same type over the window, positively oriented. */
  typeTotal: number;
  topPayeeLimit?: number;
  recentLimit?: number;
}): CategoryYearlyDetail {
  const { type, rows, budgets, today, years, toDisplay, typeTotal } = input;
  const sign = type === "I" ? 1 : -1;
  const { currentYear, startYear, windowStart } = categoryYearWindow(today, years);
  const lastYearKey = String(Number(currentYear) - 1);
  // Same day a year ago, as a string bound: "2025-02-29" sorts after every
  // real February 2025 date, so a leap day needs no special case.
  const sameDayLastYear = `${lastYearKey}${today.slice(4, 10)}`;

  const byYear = new Map<string, { amount: number; count: number }>();
  let samePeriodLastYear = 0;
  for (const r of rows) {
    if (r.date > today) continue;
    const y = r.date.slice(0, 4);
    const e = byYear.get(y) ?? { amount: 0, count: 0 };
    const v = sign * toDisplay(r);
    e.amount += v;
    e.count += 1;
    byYear.set(y, e);
    if (y === lastYearKey && r.date <= sameDayLastYear) samePeriodLastYear += v;
  }
  const amountOf = (y: string) => round2(byYear.get(y)?.amount ?? 0);

  const budgetByYear = new Map<string, number>();
  for (const [month, amount] of budgets) {
    const y = month.slice(0, 4);
    budgetByYear.set(y, (budgetByYear.get(y) ?? 0) + amount);
  }

  const series: CategoryYear[] = [];
  for (let y = Number(startYear); y <= Number(currentYear); y++) {
    const key = String(y);
    const b = budgetByYear.get(key);
    series.push({
      year: key,
      amount: amountOf(key),
      count: byYear.get(key)?.count ?? 0,
      budget: b != null ? round2(b) : null,
      partial: key === currentYear,
    });
  }

  // Same rule as the monthly average: complete periods only, from the first
  // one with activity (years before the category existed would dilute it).
  const complete = series.filter((y) => !y.partial);
  const firstActive = complete.findIndex((y) => y.count > 0);
  const active = firstActive >= 0 ? complete.slice(firstActive) : [];
  const activeAmounts = active.map((y) => y.amount);
  const highest = active.reduce<CategoryYear | null>((best, y) => (!best || y.amount > best.amount ? y : best), null);

  const windowRows = rows.filter((r) => r.date <= today && r.date >= windowStart);
  const total = round2(series.reduce((s, y) => s + y.amount, 0));
  const transactionCount = windowRows.length;
  const med = median(activeAmounts);

  return {
    years: series,
    stats: {
      thisYear: amountOf(currentYear),
      lastYear: amountOf(lastYearKey),
      samePeriodLastYear: round2(samePeriodLastYear),
      averageYearly: activeAmounts.length ? round2(activeAmounts.reduce((s, v) => s + v, 0) / activeAmounts.length) : null,
      medianYearly: med != null ? round2(med) : null,
      highestYear: highest ? { year: highest.year, amount: highest.amount } : null,
      total,
      transactionCount,
      averageTransaction: transactionCount > 0 ? round2(total / transactionCount) : null,
      shareOfType: typeTotal > 0 ? total / typeTotal : null,
    },
    hasBudget: series.some((y) => y.budget != null),
    topPayees: topPayeesOf(windowRows, sign, toDisplay, total, input.topPayeeLimit ?? 8),
    recent: recentOf(windowRows, input.recentLimit ?? 10),
  };
}
