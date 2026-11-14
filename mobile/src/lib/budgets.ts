// Budget v2 on the phone: the shape of GET /api/budgets/month and what the
// Budgets screen derives from it. Pure.
//
// The server works out every amount, in the display currency. Nothing here adds
// money up, so the screen cannot disagree with the web page or with the Left to
// spend widget, which read the same totals.
//
// Mirrors pf-app `src/lib/budgets/month.ts` (types), `month-view.ts`
// (monthProgress) and `app/(app)/budgets/_components/budget-rows.tsx`
// (visibleLinesFor, spendBar); keep them in sync.

import { formatWholeMoney } from "./format";

export type BudgetLineStatus = "unbudgeted" | "ok" | "warn" | "over" | "received" | "expected";
export type DebtStatus = "paid" | "due" | "late" | "none";
export type RolloverNegative = "carry" | "reset";

/**
 * A line's budget rules for the month (web `month.ts` LinePlan). `open` = the
 * current month or later; a month that has ended is a plain value. Absent on a
 * server without budget rules.
 */
export interface LinePlan {
  ruleCount: number;
  /** What the rules active this month add up to; null when none is. */
  fromRules: number | null;
  /** Typed on top of the rules (negative takes off). */
  adjustment: number;
  /** "Use only this amount": the rules are ignored this month. */
  override: boolean;
  open: boolean;
}

export interface BudgetLine {
  plan?: LinePlan | null;
  /** `c:<categoryId>`: what the write routes take. */
  key: string;
  categoryId: number | null;
  name: string;
  /** This month's budget; null = none set (inside a one-line group, always null). */
  budgeted: number | null;
  /** Spending: money out, refunds net. Income: money received. */
  actual: number;
  carriedIn: number | null;
  /** budgeted (+ carriedIn) − actual; null when there is nothing to compare against. */
  left: number | null;
  rollover: boolean;
  rolloverNegative: RolloverNegative;
  average3: number;
  upcoming: number;
  status: BudgetLineStatus;
}

export interface BudgetGroup {
  plan?: LinePlan | null;
  /** `g:<group>`; the name part is what the write routes take, `name` is only its label. */
  key: string;
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
  status: BudgetLineStatus;
  lines: BudgetLine[];
}

export interface DebtLine {
  accountId: number;
  name: string;
  planned: number;
  paid: number;
  principal: number;
  interest: number;
  bookedInterest: number | null;
  dueDates: string[];
  status: DebtStatus;
  source: "schedule" | "fixed" | "none";
  loanIds: number[];
}

export interface BudgetSummary {
  plannedIncome: number;
  receivedIncome: number;
  plannedSpending: number;
  spent: number;
  plannedDebt: number;
  paidDebt: number;
  leftToPlan: number;
  netCashFlow: number;
  upcoming: number;
}

export interface ExcludedLine {
  key: string;
  categoryId: number;
  name: string;
  group: string;
  type: "E" | "I";
  by: "category" | "group";
}

/** The fields of GET /api/budgets/month the phone reads. */
export interface BudgetMonth {
  month: string;
  currency: string;
  today: string;
  summary: BudgetSummary;
  counts: { notBudgeted: number; overspent: number; withUpcoming: number };
  income: BudgetGroup[];
  spending: BudgetGroup[];
  debt: DebtLine[];
  excluded: ExcludedLine[];
}

export type BudgetSettingsTarget = { categoryId: number } | { group: string };

export interface BudgetSettingsChange {
  target: BudgetSettingsTarget;
  month: string;
  excluded?: boolean;
  rollover?: boolean;
  rolloverNegative?: RolloverNegative;
}

/** The fill sources the phone offers; the web also has fixed amounts and more averages. */
export type BudgetFillSource = { kind: "average"; months: number } | { kind: "budget" } | { kind: "spent" };

export interface BudgetFillRequest {
  months: string[];
  source: BudgetFillSource;
  overwrite: boolean;
  scope: { kind: "all" };
  section: "spending";
  preview: boolean;
}

export interface BudgetFillResult {
  rows: Array<{ key: string; name: string; month: string; amount: number; previous: number | null }>;
  applied: boolean;
  total: number;
  currency: string;
}

export function formatMonthLabel(month: string): string {
  const [year, m] = month.split("-");
  return new Date(Number(year), Number(m) - 1).toLocaleDateString("en-CA", { month: "long", year: "numeric" });
}

