// What the home-screen widgets show, built from the same routes the app's own
// screens read. Pure, so it can be tested without a device.
//
// Amounts are formatted here, in the app's one formatCurrency, and the widgets
// draw the strings as they are. Anything that depends on today's date ("3 days
// left", "Tomorrow") is left to the widget, which redraws without the app.
// The native side reads this shape: see WidgetRenderer.kt, and the sample in
// modules/finlynq-widgets/android/src/debug/assets that a test holds it to.

import type { LoanSummary, LoanScheduleRow } from "../../../../shared/types";
import { formatCurrency } from "../format";
import { isLoanCompleted } from "../loans";
import { addDays, effectiveNextDate, isTrackedPayee, rollForwardNextDate, type RecurringRow, type SubscriptionRow } from "../subscriptions";
import { looksEncrypted } from "../transfer-pair";
import { WIDGET_LINKS } from "./links";

export const WIDGET_SNAPSHOT_VERSION = 1;
/** The widget holds this many rows at its largest. */
export const MAX_UPCOMING_ITEMS = 6;
/** How far ahead "upcoming" looks. */
export const UPCOMING_WINDOW_DAYS = 90;
/** Share of the budget used at which Left to spend turns amber. */
export const WARN_AT_USED = 0.8;

export type WidgetTone = "ok" | "warn" | "over";

export interface LeftToSpendSection {
  asOfMs: number;
  /** YYYY-MM: the widget shows nothing from an earlier month. */
  month: string;
  /** False when nothing is budgeted: the widget shows what was spent instead. */
  hasBudget: boolean;
  /** What is left; when over budget, how far over. */
  leftLabel: string;
  plannedLabel: string;
  spentLabel: string;
  usedFraction: number;
  tone: WidgetTone;
}

export interface UpcomingItem {
  date: string;
  name: string;
  amountLabel: string;
  kind: "loan" | "subscription" | "detected";
  link: string;
}

export interface UpcomingSection {
  asOfMs: number;
  items: UpcomingItem[];
}

export interface NetWorthSection {
  asOfMs: number;
  netWorthLabel: string;
  assetsLabel: string;
  debtsLabel: string;
}

export interface WidgetSnapshot {
  version: number;
  updatedAtMs: number;
  leftToSpend: LeftToSpendSection | null;
  upcoming: UpcomingSection | null;
  netWorth: NetWorthSection | null;
}

/** The fields of GET /api/budgets/month this reads; amounts in `currency`. */
export interface BudgetMonthInput {
  month: string;
  currency: string;
  summary: { plannedSpending: number; spent: number };
}

/** The same totals the Budgets page shows: planned spending against what was spent. */
export function leftToSpendSection(budget: BudgetMonthInput, nowMs: number): LeftToSpendSection {
  const { plannedSpending: planned, spent } = budget.summary;
  const left = planned - spent;
  const hasBudget = planned > 0;
  const usedFraction = hasBudget ? Math.max(spent / planned, 0) : 0;
  let tone: WidgetTone = "ok";
  if (hasBudget && left < -0.005) tone = "over";
  else if (hasBudget && usedFraction >= WARN_AT_USED) tone = "warn";
  return {
    asOfMs: nowMs,
    month: budget.month,
    hasBudget,
    leftLabel: formatCurrency(Math.abs(left), budget.currency),
    plannedLabel: formatCurrency(planned, budget.currency),
    spentLabel: formatCurrency(spent, budget.currency),
    usedFraction,
    tone,
  };
}

/** Loans the widget should look up a next payment for. */
export function loansToSchedule(loans: LoanSummary[]): LoanSummary[] {
  return loans.filter((l) => !l.dataIntegrity && !isLoanCompleted(l));
}

export interface LoanNextPayment {
  loan: Pick<LoanSummary, "name" | "currency">;
  schedule: Pick<LoanScheduleRow, "date" | "payment">[];
}

/**
 * The next payment of each subscription, detected series and loan, soonest
 * first. A name the server could not decrypt returns null, so the caller keeps
 * the names it already has: "Subscription" or `v1:...` must never replace them.
 */
export function upcomingSection(
  subs: SubscriptionRow[],
  recurring: RecurringRow[],
  loans: LoanNextPayment[],
  today: string,
  nowMs: number,
): UpcomingSection | null {
  const activeSubs = subs.filter((s) => s.status === "active");
  const names = [
    ...activeSubs.map((s) => s.name),
    ...recurring.map((r) => r.payee),
    ...loans.map((l) => l.loan.name),
  ];
  if (names.some((n) => n == null || looksEncrypted(n))) return null;

  const end = addDays(today, UPCOMING_WINDOW_DAYS);
  const items: UpcomingItem[] = [];
  // The next date, not every occurrence: a weekly bill appears once. The stored
  // date stands as it is, so a bill first due next month does not show this month.
  for (const s of activeSubs) {
    const date = effectiveNextDate(s, today);
    if (!date || date > end) continue;
    items.push({
      date,
      name: s.name ?? "Subscription",
      amountLabel: formatCurrency(Math.abs(s.amount), s.currency),
      kind: "subscription",
      link: WIDGET_LINKS.subscriptions,
    });
  }
  for (const r of recurring) {
    if (r.avgAmount >= 0 || isTrackedPayee(r.payee, activeSubs)) continue; // Income, or already listed.
    const date = rollForwardNextDate(r.nextDate, r.frequency, today);
    if (!date || date > end) continue;
    items.push({
      date,
      name: r.payee,
      amountLabel: formatCurrency(Math.abs(r.avgAmount), r.currency),
      kind: "detected",
      link: WIDGET_LINKS.subscriptions,
    });
  }

  for (const { loan, schedule } of loans) {
    const next = schedule.find((r) => r.date >= today && r.date <= end);
    if (!next) continue;
    items.push({
      date: next.date,
      name: loan.name ?? "Loan",
      amountLabel: formatCurrency(next.payment, loan.currency),
      kind: "loan",
      link: WIDGET_LINKS.loans,
    });
  }

  items.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  return { asOfMs: nowMs, items: items.slice(0, MAX_UPCOMING_ITEMS) };
}

export function netWorthSection(
  dashboard: { displayCurrency: string; netWorth: number; totalAssets: number; totalLiabilities: number },
  nowMs: number,
): NetWorthSection {
  const { displayCurrency: currency } = dashboard;
  return {
    asOfMs: nowMs,
    netWorthLabel: formatCurrency(dashboard.netWorth, currency),
    assetsLabel: formatCurrency(dashboard.totalAssets, currency),
    debtsLabel: formatCurrency(dashboard.totalLiabilities, currency),
  };
}

export function parseSnapshot(json: string | null): WidgetSnapshot | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as WidgetSnapshot;
    return parsed?.version === WIDGET_SNAPSHOT_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A section that could not be fetched keeps what it had, with its old date, so a
 * widget shows the last known figures and how old they are rather than a blank.
 */
export function mergeSnapshot(
  previous: WidgetSnapshot | null,
  next: Pick<WidgetSnapshot, "leftToSpend" | "upcoming" | "netWorth">,
  nowMs: number,
): WidgetSnapshot {
  return {
    version: WIDGET_SNAPSHOT_VERSION,
    updatedAtMs: nowMs,
    leftToSpend: next.leftToSpend ?? previous?.leftToSpend ?? null,
    upcoming: next.upcoming ?? previous?.upcoming ?? null,
    netWorth: next.netWorth ?? previous?.netWorth ?? null,
  };
}
