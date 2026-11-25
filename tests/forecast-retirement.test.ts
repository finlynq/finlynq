/**
 * Forecast Phase 4: the retire event (income stops, spending scaled, pensions,
 * contributions stop), withdrawal strategies, and the retirement answer
 * (money lasts until age N). Pure.
 */
import { describe, it, expect } from "vitest";
import { scenarioConfigSchema, type ScenarioConfig } from "@/lib/forecast/config";
import { runForecast } from "@/lib/forecast/engine";
import { isValidBirthYear } from "@/lib/settings/birth-year";
import type { ForecastInputs } from "@/lib/forecast/types";

function months(start: string, n: number): string[] {
  const [y, m] = start.split("-").map(Number);
  return Array.from({ length: n }, (_, i) => {
    const idx = y * 12 + m - 1 + i;
    return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
  });
}

function inputs(over: Partial<ForecastInputs> = {}): ForecastInputs {
  // Rules-style budgets: salary 6,000 and rent + food 3,000 every month for 50 years.
  const all = months("2027-01", 600);
  return {
    inputsAsOf: "2026-12-10T12:00:00.000Z", today: "2026-12-10", startMonth: "2027-01", currency: "USD",
    birthYear: 1970,
    maxHorizonMonths: 600, budgetHorizonEnd: "2029-11",
    lines: [
      { key: "c:1", label: "Salary", type: "income", group: "Pay" },
      { key: "c:2", label: "Living costs", type: "expense", group: "Home" },
    ],
    budget: {
      "c:1": { months: Object.fromEntries(all.map((m) => [m, 6000])), carryFrom: null, carryAmount: null },
      "c:2": { months: Object.fromEntries(all.map((m) => [m, 3000])), carryFrom: null, carryAmount: null },
    },
    historyMonths: [], history: {}, pastBudget: {}, scheduled: {},
    loans: [],
    accounts: [
      { id: 1, label: "Chequing", pool: "cash", balance: 10000 },
      { id: 2, label: "Brokerage", pool: "investments", balance: 300000 },
    ],
    notes: [], leftOut: [],
    ...over,
  };
}

const ZERO = { inflationPct: 0, investmentReturnPct: 0, otherAssetGrowthPct: 0 };
const cfg = (events: object[], horizonMonths = 120, assumptions: object = ZERO): ScenarioConfig =>
  scenarioConfigSchema.parse({
    horizonMonths, assumptions,
    layers: [{ id: "budget", kind: "budget", label: "Budget", op: "fill" }],
    events,
  });
const retire = (month: string, params: object = {}) => ({ id: "ret", kind: "retire", label: "Retire", month, params });

describe("retire event", () => {
  it("stops income, scales spending, starts a pension and stops contributions", () => {
    const r = runForecast(inputs(), cfg([
      { id: "save", kind: "move_money", month: "2027-01", params: { direction: "to_investments", amount: 1000, frequency: "monthly" } },
      retire("2028-01", { spendingFactor: 0.8, pensions: [{ label: "State pension", amount: 1500, startMonth: "2029-01", growthPct: 0 }] }),
    ], 36));
    const at = (key: string, m: string) => r.lines.find((l) => l.key === key)!.amounts[r.months.indexOf(m)];
    expect(at("c:1", "2027-12")).toBe(6000);
    expect(at("c:1", "2028-01")).toBe(0);
    expect(at("c:2", "2027-12")).toBe(3000);
    expect(at("c:2", "2028-01")).toBe(2400);
    expect(at("ev:ret:p0", "2028-12")).toBeNull();
    expect(at("ev:ret:p0", "2029-01")).toBe(1500);
    expect(r.totals.toInvestments[r.months.indexOf("2027-12")]).toBe(1000);
    expect(r.totals.toInvestments[r.months.indexOf("2028-01")]).toBe(0);
    expect(r.milestones.find((m) => m.kind === "retired")).toMatchObject({ month: "2028-01", label: "Retire at 58" });
  });

  it("a pension in today's money grows with inflation from today", () => {
    const r = runForecast(inputs(), cfg([retire("2028-01", { pensions: [{ amount: 1000, growthPct: null }] })], 24, { ...ZERO, inflationPct: 12 }));
    const p = r.lines.find((l) => l.key === "ev:ret:p0")!.amounts;
    expect(p[12]).toBeCloseTo(1000 * Math.pow(1.12, 13 / 12), 1); // Jan 2028 is 13 months after today's month
  });
});

