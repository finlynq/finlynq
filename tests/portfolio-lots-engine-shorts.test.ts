/**
 * The two pure engine functions behind shorts (2026-10-14), shared by the live
 * write hooks and the rebuild replay:
 *
 *   planSellAgainstLongs — a sale closes the open long lots it can and opens
 *                          ONE short for the rest, at the sale's price.
 *   coverShortsForBuy    — a buy closes open shorts first, oldest first, and
 *                          leaves the rest (prorated) to open a long lot.
 *
 * The database-backed end-to-end cases (rebuild == recording, re-match
 * refusals) are in tests/portfolio-lots-shorts.test.ts.
 */

import { describe, it, expect } from "vitest";
import { coverShortsForBuy, openLotForBuy, planSellAgainstLongs } from "@/lib/portfolio/lots/engine";
import type { CashLegHint, HoldingLot, TxRowForLots } from "@/lib/portfolio/lots/types";

const lot = (over: Partial<HoldingLot>): HoldingLot => ({
  id: 1,
  userId: "u",
  holdingId: 200,
  accountId: 100,
  openTxId: 1,
  openDate: "2026-03-02",
  qtyOriginal: 100,
  qtyRemaining: 100,
  costPerShare: 10,
  currency: "USD",
  fxToUsdAtOpen: null,
  origin: "buy",
  parentLotId: null,
  status: "open",
  side: "long",
  source: "manual",
  ...over,
});

const tx = (over: Partial<TxRowForLots>): TxRowForLots => ({
  id: 99,
  userId: "u",
  date: "2026-05-02",
  amount: 3750,
  currency: "USD",
  enteredAmount: null,
  enteredCurrency: null,
  quantity: -150,
  accountId: 100,
  categoryId: null,
  portfolioHoldingId: 200,
  tradeLinkId: null,
  source: "manual",
  ...over,
});

const cash = (enteredAmount: number): CashLegHint => ({
  enteredAmount,
  enteredCurrency: "USD",
  amount: enteredAmount,
  currency: "USD",
  tradeLinkId: "t",
});

describe("planSellAgainstLongs", () => {
  it("closes what the long lots hold and opens a short for the rest, at the sale's price", () => {
    const plan = planSellAgainstLongs({ tx: tx({}), lots: [lot({})], holdingCurrency: "USD" });
    expect(plan.closures.map((c) => [c.lotId, c.qtyClosed, c.proceedsPerShare, c.realizedGain, c.closeKind])).toEqual([
      [1, 100, 25, 1500, "sell"],
    ]);
    expect(plan.qtyDeltas.get(1)).toBe(100);
    expect(plan.shortLot).toMatchObject({
      openTxId: 99,
      openDate: "2026-05-02",
      side: "short",
      status: "open",
      qtyOriginal: 50,
      qtyRemaining: 50,
      costPerShare: 25,
      origin: "buy",
    });
  });

  it("takes proceeds from the paired cash leg when there is one", () => {
    const plan = planSellAgainstLongs({ tx: tx({ amount: 0 }), lots: [lot({})], cashLeg: cash(3000), holdingCurrency: "USD" });
    expect(plan.closures[0].proceedsPerShare).toBe(20);
    expect(plan.shortLot?.costPerShare).toBe(20);
  });

  it("opens no short when the lots cover the sale, and only a short when there are none", () => {
    expect(planSellAgainstLongs({ tx: tx({ quantity: -60, amount: 1500 }), lots: [lot({})], holdingCurrency: "USD" }).shortLot).toBeNull();
    const allShort = planSellAgainstLongs({ tx: tx({}), lots: [], holdingCurrency: "USD", shortOrigin: "backfill" });
    expect(allShort.closures).toEqual([]);
    expect(allShort.shortLot).toMatchObject({ qtyOriginal: 150, costPerShare: 25, origin: "backfill" });
  });

  it("never sells from a short lot or a lot already closed", () => {
    const plan = planSellAgainstLongs({
      tx: tx({ quantity: -10, amount: 250 }),
      lots: [
        lot({ id: 1, side: "short", openDate: "2026-01-01" }),
        lot({ id: 2, status: "closed", qtyRemaining: 0, openDate: "2026-01-02" }),
        lot({ id: 3, openDate: "2026-04-01", costPerShare: 20 }),
      ],
      holdingCurrency: "USD",
    });
    expect(plan.closures.map((c) => c.lotId)).toEqual([3]);
  });

  it("a SPECIFIC pick the named lots can't fill plans no long closures but still the short", () => {
    const plan = planSellAgainstLongs({
      tx: tx({ quantity: -120, amount: 3000 }),
      lots: [lot({ id: 1, qtyRemaining: 30 }), lot({ id: 2, openDate: "2026-04-01", qtyRemaining: 70 })],
      holdingCurrency: "USD",
      strategy: "SPECIFIC",
      lotIds: [2],
    });
    expect(plan.specificShortfall).toBeCloseTo(30);
    expect(plan.closures).toEqual([]);
    expect(plan.shortLot?.qtyOriginal).toBe(20);
  });
});

