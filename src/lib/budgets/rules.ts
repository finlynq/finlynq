/**
 * Budget rules (plan/budget-rules.md). Pure and client-safe: the amount a rule
 * gives a month, a line's month from its rules plus what was typed, which old
 * rules a new one ends, and the words for an increase.
 *
 * A month's stored row keeps the WHOLE budget in `amount` (every reader reads
 * that) and the part that came from rules in `rulesAmount`, so the typed part
 * (the adjustment) is `amount - rulesAmount`. Only the current and later
 * months are ever recomputed; a month that has ended keeps its value.
 */
import { shiftMonth } from "./lines";

export interface RuleIncrease {
  mode: "percent" | "amount";
  /** Percent as a number (3 = +3%) or an amount; negative lowers. */
  value: number;
  every: "month" | "year";
  /** 1-12, the month a yearly step lands in. Default 1 (January). */
  stepMonth?: number;
}

export interface RuleShape {
  amount: number;
  currency: string;
  startMonth: string;
  endMonth: string | null;
  increase: RuleIncrease | null;
}

export interface BudgetRuleView extends RuleShape {
  id: number;
  key: string;
}

/** The stored row of one line for one month. */
export interface StoredMonth {
  amount: number;
  rulesAmount: number | null;
  override: boolean;
}

/** How many months `to` is after `from` (negative when before). */
export function monthsAfter(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

export const isRuleActive = (rule: Pick<RuleShape, "startMonth" | "endMonth">, month: string): boolean =>
  month >= rule.startMonth && (rule.endMonth == null || month <= rule.endMonth);

/**
 * How many increases a rule has had by `month`. A rule never steps in its own
 * start month: every month = months since the start; every year = how many
 * times the step month came round after the start, up to `month`.
 */
export function increaseSteps(rule: Pick<RuleShape, "startMonth" | "increase">, month: string): number {
  const inc = rule.increase;
  if (!inc || !Number.isFinite(inc.value) || inc.value === 0) return 0;
  const k = monthsAfter(rule.startMonth, month);
  if (k <= 0) return 0;
  if (inc.every === "month") return k;
  const step = inc.stepMonth ?? 1;
  // Months after the start until the first step month, then one per year.
  const startM = Number(rule.startMonth.slice(5, 7));
  const first = ((step - startM + 12) % 12) || 12;
  return k < first ? 0 : 1 + Math.floor((k - first) / 12);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The rule's amount for `month` in the rule's own currency, or null when it isn't active then. */
export function ruleAmountForMonth(rule: RuleShape, month: string): number | null {
  if (!isRuleActive(rule, month)) return null;
  const steps = increaseSteps(rule, month);
  if (!steps || !rule.increase) return round2(rule.amount);
  const v = rule.increase.value;
  const out = rule.increase.mode === "percent" ? rule.amount * Math.pow(1 + v / 100, steps) : rule.amount + v * steps;
  return round2(Math.max(0, out));
}

/** Sum of a line's active rules for `month`, converted with `convert(amount, currency)`. */
export function rulesTotalForMonth(
  rules: readonly RuleShape[],
  month: string,
  convert: (amount: number, currency: string) => number,
): { total: number; active: number } {
  let total = 0;
  let active = 0;
  for (const r of rules) {
    const a = ruleAmountForMonth(r, month);
    if (a == null) continue;
    total += convert(a, r.currency);
    active++;
  }
  return { total: round2(total), active };
}

/** The adjustment (typed part) of a stored month. */
export const adjustmentOf = (row: StoredMonth): number => (row.override ? 0 : round2(row.amount - (row.rulesAmount ?? 0)));

/**
 * What an OPEN month's row should be, given its stored row (in the same
 * currency as `rulesTotal`) and its rules. Returns:
 *   undefined - leave the row as it is
 *   null      - delete the row (it only existed because of rules)
 *   a row     - write it
 */
export function nextOpenMonth(row: StoredMonth | null, rulesTotal: number, activeRules: number): StoredMonth | null | undefined {
  if (row?.override) return undefined;
  if (activeRules === 0) {
    if (!row || row.rulesAmount == null) return undefined;
    const adj = adjustmentOf(row);
    return Math.abs(adj) < 0.005 ? null : { amount: adj, rulesAmount: null, override: false };
  }
  const adj = row ? adjustmentOf(row) : 0;
  const next = { amount: round2(rulesTotal + adj), rulesAmount: round2(rulesTotal), override: false };
  if (row && Math.abs(row.amount - next.amount) < 0.005 && row.rulesAmount != null && Math.abs(row.rulesAmount - next.rulesAmount) < 0.005) {
    return undefined;
  }
  return next;
}

/** A month's budget computed on the fly (beyond what is stored): what `nextOpenMonth` would store. */
export function computedMonthTotal(row: StoredMonth | null, rulesTotal: number, activeRules: number): number | null {
  const next = nextOpenMonth(row, rulesTotal, activeRules);
  if (next === undefined) return row ? row.amount : null;
  return next ? next.amount : null;
}

/**
 * The line's existing rules a new rule from `start` (to `end`, or for good)
 * replaces: an overlapping rule that started earlier ends the month before
 * `start`; one starting inside the new rule's months is removed.
 */
export function planRuleReplacement(
  existing: ReadonlyArray<Pick<BudgetRuleView, "id" | "startMonth" | "endMonth">>,
  start: string,
  end: string | null,
): { end: Array<{ id: number; endMonth: string }>; remove: number[] } {
  const out = { end: [] as Array<{ id: number; endMonth: string }>, remove: [] as number[] };
  for (const r of existing) {
    const overlaps = (r.endMonth == null || r.endMonth >= start) && (end == null || r.startMonth <= end);
    if (!overlaps) continue;
    if (r.startMonth < start) out.end.push({ id: r.id, endMonth: shiftMonth(start, -1) });
    else out.remove.push(r.id);
  }
  return out;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "+3% every January", "+25 every month", or "" for no increase. */
export function describeIncrease(inc: RuleIncrease | null, formatAmount: (n: number) => string): string {
  if (!inc || !inc.value) return "";
  const sign = inc.value > 0 ? "+" : "−";
  const size = inc.mode === "percent" ? `${Math.abs(inc.value)}%` : formatAmount(Math.abs(inc.value));
  const when = inc.every === "month" ? "every month" : `every ${MONTH_NAMES[(inc.stepMonth ?? 1) - 1]}`;
  return `${sign}${size} ${when}`;
}