export interface MonthProgress {
  state: "past" | "current" | "future";
  day: number;
  days: number;
  /** Share of the month gone, 0..1 (1 for a past month, 0 for a future one). */
  fraction: number;
}

export function monthProgress(month: string, today: string): MonthProgress {
  const [y, m] = month.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const todayMonth = today.slice(0, 7);
  if (todayMonth > month) return { state: "past", day: days, days, fraction: 1 };
  if (todayMonth < month) return { state: "future", day: 0, days, fraction: 0 };
  const day = Math.min(days, Math.max(1, Number(today.slice(8, 10))));
  return { state: "current", day, days, fraction: day / days };
}

export type BarTone = "ok" | "warn" | "over";

export interface BarSpec {
  value: number;
  target: number;
  tone: BarTone;
}

/** Spent out of what was available (budget + carried in); none when nothing is budgeted. */
export function spendBar(x: Pick<BudgetLine, "budgeted" | "carriedIn" | "left" | "status">): BarSpec | null {
  if (x.left == null) return null;
  const target = (x.budgeted ?? 0) + (x.carriedIn ?? 0);
  if (target <= 0.005) return null;
  const value = target - x.left;
  const tone: BarTone = x.status === "over" ? "over" : x.status === "warn" || value / target >= 0.9 ? "warn" : "ok";
  return { value, target, tone };
}

/** One line of Home's Budget Progress card: something with a budget to spend against this month. */
export interface BudgetProgressLine {
  key: string;
  name: string;
  /** Spent this month, as the Budgets screen shows it. */
  spent: number;
  /** This month's budget plus anything carried in: what the bar fills towards. */
  available: number;
  /** The server's verdict; "over" means more was spent than was available. */
  status: BudgetLineStatus;
}

/** Spent over available; anything spent against nothing available ranks above every ratio. */
function budgetRisk(x: Pick<BudgetProgressLine, "spent" | "available">): number {
  if (x.available <= 0.005) return x.spent > 0.005 ? Number.POSITIVE_INFINITY : 0;
  return x.spent / x.available;
}

/**
 * What Home's Budget Progress card lists, most at risk first: each group budgeted
 * as one line, and in the other groups each category with a budget of its own or
 * a rollover. Income and debt payments stay out, as on the card's old list of
 * spending budgets. Ties keep the server's order.
 */
export function budgetProgressLines(month: BudgetMonth): BudgetProgressLine[] {
  type Unit = Pick<BudgetLine, "key" | "name" | "budgeted" | "actual" | "carriedIn" | "left" | "status">;
  const units = month.spending.flatMap<Unit>((g) => (g.byGroup ? [g] : g.lines)).filter((x) => x.left != null);
  return units
    .map((x, i) => {
      const line: BudgetProgressLine = {
        key: x.key,
        name: x.name,
        spent: x.actual,
        available: (x.budgeted ?? 0) + (x.carriedIn ?? 0),
        status: x.status,
      };
      return { line, i, risk: budgetRisk(line) };
    })
    .sort((a, b) => (a.risk === b.risk ? a.i - b.i : b.risk - a.risk))
    .map((x) => x.line);
}

export const DEBT_TONE: Record<DebtStatus, BarTone | null> = { paid: "ok", late: "over", due: "warn", none: null };

export function debtStatusLabel(d: Pick<DebtLine, "status" | "dueDates">, today: string): string {
  if (d.status === "paid") return "Paid";
  if (d.status === "late") return "Late";
  if (d.status === "none") return "Nothing due";
  const due = d.dueDates.find((x) => x >= today) ?? d.dueDates[d.dueDates.length - 1];
  return due ? `Due ${due.slice(5)}` : "Due";
}

export type BudgetFilter = "all" | "unbudgeted" | "over" | "upcoming";

/**
 * The lines a filter shows from one spending group, or null when it hides the
 * group. A group budgeted as one line is matched as a whole.
 */
export function visibleLinesFor(group: BudgetGroup, filter: BudgetFilter): BudgetLine[] | null {
  if (filter === "all") return group.lines;
  const match = (x: Pick<BudgetLine, "status" | "upcoming">) =>
    filter === "unbudgeted" ? x.status === "unbudgeted" : filter === "over" ? x.status === "over" : x.upcoming > 0;
  if (group.byGroup) return match(group) ? group.lines : null;
  const lines = group.lines.filter(match);
  return lines.length ? lines : null;
}

