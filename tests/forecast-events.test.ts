/**
 * Forecast Phase 3 events (plan section 6): one-offs, new lines, income
 * changes, moving money, extra payments, new loans, refinancing, buying a
 * home, and the debt strategy cross-checked against calculateDebtPayoff
 * (get_debt_payoff_plan). Pure.
 */
import { describe, it, expect } from "vitest";
import { scenarioConfigSchema, type ScenarioConfig } from "@/lib/forecast/config";
import { runForecast } from "@/lib/forecast/engine";
import { annuityPayment } from "@/lib/forecast/events";
import { applyPatch, diffFromParent } from "@/lib/forecast/variants";
import { calculateDebtPayoff } from "@/lib/loan-calculator";
import type { ForecastInputs, LoanInput } from "@/lib/forecast/types";

const ZERO = { inflationPct: 0, investmentReturnPct: 0, otherAssetGrowthPct: 0 };

function months(start: string, n: number): string[] {
  const [y, m] = start.split("-").map(Number);
  return Array.from({ length: n }, (_, i) => {
    const idx = y * 12 + m - 1 + i;
    return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
  });
}

/** A loan as inputs.ts builds it: schedule rows from the monthly amortization, plus terms. */
function loan(accountId: number, label: string, balance: number, ratePct: number, payment: number, start = "2027-01", reamortizable = true): LoanInput {
  const rows: LoanInput["months"] = {};
  let bal = balance;
  for (const m of months(start, 600)) {
    if (bal <= 0.005) break;
    const interest = Math.round(((bal * ratePct) / 100 / 12) * 100) / 100;
    const pay = Math.min(payment, bal + interest);
    bal = Math.round((bal + interest - pay) * 100) / 100;
    rows[m] = { payment: pay, interest, principal: pay - interest, balance: Math.max(0, bal) };
  }
  return { accountId, label, openingBalance: balance, balanceSource: "account", fixedPayment: null, months: rows, terms: { annualRatePct: ratePct, monthlyPayment: payment, residual: 0, reamortizable } };
}

function inputs(over: Partial<ForecastInputs> = {}): ForecastInputs {
  const built = baseInputs(over);
  // inputs.ts always adds one debt line per loan.
  built.lines = [...built.lines, ...built.loans.map((l) => ({ key: `debt:${l.accountId}`, label: l.label, type: "debt" as const, group: "Debt payments" }))];
  return built;
}

function baseInputs(over: Partial<ForecastInputs>): ForecastInputs {
  return {
    inputsAsOf: "2026-12-10T12:00:00.000Z", today: "2026-12-10", startMonth: "2027-01", currency: "USD",
    maxHorizonMonths: 600, budgetHorizonEnd: "2029-11",
    lines: [
      { key: "c:1", label: "Salary", type: "income", group: "Pay" },
      { key: "c:2", label: "Rent", type: "expense", group: "Home" },
    ],
    budget: {
      "c:1": { months: Object.fromEntries(months("2027-01", 36).map((m) => [m, 6000])), carryFrom: null, carryAmount: null },
      "c:2": { months: Object.fromEntries(months("2027-01", 36).map((m) => [m, 2000])), carryFrom: null, carryAmount: null },
    },
    historyMonths: [], history: {}, pastBudget: {}, scheduled: {},
    loans: [],
    accounts: [
      { id: 1, label: "Chequing", pool: "cash", balance: 100000 },
      { id: 2, label: "Brokerage", pool: "investments", balance: 50000 },
    ],
    notes: [], leftOut: [],
    ...over,
  };
}

const cfg = (events: object[], horizonMonths = 24, over: object = {}): ScenarioConfig =>
  scenarioConfigSchema.parse({
    horizonMonths, assumptions: ZERO,
    layers: [{ id: "budget", kind: "budget", label: "Budget", op: "fill" }],
    events, ...over,
  });
const ev = (e: object) => ({ label: "", enabled: true, ...e });

