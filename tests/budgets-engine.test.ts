/**
 * Budget v2 engine (plan/budget-v2.md): the pure parts. Fills (copy,
 * averages, increases once / every month / every year), carryover with resets
 * and edits, debt-payment lines from a loan schedule, automatic account roles,
 * and the month model (groups budgeted as one line, excluded lines, income,
 * totals). The real-database side is budgets-load-month.test.ts.
 */
import { describe, it, expect } from "vitest";
import { applyAdjust, planFill, sourceAmount, yearlySteps, type FillLine } from "@/lib/budgets/fill";
import { walkCarryover } from "@/lib/budgets/carryover";
import { debtStatus, scheduledInMonth } from "@/lib/budgets/debt-line";
import { automaticBudgetRole, monthRange, parseLineKey, resolveBudgetRole } from "@/lib/budgets/lines";
import { buildBudgetMonth, type BuildMonthInput, type MonthCategoryInput } from "@/lib/budgets/month";

describe("fill", () => {
  const line: FillLine = {
    key: "c:1",
    budgets: { "2026-09": 400, "2025-11": 350 },
    spent: { "2026-07": 300, "2026-08": 360, "2026-09": 420, "2025-12": 500 },
  };

  it("reads sources relative to the month before the first target", () => {
    expect(sourceAmount(line, { kind: "budget" }, "2026-09", "2026-10", "2026-09")).toBe(400);
    expect(sourceAmount(line, { kind: "spent" }, "2026-09", "2026-10", "2026-09")).toBe(420);
    expect(sourceAmount(line, { kind: "average", months: 3 }, "2026-09", "2026-10", "2026-09")).toBe(360);
    // A base month that isn't over yet averages complete months only.
    expect(sourceAmount(line, { kind: "average", months: 3 }, "2026-10", "2026-11", "2026-09")).toBe(360);
    expect(sourceAmount(line, { kind: "fixed", amount: 75 }, "2026-09", "2026-10", "2026-09")).toBe(75);
  });

  it("same month last year prefers that month's budget, then its spending", () => {
    expect(sourceAmount(line, { kind: "same_month_last_year" }, "2026-10", "2026-11", "2026-09")).toBe(350);
    expect(sourceAmount(line, { kind: "same_month_last_year" }, "2026-11", "2026-12", "2026-09")).toBe(500);
    expect(sourceAmount(line, { kind: "same_month_last_year" }, "2026-12", "2027-01", "2026-09")).toBeNull();
  });

  it("increases once, compounding every month, or stepping each January", () => {
    expect(applyAdjust(100, { mode: "percent", value: 10, every: "once" }, 3, "2026-09", "2026-12")).toBeCloseTo(110);
    expect(applyAdjust(100, { mode: "percent", value: 10, every: "month" }, 0, "2026-09", "2026-10")).toBeCloseTo(110);
    expect(applyAdjust(100, { mode: "percent", value: 10, every: "month" }, 2, "2026-09", "2026-12")).toBeCloseTo(133.1);
    expect(yearlySteps("2026-10", "2026-12")).toBe(0);
    expect(yearlySteps("2026-10", "2027-01")).toBe(1);
    expect(yearlySteps("2026-10", "2028-03")).toBe(2);
    expect(applyAdjust(2000, { mode: "percent", value: 3, every: "year" }, 5, "2026-10", "2027-03")).toBeCloseTo(2060);
    expect(applyAdjust(2000, { mode: "percent", value: 3, every: "year", stepMonth: 7 }, 5, "2026-10", "2027-03")).toBe(2000);
    expect(applyAdjust(100, { mode: "amount", value: 25, every: "month" }, 1, "2026-09", "2026-11")).toBe(150);
    expect(applyAdjust(100, { mode: "amount", value: -500, every: "once" }, 0, "2026-09", "2026-10")).toBe(0);
  });

  it("fills only months without a budget unless told to replace", () => {
    const l: FillLine = { key: "c:2", budgets: { "2026-09": 100, "2026-11": 999 }, spent: {} };
    const months = ["2026-10", "2026-11", "2026-12"];
    const keep = planFill({ lines: [l], months, source: { kind: "budget" }, overwrite: false, lastCompleteMonth: "2026-09" });
    expect(keep.map((r) => [r.month, r.amount])).toEqual([
      ["2026-10", 100],
      ["2026-12", 100],
    ]);
    const replace = planFill({ lines: [l], months, source: { kind: "budget" }, overwrite: true, lastCompleteMonth: "2026-09" });
    expect(replace.find((r) => r.month === "2026-11")).toMatchObject({ amount: 100, previous: 999 });
  });

  it("copies a month forward with a yearly increase in one fill", () => {
    const rent: FillLine = { key: "c:3", budgets: { "2026-10": 2000 }, spent: {} };
    const plan = planFill({
      lines: [rent],
      months: monthRange("2026-11", "2027-02"),
      source: { kind: "budget" },
      adjust: { mode: "percent", value: 3, every: "year" },
      overwrite: false,
      lastCompleteMonth: "2026-10",
    });
    expect(plan.map((r) => r.amount)).toEqual([2000, 2000, 2060, 2060]);
  });
});

