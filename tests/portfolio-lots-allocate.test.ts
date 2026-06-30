/**
 * FINLYNQ — whole-ticker lot allocation editor, pure planner.
 *
 * Covers planHoldingAllocation (allocate.ts), the single source of truth the
 * matrix UI mirrors and the DB orchestrator validates against:
 *   - FIFO-style allocation reproduces the expected closures + realized gain;
 *   - per-sell Σ qty must equal needed → qty_mismatch otherwise;
 *   - a future-dated lot (opened after the sale) is rejected (out-of-order
 *     guard);
 *   - chronological depletion — a lot consumed by an earlier sale is gone for
 *     a later one (overflow → short);
 *   - an explicit SHORT_LOT_ID entry opens a short with no error.
 */

import { describe, it, expect } from "vitest";
import {
  planHoldingAllocation,
  SHORT_LOT_ID,
  type AllocLot,
  type AllocSell,
} from "@/lib/portfolio/lots/allocate";

const lots: AllocLot[] = [
  { id: 2008, openDate: "2023-04-11", available: 7.37, costPerShare: 80.36, currency: "USD" },
  { id: 1993, openDate: "2023-07-12", available: 10.33, costPerShare: 87.87, currency: "USD" },
  { id: 1899, openDate: "2024-03-12", available: 10.86, costPerShare: 97.74, currency: "USD" },
];
const sellLate: AllocSell = {
  closeTxId: 87570,
  closeDate: "2026-04-09",
  proceedsPerShare: 125.3,
  qty: 21.19,
  currency: "USD",
};

describe("planHoldingAllocation", () => {
  it("plans a balanced allocation and sums realized gain", () => {
    const r = planHoldingAllocation({
      lots,
      sells: [sellLate],
      spec: {
        87570: [
          { lotId: 1993, qty: 10.33 },
          { lotId: 1899, qty: 10.86 },
        ],
      },
    });
    expect(r.ok).toBe(true);
    expect(r.openedShorts).toHaveLength(0);
    const g = (125.3 - 87.87) * 10.33 + (125.3 - 97.74) * 10.86;
    expect(r.totals.realizedGain).toBeCloseTo(g, 4);
    // Both lots opened 2023/2024, closed 2026 → long-term.
    expect(r.totals.longTerm).toBeCloseTo(g, 4);
    expect(r.totals.shortTerm).toBeCloseTo(0, 6);
    expect(r.totals.openShares).toBeCloseTo(7.37, 4); // lot 2008 untouched
  });

  it("rejects an unbalanced sell (qty_mismatch)", () => {
    const r = planHoldingAllocation({
      lots,
      sells: [sellLate],
      spec: { 87570: [{ lotId: 1993, qty: 5 }] },
    });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("qty_mismatch");
  });

  it("rejects allocating a lot that opened after the sale (out-of-order guard)", () => {
    const earlySell: AllocSell = {
      closeTxId: 1,
      closeDate: "2023-11-07",
      proceedsPerShare: 101.56,
      qty: 5,
      currency: "USD",
    };
    const r = planHoldingAllocation({
      lots,
      sells: [earlySell],
      // lot 1899 opened 2024-03-12, after the 2023-11-07 sale.
      spec: { 1: [{ lotId: 1899, qty: 5 }] },
    });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("lot_not_eligible");
  });

  it("depletes chronologically — a later sale overflows to a short", () => {
    const early: AllocSell = { closeTxId: 1, closeDate: "2023-11-07", proceedsPerShare: 101.56, qty: 7.37, currency: "USD" };
    const late: AllocSell = { closeTxId: 2, closeDate: "2026-04-09", proceedsPerShare: 125.3, qty: 7.37, currency: "USD" };
    const r = planHoldingAllocation({
      lots: [lots[0]], // only lot 2008 (7.37 available)
      sells: [early, late],
      spec: {
        1: [{ lotId: 2008, qty: 7.37 }], // early sale consumes it fully
        2: [{ lotId: 2008, qty: 7.37 }], // late sale finds it empty → short
      },
    });
    expect(r.ok).toBe(true);
    expect(r.openedShorts).toHaveLength(1);
    expect(r.openedShorts[0].closeTxId).toBe(2);
    expect(r.openedShorts[0].qty).toBeCloseTo(7.37, 4);
  });

  it("opens a short for an explicit SHORT_LOT_ID entry with no error", () => {
    const r = planHoldingAllocation({
      lots,
      sells: [{ ...sellLate, qty: 15 }],
      spec: {
        87570: [
          { lotId: 1993, qty: 10.33 },
          { lotId: SHORT_LOT_ID, qty: 4.67 },
        ],
      },
    });
    expect(r.ok).toBe(true);
    expect(r.openedShorts).toHaveLength(1);
    expect(r.openedShorts[0].qty).toBeCloseTo(4.67, 4);
  });
});
