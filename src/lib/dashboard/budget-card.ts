/**
 * The dashboard's Budgets card (2026-11-25).
 *
 * The card used to show the month's income minus spending under a "Budgets"
 * label, so it said "Over budget" even with no budget set, and never matched
 * the Budgets page. It now shows what the Budgets page and the phone widget
 * call left to spend: the month's planned spending minus what was spent, from
 * the same month model (`GET /api/budgets/month` → `loadBudgetMonth`).
 *
 * Its month is a calendar month: this month, or the one before it (the
 * default, like the other cards). Pure and client-safe.
 */
import { shiftMonth } from "@/lib/reports/category-detail";
import type { SpendMonthMode } from "@/lib/dashboard/spend-month";

export interface BudgetCardSummary {
  plannedSpending: number;
  spent: number;
}

/** "YYYY-MM" the card shows for its choice. */
export function budgetCardMonth(currentMonth: string, mode: SpendMonthMode): string {
  return mode === "current" ? currentMonth : shiftMonth(currentMonth, -1);
}

/**
 * The card's figure and subtitle. `summary` undefined = still loading, null =
 * the request failed.
 */
export function budgetCardView(
  summary: BudgetCardSummary | null | undefined,
  showingCurrent: boolean,
  fmt: (n: number) => string,
): { value: number; sub: string } {
  if (summary === undefined) return { value: 0, sub: "Loading…" };
  if (summary === null) return { value: 0, sub: "Couldn't load your budget" };
  const planned = summary.plannedSpending;
  if (planned <= 0.005) return { value: 0, sub: "No spending budget set" };
  const left = Math.round((planned - summary.spent) * 100) / 100;
  const word = showingCurrent
    ? left >= 0 ? "Left to spend" : "Over budget"
    : left >= 0 ? "Left over" : "Overspent";
  return { value: left, sub: `${word} · ${fmt(planned)} budgeted` };
}
