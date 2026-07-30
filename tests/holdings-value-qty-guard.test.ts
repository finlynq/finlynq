/**
 * Regression guard for review 2026-07-30 finding #2.
 *
 * `valueHoldingsAtDate` used to skip every holding whose net quantity was
 * `<= 0`, which correctly dropped sold-out positions but ALSO deleted
 * net-negative ones (overdrawn cash sleeves, shorts) from account balances,
 * net-worth snapshots, goals progress and the MCP balance tools — while
 * `/api/portfolio/overview` kept them (`quantity !== 0`). These assertions pin
 * the corrected contract so nobody re-introduces the `<= 0` form.
 *
 * Pure — no DB, no pricing, no FX.
 */

import { describe, it, expect } from "vitest";
import { isMaterialQty, QTY_EPSILON } from "@/lib/holdings-value";

describe("isMaterialQty — holdings valuation inclusion rule", () => {
  it("keeps ordinary long positions", () => {
    expect(isMaterialQty(1)).toBe(true);
    expect(isMaterialQty(0.5)).toBe(true);
    expect(isMaterialQty(1_000_000)).toBe(true);
  });

  it("keeps a net-negative cash sleeve (invariant tc-1b: −1000 must report as −1000)", () => {
    expect(isMaterialQty(-1000)).toBe(true);
  });

  it("keeps a short position", () => {
    expect(isMaterialQty(-25)).toBe(true);
    expect(isMaterialQty(-0.0001)).toBe(true);
  });

  it("drops a fully sold-out position", () => {
    expect(isMaterialQty(0)).toBe(false);
    expect(isMaterialQty(-0)).toBe(false);
  });

  it("drops IEEE-754 float dust in BOTH directions", () => {
    expect(isMaterialQty(QTY_EPSILON / 10)).toBe(false);
    expect(isMaterialQty(-QTY_EPSILON / 10)).toBe(false);
    // 0.1 + 0.2 - 0.3 ≈ 5.5e-17 — the classic residue a buy/sell round-trip leaves.
    expect(isMaterialQty(0.1 + 0.2 - 0.3)).toBe(false);
  });

  it("treats the epsilon itself as material (inclusive boundary, symmetric)", () => {
    expect(isMaterialQty(QTY_EPSILON)).toBe(true);
    expect(isMaterialQty(-QTY_EPSILON)).toBe(true);
  });

  it("drops non-finite quantities rather than valuing NaN × price", () => {
    expect(isMaterialQty(Number.NaN)).toBe(false);
    expect(isMaterialQty(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isMaterialQty(Number.NEGATIVE_INFINITY)).toBe(false);
  });
});
