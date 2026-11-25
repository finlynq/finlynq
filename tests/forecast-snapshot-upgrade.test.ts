/**
 * A snapshot frozen before later totals existed (phase 2: no toInvestments /
 * purchases / borrowed / withdrawn, no retirement) must still read: the page
 * runs yearlyView and compareResults over it. Before the fix, comparing with
 * such a snapshot crashed the page. Pure.
 */
import { describe, it, expect } from "vitest";
import { baselineScenario } from "@/lib/forecast/config";
import { runForecast, yearlyView } from "@/lib/forecast/engine";
import { compareResults } from "@/lib/forecast/compare";
import { upgradeForecastResult } from "@/lib/forecast/snapshot";
import type { ForecastInputs } from "@/lib/forecast/types";

const inputs: ForecastInputs = {
  inputsAsOf: "2026-12-10T12:00:00.000Z",
  today: "2026-12-10",
  startMonth: "2027-01",
  currency: "USD",
  maxHorizonMonths: 120,
  budgetHorizonEnd: "2029-11",
  lines: [
    { key: "c:1", label: "Salary", type: "income", group: "Pay" },
    { key: "c:2", label: "Groceries", type: "expense", group: "Food" },
  ],
  budget: {
    "c:1": { months: { "2027-01": 5000 }, carryFrom: null, carryAmount: null },
    "c:2": { months: { "2027-01": 500 }, carryFrom: null, carryAmount: null },
  },
  historyMonths: [],
  history: {},
  pastBudget: {},
  scheduled: {},
  loans: [],
  accounts: [{ id: 1, label: "Chequing", pool: "cash", balance: 1000 }],
  notes: [],
  leftOut: [],
};

describe("upgradeForecastResult", () => {
  it("fills totals and fields an older snapshot lacks, so yearlyView and compare work", () => {
    const fresh = runForecast(inputs, baselineScenario(24));
    const old = JSON.parse(JSON.stringify(fresh));
    for (const k of ["toInvestments", "purchases", "borrowed", "withdrawn"]) delete old.totals[k];
    delete old.retirement;
    delete old.birthYear;
    delete old.events;

    const up = upgradeForecastResult(old)!;
    expect(up.totals.withdrawn).toHaveLength(24);
    expect(up.totals.withdrawn.every((v) => v === 0)).toBe(true);
    expect(up.retirement).toBeNull();
    expect(up.events).toEqual([]);
    expect(() => yearlyView(up)).not.toThrow();
    expect(yearlyView(up).balances.netWorth).toEqual(yearlyView(fresh).balances.netWorth);
    expect(compareResults(fresh, up).endNetWorth.diff).toBe(0);
  });

  it("keeps a current result's values", () => {
    const fresh = runForecast(inputs, baselineScenario(12));
    expect(upgradeForecastResult(JSON.parse(JSON.stringify(fresh)))).toEqual(fresh);
  });
});
