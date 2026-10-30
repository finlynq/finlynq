/**
 * The month's budget as the page, MCP and the phone app see it. Pure: the
 * loader (load-month.ts) supplies every number in the display currency.
 *
 * Three kinds of lines: income (budgets on I categories), spending (E
 * categories, or an expense group budgeted as one line) and debt payments
 * (built by the loader from loan schedules). Excluded categories and groups
 * are listed apart and left out of every total.
 */
import type { DebtStatus } from "./debt-line";
import { categoryKey, groupKey, type BudgetRole, type LineKey } from "./lines";
import type { RolloverNegative } from "./carryover";

export interface MonthCategoryInput {
  id: number;
  name: string;
  group: string;
  type: "E" | "I";
  excluded: boolean;
  rollover: boolean;
  rolloverNegative: RolloverNegative;
}

export interface MonthGroupSetting {
  excluded: boolean;
  byGroup: boolean;
  rollover: boolean;
  rolloverNegative: RolloverNegative;
}

export interface DebtLine {
  accountId: number;
  name: string;
  planned: number;
  paid: number;
  principal: number;
  interest: number;
  /** Interest booked on the account this month (shown, never summed again). */
  bookedInterest: number | null;
  dueDates: string[];
  status: DebtStatus;
  /** Where planned comes from: the loan schedule, the account's fixed amount, or nothing. */
  source: "schedule" | "fixed" | "none";
  loanIds: number[];
}

export interface BudgetLine {
  key: LineKey;
  categoryId: number | null;
  name: string;
  /** This month's budget; null = none set (inside a by-group group, always null). */
  budgeted: number | null;
  /** Spending: money out, refunds net. Income: money received. */
  actual: number;
  /** For rollover lines only. */
  carriedIn: number | null;
  /** budgeted (+ carriedIn) − actual; null when there is nothing to compare against. */
  left: number | null;
  rollover: boolean;
  rolloverNegative: RolloverNegative;
  /** Spent per month over the last 3 complete months (spending lines). */
  average3: number;
  upcoming: number;
  status: "unbudgeted" | "ok" | "warn" | "over" | "received" | "expected";
}

export interface BudgetGroup {
  key: LineKey;
  name: string;
  byGroup: boolean;
  rollover: boolean;
  rolloverNegative: RolloverNegative;
  budgeted: number | null;
  actual: number;
  carriedIn: number | null;
  left: number | null;
  upcoming: number;
  average3: number;
  status: BudgetLine["status"];
  lines: BudgetLine[];
}

export interface BudgetAccountInfo {
  id: number;
  name: string;
  type: string;
  currency: string;
  isInvestment: boolean;
  archived: boolean;
  role: BudgetRole;
  storedRole: BudgetRole | null;
  automaticRole: BudgetRole;
  paymentAmount: number | null;
  linkedLoans: Array<{ id: number; name: string; type: string }>;
}

export interface BudgetMonth {
  month: string;
  currency: string;
  today: string;
  summary: {
    plannedIncome: number;
    receivedIncome: number;
    plannedSpending: number;
    spent: number;
    plannedDebt: number;
    paidDebt: number;
    /** plannedIncome − plannedSpending − plannedDebt (this month's money; carried-in excluded). */
    leftToPlan: number;
    /** receivedIncome − spent − paidDebt. */
    netCashFlow: number;
    upcoming: number;
  };
  counts: { notBudgeted: number; overspent: number; withUpcoming: number };
  income: BudgetGroup[];
  spending: BudgetGroup[];
  debt: DebtLine[];
  /** Left out of the budget, by their own setting or their group's. */
  excluded: Array<{ key: LineKey; categoryId: number; name: string; group: string; type: "E" | "I"; by: "category" | "group" }>;
  accounts: BudgetAccountInfo[];
}

