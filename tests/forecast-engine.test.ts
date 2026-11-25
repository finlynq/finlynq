/**
 * Forecast Phase 1 engine (plan/forecast-scenarios.md): the layer stack, the
 * money rules in the simulate stage, milestones, the versioned result, the
 * yearly view and compareResults. Pure; no database.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { baselineScenario, scenarioConfigSchema, FORECAST_RESULT_SCHEMA_VERSION, FORECAST_ENGINE_VERSION, type ScenarioConfig } from "@/lib/forecast/config";
import { runForecast, yearlyView } from "@/lib/forecast/engine";
import { traceCell, shiftMonth, monthsBetween } from "@/lib/forecast/layers";
import { compareResults } from "@/lib/forecast/compare";
import type { ForecastInputs } from "@/lib/forecast/types";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

function inputs(over: Partial<ForecastInputs> = {}): ForecastInputs {
  return {
    inputsAsOf: "2026-11-25T12:00:00.000Z",
    today: "2026-11-25",
    startMonth: "2026-12",
    currency: "USD",
    maxHorizonMonths: 120,
    budgetHorizonEnd: "2029-10",
    lines: [
      { key: "c:1", label: "Salary", type: "income", group: "Pay" },
      { key: "c:2", label: "Groceries", type: "expense", group: "Food" },
      { key: "c:3", label: "Dining", type: "expense", group: "Food" },
      { key: "debt:9", label: "Car loan", type: "debt", group: "Debt payments" },
    ],
    budget: {
      "c:1": { months: { "2026-12": 5000, "2027-01": 5000, "2027-02": 5000 }, carryFrom: null, carryAmount: null },
      "c:2": { months: { "2026-12": 600, "2027-01": 600 }, carryFrom: null, carryAmount: null },
    },
    loans: [
      {
        accountId: 9,
        label: "Car loan",
        openingBalance: 1000,
        balanceSource: "account",
        fixedPayment: null,
        months: {
          "2026-12": { payment: 510, interest: 10, principal: 500, balance: 500 },
          "2027-01": { payment: 505, interest: 5, principal: 500, balance: 0 },
        },
      },
    ],
    accounts: [
      { id: 1, label: "Chequing", pool: "cash", balance: 2000 },
      { id: 2, label: "Brokerage", pool: "investments", balance: 10000 },
      { id: 3, label: "House", pool: "otherAssets", balance: 300000 },
      { id: 4, label: "Visa", pool: "otherLiabilities", balance: -400 },
      { id: 9, label: "Car loan", pool: "loans", balance: -1000 },
    ],
    historyMonths: ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"],
    history: {},
    pastBudget: {},
    scheduled: {},
    notes: [],
    leftOut: [],
    ...over,
  };
}

const cfg = (over: Partial<ScenarioConfig> = {}) => ({ ...baselineScenario(3), ...over });

describe("plan stage: layers", () => {
  it("budget fills lines that have a budget and leaves the rest blank", () => {
    const r = runForecast(inputs(), cfg());
    const by = Object.fromEntries(r.lines.map((l) => [l.key, l.amounts]));
    expect(r.months).toEqual(["2026-12", "2027-01", "2027-02"]);
    expect(by["c:1"]).toEqual([5000, 5000, 5000]);
    expect(by["c:2"]).toEqual([600, 600, null]); // no budget in Feb: blank, not filled
    expect(by["c:3"]).toEqual([null, null, null]);
    expect(r.blankLines.map((l) => l.key)).toEqual(["c:3"]);
  });

  it("carries a budget past the budget horizon and inflates only the carried months", () => {
    const i = inputs({
      startMonth: "2029-09",
      budget: { "c:2": { months: { "2029-09": 600, "2029-10": 600 }, carryFrom: "2029-10", carryAmount: 600 } },
    });
    const r = runForecast(i, { ...baselineScenario(15), assumptions: { inflationPct: 12, investmentReturnPct: 0, otherAssetGrowthPct: 0 } });
    const g = r.lines.find((l) => l.key === "c:2")!.amounts;
    expect(g[0]).toBe(600); // typed budget: never inflated
    expect(g[1]).toBe(600);
    expect(g[2]).toBeCloseTo(600 * Math.pow(1.12, 1 / 12), 2); // Nov 2029: 1 month carried
    expect(g[13]).toBeCloseTo(600 * 1.12, 2); // Oct 2030: 12 months carried
    const off = runForecast(i, {
      ...baselineScenario(15),
      layers: baselineScenario(15).layers.map((l) => (l.kind === "budget" ? { ...l, params: { carryForwardBeyondHorizon: false } } : l)),
    });
    expect(off.lines.find((l) => l.key === "c:2")!.amounts[2]).toBeNull();
  });

  it("combine ops: set, add (blank counts 0), scale (blank stays blank), floor, cap, and switching the budget off", () => {
    const manual = (id: string, op: string, amount: number, scope: object = {}) =>
      ({ id, kind: "manual", label: id, op, params: { amount }, scope }) as never;
    const c = scenarioConfigSchema.parse({
      horizonMonths: 3,
      layers: [
        { id: "budget", kind: "budget", label: "Budget", op: "fill" },
        manual("raise", "scale", 1.1, { lineKeys: ["c:1"] }),
        manual("daycare", "add", 150, { lineKeys: ["c:3"] }),
        manual("dining-cap", "cap", 100, { lineKeys: ["c:3"] }),
        manual("groceries-min", "floor", 700, { lineKeys: ["c:2"] }),
      ],
    });
    const by = Object.fromEntries(runForecast(inputs(), c).lines.map((l) => [l.key, l.amounts]));
    expect(by["c:1"]).toEqual([5500, 5500, 5500]);
    expect(by["c:3"]).toEqual([100, 100, 100]); // 150 added to blank, then capped at 100
    expect(by["c:2"]).toEqual([700, 700, 700]); // floor fills the blank Feb too

    const manualOnly = scenarioConfigSchema.parse({
      horizonMonths: 3,
      layers: [
        { id: "budget", kind: "budget", label: "Budget", op: "fill", enabled: false },
        manual("rent", "set", 2000, { lineKeys: ["c:3"] }),
      ],
    });
    const mo = Object.fromEntries(runForecast(inputs(), manualOnly).lines.map((l) => [l.key, l.amounts]));
    expect(mo["c:1"]).toEqual([null, null, null]);
    expect(mo["c:3"]).toEqual([2000, 2000, 2000]);
  });

  it("respects a layer's months and never touches debt lines", () => {
    const c = scenarioConfigSchema.parse({
      horizonMonths: 3,
      layers: [
        { id: "budget", kind: "budget", label: "Budget", op: "fill" },
        { id: "jan", kind: "manual", label: "Jan only", op: "set", params: { amount: 1 }, from: "2027-01", to: "2027-01" },
      ],
    });
    const r = runForecast(inputs(), c);
    expect(r.lines.find((l) => l.key === "c:1")!.amounts).toEqual([5000, 1, 5000]);
    expect(r.lines.find((l) => l.key === "debt:9")!.amounts).toEqual([510, 505, 0]);
  });

  it("explains a number step by step", () => {
    const i = inputs({ startMonth: "2029-10", budget: { "c:2": { months: { "2029-10": 600 }, carryFrom: "2029-10", carryAmount: 600 } } });
    const steps = traceCell(i, baselineScenario(3), "c:2", "2029-12");
    expect(steps.map((s) => s.layerId)).toEqual(["budget", "inflation"]);
    expect(steps[0]).toMatchObject({ before: null, after: 600, detail: "budget of 2029-10 carried forward" });
    expect(steps[1].after).toBeCloseTo(600 * Math.pow(1.025, 2 / 12), 2);
  });
});

describe("simulate stage: where the money goes", () => {
  it("income adds, spending and loan payments take from cash; interest is not an expense", () => {
    const r = runForecast(inputs(), cfg({ assumptions: { inflationPct: 0, investmentReturnPct: 0, otherAssetGrowthPct: 0 } }));
    expect(r.opening).toMatchObject({ cash: 2000, investments: 10000, otherAssets: 300000, loans: 1000, otherLiabilities: 400 });
    expect(r.opening.netWorth).toBe(2000 + 10000 + 300000 - 1000 - 400);
    expect(r.totals.income).toEqual([5000, 5000, 5000]);
    expect(r.totals.expense).toEqual([600, 600, 0]);
    expect(r.totals.debtPayment).toEqual([510, 505, 0]);
    expect(r.totals.interest).toEqual([10, 5, 0]);
    expect(r.balances.cash).toEqual([2000 + 5000 - 600 - 510, 5890 + 5000 - 600 - 505, 9785 + 5000]);
    expect(r.balances.loans).toEqual([500, 0, 0]);
    expect(r.balances.otherLiabilities).toEqual([400, 400, 400]); // cards assumed paid in full: flat
    // Net worth moves by income − spending − interest (principal just moves cash into the loan).
    expect(r.balances.netWorth[0] - r.opening.netWorth).toBeCloseTo(5000 - 600 - 10, 2);
  });

  it("grows investments monthly and records milestones", () => {
    const r = runForecast(inputs(), cfg({ assumptions: { inflationPct: 0, investmentReturnPct: 12, otherAssetGrowthPct: 0 } }));
    expect(r.balances.investments[2]).toBeCloseTo(10000 * Math.pow(1.12, 3 / 12), 1);
    expect(r.milestones).toEqual([
      { kind: "loan_paid_off", month: "2027-01", label: "Car loan paid off", ref: "debt:9" },
      { kind: "debt_free", month: "2027-01", label: "All loans paid off" },
    ]);
    expect(r.loans[0]).toMatchObject({ payoffMonth: "2027-01", interestTotal: 15 });
  });

  it("a cash shortfall goes negative with a warning, or is covered from investments", () => {
    const poor = inputs({ accounts: [{ id: 1, label: "Chequing", pool: "cash", balance: 100 }, { id: 2, label: "Brokerage", pool: "investments", balance: 1000 }] });
    const neg = runForecast(poor, cfg({ assumptions: { inflationPct: 0, investmentReturnPct: 0, otherAssetGrowthPct: 0 }, layers: [
      { id: "b", kind: "budget", label: "Budget", op: "fill", enabled: false, scope: {}, params: { carryForwardBeyondHorizon: true }, updatedBy: "user" },
    ] }));
    expect(neg.balances.cash[0]).toBe(100 - 510);
    expect(neg.warnings.map((w) => w.code)).toContain("cash_negative");
    expect(neg.milestones.some((m) => m.kind === "cash_negative")).toBe(true);

    const draw = runForecast(poor, cfg({ shortfall: "draw_investments", assumptions: { inflationPct: 0, investmentReturnPct: 0, otherAssetGrowthPct: 0 }, layers: [
      { id: "b", kind: "budget", label: "Budget", op: "fill", enabled: false, scope: {}, params: { carryForwardBeyondHorizon: true }, updatedBy: "user" },
    ] }));
    expect(draw.balances.cash[0]).toBe(0);
    expect(draw.balances.investments[0]).toBe(1000 - 410);
    expect(draw.totals.drawn[0]).toBe(410);
    expect(draw.balances.investments[1]).toBe(85); // 590 − 505
  });

  it("pays a debt account with no loan by its fixed amount, no interest", () => {
    const i = inputs({ loans: [{ accountId: 9, label: "Family loan", openingBalance: 250, balanceSource: "fixed", fixedPayment: 100, months: {} }] });
    const r = runForecast(i, cfg());
    expect(r.totals.debtPayment).toEqual([100, 100, 50]);
    expect(r.balances.loans).toEqual([150, 50, 0]);
    expect(r.totals.interest).toEqual([0, 0, 0]);
  });
});

describe("result: versioned and self-describing (snapshot-ready)", () => {
  it("stamps versions, currency, data date, assumptions and line labels", () => {
    const r = runForecast(inputs(), cfg(), { computedAt: "2026-11-25T13:00:00.000Z" });
    expect(r).toMatchObject({
      resultSchemaVersion: FORECAST_RESULT_SCHEMA_VERSION,
      engineVersion: FORECAST_ENGINE_VERSION,
      computedAt: "2026-11-25T13:00:00.000Z",
      inputsAsOf: "2026-11-25T12:00:00.000Z",
      currency: "USD",
      startMonth: "2026-12",
      assumptions: { inflationPct: 2.5, investmentReturnPct: 5 },
    });
    expect(r.lines.find((l) => l.key === "c:2")).toMatchObject({ label: "Groceries", type: "expense", group: "Food" });
    expect(JSON.parse(JSON.stringify(r))).toEqual(r); // plain JSON
  });

  it("is deterministic", () => {
    const a = runForecast(inputs(), cfg(), { computedAt: "x" });
    const b = runForecast(inputs(), cfg(), { computedAt: "x" });
    expect(a).toEqual(b);
  });

  it("deflates by inflation for today's money", () => {
    const r = runForecast(inputs(), cfg());
    expect(r.deflator[0]).toBeCloseTo(Math.pow(1.025, 1 / 12), 6);
    expect(r.deflator[2]).toBeCloseTo(Math.pow(1.025, 3 / 12), 6);
  });

  it("warns when nothing is budgeted", () => {
    const r = runForecast(inputs({ budget: {} }), cfg());
    expect(r.warnings.map((w) => w.code)).toContain("no_budget");
  });
});

describe("yearly view", () => {
  it("sums flows per calendar year and takes balances at year end", () => {
    const r = runForecast(inputs(), cfg({ assumptions: { inflationPct: 0, investmentReturnPct: 0, otherAssetGrowthPct: 0 } }));
    const y = yearlyView(r);
    expect(y.years).toEqual(["2026", "2027"]);
    expect(y.totals.income).toEqual([5000, 10000]);
    expect(y.lines.find((l) => l.key === "c:3")!.amounts).toEqual([null, null]);
    expect(y.balances.cash).toEqual([r.balances.cash[0], r.balances.cash[2]]);
  });
});

describe("compareResults", () => {
  it("aligns by month and line key across horizons, labels and currencies", () => {
    const a = runForecast(inputs(), cfg());
    const renamed = inputs({ lines: inputs().lines.map((l) => (l.key === "c:2" ? { ...l, label: "Food shopping" } : l)) });
    const b = runForecast(renamed, { ...baselineScenario(2), layers: [...baselineScenario(2).layers, { id: "m", kind: "manual", label: "more food", op: "add", params: { amount: 100 }, scope: { lineKeys: ["c:2"] }, enabled: true, updatedBy: "user" }] });
    const c = compareResults(a, b);
    expect(c.months).toEqual(["2026-12", "2027-01", "2027-02"]);
    expect(c.balances.netWorth[2].b).toBeNull(); // b's horizon is shorter
    const food = c.lines.find((l) => l.key === "c:2")!;
    expect(food).toMatchObject({ label: "Food shopping", totalA: 1200, totalB: 1400, diff: 200 });
    expect(c.endNetWorth.month).toBe("2027-01");
    expect(c.currencyMismatch).toBeNull();
    expect(compareResults(a, { ...b, currency: "EUR" }).currencyMismatch).toEqual({ a: "USD", b: "EUR" });
  });
});

describe("helpers and wiring", () => {
  it("month math", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2027-01", -2)).toBe("2026-11");
    expect(monthsBetween("2026-11", "2028-02")).toBe(15);
  });

  it("the Loans page and the forecast share one projection and one balance query", () => {
    const route = read("src/app/api/loans/route.ts");
    expect(route).toContain("projectLoanFromToday(loan, summary, acct, today)");
    expect(route).toContain('from "@/lib/loans/linked-account-balances"');
    expect(route).not.toMatch(/async function getLinkedAccountBalances/);
    const inputsSrc = read("src/lib/forecast/inputs.ts");
    expect(inputsSrc).toContain("projectLoanFromToday(");
    expect(inputsSrc).toContain("...loanScheduleExtras(loan)");
    expect(inputsSrc).toContain("loadBudgetsByMonth(ctx");
    expect(inputsSrc).toContain("applyInvestmentMarketOverlay(");
  });

  it("the engine modules stay browser-safe (no database imports)", () => {
    for (const f of ["config", "types", "layers", "simulate", "engine", "compare"]) {
      const src = read(`src/lib/forecast/${f}.ts`);
      expect(src, f).not.toMatch(/from "@\/db"|from "@\/lib\/queries"|fx-service/);
    }
  });
});