describe("cash events", () => {
  it("one-off and recurring items become their own lines in the Events group", () => {
    const r = runForecast(inputs(), cfg([
      ev({ id: "gift", kind: "one_off", month: "2027-03", label: "Inheritance", params: { direction: "in", amount: 20000 } }),
      ev({ id: "kid", kind: "recurring_item", month: "2027-06", label: "Daycare", params: { type: "expense", amount: 900, to: "2027-08", growthPct: 0 } }),
    ], 12));
    const by = Object.fromEntries(r.lines.map((l) => [l.key, l]));
    expect(by["ev:gift"]).toMatchObject({ label: "Inheritance", type: "income", group: "Events", total: 20000 });
    expect(by["ev:gift"].amounts[2]).toBe(20000);
    expect(by["ev:kid"].amounts.slice(4, 9)).toEqual([null, 900, 900, 900, null]);
    expect(r.blankLines.some((l) => l.key.startsWith("ev:"))).toBe(false);
    expect(r.balances.cash[11]).toBe(100000 + 12 * 4000 + 20000 - 2700);
  });

  it("an income change (job loss) applies to income lines for its months", () => {
    const r = runForecast(inputs(), cfg([
      ev({ id: "loss", kind: "income_change", month: "2027-04", label: "Between jobs", params: { op: "set", value: 0, to: "2027-06" } }),
    ], 8));
    expect(r.lines.find((l) => l.key === "c:1")!.amounts).toEqual([6000, 6000, 6000, 0, 0, 0, 6000, 6000]);
  });

  it("moving money changes cash and investments, never income or net worth", () => {
    const r = runForecast(inputs(), cfg([
      ev({ id: "tfsa", kind: "move_money", month: "2027-01", params: { direction: "to_investments", amount: 1000, frequency: "monthly", to: "2027-03" } }),
    ], 4));
    expect(r.totals.toInvestments).toEqual([1000, 1000, 1000, 0]);
    expect(r.balances.investments[3]).toBe(53000);
    expect(r.totals.income).toEqual([6000, 6000, 6000, 6000]);
    const plain = runForecast(inputs(), cfg([], 4));
    expect(r.balances.netWorth).toEqual(plain.balances.netWorth);
  });
});

describe("loan events", () => {
  const withLoan = () => inputs({ loans: [loan(9, "Car loan", 12000, 6, 500)] });

  it("no event: the loan follows its schedule rows exactly", () => {
    const r = runForecast(withLoan(), cfg([], 36));
    const rows = withLoan().loans[0].months;
    expect(r.lines.find((l) => l.key === "debt:9")!.amounts[0]).toBe(rows["2027-01"].payment);
    expect(r.balances.loans[0]).toBe(rows["2027-01"].balance);
  });

  it("an extra monthly payment pays it off sooner with less interest", () => {
    const base = runForecast(withLoan(), cfg([], 60));
    const extra = runForecast(withLoan(), cfg([
      ev({ id: "x", kind: "extra_debt_payment", month: "2027-01", params: { loanKey: "debt:9", amount: 250, frequency: "monthly" } }),
    ], 60));
    const b = base.loans[0];
    const x = extra.loans[0];
    expect(x.payoffMonth! < b.payoffMonth!).toBe(true);
    expect(x.interestTotal).toBeLessThan(b.interestTotal);
    expect(extra.lines.find((l) => l.key === "debt:9")!.amounts[0]).toBe(750);
  });

  it("is skipped, with a warning, for a loan that can't be re-amortized", () => {
    const i = inputs({ loans: [loan(9, "Typed schedule", 12000, 6, 500, "2027-01", false)] });
    const r = runForecast(i, cfg([ev({ id: "x", kind: "extra_debt_payment", month: "2027-01", params: { loanKey: "debt:9", amount: 250 } })], 24));
    expect(r.warnings.map((w) => w.code)).toContain("loan_not_reamortizable");
    expect(r.lines.find((l) => l.key === "debt:9")!.amounts[0]).toBe(500);
  });

  it("refinancing re-amortizes the remaining balance at the new rate and term", () => {
    const r = runForecast(withLoan(), cfg([
      ev({ id: "rf", kind: "refinance", month: "2027-07", params: { loanKey: "debt:9", annualRatePct: 3, termMonths: 12 } }),
    ], 24));
    const debt = r.lines.find((l) => l.key === "debt:9")!.amounts;
    const balBefore = r.balances.loans[5];
    expect(debt[6]).toBeCloseTo(annuityPayment(balBefore, 3, 12), 1);
    expect(r.loans[0].payoffMonth).toBe("2028-06");
  });

  it("a new loan adds cash (when the money lands in cash) and a debt line", () => {
    const r = runForecast(inputs(), cfg([
      ev({ id: "car", kind: "new_loan", month: "2027-02", label: "Car loan", params: { principal: 10000, annualRatePct: 0, termMonths: 10, cashIn: true } }),
    ], 14));
    expect(r.totals.borrowed[1]).toBe(10000);
    const line = r.lines.find((l) => l.key === "newloan:car")!;
    expect(line).toMatchObject({ type: "debt", label: "Car loan" });
    expect(line.amounts.slice(1, 4)).toEqual([0, 1000, 1000]);
    expect(r.loans.find((l) => l.key === "newloan:car")).toMatchObject({ isNew: true, payoffMonth: "2027-12" });
    expect(r.milestones.filter((m) => m.kind === "debt_free").map((m) => m.month)).toEqual(["2027-12"]);
  });

  it("buying a home: down payment to the home, a mortgage, costs, rent stops; net worth unchanged on the day", () => {
    const plain = runForecast(inputs(), cfg([], 6));
    const r = runForecast(inputs(), cfg([
      ev({ id: "home", kind: "buy_home", month: "2027-03", label: "House", params: {
        price: 400000, downPayment: 80000, mortgageRatePct: 0, mortgageTermMonths: 320, yearlyCostsPct: 1.2, stopLineKeys: ["c:2"],
      } }),
    ], 6));
    expect(r.totals.purchases[2]).toBe(80000);
    expect(r.balances.otherAssets[2]).toBe(400000);
    expect(r.balances.loans[2]).toBe(320000);
    expect(r.lines.find((l) => l.key === "c:2")!.amounts).toEqual([2000, 2000, 0, 0, 0, 0]);
    expect(r.lines.find((l) => l.key === "ev:home:costs")!.amounts[2]).toBe(400);
    // In the purchase month: −80k cash, +400k home, +320k owed, rent 0 instead of 2000, costs 400.
    expect(r.balances.netWorth[2] - plain.balances.netWorth[2]).toBeCloseTo(2000 - 400, 2);
  });
});

