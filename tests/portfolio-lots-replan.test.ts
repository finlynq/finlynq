/**
 * FINLYNQ-176 — pure unit tests for the lot reallocation re-plan core
 * (`planLotReallocation`, src/lib/portfolio/lots/replan.ts).
 *
 * No DB I/O — hand-built lots/closures fixtures (mirrors
 * tests/portfolio-lots-engine.test.ts). Covers the load-bearing rules:
 *
 *   - deleting a fully-sold buy reallocates the sell's closure to the next
 *     FIFO lot when inventory exists;
 *   - when no long inventory remains, the closure forces a short-lot open;
 *   - the implied net position (Σ long qtyRemaining after replay − Σ short)
 *     equals the holding's live SUM(quantity) — position qty is invariant;
 *   - realizedGainDeltaByYear is populated when the cost basis changes;
 *   - a target with no dependent closures yields an empty preview (no-op).
 */

import { describe, it, expect } from "vitest";
import { planLotReallocation } from "@/lib/portfolio/lots/replan";
import type { DependentCloseInput } from "@/lib/portfolio/lots/replan";
import type {
  HoldingLot,
  HoldingLotClosure,
  TxRowForLots,
} from "@/lib/portfolio/lots/types";

// ─── fixtures ──────────────────────────────────────────────────────────────

const lot = (overrides: Partial<HoldingLot> = {}): HoldingLot => ({
  id: 1,
  userId: "u",
  holdingId: 200,
  accountId: 100,
  openTxId: 1,
  openDate: "2024-01-15",
  qtyOriginal: 10,
  qtyRemaining: 10,
  costPerShare: 100,
  currency: "USD",
  fxToUsdAtOpen: null,
  origin: "buy",
  parentLotId: null,
  status: "open",
  side: "long",
  source: "manual",
  ...overrides,
});

const tx = (overrides: Partial<TxRowForLots> = {}): TxRowForLots => ({
  id: 99,
  userId: "u",
  date: "2025-06-01",
  amount: -1500,
  currency: "USD",
  enteredAmount: -1500,
  enteredCurrency: "USD",
  quantity: -10,
  accountId: 100,
  categoryId: null,
  portfolioHoldingId: 200,
  tradeLinkId: null,
  source: "manual",
  ...overrides,
});

const closure = (
  overrides: Partial<HoldingLotClosure> = {},
): HoldingLotClosure => ({
  id: 1,
  userId: "u",
  lotId: 1,
  closeTxId: 99,
  closeDate: "2025-06-01",
  qtyClosed: 10,
  proceedsPerShare: 150,
  costPerShare: 100,
  realizedGain: 500,
  currency: "USD",
  daysHeld: 100,
  closeKind: "sell",
  source: "manual",
  ...overrides,
});

const dep = (
  txOv: Partial<TxRowForLots>,
  closures: HoldingLotClosure[],
): DependentCloseInput => ({ tx: tx(txOv), originalClosures: closures });

// ─── reallocate to another lot when inventory exists ─────────────────────

describe("planLotReallocation — reallocate to next FIFO lot", () => {
  it("re-points a fully-sold buy's closure to a surviving lot on delete", () => {
    // Lot A (id=1, openTx=1, cost 100) was fully consumed by sell S (tx 99).
    // The user deletes the buy that opened A. After reversal, A is gone and
    // a second open lot B (id=2, openTx=2, cost 120, 10 sh) remains.
    const lotB = lot({
      id: 2,
      openTxId: 2,
      openDate: "2024-03-01",
      costPerShare: 120,
      qtyRemaining: 10,
    });
    const preview = planLotReallocation({
      mutation: { op: "delete", targetTxId: 1 },
      lots: [lotB], // post-reversal snapshot: only B remains
      dependentCloses: [
        dep({ id: 99, quantity: -10 }, [
          closure({ lotId: 1, qtyClosed: 10, costPerShare: 100, realizedGain: 500 }),
        ]),
      ],
    });

    expect(preview.dependentCloseTxIds).toEqual([99]);
    expect(preview.openedShortLots).toHaveLength(0);
    expect(preview.proposedClosures).toHaveLength(1);
    const pc = preview.proposedClosures[0];
    expect(pc.closeTxId).toBe(99);
    expect(pc.lotId).toBe(2); // re-pointed to lot B
    expect(pc.qtyClosed).toBe(10);
    expect(pc.costPerShare).toBe(120); // B's cost
    expect(pc.proceedsPerShare).toBe(150);
    expect(pc.realizedGain).toBe((150 - 120) * 10); // 300, was 500
    expect(pc.isNewShortLot).toBe(false);

    // Realized-gain restatement: 2025 delta = new 300 − old 500 = −200.
    expect(preview.realizedGainDeltaByYear["2025"]).toBe(-200);

    // Net position invariant: B had 10 sh, the closure consumes 10 → net 0,
    // matching the live SUM(quantity) of buy(+10 from B's tx) + sell(−10).
    const netLong = 10 - pc.qtyClosed; // B remaining
    expect(netLong).toBe(0);
  });
});

