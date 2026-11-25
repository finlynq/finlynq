/**
 * Forecast page helpers: "mostly blank" detection, turning on the History
 * layer to fill blanks (after the budget, before inflation), and the preview
 * the first-visit card shows. Pure.
 */
import { describe, it, expect } from "vitest";
import { baselineScenario, layerSchema } from "@/lib/forecast/config";
import { runForecast } from "@/lib/forecast/engine";
import {
  QUICK_FILL_LAYER_ID, hasHistoryFill, isMostlyBlank, quickFillPreview, valueableLines, withHistoryFill,
} from "@/lib/forecast/quick-fill";
import type { ForecastInputs } from "@/lib/forecast/types";

const HIST = ["2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"];

function inputs(over: Partial<ForecastInputs> = {}): ForecastInputs {
  return {
    inputsAsOf: "2026-12-10T12:00:00.000Z",
    today: "2026-12-10",
    startMonth: "2027-01",
    currency: "USD",
    maxHorizonMonths: 120,
    budgetHorizonEnd: "2029-11",
    lines: [
      { key: "c:1", label: "Salary", type: "income", group: "Pay" },
      { key: "c:2", label: "Groceries", type: "expense", group: "Food" },
      { key: "c:3", label: "Heating", type: "expense", group: "Home" },
      { key: "c:4", label: "Streaming", type: "expense", group: "Fun" },
      { key: "c:5", label: "Gifts", type: "expense", group: "Other" },
    ],
    budget: {
      "c:1": { months: { "2027-01": 5000, "2027-02": 5000 }, carryFrom: null, carryAmount: null },
      "c:2": { months: { "2027-01": 500, "2027-02": 500 }, carryFrom: null, carryAmount: null },
    },
    historyMonths: HIST,
    history: {
      "c:2": Object.fromEntries(HIST.map((m) => [m, 550])),
      "c:3": Object.fromEntries(HIST.map((m) => [m, 120])),
      "c:5": { "2026-11": 600 },
    },
    pastBudget: {},
    scheduled: {},
    loans: [],
    accounts: [{ id: 1, label: "Chequing", pool: "cash", balance: 1000 }],
    notes: [],
    leftOut: [],
    ...over,
  };
}

describe("withHistoryFill", () => {
  it("inserts a 12-month History fill right after the budget, before inflation", () => {
    const c = withHistoryFill(baselineScenario(2));
    expect(c.layers.map((l) => l.kind)).toEqual(["budget", "history", "growth"]);
    const h = c.layers[1];
    expect(h).toMatchObject({ id: QUICK_FILL_LAYER_ID, op: "fill", enabled: true });
    expect((h as { params: { lookbackMonths: number } }).params.lookbackMonths).toBe(12);
    expect(hasHistoryFill(c)).toBe(true);
  });

  it("switches an existing History layer back on instead of adding a second", () => {
    const base = baselineScenario(2);
    const off = layerSchema.parse({ id: "mine", kind: "history", label: "Mine", op: "fill", enabled: false, params: { lookbackMonths: 3 } });
    const c = withHistoryFill({ ...base, layers: [...base.layers, off] });
    expect(c.layers.filter((l) => l.kind === "history")).toHaveLength(1);
    expect(c.layers.find((l) => l.id === "mine")?.enabled).toBe(true);
  });

  it("returns the config unchanged when history already fills", () => {
    const once = withHistoryFill(baselineScenario(2));
    expect(withHistoryFill(once)).toBe(once);
  });

  it("goes first when there is no budget layer", () => {
    const c = withHistoryFill({ ...baselineScenario(2), layers: [] });
    expect(c.layers.map((l) => l.kind)).toEqual(["history"]);
  });
});

describe("isMostlyBlank + preview", () => {
  it("is mostly blank when half or more of the lines have no value, and the preview counts what history fills", () => {
    const i = inputs();
    const base = baselineScenario(2);
    const c = { ...base, assumptions: { ...base.assumptions, inflationPct: 0 } };
    const before = runForecast(i, c);
    expect(valueableLines(i)).toHaveLength(5);
    expect(before.blankLines.map((l) => l.key).sort()).toEqual(["c:3", "c:4", "c:5"]);
    expect(isMostlyBlank(i, c, before)).toBe(true);

    const filled = withHistoryFill(c);
    const after = runForecast(i, filled);
    expect(isMostlyBlank(i, filled, after)).toBe(false); // history on: never "mostly blank"
    const p = quickFillPreview(before, after);
    expect(p).toMatchObject({ filled: 2, blankBefore: 3, monthlyIncome: 5000 });
    expect(p.monthlySpending).toBeCloseTo(500 + 120 + 50, 6); // budget wins for groceries; gifts 600/12
  });

  it("is not mostly blank with fewer than 3 blank lines or under half", () => {
    const i = inputs({
      budget: {
        "c:1": { months: { "2027-01": 5000 }, carryFrom: null, carryAmount: null },
        "c:2": { months: { "2027-01": 500 }, carryFrom: null, carryAmount: null },
        "c:3": { months: { "2027-01": 100 }, carryFrom: null, carryAmount: null },
      },
    });
    const c = baselineScenario(2);
    expect(isMostlyBlank(i, c, runForecast(i, c))).toBe(false);
  });
});