/** Income has no "over" or "due later"; a line with no expected amount is still missing a budget. */
function visibleIncomeLines(group: BudgetGroup, filter: BudgetFilter): BudgetLine[] {
  if (filter === "all") return group.lines;
  return filter === "unbudgeted" ? group.lines.filter((l) => l.status === "unbudgeted") : [];
}

/**
 * How many lines each filter shows. "Not budgeted" counts income lines too,
 * because the filter lists them; the server's count is spending only (the web
 * page always shows its Income section).
 */
export function filterCounts(month: BudgetMonth): Record<Exclude<BudgetFilter, "all">, number> {
  const income = month.income.reduce((n, g) => n + visibleIncomeLines(g, "unbudgeted").length, 0);
  return {
    unbudgeted: month.counts.notBudgeted + income,
    over: month.counts.overspent,
    upcoming: month.counts.withUpcoming,
  };
}

export type BudgetSection = "income" | "debt" | "spending";

/** Which sections and groups are collapsed. Holds group names, so sign-out removes it. */
export const BUDGET_COLLAPSED_KEY = "pf_budget_collapsed";

export const sectionKey = (section: BudgetSection) => `section:${section}`;

export type ExcludedTarget = { key: string; label: string; note: string; target: BudgetSettingsTarget };

/** `first` / `last` round the corners of a block of rows. */
type InBlock = { first: boolean; last: boolean };

export type BudgetRow =
  | { kind: "summary" }
  | { kind: "section"; section: BudgetSection; title: string; actual: number; planned: number; collapsed: boolean; collapsible: boolean }
  | ({ kind: "group"; group: BudgetGroup; section: "income" | "spending"; collapsed: boolean; collapsible: boolean } & InBlock)
  | ({ kind: "line"; line: BudgetLine; section: "income" | "spending"; inGroupBudget: boolean } & InBlock)
  | ({ kind: "debt"; debt: DebtLine } & InBlock)
  | { kind: "debtNote" }
  | { kind: "excludedToggle"; count: number; open: boolean }
  | ({ kind: "excluded"; item: ExcludedTarget } & InBlock)
  | { kind: "empty"; message: string };

type BlockRow = Extract<BudgetRow, InBlock>;
type NewBlockRow = BlockRow extends infer R ? (R extends BlockRow ? Omit<R, "first" | "last"> : never) : never;

function pushBlock(rows: BudgetRow[], block: NewBlockRow[]) {
  block.forEach((r, i) => rows.push({ ...r, first: i === 0, last: i === block.length - 1 } as BudgetRow));
}

/** A group left out as a whole is brought back as a whole; its categories are not listed one by one. */
export function excludedTargets(month: BudgetMonth): ExcludedTarget[] {
  const groups = [...new Set(month.excluded.filter((e) => e.by === "group").map((e) => e.group))];
  return [
    ...groups.map((g) => ({ key: `group:${g}`, label: g || "Other", note: "Whole group", target: { group: g } })),
    ...month.excluded
      .filter((e) => e.by === "category")
      .map((e) => ({
        key: e.key,
        label: e.name,
        note: e.type === "I" ? "Income" : e.group || "Other",
        target: { categoryId: e.categoryId },
      })),
  ];
}

/**
 * The list, in the web page's order: income, debt payments, spending. A filter
 * narrows it to the lines it names and opens anything collapsed, since finding
 * those lines is what the filter is for.
 */
