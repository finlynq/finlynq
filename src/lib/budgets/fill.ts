/**
 * Filling budgets: one action for "copy last month", "use the 3-month
 * average", "copy into next year with +3% from January", etc. Pure.
 *
 * Every source is read relative to the BASE month, the month before the first
 * target month, except `same_month_last_year`, which reads 12 months before
 * each target month. The adjustment then applies per target month:
 *   once  — the same change on every target month
 *   month — compounding: the k-th target month (0-based) gets it k+1 times
 *   year  — once for each `stepMonth` (default January) passed since the base
 * `overwrite: false` fills only months that have no budget yet.
 */
import { shiftMonth } from "./lines";

export type FillSource =
  | { kind: "budget" }
  | { kind: "spent" }
  | { kind: "average"; months: number }
  | { kind: "same_month_last_year" }
  | { kind: "fixed"; amount: number };

export interface FillAdjust {
  mode: "percent" | "amount";
  /** Percent as a number (3 = +3%); negative lowers. */
  value: number;
  every: "once" | "month" | "year";
  /** 1–12; the month a yearly step lands in. Default 1 (January). */
  stepMonth?: number;
}

export interface FillLine {
  key: string;
  /** Budget per month (display currency); absent = none. */
  budgets: Readonly<Record<string, number>>;
  /** Spent per month (display currency, positive = out). */
  spent: Readonly<Record<string, number>>;
}

export interface FillPlanRow {
  key: string;
  month: string;
  amount: number;
  previous: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export const baseMonthOf = (months: readonly string[]): string => shiftMonth(months[0], -1);

/** The unadjusted amount a line gets for one target month, or null to skip. */
export function sourceAmount(
  line: FillLine,
  source: FillSource,
  baseMonth: string,
  target: string,
  lastCompleteMonth: string,
): number | null {
  switch (source.kind) {
    case "budget":
      return line.budgets[baseMonth] ?? null;
    case "spent": {
      const v = line.spent[baseMonth] ?? 0;
      return v > 0 ? v : null;
    }
    case "average": {
      const n = Math.max(1, Math.min(24, Math.round(source.months)));
      const end = baseMonth < lastCompleteMonth ? baseMonth : lastCompleteMonth;
      let sum = 0;
      for (let i = 0; i < n; i++) sum += line.spent[shiftMonth(end, -i)] ?? 0;
      const avg = sum / n;
      return avg > 0 ? avg : null;
    }
    case "same_month_last_year": {
      const ly = shiftMonth(target, -12);
      const b = line.budgets[ly];
      if (b != null) return b;
      const s = line.spent[ly] ?? 0;
      return s > 0 ? s : null;
    }
    case "fixed":
      return Number.isFinite(source.amount) && source.amount >= 0 ? source.amount : null;
  }
}

/** How many times `stepMonth` (1–12) is passed after `baseMonth`, up to and including `target`. */
export function yearlySteps(baseMonth: string, target: string, stepMonth = 1): number {
  let steps = 0;
  for (let m = shiftMonth(baseMonth, 1); m <= target; m = shiftMonth(m, 1)) {
    if (Number(m.slice(5, 7)) === stepMonth) steps++;
  }
  return steps;
}

export function applyAdjust(base: number, adjust: FillAdjust | null | undefined, k: number, baseMonth: string, target: string): number {
  if (!adjust || !Number.isFinite(adjust.value) || adjust.value === 0) return base;
  const times =
    adjust.every === "once" ? 1 : adjust.every === "month" ? k + 1 : yearlySteps(baseMonth, target, adjust.stepMonth ?? 1);
  if (times === 0) return base;
  const out = adjust.mode === "percent" ? base * Math.pow(1 + adjust.value / 100, times) : base + adjust.value * times;
  return Math.max(0, out);
}

export function planFill(opts: {
  lines: readonly FillLine[];
  months: readonly string[];
  source: FillSource;
  adjust?: FillAdjust | null;
  overwrite: boolean;
  lastCompleteMonth: string;
}): FillPlanRow[] {
  const months = [...opts.months].sort();
  if (!months.length) return [];
  const baseMonth = baseMonthOf(months);
  const out: FillPlanRow[] = [];
  for (const line of opts.lines) {
    months.forEach((month, k) => {
      const previous = line.budgets[month] ?? null;
      if (!opts.overwrite && previous != null) return;
      const base = sourceAmount(line, opts.source, baseMonth, month, opts.lastCompleteMonth);
      if (base == null) return;
      out.push({ key: line.key, month, amount: round2(applyAdjust(base, opts.adjust, k, baseMonth, month)), previous });
    });
  }
  return out;
}
