import { describe, it, expect } from "vitest";
import {
  calculateHistoricalVolatility,
  runMonteCarloSimulation,
} from "@/lib/monte-carlo";

describe("calculateHistoricalVolatility", () => {
  it("returns default 15 for less than 2 data points", () => {
    expect(calculateHistoricalVolatility([])).toBe(15);
    expect(calculateHistoricalVolatility([10])).toBe(15);
  });

  it("returns 0 for identical returns", () => {
    expect(calculateHistoricalVolatility([5, 5, 5, 5])).toBeCloseTo(0);
  });

  it("computes standard deviation correctly", () => {
    // Known dataset: [2, 4, 4, 4, 5, 5, 7, 9] -> stdev ≈ 2.138
    const vol = calculateHistoricalVolatility([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(vol).toBeCloseTo(2.138, 1);
  });
});

describe("runMonteCarloSimulation", () => {
  const baseParams = {
    currentInvestments: 100000,
    monthlySavings: 2000,
    annualReturn: 7,
    annualVolatility: 15,
    inflation: 2,
    yearsToSimulate: 10,
    numSimulations: 100,
    withdrawalRate: 4,
    annualExpenses: 50000,
  };

  it("computes correct FIRE number", () => {
    const result = runMonteCarloSimulation(baseParams);
    // FIRE number = annualExpenses / (withdrawalRate / 100) = 50000 / 0.04 = 1,250,000
    expect(result.fireNumber).toBe(1250000);
  });

  it("returns percentile paths with correct length", () => {
    const result = runMonteCarloSimulation(baseParams);
    // years array: [0, 1, ..., 10] = 11 elements
    expect(result.years).toHaveLength(11);
    expect(result.percentilePaths.p10).toHaveLength(11);
    expect(result.percentilePaths.p50).toHaveLength(11);
    expect(result.percentilePaths.p90).toHaveLength(11);
  });

  it("all paths start at currentInvestments", () => {
    const result = runMonteCarloSimulation(baseParams);
    expect(result.percentilePaths.p10[0]).toBe(baseParams.currentInvestments);
    expect(result.percentilePaths.p50[0]).toBe(baseParams.currentInvestments);
    expect(result.percentilePaths.p90[0]).toBe(baseParams.currentInvestments);
  });

  it("p10 <= p25 <= p50 <= p75 <= p90 at each year", () => {
    const result = runMonteCarloSimulation(baseParams);
    for (let y = 0; y <= baseParams.yearsToSimulate; y++) {
      expect(result.percentilePaths.p10[y]).toBeLessThanOrEqual(result.percentilePaths.p25[y]);
      expect(result.percentilePaths.p25[y]).toBeLessThanOrEqual(result.percentilePaths.p50[y]);
      expect(result.percentilePaths.p50[y]).toBeLessThanOrEqual(result.percentilePaths.p75[y]);
      expect(result.percentilePaths.p75[y]).toBeLessThanOrEqual(result.percentilePaths.p90[y]);
    }
  });

  it("success probability is between 0 and 100", () => {
    const result = runMonteCarloSimulation(baseParams);
    expect(result.successProbability).toBeGreaterThanOrEqual(0);
    expect(result.successProbability).toBeLessThanOrEqual(100);
  });

  it("final values match last element of percentile paths", () => {
    const result = runMonteCarloSimulation(baseParams);
    const last = baseParams.yearsToSimulate;
    expect(result.finalValues.p10).toBe(result.percentilePaths.p10[last]);
    expect(result.finalValues.p50).toBe(result.percentilePaths.p50[last]);
    expect(result.finalValues.p90).toBe(result.percentilePaths.p90[last]);
  });

  it("with zero volatility and positive return, portfolio always grows", () => {
    const result = runMonteCarloSimulation({
      ...baseParams,
      annualVolatility: 0.001, // near-zero
      numSimulations: 50,
    });
    // p10 should still grow (positive real return + savings)
    expect(result.percentilePaths.p10[10]).toBeGreaterThan(baseParams.currentInvestments);
  });
});