export function budgetRows(
  month: BudgetMonth,
  filter: BudgetFilter,
  collapsed: ReadonlySet<string>,
  excludedOpen: boolean,
): BudgetRow[] {
  const rows: BudgetRow[] = [{ kind: "summary" }];
  const all = filter === "all";
  const isCollapsed = (key: string) => all && collapsed.has(key);
  const { summary } = month;

  const income = month.income
    .map((group) => ({ group, lines: visibleIncomeLines(group, filter) }))
    .filter((x) => x.lines.length > 0);
  if (income.length > 0) {
    const closed = isCollapsed(sectionKey("income"));
    rows.push({
      kind: "section", section: "income", title: "Income",
      actual: summary.receivedIncome, planned: summary.plannedIncome, collapsed: closed, collapsible: all,
    });
    if (!closed) {
      for (const { group, lines } of income) {
        const block: NewBlockRow[] = [];
        // One income group needs no heading of its own: the section already says it.
        const headed = month.income.length > 1;
        const groupClosed = headed && isCollapsed(group.key);
        if (headed) block.push({ kind: "group", group, section: "income", collapsed: groupClosed, collapsible: all });
        if (!groupClosed) {
          for (const line of lines) block.push({ kind: "line", line, section: "income", inGroupBudget: false });
        }
        pushBlock(rows, block);
      }
    }
  }

  if (all && month.debt.length > 0) {
    const closed = isCollapsed(sectionKey("debt"));
    rows.push({
      kind: "section", section: "debt", title: "Debt payments",
      actual: summary.paidDebt, planned: summary.plannedDebt, collapsed: closed, collapsible: true,
    });
    if (!closed) {
      pushBlock(rows, month.debt.map((debt) => ({ kind: "debt", debt })));
      rows.push({ kind: "debtNote" });
    }
  }

  const spending = month.spending
    .map((group) => ({ group, lines: visibleLinesFor(group, filter) }))
    .filter((x): x is { group: BudgetGroup; lines: BudgetLine[] } => x.lines != null);
  if (spending.length > 0) {
    const closed = isCollapsed(sectionKey("spending"));
    rows.push({
      kind: "section", section: "spending", title: "Spending",
      actual: summary.spent, planned: summary.plannedSpending, collapsed: closed, collapsible: all,
    });
    if (!closed) {
      for (const { group, lines } of spending) {
        const groupClosed = isCollapsed(group.key);
        const block: NewBlockRow[] = [{ kind: "group", group, section: "spending", collapsed: groupClosed, collapsible: all }];
        if (!groupClosed) {
          for (const line of lines) block.push({ kind: "line", line, section: "spending", inGroupBudget: group.byGroup });
        }
        pushBlock(rows, block);
      }
    }
  }

  if (rows.length === 1) {
    rows.push({
      kind: "empty",
      message: all ? "No income or expense categories yet." : "Nothing to show for this filter this month.",
    });
  }

  if (all && month.excluded.length > 0) {
    rows.push({ kind: "excludedToggle", count: month.excluded.length, open: excludedOpen });
    if (excludedOpen) pushBlock(rows, excludedTargets(month).map((item) => ({ kind: "excluded", item })));
  }
  return rows;
}

/** What the budget sheet edits: one category, or one group budgeted as a single line. */
export interface BudgetTarget {
  key: string;
  name: string;
  section: "income" | "spending";
  categoryId: number | null;
  /** The group's stored name, for a group budgeted as one line. */
  group: string | null;
  /** A category inside a one-line group has no budget of its own. */
  inGroupBudget: boolean;
  budgeted: number | null;
  actual: number;
  average3: number;
  carriedIn: number | null;
  rollover: boolean;
  rolloverNegative: RolloverNegative;
  plan: LinePlan | null;
}

const lineTarget = (line: BudgetLine, section: "income" | "spending", inGroupBudget: boolean): BudgetTarget => ({
  key: line.key,
  name: line.name,
  section,
  categoryId: line.categoryId,
  group: null,
  inGroupBudget,
  budgeted: line.budgeted,
  actual: line.actual,
  average3: line.average3,
  carriedIn: line.carriedIn,
  rollover: line.rollover,
  rolloverNegative: line.rolloverNegative,
  plan: line.plan ?? null,
});

/**
 * Looked up from the month each time, so a setting saved from the sheet shows as
 * soon as the month reloads. Null once the line has gone (left out of the budget).
 */
export function findBudgetTarget(month: BudgetMonth, key: string): BudgetTarget | null {
  for (const g of month.income) {
    for (const l of g.lines) if (l.key === key) return lineTarget(l, "income", false);
  }
  for (const g of month.spending) {
    if (g.byGroup && g.key === key) {
      return {
        key: g.key,
        name: g.name,
        section: "spending",
        categoryId: null,
        group: g.key.slice(2),
        inGroupBudget: false,
        budgeted: g.budgeted,
        actual: g.actual,
        average3: g.average3,
        carriedIn: g.carriedIn,
        rollover: g.rollover,
        rolloverNegative: g.rolloverNegative,
        plan: g.plan ?? null,
      };
    }
    for (const l of g.lines) if (l.key === key) return lineTarget(l, "spending", g.byGroup);
  }
  return null;
}

