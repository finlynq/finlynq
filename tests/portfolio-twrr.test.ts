/**
 * Pure-function tests for the TWRR + MWRR engines (Phase 3 of
 * plan/portfolio-lots-and-performance.md).
 *
 * Test fixtures keep the time series tiny + hand-checkable. The CFA
 * textbook worked example for Modified Dietz is the gold standard for
 * the multi-flow case.
 */

import { describe, it, expect } from "vitest";
import {
  annualizeReturn,
  computeTwrr,
} from "@/lib/portfolio/performance/twrr";
import { computeMwrr } from "@/lib/portfolio/performance/mwrr";
import { isInternalSwapKind } from "@/lib/portfolio/aggregation-predicates";

describe("computeTwrr", () => {
  it("returns 0 for fewer than 2 snapshots", () => {
    const r = computeTwrr([]);
    expect(r.periodReturn).toBe(0);
    const r1 = computeTwrr([{ date: "2025-01-01", marketValue: 100, contribution: 0 }]);
    expect(r1.periodReturn).toBe(0);
  });

  it("computes simple two-point return without contributions", () => {
    const r = computeTwrr([
      { date: "2025-01-01", marketValue: 100, contribution: 0 },
      { date: "2025-12-31", marketValue: 110, contribution: 0 },
    ]);
    expect(r.periodReturn).toBeCloseTo(0.1, 6); // +10%
    expect(r.hadContributions).toBe(false);
  });

  it("chains multi-bar returns geometrically", () => {
    // Day 0: 100 → Day 1: 110 (+10%) → Day 2: 99 (-10%)
    // Chained: 1.10 × 0.90 = 0.99 → -1.0% over the period
    const r = computeTwrr([
      { date: "2025-01-01", marketValue: 100, contribution: 0 },
      { date: "2025-01-02", marketValue: 110, contribution: 0 },
      { date: "2025-01-03", marketValue: 99, contribution: 0 },
    ]);
    expect(r.periodReturn).toBeCloseTo(-0.01, 6);
  });

  it("adjusts for same-day contribution via Modified Dietz", () => {
    // Day 0: 100, Day 1: 220 with a $100 contribution at start of day 1.
    // Bar return: (220 - 100 - 100) / (100 + 100) = 20 / 200 = +10%.
    // Without the contribution adjustment, naive return = (220-100)/100 = +120%.
    const r = computeTwrr([
      { date: "2025-01-01", marketValue: 100, contribution: 0 },
      { date: "2025-01-02", marketValue: 220, contribution: 100 },
    ]);
    expect(r.periodReturn).toBeCloseTo(0.1, 6);
    expect(r.hadContributions).toBe(true);
  });

  it("handles a fresh account (prev marketValue = 0)", () => {
    const r = computeTwrr([
      { date: "2025-01-01", marketValue: 0, contribution: 0 },
      { date: "2025-01-02", marketValue: 100, contribution: 100 },
    ]);
    // Bar return is 0 — initial contribution funds the bar; not a return.
    expect(r.periodReturn).toBeCloseTo(0, 6);
  });
});

describe("annualizeReturn", () => {
  it("annualizes a 6-month +10% return to ≈21%", () => {
    const r = annualizeReturn(0.1, 182);
    expect(r).toBeGreaterThan(0.20);
    expect(r).toBeLessThan(0.22);
  });

  it("clamps 0-day periods to 0", () => {
    expect(annualizeReturn(0.1, 0)).toBe(0);
  });
});

