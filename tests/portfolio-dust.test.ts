/**
 * Rounding leftovers in a position (src/lib/portfolio/dust.ts) and the MCP
 * side of the same rule (closeDustPosition in cost-metrics.ts). The figures
 * are the ones measured on prod 2026-10-14.
 */

import { describe, it, expect } from "vitest";
import { isDustQuantity } from "@/lib/portfolio/dust";
import { closeDustPosition, costMetrics } from "@/lib/portfolio/cost-metrics";

describe("isDustQuantity", () => {
  it("closes the prod fund leftovers (a few hundred-thousandths of a unit, worth cents)", () => {
    expect(isDustQuantity(-0.000049, { price: 612.24 })).toBe(true); // LEIG, -C$0.03
    expect(isDustQuantity(-0.000023, { price: 869.57 })).toBe(true); // LUSET, -C$0.02
    expect(isDustQuantity(0.000031, { price: 645.16 })).toBe(true); // LMCCG, +C$0.02
    expect(isDustQuantity(0.000034, { price: null })).toBe(true); // no price: units alone decide
  });

  it("closes floating-point noise, cash included", () => {
    expect(isDustQuantity(-2.09e-11, { isCash: true })).toBe(true);
    expect(isDustQuantity(5e-10)).toBe(true);
  });

  it("closes cash only below half a cent", () => {
    expect(isDustQuantity(0.004, { isCash: true })).toBe(true);
    expect(isDustQuantity(-0.004, { isCash: true })).toBe(true);
    expect(isDustQuantity(0.01, { isCash: true })).toBe(false);
  });

  it("never hides a real small holding of something expensive", () => {
    expect(isDustQuantity(0.00005, { price: 105000 })).toBe(false); // ≈ $5 of BTC
    expect(isDustQuantity(0.00009, { price: 700000 })).toBe(false); // a sliver of BRK.A
  });

  it("never hides a position of a ten-thousandth of a unit or more", () => {
    expect(isDustQuantity(0.0001, { price: 1 })).toBe(false);
    expect(isDustQuantity(-0.0001, { price: null })).toBe(false);
    expect(isDustQuantity(5, { price: 0 })).toBe(false);
  });

  it("is false for a non-number rather than hiding it", () => {
    expect(isDustQuantity(Number.NaN)).toBe(false);
  });
});

describe("closeDustPosition (MCP portfolio tools)", () => {
  const tallies = { buyQty: 0.981651, buyAmt: 660.05, sellQty: 0.9817, sellAmt: 703.22, remainingQty: -0.000049 };

  it("reports a leftover as closed: no units, no cost basis, realized gain kept", () => {
    const simple = closeDustPosition(-0.000049, costMetrics(tallies), 672.4);
    expect(simple).toMatchObject({ remainingQty: 0, avgCost: null, costBasis: null });
    expect(simple.realizedGain).toBeCloseTo(costMetrics(tallies).realizedGain, 6);

    // Lots left behind by an old rebuild still hold 0.6277 units at 689: the
    // position is closed all the same, and the lots' realized gain stays.
    const lot = { qty: 0.6277, costBasis: 432.46, realizedGain: 26 };
    expect(closeDustPosition(-0.000049, costMetrics(tallies, lot), 672.4)).toMatchObject({
      remainingQty: 0, avgCost: null, costBasis: null, realizedGain: 26,
    });
  });

  it("leaves a real position untouched", () => {
    const m = costMetrics({ buyQty: 10, buyAmt: 500, sellQty: 0, sellAmt: 0, remainingQty: 10 });
    expect(closeDustPosition(10, m, 50)).toEqual({ ...m, remainingQty: 10 });
  });
});