/**
 * A typed budget: a number of 0 or more, empty to clear it, "invalid" otherwise.
 * A phone's decimal pad types a comma in many locales, so a comma before the last
 * one or two digits is the decimal point ("12,50" is 12.5, never 1250). Any other
 * comma separates thousands, as on the web.
 */
export function parseBudgetAmount(text: string): number | null | "invalid" {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const decimalComma = /^(.*),(\d{1,2})$/.exec(trimmed);
  const plain = decimalComma ? `${decimalComma[1].replace(/[.,]/g, "")}.${decimalComma[2]}` : trimmed.replace(/,/g, "");
  const n = Number(plain);
  return Number.isFinite(n) && n >= 0 ? n : "invalid";
}

export interface LeftToPlanView {
  label: string;
  /** Absent until there is expected income to plan. */
  amount: number | null;
  tone: BarTone | null;
  sentence: (fmt: (n: number) => string) => string;
}

/** The web page's "Left to plan" headline, for the summary's second block. */
export function leftToPlanView(s: Pick<BudgetSummary, "plannedIncome" | "leftToPlan">): LeftToPlanView {
  if (s.plannedIncome <= 0.005) {
    return {
      label: "Left to plan",
      amount: null,
      tone: null,
      sentence: () => "Set expected income to see how much of it is left to plan.",
    };
  }
  if (s.leftToPlan < -0.005) {
    return {
      label: "Over-planned",
      amount: -s.leftToPlan,
      tone: "over",
      sentence: (fmt) => `More planned than the ${fmt(s.plannedIncome)} you expect.`,
    };
  }
  if (s.leftToPlan <= 0.005) {
    return {
      label: "Left to plan",
      amount: 0,
      tone: "ok",
      sentence: (fmt) => `Every dollar of the ${fmt(s.plannedIncome)} you expect is planned.`,
    };
  }
  return {
    label: "Left to plan",
    amount: s.leftToPlan,
    tone: "ok",
    sentence: (fmt) => `Not planned yet, of the ${fmt(s.plannedIncome)} you expect.`,
  };
}

/**
 * What one row says, beside its name and under it. `state` marks the two rows
 * the screen draws differently (FINLYNQ-318): a line 95% or more spent gets an
 * "Almost spent" chip, and a line with no budget a dimmed name and a
 * "+ Set budget" button where its right-hand figure would be.
 */
export interface RowView {
  right: string | null;
  tone: BarTone | "muted";
  meta: string | null;
  bar: BarSpec | null;
  state?: "almost" | "unbudgeted";
}

const joinBits = (bits: Array<string | null>) => bits.filter(Boolean).join(" · ") || null;

/** Share of a line's money spent at which it reads "Almost spent" and turns amber. */
export const ALMOST_SPENT_AT = 0.95;

/** A category with its own budget, or a group budgeted as one line. */
export function spendingLineView(
  x: Pick<BudgetLine, "budgeted" | "actual" | "left" | "carriedIn" | "rollover" | "upcoming" | "average3" | "status">,
  currency: string,
): RowView {
  const fmt = (n: number) => formatWholeMoney(n, currency);
  const carried = x.rollover && x.carriedIn ? `carried in ${fmt(x.carriedIn)}` : null;
  const due = x.upcoming > 0 ? `${fmt(x.upcoming)} due later` : null;
  if (x.status === "unbudgeted" || x.left == null) {
    const spent = x.actual !== 0 ? `${fmt(x.actual)} spent` : null;
    const average = x.average3 > 0 ? `avg ${fmt(x.average3)}` : null;
    return { right: null, tone: "muted", meta: joinBits([spent, average, due]), bar: null, state: "unbudgeted" };
  }
  const amounts = x.budgeted != null ? `${fmt(x.actual)} of ${fmt(x.budgeted)}` : `${fmt(x.actual)} spent`;
  const over = x.left < -0.005;
  const bar = spendBar(x);
  const almost = !over && bar != null && bar.value / bar.target >= ALMOST_SPENT_AT;
  // The server's warn means bills still due are more than what is left.
  const tone: BarTone = over ? "over" : almost || x.status === "warn" ? "warn" : "ok";
  return {
    right: over ? `${fmt(-x.left)} over` : `${fmt(x.left)} left`,
    tone,
    meta: joinBits([amounts, carried, due]),
    bar: bar ? { ...bar, tone } : null,
    ...(almost ? { state: "almost" as const } : {}),
  };
}