describe("carryover", () => {
  const months = {
    "2026-08": { budgeted: 300, spent: 250 },
    "2026-09": { budgeted: 300, spent: 400 },
    "2026-10": { budgeted: 300, spent: 100 },
  };

  it("carries nothing before rollover was turned on", () => {
    expect(walkCarryover({ target: "2026-10", sets: {}, months, negative: "carry" })).toMatchObject({ carriedIn: 0, left: 200 });
  });

  it("carries leftover and overspending forward from the start month", () => {
    // Aug +50 → Sep 50+300−400 = −50 → Oct carries −50.
    expect(walkCarryover({ target: "2026-10", sets: { "2026-08": 0 }, months, negative: "carry" })).toMatchObject({
      carriedIn: -50,
      left: 150,
    });
    // With "reset", the overspent September carries 0.
    expect(walkCarryover({ target: "2026-10", sets: { "2026-08": 0 }, months, negative: "reset" })).toMatchObject({
      carriedIn: 0,
      left: 200,
    });
  });

  it("restarts from the latest reset or edit", () => {
    expect(walkCarryover({ target: "2026-10", sets: { "2026-08": 0, "2026-10": 0 }, months, negative: "carry" })).toMatchObject({
      carriedIn: 0,
      startMonth: "2026-10",
    });
    expect(walkCarryover({ target: "2026-10", sets: { "2026-08": 0, "2026-09": 500 }, months, negative: "carry" })).toMatchObject({
      carriedIn: 400,
      left: 600,
    });
  });
});

describe("debt lines", () => {
  const rows = [
    { date: "2026-10-01", payment: 500, principal: 420, interest: 80 },
    { date: "2026-10-15", payment: 500, principal: 422, interest: 78 },
    { date: "2026-10-29", payment: 500, principal: 424, interest: 76 },
    { date: "2026-11-12", payment: 500, principal: 426, interest: 74 },
  ];

  it("sums every payment dated in the month (a biweekly loan can have three)", () => {
    expect(scheduledInMonth(rows, "2026-10")).toEqual({
      planned: 1500,
      principal: 1266,
      interest: 234,
      dueDates: ["2026-10-01", "2026-10-15", "2026-10-29"],
    });
    expect(scheduledInMonth(rows, "2026-12").planned).toBe(0);
  });

  it("reads paid, due and late", () => {
    expect(debtStatus(1500, 1500, ["2026-10-01"], "2026-10-20")).toBe("paid");
    expect(debtStatus(1500, 1495, ["2026-10-01"], "2026-10-20")).toBe("paid");
    expect(debtStatus(1500, 1000, ["2026-10-01", "2026-10-29"], "2026-10-20")).toBe("late");
    expect(debtStatus(500, 0, ["2026-10-29"], "2026-10-20")).toBe("due");
    expect(debtStatus(0, 0, [], "2026-10-20")).toBe("none");
  });
});

describe("account roles and keys", () => {
  it("makes accounts linked to a scheduled loan debt payments; cards count by category", () => {
    expect(automaticBudgetRole(["mortgage"])).toBe("debt_payment");
    expect(automaticBudgetRole(["lease"])).toBe("debt_payment");
    expect(automaticBudgetRole(["credit_card"])).toBe("categories");
    expect(automaticBudgetRole([])).toBe("categories");
    expect(resolveBudgetRole("excluded", ["mortgage"])).toBe("excluded");
    expect(resolveBudgetRole(null, ["student_loan"])).toBe("debt_payment");
  });

  it("parses line keys", () => {
    expect(parseLineKey("c:12")).toEqual({ kind: "category", categoryId: 12 });
    expect(parseLineKey("g:Food & dining")).toEqual({ kind: "group", group: "Food & dining" });
    expect(parseLineKey("c:x")).toBeNull();
    expect(parseLineKey("x:1")).toBeNull();
  });
});

