/**
 * Page helpers for the "your forecast is mostly blank" start and the
 * "Fill blanks from my history" button (pure, browser-safe).
 *
 * Both just turn on the existing History layer (op `fill`, so budgets still
 * win and a line with no history stays blank). It goes right after the budget
 * layer so the scenario's inflation layer grows it like a carried amount.
 */
import { layerSchema, type ScenarioConfig } from "./config";
import type { ForecastInputs, ForecastResult } from "./types";

export const QUICK_FILL_LAYER_ID = "history-fill";
export const QUICK_FILL_LOOKBACK = 12;

/** True when some enabled History layer fills blanks already. */
export function hasHistoryFill(config: ScenarioConfig): boolean {
  return config.layers.some((l) => l.kind === "history" && l.enabled);
}

/**
 * The config with blanks filled from the last `lookback` months: an existing
 * (switched-off) History layer is switched on, else a new one is inserted
 * after the first budget layer (or first, when there is none).
 */
export function withHistoryFill(config: ScenarioConfig, lookback = QUICK_FILL_LOOKBACK): ScenarioConfig {
  if (hasHistoryFill(config)) return config;
  const existing = config.layers.findIndex((l) => l.kind === "history");
  if (existing >= 0) {
    return { ...config, layers: config.layers.map((l, i) => (i === existing ? { ...l, enabled: true } : l)) };
  }
  const layer = layerSchema.parse({
    id: QUICK_FILL_LAYER_ID,
    kind: "history",
    label: "Your history",
    op: "fill",
    params: { lookbackMonths: lookback, method: "average", seasonal: false },
  });
  const budgetAt = config.layers.findIndex((l) => l.kind === "budget");
  const layers = [...config.layers];
  layers.splice(budgetAt + 1, 0, layer);
  return { ...config, layers };
}

/** Income and spending lines the forecast could value (debt and event lines excluded). */
export function valueableLines(inputs: ForecastInputs) {
  return inputs.lines.filter((l) => l.type === "income" || l.type === "expense");
}

/**
 * "Mostly blank": at least 3 income/spending lines and at least half of them
 * have no value anywhere in the forecast, with no History layer filling them.
 */
export function isMostlyBlank(inputs: ForecastInputs, config: ScenarioConfig, result: ForecastResult): boolean {
  if (hasHistoryFill(config)) return false;
  const total = valueableLines(inputs).length;
  const blank = result.blankLines.length;
  return blank >= 3 && blank * 2 >= total;
}

export type QuickFillPreview = {
  /** Lines that were blank and get a value from history. */
  filled: number;
  /** Lines blank before. */
  blankBefore: number;
  /** First forecast month's income and spending with history filling blanks. */
  monthlyIncome: number;
  monthlySpending: number;
};

/** What turning on history would change, from a run of the filled config. */
export function quickFillPreview(before: ForecastResult, after: ForecastResult): QuickFillPreview {
  const stillBlank = new Set(after.blankLines.map((l) => l.key));
  const filled = before.blankLines.filter((l) => !stillBlank.has(l.key)).length;
  return {
    filled,
    blankBefore: before.blankLines.length,
    monthlyIncome: after.totals.income[0] ?? 0,
    monthlySpending: after.totals.expense[0] ?? 0,
  };
}