// ─── open a short lot when no inventory remains ──────────────────────────

describe("planLotReallocation — auto-open short on insufficient inventory", () => {
  it("forces a short-lot open when the deleted buy was the only inventory", () => {
    // Buy (tx 1) opened the only lot; a later sell (tx 99) fully consumed it.
    // Deleting the buy leaves NO long inventory → the sell must short.
    const preview = planLotReallocation({
      mutation: { op: "delete", targetTxId: 1 },
      lots: [], // post-reversal: nothing left
      dependentCloses: [
        dep({ id: 99, quantity: -10 }, [
          closure({ lotId: 1, qtyClosed: 10, costPerShare: 100, realizedGain: 500 }),
        ]),
      ],
    });

    expect(preview.openedShortLots).toHaveLength(1);
    const short = preview.openedShortLots[0];
    expect(short.holdingId).toBe(200);
    expect(short.accountId).toBe(100);
    expect(short.qty).toBe(10);
    expect(short.costPerShare).toBe(150); // proceeds price
    expect(short.currency).toBe("USD");

    expect(preview.proposedClosures).toHaveLength(1);
    const pc = preview.proposedClosures[0];
    expect(pc.isNewShortLot).toBe(true);
    expect(pc.lotId).toBeLessThan(0); // negative placeholder in preview
    expect(pc.realizedGain).toBe(0); // opening a short realizes nothing

    // Net position invariant: live SUM(quantity) = sell(−10) only (buy gone)
    // = −10. Implied by the plan: 0 long − 10 short = −10. ✓
    const netShort = short.qty;
    expect(0 - netShort).toBe(-10);

    // Realized gain for 2025 was 500; now 0 (the short defers it) → −500.
    expect(preview.realizedGainDeltaByYear["2025"]).toBe(-500);
  });

  it("partially reallocates then shorts the remainder", () => {
    // After reversal, only 4 sh of long inventory remain (lot B), but the
    // sell closed 10 → 4 reallocate to B, 6 go short.
    const lotB = lot({ id: 2, openTxId: 2, costPerShare: 120, qtyRemaining: 4 });
    const preview = planLotReallocation({
      mutation: { op: "delete", targetTxId: 1 },
      lots: [lotB],
      dependentCloses: [
        dep({ id: 99, quantity: -10 }, [
          closure({ lotId: 1, qtyClosed: 10, costPerShare: 100, realizedGain: 500 }),
        ]),
      ],
    });
    const longClosure = preview.proposedClosures.find((c) => !c.isNewShortLot);
    const shortClosure = preview.proposedClosures.find((c) => c.isNewShortLot);
    expect(longClosure?.qtyClosed).toBe(4);
    expect(longClosure?.lotId).toBe(2);
    expect(shortClosure?.qtyClosed).toBe(6);
    expect(preview.openedShortLots[0].qty).toBe(6);
  });
});

// ─── transfer-out closures realize 0 ─────────────────────────────────────

describe("planLotReallocation — transfer_out realizes 0", () => {
  it("re-points a transfer_out closure with zero realized gain", () => {
    const lotB = lot({ id: 2, openTxId: 2, costPerShare: 120, qtyRemaining: 10 });
    const preview = planLotReallocation({
      mutation: { op: "delete", targetTxId: 1 },
      lots: [lotB],
      dependentCloses: [
        dep({ id: 99, quantity: -10 }, [
          closure({
            lotId: 1,
            qtyClosed: 10,
            proceedsPerShare: 100,
            costPerShare: 100,
            realizedGain: 0,
            closeKind: "transfer_out",
          }),
        ]),
      ],
    });
    const pc = preview.proposedClosures[0];
    expect(pc.closeKind).toBe("transfer_out");
    expect(pc.realizedGain).toBe(0); // proceeds forced to B's cost
    expect(pc.proceedsPerShare).toBe(120); // == B cost, no realization
    // No realized-gain delta — both old and new are 0.
    expect(preview.realizedGainDeltaByYear["2025"]).toBeUndefined();
  });
});

// ─── no dependent closures → empty preview ───────────────────────────────

describe("planLotReallocation — no dependents is a no-op", () => {
  it("returns an empty preview when there is nothing to replay", () => {
    const preview = planLotReallocation({
      mutation: { op: "delete", targetTxId: 1 },
      lots: [lot({ id: 2 })],
      dependentCloses: [],
    });
    expect(preview.dependentCloseTxIds).toHaveLength(0);
    expect(preview.proposedClosures).toHaveLength(0);
    expect(preview.openedShortLots).toHaveLength(0);
    expect(preview.realizedGainDeltaByYear).toEqual({});
  });
});