describe("month model", () => {
  const cat = (id: number, name: string, group: string, type: "E" | "I", extra: Partial<MonthCategoryInput> = {}): MonthCategoryInput => ({
    id, name, group, type, excluded: false, rollover: false, rolloverNegative: "carry", ...extra,
  });
  const base: BuildMonthInput = {
    month: "2026-10",
    currency: "USD",
    today: "2026-10-20",
    categories: [
      cat(1, "Groceries", "Food", "E"),
      cat(2, "Coffee", "Food", "E"),
      cat(3, "Rent", "Housing", "E", { rollover: true }),
      cat(4, "Gifts", "Other", "E", { excluded: true }),
      cat(5, "Salary", "Income", "I"),
      cat(6, "Snacks", "Treats", "E"),
      cat(7, "Candy", "Treats", "E"),
    ],
    groupSettings: new Map([["Treats", { excluded: false, byGroup: true, rollover: false, rolloverNegative: "carry" as const }]]),
    budgets: new Map([[1, 500], [3, 1000], [5, 5000]]),
    groupBudgets: new Map([["Treats", 80]]),
    actuals: new Map([[1, 420], [2, 30], [3, 900], [4, 200], [5, 5000], [6, 50], [7, 45]]),
    averages: new Map([[2, 28]]),
    carry: new Map([["c:3", { carriedIn: 100, left: 200 }]]),
    upcoming: new Map([[1, 120]]),
    debt: [
      {
        accountId: 9, name: "Car loan", planned: 587, paid: 587, principal: 500, interest: 87,
        bookedInterest: 87, dueDates: ["2026-10-01"], status: "paid", source: "schedule", loanIds: [1],
      },
    ],
    accounts: [],
  };

  it("lists every category, budgeted or not, and leaves excluded ones out of every total", () => {
    const m = buildBudgetMonth(base);
    const food = m.spending.find((g) => g.name === "Food")!;
    expect(food.lines.map((l) => [l.name, l.budgeted, l.status])).toEqual([
      ["Coffee", null, "unbudgeted"],
      ["Groceries", 500, "warn"],
    ]);
    expect(m.excluded.map((e) => e.name)).toEqual(["Gifts"]);
    expect(m.summary.spent).toBe(420 + 30 + 900 + 50 + 45);
  });

  it("carries leftover into a rollover line and budgets a group as one line", () => {
    const m = buildBudgetMonth(base);
    const rent = m.spending.find((g) => g.name === "Housing")!.lines[0];
    expect(rent).toMatchObject({ carriedIn: 100, left: 200, status: "ok" });
    const treats = m.spending.find((g) => g.name === "Treats")!;
    expect(treats).toMatchObject({ byGroup: true, budgeted: 80, actual: 95, left: -15, status: "over" });
    expect(treats.lines.every((l) => l.budgeted == null && l.left == null)).toBe(true);
  });

  it("does not list a loan's interest category unless something else is in it", () => {
    const withInterest: BuildMonthInput = {
      ...base,
      categories: [...base.categories, cat(8, "Loan interest", "Financial", "E")],
      coveredByLoan: new Set([8]),
    };
    expect(buildBudgetMonth(withInterest).spending.flatMap((g) => g.lines).some((l) => l.name === "Loan interest")).toBe(false);
    expect(buildBudgetMonth(withInterest).counts.notBudgeted).toBe(1);
    // Card interest in the same category still shows, so nothing is hidden.
    const cardInterest = { ...withInterest, actuals: new Map([...base.actuals, [8, 12]]) };
    expect(buildBudgetMonth(cardInterest).spending.flatMap((g) => g.lines).find((l) => l.name === "Loan interest")?.actual).toBe(12);
  });

  it("totals a cash-flow summary and counts what needs attention", () => {
    const m = buildBudgetMonth(base);
    // Planned spending: Groceries 500 + Rent 1000 + Treats 80 (Coffee unbudgeted).
    expect(m.summary).toMatchObject({
      plannedIncome: 5000,
      receivedIncome: 5000,
      plannedSpending: 1580,
      plannedDebt: 587,
      paidDebt: 587,
      leftToPlan: 5000 - 1580 - 587,
      netCashFlow: 5000 - (420 + 30 + 900 + 50 + 45) - 587,
    });
    expect(m.counts).toEqual({ notBudgeted: 1, overspent: 1, withUpcoming: 1 });
    expect(m.income[0].lines[0]).toMatchObject({ name: "Salary", budgeted: 5000, actual: 5000, status: "received" });
  });
});
