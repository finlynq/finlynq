/**
 * Budget rules, pure parts (plan/budget-rules.md): what a rule gives a month,
 * how an open month's stored row follows its rules and adjustment, which old
 * rules a new one ends, and the words for an increase.
 */
import { describe, it, expect } from "vitest";
import {
  computedMonthTotal,
  describeIncrease,
  increaseSteps,
  monthsAfter,
  nextOpenMonth,
  planRuleReplacement,
  ruleAmountForMonth,
  rulesTotalForMonth,
  type RuleShape,
} from "@/lib/budgets/rules";

const rule = (r: Partial<RuleShape> & Pick<RuleShape, "amount" | "startMonth">): RuleShape => ({
  currency: "USD",
  endMonth: null,
  increase: null,
  ...r,
});

describe("increaseSteps", () => {
  it("counts yearly steps after the start month, never in it", () => {
    const r = { startMonth: "2026-10", increase: { mode: "percent" as const, value: 3, every: "year" as const, stepMonth: 1 } };
    expect(increaseSteps(r, "2026-10")).toBe(0);
    expect(increaseSteps(r, "2026-12")).toBe(0);
    expect(increaseSteps(r, "2027-01")).toBe(1);
    expect(increaseSteps(r, "2027-12")).toBe(1);
    expect(increaseSteps(r, "2028-01")).toBe(2);
  });

  it("a rule starting in its step month waits a full year", () => {
    const r = { startMonth: "2027-01", increase: { mode: "percent" as const, value: 3, every: "year" as const, stepMonth: 1 } };
    expect(increaseSteps(r, "2027-01")).toBe(0);
    expect(increaseSteps(r, "2027-12")).toBe(0);
    expect(increaseSteps(r, "2028-01")).toBe(1);
  });

  it("monthly steps are the months since the start", () => {
    const r = { startMonth: "2026-11", increase: { mode: "amount" as const, value: 10, every: "month" as const } };
    expect(increaseSteps(r, "2026-11")).toBe(0);
    expect(increaseSteps(r, "2027-02")).toBe(3);
  });

  it("monthsAfter", () => {
    expect(monthsAfter("2026-10", "2027-01")).toBe(3);
    expect(monthsAfter("2027-01", "2026-10")).toBe(-3);
  });
});

describe("the worked example (plan/budget-rules.md)", () => {
  const a = rule({ amount: 100, startMonth: "2026-10", endMonth: "2027-07", increase: { mode: "percent", value: 3, every: "year", stepMonth: 1 } });
  const b = rule({ amount: 300, startMonth: "2027-01" });
  const total = (m: string) => rulesTotalForMonth([a, b], m, (x) => x).total;

  it("Oct-Dec 2026 = 100, Jan-Jul 2027 = 403, from Aug 2027 = 300", () => {
    expect(total("2026-09")).toBe(0);
    expect(total("2026-10")).toBe(100);
    expect(total("2026-12")).toBe(100);
    expect(total("2027-01")).toBe(403);
    expect(total("2027-07")).toBe(403);
    expect(total("2027-08")).toBe(300);
    expect(total("2030-05")).toBe(300);
  });

  it("an active-rule count comes back too", () => {
    expect(rulesTotalForMonth([a, b], "2027-03", (x) => x).active).toBe(2);
    expect(rulesTotalForMonth([a, b], "2026-09", (x) => x).active).toBe(0);
  });

  it("a rule is inactive outside its months", () => {
    expect(ruleAmountForMonth(a, "2026-09")).toBeNull();
    expect(ruleAmountForMonth(a, "2027-08")).toBeNull();
  });

  it("compounds a percent and never goes below 0", () => {
    const c = rule({ amount: 100, startMonth: "2026-01", increase: { mode: "percent", value: 10, every: "month" } });
    expect(ruleAmountForMonth(c, "2026-03")).toBe(121);
    const d = rule({ amount: 50, startMonth: "2026-01", increase: { mode: "amount", value: -20, every: "month" } });
    expect(ruleAmountForMonth(d, "2026-04")).toBe(0);
  });

  it("converts each rule from its own currency", () => {
    const cad = rule({ amount: 100, startMonth: "2026-01", currency: "CAD" });
    expect(rulesTotalForMonth([cad], "2026-02", (x, c) => (c === "CAD" ? x * 0.7 : x)).total).toBe(70);
  });
});

