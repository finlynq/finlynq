/**
 * The plan stage (plan/forecast-scenarios.md section 5): for every line and
 * month, fold the scenario's enabled layers top to bottom. Pure.
 *
 * A cell starts as "no value" (null). Each layer that applies (enabled, in
 * scope, inside its from/to window) combines with the value so far:
 *   fill  value so far, or this layer's where there is none
 *   set   this layer's value
 *   add   so far + amount (blank counts as 0)   scale  so far × amount (blank stays blank)
 *   floor max(so far, amount) (blank → amount)  cap    min(so far, amount) (blank stays blank)
 *   grow  so far × (1 + rate)^(months / 12)
 * A blank cell stays blank unless a layer gives it a value (owner decision
 * 2026-11-25: a line with no budget stays blank in the budget layer).
 * Debt lines are never touched by layers: their amounts come from the loan
 * schedule in the simulate stage.
 */
import type { ForecastLayer, ScenarioConfig } from "./config";
import type { ForecastInputs, ForecastLineDef, TraceStep } from "./types";

export function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

export function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

export function forecastMonths(startMonth: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => shiftMonth(startMonth, i));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Does this layer apply to this line at all (ignoring the month)? */
export function layerTouchesLine(layer: ForecastLayer, line: ForecastLineDef): boolean {
  if (line.type === "debt") return false;
  const s = layer.scope ?? {};
  if (s.lineTypes?.length && !s.lineTypes.includes(line.type as "income" | "expense")) return false;
  if (s.lineKeys?.length && !s.lineKeys.includes(line.key)) return false;
  if (s.groups?.length && !s.groups.includes(line.group)) return false;
  return true;
}

function inWindow(layer: ForecastLayer, month: string): boolean {
  if (layer.from && month < layer.from) return false;
  if (layer.to && month > layer.to) return false;
  return true;
}

type CellState = {
  value: number | null;
  /** Month the budget started carrying, when this cell's value is a carried budget. */
  carriedFrom: string | null;
};

/** The budget layer's own value for a cell (before combining), and whether it was carried. */
function budgetValue(
  inputs: ForecastInputs,
  layer: Extract<ForecastLayer, { kind: "budget" }>,
  key: string,
  month: string,
): { value: number | null; carriedFrom: string | null; detail: string } {
  const series = inputs.budget[key];
  if (!series) return { value: null, carriedFrom: null, detail: "no budget" };
  const v = series.months[month];
  if (v != null) return { value: v, carriedFrom: null, detail: "budget" };
  if (
    layer.params.carryForwardBeyondHorizon &&
    series.carryFrom &&
    series.carryAmount != null &&
    month > series.carryFrom
  ) {
    return { value: series.carryAmount, carriedFrom: series.carryFrom, detail: `budget of ${series.carryFrom} carried forward` };
  }
  return { value: null, carriedFrom: null, detail: "no budget this month" };
}

function combine(op: string, before: number | null, amount: number | null): number | null {
  switch (op) {
    case "fill":
      return before ?? amount;
    case "set":
      return amount;
    // add / floor on a blank cell give the amount (explicit money);
    // scale / cap on a blank cell keep it blank (nothing to scale or cap).
    case "add":
      return amount == null ? before : (before ?? 0) + amount;
    case "scale":
      return before == null ? before : before * (amount ?? 1);
    case "floor":
      return amount == null ? before : before == null ? amount : Math.max(before, amount);
    case "cap":
      return before == null ? before : Math.min(before, amount ?? before);
    default:
      return before;
  }
}

/**
 * One cell through the stack. `trace` collects the steps when given (the page
 * asks for one cell at a time; the engine passes none).
 */
export function foldCell(
  inputs: ForecastInputs,
  config: ScenarioConfig,
  line: ForecastLineDef,
  month: string,
  trace?: TraceStep[],
): number | null {
  const cell: CellState = { value: null, carriedFrom: null };
  for (const layer of config.layers) {
    if (!layer.enabled || !layerTouchesLine(layer, line) || !inWindow(layer, month)) continue;
    const before = cell.value;
    let detail: string | undefined;
    if (layer.kind === "budget") {
      const b = budgetValue(inputs, layer, line.key, month);
      detail = b.detail;
      const next = combine(layer.op, before, b.value);
      // Remember carrying only when the budget layer is where the value came from.
      if (next !== before) cell.carriedFrom = b.carriedFrom;
      cell.value = next;
    } else if (layer.kind === "growth") {
      if (before == null) continue;
      const rate = (layer.params.ratePct ?? config.assumptions.inflationPct) / 100;
      let base: string | null;
      if (layer.params.appliesTo === "carried") base = cell.carriedFrom;
      else base = layer.from ?? shiftMonth(inputs.startMonth, -1);
      if (!base) {
        detail = "not a carried budget";
      } else {
        const n = Math.max(0, monthsBetween(base, month));
        cell.value = before * Math.pow(1 + rate, n / 12);
        detail = `${(rate * 100).toFixed(2)}% a year for ${n} month${n === 1 ? "" : "s"}`;
      }
    } else {
      cell.value = combine(layer.op, before, layer.params.amount);
    }
    if (cell.value != null && !Number.isFinite(cell.value)) cell.value = null;
    trace?.push({
      layerId: layer.id,
      label: layer.label || layer.kind,
      op: layer.op,
      before: before == null ? null : round2(before),
      after: cell.value == null ? null : round2(cell.value),
      detail,
    });
  }
  return cell.value == null ? null : round2(cell.value);
}

/** Every line × month amount for the plan stage. */
export function planLines(
  inputs: ForecastInputs,
  config: ScenarioConfig,
  months: readonly string[],
): Map<string, Array<number | null>> {
  const out = new Map<string, Array<number | null>>();
  for (const line of inputs.lines) {
    if (line.type === "debt") continue;
    out.set(line.key, months.map((m) => foldCell(inputs, config, line, m)));
  }
  return out;
}

/** The steps behind one cell, for "why is this number". */
export function traceCell(inputs: ForecastInputs, config: ScenarioConfig, key: string, month: string): TraceStep[] {
  const line = inputs.lines.find((l) => l.key === key);
  if (!line) return [];
  const steps: TraceStep[] = [];
  foldCell(inputs, config, line, month, steps);
  return steps;
}