export interface BuildMonthInput {
  month: string;
  currency: string;
  today: string;
  categories: readonly MonthCategoryInput[];
  groupSettings: ReadonlyMap<string, MonthGroupSetting>;
  /** Category budgets for the month. */
  budgets: ReadonlyMap<number, number>;
  /** Expense-group budgets for the month. */
  groupBudgets: ReadonlyMap<string, number>;
  /** Spending positive for E, received positive for I. */
  actuals: ReadonlyMap<number, number>;
  averages: ReadonlyMap<number, number>;
  /** Carry results for rollover lines, keyed by line key. */
  carry: ReadonlyMap<string, { carriedIn: number; left: number }>;
  upcoming: ReadonlyMap<number, number>;
  debt: readonly DebtLine[];
  accounts: readonly BudgetAccountInfo[];
  /**
   * Interest categories of loans paid as debt-payment lines. Their interest
   * belongs to the loan's line, so with no budget and nothing spent in them
   * elsewhere they are not listed (no "not budgeted" nag for interest).
   */
  coveredByLoan?: ReadonlySet<number>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const OTHER = "Other";
export const groupLabel = (g: string) => (g.trim() ? g : OTHER);

function spendingStatus(budgeted: number | null, left: number | null, upcoming: number, rollover: boolean): BudgetLine["status"] {
  if (budgeted == null && !rollover) return "unbudgeted";
  if (left == null) return "unbudgeted";
  if (left < -0.005) return "over";
  if (upcoming > 0 && upcoming > left + 0.005) return "warn";
  return "ok";
}

function sortByName<T extends { name: string }>(rows: T[]): T[] {
  return rows.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
}

function sortGroups(groups: BudgetGroup[]): BudgetGroup[] {
  return groups.sort((a, b) => {
    if (a.name === OTHER) return 1;
    if (b.name === OTHER) return -1;
    return a.name.localeCompare(b.name);
  });
}

export function buildBudgetMonth(input: BuildMonthInput): BudgetMonth {
  const excluded: BudgetMonth["excluded"] = [];
  const spendingGroups = new Map<string, MonthCategoryInput[]>();
  const incomeGroups = new Map<string, MonthCategoryInput[]>();

  for (const c of input.categories) {
    const gs = c.type === "E" ? input.groupSettings.get(c.group) : undefined;
    if (c.excluded || gs?.excluded) {
      excluded.push({
        key: categoryKey(c.id), categoryId: c.id, name: c.name, group: c.group, type: c.type,
        by: c.excluded ? "category" : "group",
      });
      continue;
    }
    if (
      input.coveredByLoan?.has(c.id) &&
      Math.abs(input.actuals.get(c.id) ?? 0) < 0.005 &&
      !input.budgets.has(c.id) &&
      !c.rollover
    ) {
      continue;
    }
    const target = c.type === "E" ? spendingGroups : incomeGroups;
    target.set(c.group, [...(target.get(c.group) ?? []), c]);
  }

  const lineFor = (c: MonthCategoryInput, inGroupBudget: boolean): BudgetLine => {
    const key = categoryKey(c.id);
    const actual = round2(input.actuals.get(c.id) ?? 0);
    const upcoming = round2(input.upcoming.get(c.id) ?? 0);
    const average3 = round2(input.averages.get(c.id) ?? 0);
    if (c.type === "I") {
      const budgeted = input.budgets.get(c.id) ?? null;
      return {
        key, categoryId: c.id, name: c.name, budgeted, actual,
        carriedIn: null,
        left: budgeted == null ? null : round2(budgeted - actual),
        rollover: false, rolloverNegative: c.rolloverNegative, average3, upcoming,
        status: budgeted == null ? "unbudgeted" : actual >= budgeted - 0.005 ? "received" : "expected",
      };
    }
    if (inGroupBudget) {
      return {
        key, categoryId: c.id, name: c.name, budgeted: null, actual, carriedIn: null, left: null,
        rollover: false, rolloverNegative: c.rolloverNegative, average3, upcoming, status: "ok",
      };
    }
    const budgeted = input.budgets.get(c.id) ?? null;
    const carry = c.rollover ? input.carry.get(key) : undefined;
    const carriedIn = c.rollover ? round2(carry?.carriedIn ?? 0) : null;
    const left =
      budgeted == null && !c.rollover ? null : round2((carriedIn ?? 0) + (budgeted ?? 0) - actual);
    return {
      key, categoryId: c.id, name: c.name, budgeted, actual, carriedIn, left,
      rollover: c.rollover, rolloverNegative: c.rolloverNegative, average3, upcoming,
      status: spendingStatus(budgeted, left, upcoming, c.rollover),
    };
  };

  const spending: BudgetGroup[] = [];
  for (const [name, cats] of spendingGroups) {
    const gs = input.groupSettings.get(name);
    const byGroup = !!gs?.byGroup;
    const lines = sortByName(cats.map((c) => lineFor(c, byGroup)));
    const actual = round2(lines.reduce((s, l) => s + l.actual, 0));
    const upcoming = round2(lines.reduce((s, l) => s + l.upcoming, 0));
    const average3 = round2(lines.reduce((s, l) => s + l.average3, 0));
    const key = groupKey(name);
    let budgeted: number | null;
    let carriedIn: number | null = null;
    let left: number | null;
    let rollover = false;
    if (byGroup) {
      budgeted = input.groupBudgets.get(name) ?? null;
      rollover = !!gs?.rollover;
      if (rollover) carriedIn = round2(input.carry.get(key)?.carriedIn ?? 0);
      left = budgeted == null && !rollover ? null : round2((carriedIn ?? 0) + (budgeted ?? 0) - actual);
    } else {
      const set = lines.filter((l) => l.budgeted != null);
      budgeted = set.length ? round2(set.reduce((s, l) => s + (l.budgeted ?? 0), 0)) : null;
      const withLeft = lines.filter((l) => l.left != null);
      left = withLeft.length ? round2(withLeft.reduce((s, l) => s + (l.left ?? 0), 0)) : null;
      const carried = lines.filter((l) => l.carriedIn != null);
      carriedIn = carried.length ? round2(carried.reduce((s, l) => s + (l.carriedIn ?? 0), 0)) : null;
    }
    spending.push({
      key, name: groupLabel(name), byGroup, rollover, rolloverNegative: gs?.rolloverNegative ?? "carry",
      budgeted, actual, carriedIn, left, upcoming, average3,
      status: byGroup ? spendingStatus(budgeted, left, upcoming, rollover) : left != null && left < -0.005 ? "over" : "ok",
      lines,
    });
  }

  const income: BudgetGroup[] = [];
  for (const [name, cats] of incomeGroups) {
    const lines = sortByName(cats.map((c) => lineFor(c, false)));
    const set = lines.filter((l) => l.budgeted != null);
    income.push({
      key: groupKey(`income:${name}`), name: groupLabel(name), byGroup: false, rollover: false, rolloverNegative: "carry",
      budgeted: set.length ? round2(set.reduce((s, l) => s + (l.budgeted ?? 0), 0)) : null,
      actual: round2(lines.reduce((s, l) => s + l.actual, 0)),
      carriedIn: null, left: null, upcoming: 0, average3: 0, status: "ok", lines,
    });
  }

  const sum = (xs: number[]) => round2(xs.reduce((s, x) => s + x, 0));
  const spendingBudgets: number[] = [];
  for (const g of spending) {
    if (g.byGroup) {
      if (g.budgeted != null) spendingBudgets.push(g.budgeted);
    } else {
      for (const l of g.lines) if (l.budgeted != null) spendingBudgets.push(l.budgeted);
    }
  }
  const plannedIncome = sum(income.flatMap((g) => g.lines.map((l) => l.budgeted ?? 0)));
  const receivedIncome = sum(income.map((g) => g.actual));
  const plannedSpending = sum(spendingBudgets);
  const spent = sum(spending.map((g) => g.actual));
  const plannedDebt = sum(input.debt.map((d) => d.planned));
  const paidDebt = sum(input.debt.map((d) => d.paid));

  // Units the user budgets: by-group groups, and the categories of the others.
  const units: Array<{ status: BudgetLine["status"]; upcoming: number }> = spending.flatMap((g) =>
    g.byGroup ? [{ status: g.status, upcoming: g.upcoming }] : g.lines.map((l) => ({ status: l.status, upcoming: l.upcoming })),
  );

  return {
    month: input.month,
    currency: input.currency,
    today: input.today,
    summary: {
      plannedIncome,
      receivedIncome,
      plannedSpending,
      spent,
      plannedDebt,
      paidDebt,
      leftToPlan: round2(plannedIncome - plannedSpending - plannedDebt),
      netCashFlow: round2(receivedIncome - spent - paidDebt),
      upcoming: sum(spending.map((g) => g.upcoming)),
    },
    counts: {
      notBudgeted: units.filter((u) => u.status === "unbudgeted").length,
      overspent: units.filter((u) => u.status === "over").length,
      withUpcoming: units.filter((u) => u.upcoming > 0).length,
    },
    income: sortGroups(income),
    spending: sortGroups(spending),
    debt: [...input.debt].sort((a, b) => a.name.localeCompare(b.name)),
    excluded: excluded.sort((a, b) => a.name.localeCompare(b.name)),
    accounts: [...input.accounts],
  };
}