export function incomeLineView(x: Pick<BudgetLine, "budgeted" | "actual" | "left" | "status">, currency: string): RowView {
  const fmt = (n: number) => formatWholeMoney(n, currency);
  if (x.budgeted == null) {
    return { right: null, tone: "muted", meta: x.actual !== 0 ? `${fmt(x.actual)} received` : null, bar: null, state: "unbudgeted" };
  }
  return {
    right: x.status === "received" ? "Received" : `${fmt(Math.max(0, x.left ?? 0))} to come`,
    tone: x.status === "received" ? "ok" : "muted",
    meta: `${fmt(x.actual)} of ${fmt(x.budgeted)}`,
    bar: x.budgeted > 0 ? { value: x.actual, target: x.budgeted, tone: "ok" } : null,
  };
}

/** A category inside a one-line group: what it spent, and no budget of its own. */
export function inGroupLineView(x: Pick<BudgetLine, "actual">, currency: string): RowView {
  return { right: formatWholeMoney(x.actual, currency), tone: "muted", meta: null, bar: null };
}

export function groupView(group: BudgetGroup, section: "income" | "spending", currency: string): RowView {
  if (group.byGroup) return spendingLineView(group, currency);
  const fmt = (n: number) => formatWholeMoney(n, currency);
  if (section === "income") {
    const meta = group.budgeted != null ? `${fmt(group.actual)} of ${fmt(group.budgeted)}` : group.actual !== 0 ? `${fmt(group.actual)} received` : null;
    return { right: null, tone: "muted", meta, bar: null };
  }
  // Left only counts the lines with a budget, while spent counts them all, so
  // the two amounts are named rather than written as "x of y".
  const spent = group.actual !== 0 ? `${fmt(group.actual)} spent` : null;
  const budgeted = group.budgeted != null ? `${fmt(group.budgeted)} budgeted` : null;
  const over = group.left != null && group.left < -0.005;
  return {
    right: group.left == null ? null : over ? `${fmt(-group.left)} over` : `${fmt(group.left)} left`,
    tone: over ? "over" : "ok",
    meta: joinBits([spent, budgeted]),
    bar: spendBar(group),
  };
}

export function debtView(d: DebtLine, today: string, currency: string): RowView {
  const fmt = (n: number) => formatWholeMoney(n, currency);
  const tone = DEBT_TONE[d.status];
  const interest = d.source === "schedule" && d.planned > 0 ? `${fmt(d.interest)} interest` : null;
  return {
    right: debtStatusLabel(d, today),
    tone: tone ?? "muted",
    meta: d.planned > 0 || d.paid !== 0 ? joinBits([`${fmt(d.paid)} of ${fmt(d.planned)}`, interest]) : "No payment scheduled this month",
    bar: d.planned > 0 ? { value: d.paid, target: d.planned, tone: tone ?? "ok" } : null,
  };
}

// ─── Budgets screen summary (FINLYNQ-318) ────────────────────────────────────

/** Whole percent of `actual` against `planned`; null when nothing is planned. */
export function percentOf(actual: number, planned: number): number | null {
  if (!(planned > 0.005)) return null;
  return Math.round((actual / planned) * 100);
}

export interface PaceView {
  tone: BarTone;
  label: string;
}

/** How far above an even pace spending may run before the chip turns red. */
export const PACE_WARN_BAND = 0.1;

/**
 * This month's spending against an even pace through the month. Expected
 * spend = planned × day / days in month. At or under it → ok ("On track"); above
 * it by up to 10% of the expected amount → warn; further above → over. Only for
 * the month in progress with something planned; past and future months have no
 * pace.
 */
