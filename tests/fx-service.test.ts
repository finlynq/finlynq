import { describe, it, expect, vi } from "vitest";
import { convertCurrency, convertWithRateMap } from "@/lib/fx-service";

// Only test pure functions that don't need DB
describe("convertCurrency", () => {
  it("converts amount with rate", () => {
    expect(convertCurrency(100, 1.36)).toBe(136);
  });

  it("rounds to 2 decimal places", () => {
    expect(convertCurrency(100.555, 1)).toBe(100.56);
  });

  it("handles rate of 1 (same currency)", () => {
    expect(convertCurrency(100, 1)).toBe(100);
  });

  it("handles zero amount", () => {
    expect(convertCurrency(0, 1.36)).toBe(0);
  });

  it("handles negative amounts", () => {
    expect(convertCurrency(-100, 1.36)).toBe(-136);
  });
});

describe("convertWithRateMap", () => {
  it("converts using rate map", () => {
    const rateMap = new Map([["CAD", 1], ["USD", 1.36]]);
    expect(convertWithRateMap(100, "USD", rateMap)).toBe(136);
  });

  it("defaults to rate 1 for unknown currency", () => {
    const rateMap = new Map([["CAD", 1]]);
    expect(convertWithRateMap(100, "EUR", rateMap)).toBe(100);
  });

  it("handles same currency (rate 1)", () => {
    const rateMap = new Map([["CAD", 1]]);
    expect(convertWithRateMap(100, "CAD", rateMap)).toBe(100);
  });
});