describe("debt strategy", () => {
  const three = () => inputs({
    loans: [
      loan(1, "Card A", 3000, 19.99, 90),
      loan(2, "Car", 9000, 5.5, 300),
      loan(3, "Student", 15000, 4.5, 200),
    ],
  });

  for (const method of ["avalanche", "snowball"] as const) {
    it(`${method}: same order and same or earlier payoffs than calculateDebtPayoff`, () => {
      const r = runForecast(three(), cfg([ev({ id: "s", kind: "debt_strategy", month: "2027-01", params: { method, extraPerMonth: 400 } })], 240));
      const plan = calculateDebtPayoff(
        [
          { id: 1, name: "Card A", balance: 3000, rate: 19.99, minPayment: 90 },
          { id: 2, name: "Car", balance: 9000, rate: 5.5, minPayment: 300 },
          { id: 3, name: "Student", balance: 15000, rate: 4.5, minPayment: 200 },
        ],
        400,
        method,
      );
      const ours = r.loans.filter((l) => l.payoffMonth).sort((a, b) => a.payoffMonth!.localeCompare(b.payoffMonth!)).map((l) => l.label);
      expect(ours).toEqual(plan.order.map((o) => o.name));
      const start = "2027-01";
      for (const o of plan.order) {
        const mine = r.loans.find((l) => l.label === o.name)!.payoffMonth!;
        const idx = months(start, 600).indexOf(mine) + 1; // months counted from 1
        expect(idx).toBeLessThanOrEqual(o.paidOffMonth);
        expect(o.paidOffMonth - idx).toBeLessThanOrEqual(1);
      }
      const interest = r.loans.reduce((s, l) => s + l.interestTotal, 0);
      expect(interest).toBeLessThanOrEqual(plan.totalInterest + 0.01);
      // Lower only because a final month's leftover goes to the next loan instead
      // of being lost (2.8% on these numbers: 1,783.95 vs 1,835.75).
      expect(plan.totalInterest - interest).toBeLessThan(plan.totalInterest * 0.05);
    });
  }

  it("beats paying the minimums", () => {
    const base = runForecast(three(), cfg([], 240));
    const snow = runForecast(three(), cfg([ev({ id: "s", kind: "debt_strategy", month: "2027-01", params: { method: "avalanche", extraPerMonth: 400 } })], 240));
    const total = (r: typeof base) => r.loans.reduce((s, l) => s + l.interestTotal, 0);
    expect(total(snow)).toBeLessThan(total(base));
    const free = (r: typeof base) => r.milestones.find((m) => m.kind === "debt_free")?.month ?? "9999";
    expect(free(snow) < free(base)).toBe(true);
  });
});