export function spendingPace(
  planned: number,
  spent: number,
  progress: MonthProgress,
  fmt: (n: number) => string,
): PaceView | null {
  if (progress.state !== "current" || !(planned > 0.005) || progress.days <= 0) return null;
  const expected = (planned * progress.day) / progress.days;
  const ahead = spent - expected;
  if (ahead <= 0.005) return { tone: "ok", label: `On track · ${fmt(Math.max(0, -ahead))} under pace` };
  if (ahead <= expected * PACE_WARN_BAND) return { tone: "warn", label: `Close to pace · ${fmt(ahead)} over pace` };
  return { tone: "over", label: `Spending fast · ${fmt(ahead)} over pace` };
}

/**
 * Whether anything this month has a budget. The "Tap a line to set its budget"
 * hint only shows until the user has set one.
 */
export function hasAnyBudget(month: Pick<BudgetMonth, "summary" | "income" | "spending">): boolean {
  if (month.summary.plannedSpending > 0.005 || month.summary.plannedIncome > 0.005) return true;
  return [...month.income, ...month.spending].some(
    (g) => g.budgeted != null || g.lines.some((l) => l.budgeted != null),
  );
}

/** What a route-not-found looks like: `request()` reports a body-less 404 this way. */
export const isMissingRoute = (error: string | undefined) => error === "HTTP 404";
export const BUDGET_ROUTE_MISSING =
  "Budgets need a newer Finlynq server. Update the server this app connects to, then try again.";

// ─── Budget rules (web plan/budget-rules.md) ─────────────────────────────────
// Mirrors pf-app `src/lib/budgets/rules.ts` (describeIncrease) and the web
// budget-rows `ruleMade`; keep them in sync. The server works out every amount.

export interface RuleIncrease {
  mode: "percent" | "amount";
  value: number;
  every: "month" | "year";
  stepMonth?: number;
}

export interface BudgetRule {
  id: number;
  key: string;
  amount: number;
  currency: string;
  startMonth: string;
  endMonth: string | null;
  increase: RuleIncrease | null;
  /** The rule's amount in the first month shown, in the display currency. */
  fromMonthAmount: number | null;
}

/** GET /api/budgets/rules?key=&month= */
export interface LineRulesView {
  key: string;
  currency: string;
  /** The first month shown: the month asked for, or this month when that has ended. */
  from: string;
  rules: BudgetRule[];
  months: Array<{ month: string; fromRules: number; adjustment: number; override: boolean; total: number | null }>;
}

export interface BudgetRuleInput {
  amount: number;
  startMonth: string;
  endMonth: string | null;
  increase: RuleIncrease | null;
}

/** Rules make the month's budget: an open month a rule covers, or one set to "only this amount". */
export function ruleMade(plan: LinePlan | null | undefined): plan is LinePlan {
  return !!plan?.open && (plan.fromRules != null || plan.override);
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthName = (n: number) => MONTH_NAMES[(((n - 1) % 12) + 12) % 12];

/** "+3% every January", "\u2212$25 every month", or "" for no increase. */
export function describeIncrease(inc: RuleIncrease | null, formatAmount: (n: number) => string): string {
  if (!inc || !inc.value) return "";
  const sign = inc.value > 0 ? "+" : "\u2212";
  const size = inc.mode === "percent" ? `${Math.abs(inc.value)}%` : formatAmount(Math.abs(inc.value));
  const when = inc.every === "month" ? "every month" : `every ${monthName(inc.stepMonth ?? 1)}`;
  return `${sign}${size} ${when}`;
}

export function shortMonth(month: string): string {
  const [year, m] = month.split("-").map(Number);
  return `${MONTH_NAMES[m - 1].slice(0, 3)} ${year}`;
}

/** "Oct 2026 to Jul 2027" or "from Oct 2026, no end". */
export function ruleRange(startMonth: string, endMonth: string | null): string {
  return endMonth ? `${shortMonth(startMonth)} to ${shortMonth(endMonth)}` : `from ${shortMonth(startMonth)}, no end`;
}

/** `YYYY-MM` shifted by n months. */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

/**
 * A typed amount that may be negative (an adjustment): a number, empty for
 * none, "invalid" otherwise. Same comma rule as parseBudgetAmount.
 */
export function parseSignedAmount(text: string): number | null | "invalid" {
  const trimmed = text.trim();
  const negative = /^[-\u2212]/.test(trimmed);
  const parsed = parseBudgetAmount(negative ? trimmed.slice(1) : trimmed);
  if (parsed === "invalid") return "invalid";
  if (parsed == null) return negative ? "invalid" : null;
  return negative ? -parsed : parsed;
}
