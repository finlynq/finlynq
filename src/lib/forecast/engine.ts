/**
 * runForecast = plan stage (layers.ts) + simulate stage (simulate.ts). Pure
 * and deterministic: the same inputs and settings always give the same
 * result, so the page can re-run it in the browser on every change and a
 * result can be saved as a snapshot and compared later (compare.ts).
 */
import {
  FORECAST_ENGINE_VERSION,
  FORECAST_RESULT_SCHEMA_VERSION,
  MAX_HORIZON_MONTHS,
  type ScenarioConfig,
} from "./config";
import { forecastMonths, planLines } from "./layers";
import { simulate } from "./simulate";
import type { ForecastInputs, ForecastResult, ForecastWarning } from "./types";

const round2 = (n: number) => Math.round(n * 100) / 100;

export function runForecast(
  inputs: ForecastInputs,
  config: ScenarioConfig,
  opts: { computedAt?: string } = {},
): ForecastResult {
  const horizon = Math.max(1, Math.min(config.horizonMonths, inputs.maxHorizonMonths, MAX_HORIZON_MONTHS));
  const months = forecastMonths(inputs.startMonth, horizon);
  const planned = planLines(inputs, config, months);
  const sim = simulate(inputs, config, months, planned);

  const lines = inputs.lines.map((l) => {
    const amounts: Array<number | null> =
      l.type === "debt" ? sim.debtLineAmounts.get(l.key) ?? months.map(() => 0) : planned.get(l.key) ?? months.map(() => null);
    const total = round2(amounts.reduce<number>((s, v) => s + (v ?? 0), 0));
    return { key: l.key, label: l.label, type: l.type, group: l.group, amounts, total };
  });

  const blankLines = lines
    .filter((l) => l.type !== "debt" && l.amounts.every((v) => v == null))
    .map((l) => ({ key: l.key, label: l.label, type: l.type }));

  const warnings: ForecastWarning[] = inputs.notes.map((message) => ({ code: "note", message }));
  const budgetLayerOn = config.layers.some((l) => l.kind === "budget" && l.enabled);
  const valued = lines.filter((l) => l.type !== "debt" && l.amounts.some((v) => v != null));
  if (budgetLayerOn && valued.length === 0) {
    warnings.push({ code: "no_budget", message: "Nothing to forecast for income and spending: none of your categories has a budget in these months. Add budgets, or add a layer that fills them." });
  }
  if (config.shortfall === "negative" && sim.balances.cash.some((v) => v < -0.01)) {
    const first = months[sim.balances.cash.findIndex((v) => v < -0.01)];
    warnings.push({ code: "cash_negative", message: `Cash goes below zero in ${first}. Choose "Sell investments to cover it" to model drawing on investments instead.` });
  }

  const rate = config.assumptions.inflationPct / 100;
  const deflator = months.map((_, i) => Math.pow(1 + rate, (i + 1) / 12));

  return {
    resultSchemaVersion: FORECAST_RESULT_SCHEMA_VERSION,
    engineVersion: FORECAST_ENGINE_VERSION,
    computedAt: opts.computedAt ?? new Date().toISOString(),
    inputsAsOf: inputs.inputsAsOf,
    currency: inputs.currency,
    startMonth: inputs.startMonth,
    months,
    assumptions: { ...config.assumptions },
    shortfall: config.shortfall,
    layers: config.layers.map((l) => ({ id: l.id, kind: l.kind, label: l.label, enabled: l.enabled })),
    lines,
    totals: sim.totals,
    opening: sim.opening,
    balances: sim.balances,
    loans: sim.loans,
    milestones: sim.milestones,
    warnings,
    deflator,
    blankLines,
  };
}

export type YearlyView = {
  years: string[];
  /** Per line: the year's total (null when every month of that year is blank). */
  lines: Array<{ key: string; label: string; type: string; group: string; amounts: Array<number | null>; total: number }>;
  totals: { income: number[]; expense: number[]; debtPayment: number[]; interest: number[]; net: number[] };
  /** Balances at the end of each year (or of the last forecast month in it). */
  balances: Record<keyof ForecastResult["balances"], number[]>;
  /** Deflator at each year's last month. */
  deflator: number[];
};

/** Calendar-year roll-up of a result (flows summed, balances at year end). */
export function yearlyView(result: ForecastResult): YearlyView {
  const yearIdx = new Map<string, number[]>();
  result.months.forEach((m, i) => {
    const y = m.slice(0, 4);
    yearIdx.set(y, [...(yearIdx.get(y) ?? []), i]);
  });
  const years = [...yearIdx.keys()];
  const sumOf = (arr: number[], idx: number[]) => round2(idx.reduce((s, i) => s + arr[i], 0));
  const sumNullable = (arr: Array<number | null>, idx: number[]) =>
    idx.every((i) => arr[i] == null) ? null : round2(idx.reduce((s, i) => s + (arr[i] ?? 0), 0));
  const last = (idx: number[]) => idx[idx.length - 1];
  const t = result.totals;
  const b = result.balances;
  return {
    years,
    lines: result.lines.map((l) => ({ ...l, amounts: years.map((y) => sumNullable(l.amounts, yearIdx.get(y)!)) })),
    totals: {
      income: years.map((y) => sumOf(t.income, yearIdx.get(y)!)),
      expense: years.map((y) => sumOf(t.expense, yearIdx.get(y)!)),
      debtPayment: years.map((y) => sumOf(t.debtPayment, yearIdx.get(y)!)),
      interest: years.map((y) => sumOf(t.interest, yearIdx.get(y)!)),
      net: years.map((y) => sumOf(t.net, yearIdx.get(y)!)),
    },
    balances: {
      cash: years.map((y) => b.cash[last(yearIdx.get(y)!)]),
      investments: years.map((y) => b.investments[last(yearIdx.get(y)!)]),
      otherAssets: years.map((y) => b.otherAssets[last(yearIdx.get(y)!)]),
      loans: years.map((y) => b.loans[last(yearIdx.get(y)!)]),
      otherLiabilities: years.map((y) => b.otherLiabilities[last(yearIdx.get(y)!)]),
      netWorth: years.map((y) => b.netWorth[last(yearIdx.get(y)!)]),
    },
    deflator: years.map((y) => result.deflator[last(yearIdx.get(y)!)]),
  };
}