describe("nextOpenMonth", () => {
  it("no row + rules → a rule-made row", () => {
    expect(nextOpenMonth(null, 400, 2)).toEqual({ amount: 400, rulesAmount: 400, override: false });
  });

  it("a typed amount stays as typed and the rules add to it", () => {
    // Typed 50 before any rule existed (rulesAmount null).
    expect(nextOpenMonth({ amount: 50, rulesAmount: null, override: false }, 400, 1)).toEqual({ amount: 450, rulesAmount: 400, override: false });
  });

  it("a rule change keeps the adjustment", () => {
    expect(nextOpenMonth({ amount: 450, rulesAmount: 400, override: false }, 300, 1)).toEqual({ amount: 350, rulesAmount: 300, override: false });
  });

  it("a negative adjustment can take the month below 0", () => {
    expect(nextOpenMonth({ amount: -50, rulesAmount: 100, override: false }, 100, 1)).toBeUndefined();
    expect(nextOpenMonth({ amount: -150, rulesAmount: 0, override: false }, 100, 1)).toEqual({ amount: -50, rulesAmount: 100, override: false });
  });

  it("override is left alone", () => {
    expect(nextOpenMonth({ amount: 80, rulesAmount: null, override: true }, 400, 1)).toBeUndefined();
  });

  it("no rules left: a rule-only row goes, an adjustment stays as a plain value", () => {
    expect(nextOpenMonth({ amount: 400, rulesAmount: 400, override: false }, 0, 0)).toBeNull();
    expect(nextOpenMonth({ amount: 450, rulesAmount: 400, override: false }, 0, 0)).toEqual({ amount: 50, rulesAmount: null, override: false });
  });

  it("a line that never had rules is untouched", () => {
    expect(nextOpenMonth({ amount: 75, rulesAmount: null, override: false }, 0, 0)).toBeUndefined();
    expect(nextOpenMonth(null, 0, 0)).toBeUndefined();
  });

  it("unchanged rows are not rewritten", () => {
    expect(nextOpenMonth({ amount: 400, rulesAmount: 400, override: false }, 400, 1)).toBeUndefined();
  });

  it("computedMonthTotal matches what would be stored", () => {
    expect(computedMonthTotal(null, 400, 1)).toBe(400);
    expect(computedMonthTotal({ amount: 450, rulesAmount: 400, override: false }, 300, 1)).toBe(350);
    expect(computedMonthTotal({ amount: 80, rulesAmount: null, override: true }, 300, 1)).toBe(80);
    expect(computedMonthTotal({ amount: 400, rulesAmount: 400, override: false }, 0, 0)).toBeNull();
    expect(computedMonthTotal(null, 0, 0)).toBeNull();
  });
});

describe("planRuleReplacement", () => {
  const existing = [
    { id: 1, startMonth: "2026-01", endMonth: null },
    { id: 2, startMonth: "2027-03", endMonth: "2027-06" },
    { id: 3, startMonth: "2025-01", endMonth: "2025-12" },
  ];

  it("ends an earlier overlapping rule the month before, removes one inside, keeps one that ended", () => {
    expect(planRuleReplacement(existing, "2026-11", null)).toEqual({ end: [{ id: 1, endMonth: "2026-10" }], remove: [2] });
  });

  it("a rule after the new one's end is kept", () => {
    expect(planRuleReplacement(existing, "2026-11", "2027-01")).toEqual({ end: [{ id: 1, endMonth: "2026-10" }], remove: [] });
  });
});

describe("describeIncrease", () => {
  const fmt = (n: number) => `$${n}`;
  it("words", () => {
    expect(describeIncrease({ mode: "percent", value: 3, every: "year", stepMonth: 1 }, fmt)).toBe("+3% every January");
    expect(describeIncrease({ mode: "amount", value: -25, every: "month" }, fmt)).toBe("−$25 every month");
    expect(describeIncrease(null, fmt)).toBe("");
  });
});
