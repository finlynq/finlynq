/**
 * Forecast Phase 2 layers (history, budget realism, scheduled) and variants
 * (a variant stores only its differences from its parent). Pure.
 */
import { describe, it, expect } from "vitest";
import { baselineScenario, scenarioConfigSchema, type ScenarioConfig } from "@/lib/forecast/config";
import { runForecast } from "@/lib/forecast/engine";
import { traceCell } from "@/lib/forecast/layers";
import { applyPatch, diffFromParent, isEmptyPatch, resolveDoc } from "@/lib/forecast/variants";
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
      // Heating: 300 in Dec-Feb, 50 the rest of the year.
      "c:3": Object.fromEntries(HIST.map((m) => [m, ["12", "01", "02"].includes(m.slice(5)) ? 300 : 50])),
      "c:5": { "2026-11": 600 },
    },
    pastBudget: { "c:2": Object.fromEntries(HIST.slice(-6).map((m) => [m, 500])) },
    scheduled: { "c:4": { "2027-01": 15, "2027-02": 15 }, "c:2": { "2027-01": 20 } },
    loans: [],
    accounts: [{ id: 1, label: "Chequing", pool: "cash", balance: 1000 }],
    notes: [],
    leftOut: [],
    ...over,
  };
}

const layer = (l: object) => l as never;
const cfg = (layers: object[]): ScenarioConfig =>
  scenarioConfigSchema.parse({ horizonMonths: 2, assumptions: { inflationPct: 0, investmentReturnPct: 0, otherAssetGrowthPct: 0 }, layers });
const amountsOf = (c: ScenarioConfig, i = inputs()) => Object.fromEntries(runForecast(i, c).lines.map((l) => [l.key, l.amounts]));

describe("history layer", () => {
  it("fills lines with no budget from the average, leaves budgeted and history-less lines alone", () => {
    const a = amountsOf(cfg([
      { id: "budget", kind: "budget", label: "Budget", op: "fill" },
      layer({ id: "hist", kind: "history", label: "History", op: "fill", params: { lookbackMonths: 6 } }),
    ]));
    expect(a["c:2"]).toEqual([500, 500]); // budget wins (fill)
    expect(a["c:3"]).toEqual([50, 50]); // Jun-Nov average = 50
    expect(a["c:4"]).toEqual([null, null]); // no history: stays blank
    expect(a["c:5"]).toEqual([100, 100]); // 600 in one of 6 months
  });

  it("median and seasonal options", () => {
    const median = amountsOf(cfg([layer({ id: "h", kind: "history", label: "H", op: "set", params: { lookbackMonths: 12, method: "median" } })]));
    expect(median["c:5"]).toEqual([0, 0]); // 600 once in 12 months: median 0
    const seasonal = amountsOf(cfg([layer({ id: "h", kind: "history", label: "H", op: "set", params: { lookbackMonths: 12, seasonal: true } })]));
    expect(seasonal["c:3"]).toEqual([300, 300]); // January and February last year
  });

  it("inflation grows history amounts from the forecast start, never typed budgets", () => {
    const c = scenarioConfigSchema.parse({
      horizonMonths: 12,
      assumptions: { inflationPct: 12, investmentReturnPct: 0, otherAssetGrowthPct: 0 },
      layers: [
        { id: "budget", kind: "budget", label: "Budget", op: "fill" },
        { id: "hist", kind: "history", label: "History", op: "fill", params: { lookbackMonths: 6 } },
        { id: "inflation", kind: "growth", label: "Inflation", op: "grow", params: { ratePct: null, appliesTo: "carried" } },
      ],
    });
    const a = amountsOf(c);
    expect(a["c:2"][0]).toBe(500);
    expect(a["c:3"][0]).toBeCloseTo(50 * Math.pow(1.12, 1 / 12), 2);
    expect(a["c:3"][11]).toBeCloseTo(50 * 1.12, 2);
  });
});

