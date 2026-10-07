/**
 * Category detail ("category view") — pure builder.
 *
 * Feeds `GET /api/reports/category` and through it the `/categories/[id]`
 * page: one category's month-by-month amounts, its average and comparisons,
 * budget history, top payees and recent transactions.
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

export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

/** `YYYY-MM` shifted by `delta` months. */
export function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
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

  // Top payees over the window.
  const payees = new Map<string, { payee: string; amount: number; count: number }>();
  for (const r of windowRows) {
    const label = (r.payee ?? "").trim() || "(no payee)";
    const key = label.toLowerCase();
    const e = payees.get(key) ?? { payee: label, amount: 0, count: 0 };
    e.amount += sign * toDisplay(r);
    e.count += 1;
    payees.set(key, e);
  }
  const topPayees = [...payees.values()]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, input.topPayeeLimit ?? 8)
    .map((p) => ({
      payee: p.payee,
      amount: round2(p.amount),
      count: p.count,
      share: total !== 0 ? p.amount / total : 0,
    }));

  const recent = [...windowRows]
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
    .slice(0, input.recentLimit ?? 10)
    .map((r) => ({
      id: r.id,
      date: r.date,
      payee: r.payee,
      amount: r.amount,
      currency: r.currency,
      accountName: r.accountName,
    }));

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