describe("events in variants", () => {
  it("round-trip through diff and apply", () => {
    const parent = cfg([ev({ id: "a", kind: "one_off", month: "2027-03", params: { direction: "in", amount: 1 } })]);
    const edited = cfg([
      ev({ id: "a", kind: "one_off", month: "2027-04", params: { direction: "in", amount: 1 } }),
      ev({ id: "b", kind: "debt_strategy", month: "2027-01", params: { method: "snowball", extraPerMonth: 100 } }),
    ]);
    const patch = diffFromParent(parent, edited);
    expect(Object.keys(patch.eventOverrides)).toEqual(["a"]);
    expect(patch.addedEvents.map((e) => e.id)).toEqual(["b"]);
    expect(applyPatch(parent, patch)).toEqual(edited);
    const removed = diffFromParent(parent, { ...parent, events: [] });
    expect(removed.removedEventIds).toEqual(["a"]);
  });

  it("disabled events and events past the horizon do nothing", () => {
    const r = runForecast(inputs(), cfg([
      ev({ id: "off", kind: "one_off", month: "2027-02", enabled: false, params: { direction: "out", amount: 5000 } }),
      ev({ id: "late", kind: "one_off", month: "2040-01", params: { direction: "out", amount: 5000 } }),
    ], 6));
    expect(r.lines.some((l) => l.key.startsWith("ev:"))).toBe(false);
  });
});

describe("plan vs actual and interest in comparisons", () => {
  it("compares a snapshot's finished months with what actually happened", async () => {
    const { planVsActual } = await import("@/lib/forecast/compare");
    const snap = runForecast(inputs(), cfg([ev({ id: "gift", kind: "one_off", month: "2027-01", params: { direction: "in", amount: 100 } })], 6));
    // Two months later: Jan and Feb 2027 have finished.
    const later = inputs({
      startMonth: "2027-03",
      historyMonths: ["2026-12", "2027-01", "2027-02"],
      history: { "c:1": { "2027-01": 6000, "2027-02": 5500 }, "c:2": { "2027-01": 2100, "2027-02": 2000 } },
    });
    const p = planVsActual(snap, later);
    expect(p.months).toEqual(["2027-01", "2027-02"]);
    const by = Object.fromEntries(p.lines.map((l) => [l.key, l]));
    expect(by["c:1"]).toMatchObject({ plannedTotal: 12000, actualTotal: 11500, diff: -500 });
    expect(by["c:2"]).toMatchObject({ plannedTotal: 4000, actualTotal: 4100, diff: 100 });
    expect(p.totals).toEqual({ plannedIncome: 12000, actualIncome: 11500, plannedSpending: 4000, actualSpending: 4100 });
    expect(p.skipped).toBe(1); // the one-off has no actual
    expect(p.lines[0].key).toBe("c:1"); // biggest difference first
  });

  it("a snapshot with no finished months has nothing to compare yet", async () => {
    const { planVsActual } = await import("@/lib/forecast/compare");
    const snap = runForecast(inputs(), cfg([], 6));
    expect(planVsActual(snap, inputs()).months).toEqual([]);
  });

  it("compareResults reports interest saved", async () => {
    const { compareResults } = await import("@/lib/forecast/compare");
    const i = inputs({ loans: [loan(9, "Car loan", 12000, 6, 500)] });
    const a = runForecast(i, cfg([], 36));
    const b = runForecast(i, cfg([ev({ id: "x", kind: "extra_debt_payment", month: "2027-01", params: { loanKey: "debt:9", amount: 300 } })], 36));
    const c = compareResults(a, b);
    expect(c.interest.diff).toBeLessThan(0);
    expect(c.interest.a).toBeCloseTo(a.loans[0].interestTotal, 1);
  });
});