describe("budget realism layer", () => {
  it("scales a budget by actual ÷ budget in recent months", () => {
    const c = cfg([
      { id: "budget", kind: "budget", label: "Budget", op: "fill" },
      layer({ id: "real", kind: "budget_realism", label: "Realism", op: "scale", params: { lookbackMonths: 6 } }),
    ]);
    expect(amountsOf(c)["c:2"]).toEqual([550, 550]); // 550 spent vs 500 budgeted
    const steps = traceCell(inputs(), c, "c:2", "2027-01");
    expect(steps[1]).toMatchObject({ before: 500, after: 550, detail: "actual was 110% of budget over 6 months" });
  });

  it("leaves a line alone without enough budgeted months", () => {
    const c = cfg([
      { id: "budget", kind: "budget", label: "Budget", op: "fill" },
      layer({ id: "real", kind: "budget_realism", label: "Realism", op: "scale", params: { lookbackMonths: 6, minMonths: 7 } }),
    ]);
    expect(amountsOf(c)["c:2"]).toEqual([500, 500]);
    expect(amountsOf(c)["c:1"]).toEqual([5000, 5000]); // no past budget at all
  });
});

describe("scheduled layer", () => {
  it("floors lines at what is scheduled and fills unbudgeted ones", () => {
    const a = amountsOf(cfg([
      { id: "budget", kind: "budget", label: "Budget", op: "fill" },
      layer({ id: "sched", kind: "scheduled", label: "Scheduled", op: "floor" }),
    ]));
    expect(a["c:4"]).toEqual([15, 15]);
    expect(a["c:2"]).toEqual([500, 500]); // 500 budget > 20 scheduled
  });
});

describe("variants", () => {
  const parent = baselineScenario(60);

  it("round-trips: diff then apply gives back the edited config", () => {
    const edited: ScenarioConfig = scenarioConfigSchema.parse({
      ...parent,
      horizonMonths: 120,
      assumptions: { ...parent.assumptions, investmentReturnPct: 7 },
      layers: [
        parent.layers[1], // reordered
        { ...parent.layers[0], enabled: false },
        { id: "hist", kind: "history", label: "History", op: "fill", params: { lookbackMonths: 12 } },
      ],
    });
    const patch = diffFromParent(parent, edited);
    expect(patch.horizonMonths).toBe(120);
    expect(patch.assumptions).toEqual({ investmentReturnPct: 7 });
    expect(Object.keys(patch.layerOverrides)).toEqual(["budget"]);
    expect(patch.addedLayers.map((l) => l.id)).toEqual(["hist"]);
    expect(patch.order).toEqual(["inflation", "budget", "hist"]);
    expect(applyPatch(parent, patch)).toEqual(edited);
  });

  it("an unchanged variant has an empty patch, and parent changes flow through", () => {
    expect(isEmptyPatch(diffFromParent(parent, parent))).toBe(true);
    const patch = diffFromParent(parent, { ...parent, assumptions: { ...parent.assumptions, inflationPct: 3 } });
    const changedParent = { ...parent, assumptions: { ...parent.assumptions, investmentReturnPct: 9 } };
    expect(applyPatch(changedParent, patch).assumptions).toMatchObject({ inflationPct: 3, investmentReturnPct: 9 });
  });

  it("removing a parent layer is remembered", () => {
    const edited = { ...parent, layers: [parent.layers[0]] };
    const patch = diffFromParent(parent, edited);
    expect(patch.removedLayerIds).toEqual(["inflation"]);
    expect(applyPatch(parent, patch).layers.map((l) => l.id)).toEqual(["budget"]);
  });

  it("resolves variants of variants and survives cycles and missing parents", () => {
    const docs = new Map<number, Parameters<typeof resolveDoc>[0]>([
      [1, { kind: "variant", parent: { type: "builtin" }, patch: diffFromParent(parent, { ...parent, horizonMonths: 120 }) }],
      [2, { kind: "variant", parent: { type: "scenario", id: 1 }, patch: diffFromParent(parent, { ...parent, shortfall: "draw_investments" }) }],
      [3, { kind: "variant", parent: { type: "scenario", id: 3 }, patch: diffFromParent(parent, parent) }],
      [4, { kind: "variant", parent: { type: "scenario", id: 99 }, patch: diffFromParent(parent, parent) }],
    ]);
    const lookup = (id: number) => docs.get(id) ?? null;
    expect(resolveDoc(docs.get(2)!, lookup)).toMatchObject({ horizonMonths: 120, shortfall: "draw_investments" });
    expect(resolveDoc(docs.get(3)!, lookup)).toEqual(parent);
    expect(resolveDoc(docs.get(4)!, lookup)).toEqual(parent);
  });
});