describe("withdrawals and the answer", () => {
  it("cover shortfall: sells only what's needed, and says when money runs out and at what age", () => {
    // From 2028: no income, 3,000 a month of spending, 10k cash + 300k + saved 12×3000 by then.
    const r = runForecast(inputs(), cfg([retire("2028-01")], 240));
    const i = r.months.indexOf("2028-01");
    expect(r.retirement).toMatchObject({ month: "2028-01", age: 58, investmentsAtRetirement: 300000 });
    expect(r.totals.withdrawn[i]).toBe(0); // the 46k of cash is used first
    const firstSell = r.totals.withdrawn.findIndex((w) => w > 0);
    expect(r.balances.cash[firstSell]).toBeCloseTo(0, 2);
    // 46,000 cash + 300,000 investments at 3,000 a month = 115.33 months → runs out in the 116th month of retirement.
    expect(r.retirement!.runsOutMonth).toBe(months("2028-01", 200)[115]);
    expect(r.retirement!.runsOutAge).toBe(2037 - 1970);
    expect(r.milestones.some((m) => m.kind === "money_runs_out")).toBe(true);
    // Withdrawals are transfers: net worth falls only by spending.
    expect(r.balances.netWorth[i] - r.balances.netWorth[i - 1]).toBeCloseTo(-3000, 2);
  });

  it("money lasting past the forecast says so, with the age at the end", () => {
    const r = runForecast(inputs(), cfg([retire("2028-01", { pensions: [{ amount: 3000, growthPct: 0 }] })], 600));
    expect(r.retirement).toMatchObject({ runsOutMonth: null, horizonEndAge: 2076 - 1970 });
  });

  it("4% rule: a yearly 4% of investments at retirement, paid monthly, growing with inflation", () => {
    const r = runForecast(inputs(), cfg([retire("2028-01", { withdrawal: { method: "fixed_pct", pct: 4, growWithInflation: true } })], 60, { ...ZERO, inflationPct: 12 }));
    const i = r.months.indexOf("2028-01");
    const inv0 = r.retirement!.investmentsAtRetirement;
    expect(r.totals.withdrawn[i]).toBeCloseTo((inv0 * 0.04) / 12, 1);
    expect(r.totals.withdrawn[i + 12]).toBeCloseTo(((inv0 * 0.04) / 12) * 1.12, 0);
    // 1,000 a month doesn't cover 3,000 of spending: warned once cash runs dry.
    expect(r.warnings.map((w) => w.code)).toContain("withdrawals_short");
  });

  it("fixed amount", () => {
    const r = runForecast(inputs(), cfg([retire("2028-01", { withdrawal: { method: "fixed_amount", amount: 3000, growWithInflation: false } })], 36));
    const i = r.months.indexOf("2028-01");
    expect(r.totals.withdrawn.slice(i, i + 3)).toEqual([3000, 3000, 3000]);
    expect(r.balances.cash[i]).toBe(r.balances.cash[i - 1]); // 3,000 in, 3,000 out
  });

  it("without a birth year, ages are left out", () => {
    const r = runForecast(inputs({ birthYear: null }), cfg([retire("2028-01")], 24));
    expect(r.retirement).toMatchObject({ age: null, horizonEndAge: null });
    expect(r.milestones.find((m) => m.kind === "retired")!.label).toBe("Retire");
    expect(r.birthYear).toBeNull();
  });

  it("no retire event, no retirement block", () => {
    expect(runForecast(inputs(), cfg([], 12)).retirement).toBeNull();
  });
});

describe("birth year", () => {
  it("accepts a plausible year only", () => {
    expect(isValidBirthYear(1985, 2026)).toBe(true);
    expect(isValidBirthYear(1899, 2026)).toBe(false);
    expect(isValidBirthYear(2027, 2026)).toBe(false);
    expect(isValidBirthYear(1985.5, 2026)).toBe(false);
    expect(isValidBirthYear("1985", 2026)).toBe(false);
  });
});