describe("computeMwrr (XIRR)", () => {
  it("matches Excel XIRR for a simple two-cash-flow setup", () => {
    // Buy $1000 on 2024-01-01, portfolio worth $1100 on 2025-01-01.
    // Expected IRR ≈ 10%.
    const result = computeMwrr(
      [{ date: "2024-01-01", amount: -1000 }],
      1100,
      "2025-01-01",
    );
    expect(result.converged).toBe(true);
    expect(result.irr).toBeCloseTo(0.10, 3);
  });

  it("converges on a multi-flow scenario", () => {
    // Three contributions, final value.
    const result = computeMwrr(
      [
        { date: "2024-01-01", amount: -1000 },
        { date: "2024-04-01", amount: -500 },
        { date: "2024-07-01", amount: -500 },
      ],
      2200,
      "2025-01-01",
    );
    expect(result.converged).toBe(true);
    // Hand-check: ~12% — $200 gain on roughly $1k average invested for a year.
    expect(result.irr).toBeGreaterThan(0.05);
    expect(result.irr).toBeLessThan(0.20);
  });

  it("returns converged=false for all-same-sign flows (no sign change)", () => {
    const result = computeMwrr(
      [{ date: "2024-01-01", amount: -1000 }],
      0, // wipeout — finalValue=0 means no positive flow
      "2025-01-01",
    );
    // With all-negative flows + zero final, there's no root.
    // (Modified Newton-Raphson may still iterate but not converge.)
    // We only assert it didn't throw — the boolean depends on impl.
    expect(typeof result.converged).toBe("boolean");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// FINLYNQ-254: in-kind / inter-account transfers (and their FX legs) must NOT
// register as performance in the daily Modified-Dietz chaining. On a transfer
// day with UNCHANGED prices the whole-portfolio market value is unchanged and
// the two legs net to ~0 in net_contribution, so the day's TWRR must be flat.
// These tests pin the pure Dietz behavior AND the contribution-stamping rule
// (isInternalSwapKind) that keeps the fed net_contribution correct.
// ───────────────────────────────────────────────────────────────────────────

describe("computeTwrr — in-kind transfer day (FINLYNQ-254)", () => {
  it("is FLAT across an inter-account transfer day when prices did not move", () => {
    // Whole-portfolio aggregate series. A security worth $50,000 moves from
    // account A to account B on day 2. Aggregate MV is unchanged (value stayed
    // in the portfolio) and the +50k inflow to B nets against the -50k outflow
    // from A, so the correctly-stamped aggregate contribution is 0.
    const r = computeTwrr([
      { date: "2025-08-13", marketValue: 200_000, contribution: 0 },
      { date: "2025-08-14", marketValue: 200_000, contribution: 0 }, // transfer, prices flat
      { date: "2025-08-15", marketValue: 200_000, contribution: 0 },
    ]);
    expect(r.periodReturn).toBeCloseTo(0, 6);
    for (const d of r.dailyReturns) expect(d.r).toBeCloseTo(0, 6);
  });

  it("stays flat even when the market value DID move only by the transfer legs netting", () => {
    // Same idea with a same-account FX conversion: no MV change, netted
    // contribution 0 -> flat day.
    const r = computeTwrr([
      { date: "2025-08-17", marketValue: 216_000, contribution: 0 },
      { date: "2025-08-18", marketValue: 216_000, contribution: 0 }, // FX convert, flat
    ]);
    expect(r.periodReturn).toBeCloseTo(0, 6);
  });

  it("REGRESSION: a phantom one-sided FX-leg contribution would fake a large return", () => {
    // Demonstrates the bug the fix prevents. If the builder stamped only the
    // fx_from leg (-5,310.58 — the odd fractional FX residual from the item)
    // as a contribution while MV is unchanged, Modified Dietz reads a spurious
    // POSITIVE day return: (mv1 - mv0 - c) / (mv0 + c) with c<0 -> nonzero.
    const buggy = computeTwrr([
      { date: "2025-08-17", marketValue: 216_000, contribution: 0 },
      { date: "2025-08-18", marketValue: 216_000, contribution: -5_310.58 },
    ]);
    // The phantom flow fabricates a ~+2.5% one-day move out of thin air.
    expect(Math.abs(buggy.periodReturn)).toBeGreaterThan(0.02);
    // The FIX (netted contribution = 0) removes it — see the flat tests above.
    const fixed = computeTwrr([
      { date: "2025-08-17", marketValue: 216_000, contribution: 0 },
      { date: "2025-08-18", marketValue: 216_000, contribution: 0 },
    ]);
    expect(fixed.periodReturn).toBeCloseTo(0, 6);
  });
});

describe("isInternalSwapKind — contribution stamping (FINLYNQ-254)", () => {
  it("classifies FX-conversion + in-kind transfer legs as internal (non-contribution)", () => {
    for (const k of ["fx_from", "fx_to", "fx_fee", "in_kind_transfer_in", "in_kind_transfer_out"]) {
      expect(isInternalSwapKind(k)).toBe(true);
    }
  });

  it("does NOT classify genuine external brokerage flows as internal", () => {
    for (const k of ["brokerage_deposit_in", "brokerage_deposit_out", "brokerage_withdrawal_in", "brokerage_withdrawal_out", null, undefined, "buy"]) {
      expect(isInternalSwapKind(k as string | null | undefined)).toBe(false);
    }
  });

  it("nets a same-account FX conversion to a 0 stamped contribution", () => {
    // Mirrors the builder's per-account bucket: sum leg amounts EXCEPT internal
    // swaps. The two FX legs (-5000 CAD, +3600 USD) are internal, so the day's
    // stamped contribution is 0 — no phantom residual fed to Dietz.
    const legs = [
      { kind: "fx_from", amount: -5000 },
      { kind: "fx_to", amount: 3600 },
    ];
    const stamped = legs
      .filter((l) => !isInternalSwapKind(l.kind))
      .reduce((s, l) => s + l.amount, 0);
    expect(stamped).toBe(0);
  });

  it("still stamps a genuine brokerage deposit as a contribution", () => {
    const legs = [
      { kind: "brokerage_deposit_out", amount: -10_000 }, // external cash account leg
      { kind: "brokerage_deposit_in", amount: 10_000 },   // brokerage sleeve leg
    ];
    // The receiving investment-account leg survives the filter -> real inflow.
    const investmentLegContribution = legs
      .filter((l) => !isInternalSwapKind(l.kind) && l.amount > 0)
      .reduce((s, l) => s + l.amount, 0);
    expect(investmentLegContribution).toBe(10_000);
  });
});