describe("coverShortsForBuy", () => {
  const short = (over: Partial<HoldingLot>) => lot({ side: "short", costPerShare: 25, qtyOriginal: 50, qtyRemaining: 50, ...over });

  it("a buy that matches the short closes it with the inverse gain and opens nothing", () => {
    const plan = coverShortsForBuy({
      tx: tx({ id: 100, date: "2026-06-02", quantity: 50, amount: -750 }),
      lots: [short({ id: 7 })],
      holdingCurrency: "USD",
    });
    expect(plan.closures.map((c) => [c.lotId, c.qtyClosed, c.proceedsPerShare, c.costPerShare, c.realizedGain, c.closeKind])).toEqual([
      [7, 50, 15, 25, 500, "short_close"],
    ]);
    expect(plan.remainingQty).toBe(0);
    expect(plan.remainderTx).toBeNull();
  });

  it("closes the oldest short first and leaves long lots alone", () => {
    const plan = coverShortsForBuy({
      tx: tx({ id: 100, date: "2026-06-02", quantity: 60, amount: -900 }),
      lots: [lot({ id: 1 }), short({ id: 8, openDate: "2026-05-10" }), short({ id: 7, openDate: "2026-05-02" })],
      holdingCurrency: "USD",
    });
    expect(plan.closures.map((c) => [c.lotId, c.qtyClosed])).toEqual([
      [7, 50],
      [8, 10],
    ]);
    expect(plan.remainderTx).toBeNull();
  });

  it("prorates the rest of the buy, cash leg included, so the long lot costs the buy's price", () => {
    const plan = coverShortsForBuy({
      tx: tx({ id: 100, date: "2026-06-02", quantity: 80, amount: 0 }),
      lots: [short({ id: 7 })],
      cashLeg: cash(-1200),
      holdingCurrency: "USD",
    });
    expect(plan.remainingQty).toBe(30);
    expect(plan.remainderCashLeg?.enteredAmount).toBeCloseTo(450);
    const long = openLotForBuy({ tx: plan.remainderTx!, cashLeg: plan.remainderCashLeg, holdingCurrency: "USD" });
    expect(long.lot.qtyOriginal).toBe(30);
    expect(long.lot.costPerShare).toBeCloseTo(15);
  });

  // With no paired cash leg the long lot is costed from the row itself. The
  // old live hook cut the quantity but kept the full amount: 1200 / 30 = 40
  // a share instead of 15.
  it("prorates the row's own amount when there is no cash leg", () => {
    const plan = coverShortsForBuy({
      tx: tx({ id: 100, date: "2026-06-02", quantity: 80, amount: -1200, enteredAmount: -1200 }),
      lots: [short({ id: 7 })],
      holdingCurrency: "USD",
    });
    expect(plan.remainderTx?.amount).toBeCloseTo(-450);
    expect(plan.remainderTx?.enteredAmount).toBeCloseTo(-450);
    const long = openLotForBuy({ tx: plan.remainderTx!, holdingCurrency: "USD" });
    expect(long.lot.costPerShare).toBeCloseTo(15);
  });

  it("with no open short the whole buy is left to open a long lot, unchanged", () => {
    const buy = tx({ id: 100, quantity: 40, amount: -600 });
    const plan = coverShortsForBuy({ tx: buy, lots: [lot({})], holdingCurrency: "USD" });
    expect(plan.closures).toEqual([]);
    expect(plan.remainderTx).toEqual(buy);
  });
});
