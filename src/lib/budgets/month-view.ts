/**
 * Display helpers for the Budgets page summary: how far into the month we are,
 * and how expected income splits into planned spending, debt payments and
 * what is left to plan. Pure (client-safe).
 */
import { monthEndDate } from "./lines";

export interface MonthProgress {
  /** "past" = the whole month is behind `today`; "future" = it has not started. */
  state: "past" | "current" | "future";
  day: number;
  days: number;
  /** Share of the month gone, 0..1 (1 for a past month, 0 for a future one). */
  fraction: number;
}

export function monthProgress(month: string, today: string): MonthProgress {
  const days = Number(monthEndDate(month).slice(8));
  const todayMonth = today.slice(0, 7);
  if (todayMonth > month) return { state: "past", day: days, days, fraction: 1 };
  if (todayMonth < month) return { state: "future", day: 0, days, fraction: 0 };
  const day = Math.min(days, Math.max(1, Number(today.slice(8, 10))));
  return { state: "current", day, days, fraction: day / days };
}

export type AllocationKey = "spending" | "debt" | "left";

export interface AllocationSegment {
  key: AllocationKey;
  amount: number;
  /** Share of the bar, 0..1. */
  share: number;
}

export interface Allocation {
  segments: AllocationSegment[];
  /** Where expected income ends on the bar, 0..1. Below 1 only when more is planned than expected. */
  incomeMark: number;
  /** Planned beyond expected income (0 when it all fits). */
  overPlanned: number;
}

/**
 * The bar is as long as the larger of expected income and everything planned,
 * so an over-planned month shows where income runs out instead of hiding it.
 */
export function incomeAllocation(s: { plannedIncome: number; plannedSpending: number; plannedDebt: number }): Allocation {
  const income = Math.max(0, s.plannedIncome);
  const spending = Math.max(0, s.plannedSpending);
  const debt = Math.max(0, s.plannedDebt);
  const planned = spending + debt;
  const total = Math.max(income, planned);
  if (total <= 0.005) return { segments: [], incomeMark: 1, overPlanned: 0 };
  const parts: Array<[AllocationKey, number]> = [
    ["spending", spending],
    ["debt", debt],
    ["left", Math.max(0, income - planned)],
  ];
  return {
    segments: parts.filter(([, amount]) => amount > 0.005).map(([key, amount]) => ({ key, amount, share: amount / total })),
    incomeMark: income / total,
    overPlanned: planned - income > 0.005 ? planned - income : 0,
  };
}
