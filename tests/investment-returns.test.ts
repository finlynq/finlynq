import { describe, it, expect } from "vitest";
import { xirr, twr, analyzeDividends } from "@/lib/investment-returns";

describe("xirr", () => {
  it("returns 0 for fewer than 2 cash flows", () => {
    expect(xirr([{ date: new Date("2024-01-01"), amount: -1000 }])).toBe(0);
    expect(xirr([])).toBe(0);
  });

  it("computes positive return for profitable investment", () => {
    const cashFlows = [
      { date: new Date("2023-01-01"), amount: -10000 },
      { date: new Date("2024-01-01"), amount: 11000 },
    ];
    const result = xirr(cashFlows);
    // ~10% return
    expect(result).toBeCloseTo(10, 0);
  });

  it("computes negative return for losing investment", () => {
    const cashFlows = [
      { date: new Date("2023-01-01"), amount: -10000 },
      { date: new Date("2024-01-01"), amount: 9000 },
    ];
    const result = xirr(cashFlows);
    expect(result).toBeLessThan(0);
  });

  it("handles multiple cash flows", () => {
    const cashFlows = [
      { date: new Date("2023-01-01"), amount: -5000 },
      { date: new Date("2023-07-01"), amount: -5000 },
      { date: new Date("2024-01-01"), amount: 11000 },
    ];
    const result = xirr(cashFlows);
    expect(result).toBeGreaterThan(0);
  });
});

describe("twr", () => {
  it("returns 0 for empty periods", () => {
    expect(twr([])).toBe(0);
  });

  it("computes correct return for single period", () => {
    // Start 100, end 110, no cash flow → 10% return
    const result = twr([{ startValue: 100, endValue: 110, cashFlow: 0 }]);
    expect(result).toBeCloseTo(10, 0);
  });

  it("adjusts for cash flows", () => {
    // Start 100, add 50, end 165 → (165 / (100+50)) - 1 = 10%
    const result = twr([{ startValue: 100, endValue: 165, cashFlow: 50 }]);
    expect(result).toBeCloseTo(10, 0);
  });

  it("chains multiple periods correctly", () => {
    // Period 1: 100 → 110 (10%), Period 2: 110 → 121 (10%) → cumulative ≈ 21%
    const result = twr([
      { startValue: 100, endValue: 110, cashFlow: 0 },
      { startValue: 110, endValue: 121, cashFlow: 0 },
    ]);
    expect(result).toBeCloseTo(21, 0);
  });

  it("handles period with zero adjusted start (skips it)", () => {
    const result = twr([
      { startValue: 0, endValue: 100, cashFlow: 0 },
      { startValue: 100, endValue: 110, cashFlow: 0 },
    ]);
    expect(result).toBeCloseTo(10, 0);
  });
});

describe("analyzeDividends", () => {
  const dividends = [
    { date: "2023-03-15", amount: 100 },
    { date: "2023-06-15", amount: 100 },
    { date: "2023-09-15", amount: 100 },
    { date: "2023-12-15", amount: 100 },
    { date: "2024-03-15", amount: 120 },
  ];

  it("sums total dividends correctly", () => {
    const result = analyzeDividends(dividends, 10000);
    expect(result.totalDividends).toBe(520);
  });

  it("groups by year correctly", () => {
    const result = analyzeDividends(dividends, 10000);
    expect(result.dividendsByYear["2023"]).toBe(400);
    expect(result.dividendsByYear["2024"]).toBe(120);
  });

  it("groups by month correctly", () => {
    const result = analyzeDividends(dividends, 10000);
    expect(result.dividendsByMonth["2023-03"]).toBe(100);
    expect(result.dividendsByMonth["2024-03"]).toBe(120);
  });

  it("computes average monthly dividend", () => {
    const result = analyzeDividends(dividends, 10000);
    // 520 / 5 unique months = 104
    expect(result.avgMonthlyDividend).toBe(104);
  });

  it("computes yield on cost", () => {
    const result = analyzeDividends(dividends, 10000);
    // 520 / 10000 * 100 = 5.2%
    expect(result.yieldOnCost).toBeCloseTo(5.2, 1);
  });

  it("returns 0 yield when totalInvested is 0", () => {
    const result = analyzeDividends(dividends, 0);
    expect(result.yieldOnCost).toBe(0);
  });

  it("handles empty dividends", () => {
    const result = analyzeDividends([], 10000);
    expect(result.totalDividends).toBe(0);
    expect(result.avgMonthlyDividend).toBe(0);
  });
});
