/**
 * Which lots ONE sale can be matched to (`sale-lot-choices.ts`), the rule the
 * Lot inspector's editor and the server's reassign refusal share.
 *
 * The first five cases are the mobile mirror's own
 * (`mobile/src/__tests__/lotSales.test.ts`, keep in sync); the rest cover the
 * out-of-order case (a sale already matched to a lot bought after it) and the
 * server-side check.
 */

import { describe, it, expect } from "vitest";
import {
  findLotBoughtAfterSale,
  saleLotChoices,
  sharesTakenByLot,
  type ChoosableLot,
} from "@/lib/portfolio/lots/sale-lot-choices";

type Lot = ChoosableLot & { costPerShare: number };

const lot = (over: Partial<Lot>): Lot => ({
  id: 1,
  openDate: "2026-01-10",
  side: "long",
  status: "open",
  qtyRemaining: 100,
  costPerShare: 10,
  ...over,
});

// Buy 100 at 10 (lot 1), buy 100 at 20 (lot 2), sell 100 (first in, first out
// used all of lot 1), then buy 100 at 30 (lot 3). The demo's LOTTEST fixture
// on dev has exactly this shape.
const lots = [
  lot({ id: 1, openDate: "2026-01-10", costPerShare: 10, qtyRemaining: 0, status: "closed" }),
  lot({ id: 2, openDate: "2026-02-10", costPerShare: 20 }),
  lot({ id: 3, openDate: "2026-07-10", costPerShare: 30 }),
];
const sale = { closeDate: "2026-06-01", closures: [{ lotId: 1, qtyClosed: 100 }] };

describe("saleLotChoices", () => {
  it("lists the lot the sale used up, with what the sale takes from it", () => {
    const used = saleLotChoices(lots, sale).find((c) => c.lot.id === 1);
    expect(used).toEqual({ lot: lots[0], current: 100, available: 100, boughtAfterSale: false });
  });

  it("offers other purchases made on or before the sale, oldest first", () => {
    expect(saleLotChoices(lots, sale).map((c) => c.lot.id)).toEqual([1, 2]);
  });

  it("leaves out a purchase made after the sale", () => {
    expect(saleLotChoices(lots, sale).some((c) => c.lot.id === 3)).toBe(false);
  });

  it("a partly used lot offers what it still holds plus what the sale takes", () => {
    const partial = [lot({ id: 1, qtyRemaining: 40 }), lot({ id: 2, openDate: "2026-02-10" })];
    const s = { closeDate: "2026-06-01", closures: [{ lotId: 1, qtyClosed: 60 }] };
    expect(saleLotChoices(partial, s)[0]).toMatchObject({ current: 60, available: 100 });
  });

  it("leaves out short lots and lots with nothing left that the sale never used", () => {
    const more = [
      ...lots,
      lot({ id: 4, side: "short", openDate: "2026-03-01" }),
      lot({ id: 5, openDate: "2026-03-05", qtyRemaining: 0, status: "closed" }),
    ];
    expect(saleLotChoices(more, sale).map((c) => c.lot.id)).toEqual([1, 2]);
  });

  it("a lot bought on the sale date itself is allowed", () => {
    const sameDay = [...lots, lot({ id: 6, openDate: "2026-06-01" })];
    expect(saleLotChoices(sameDay, sale).map((c) => c.lot.id)).toEqual([1, 2, 6]);
  });

  it("adds up a sale's closures on the same lot", () => {
    const s = { closeDate: "2026-06-01", closures: [{ lotId: 1, qtyClosed: 30 }, { lotId: 1, qtyClosed: 20 }, { lotId: 2, qtyClosed: 5 }] };
    expect([...sharesTakenByLot(s.closures)]).toEqual([[1, 50], [2, 5]]);
    const partial = [lot({ id: 1, qtyRemaining: 50 }), lot({ id: 2, openDate: "2026-02-10", qtyRemaining: 95 })];
    expect(saleLotChoices(partial, s).map((c) => [c.lot.id, c.current, c.available])).toEqual([
      [1, 50, 100],
      [2, 5, 100],
    ]);
  });

  // Trades entered out of date order can leave a sale matched to a lot bought
  // after it. That lot must stay listed so the sale can be fixed, but it may
  // only keep what it takes today, even though it still holds more shares.
  it("keeps a later lot the sale already uses, capped at what the sale takes", () => {
    const outOfOrder = [
      lot({ id: 1, openDate: "2026-01-10", costPerShare: 10 }),
      lot({ id: 3, openDate: "2026-07-10", costPerShare: 30, qtyRemaining: 60 }),
    ];
    const s = { closeDate: "2026-06-01", closures: [{ lotId: 3, qtyClosed: 40 }] };
    const choices = saleLotChoices(outOfOrder, s);
    expect(choices.map((c) => c.lot.id)).toEqual([1, 3]);
    expect(choices[1]).toMatchObject({ current: 40, available: 40, boughtAfterSale: true });
    expect(choices[0]).toMatchObject({ current: 0, available: 100, boughtAfterSale: false });
  });
});

describe("findLotBoughtAfterSale", () => {
  const base = { closeDate: sale.closeDate, lots, closures: sale.closures };

  it("refuses a lot bought after the sale that the sale never used", () => {
    expect(findLotBoughtAfterSale({ ...base, perLotQty: [{ lotId: 3, qty: 100 }] })).toEqual({
      lotId: 3,
      lotOpenDate: "2026-07-10",
      closeDate: "2026-06-01",
      requested: 100,
      alreadyTaken: 0,
    });
  });

  it("allows the used-up lot and earlier lots, including the sale date itself", () => {
    expect(findLotBoughtAfterSale({ ...base, perLotQty: [{ lotId: 1, qty: 40 }, { lotId: 2, qty: 60 }] })).toBeNull();
    expect(
      findLotBoughtAfterSale({
        ...base,
        lots: [...lots, lot({ id: 6, openDate: "2026-06-01" })],
        perLotQty: [{ lotId: 6, qty: 100 }],
      }),
    ).toBeNull();
  });

  it("lets a later lot the sale already uses keep or lower its share, never raise it", () => {
    const s = { closeDate: "2026-06-01", lots, closures: [{ lotId: 3, qtyClosed: 40 }, { lotId: 2, qtyClosed: 60 }] };
    expect(findLotBoughtAfterSale({ ...s, perLotQty: [{ lotId: 3, qty: 40 }, { lotId: 2, qty: 60 }] })).toBeNull();
    expect(findLotBoughtAfterSale({ ...s, perLotQty: [{ lotId: 3, qty: 10 }, { lotId: 2, qty: 90 }] })).toBeNull();
    expect(findLotBoughtAfterSale({ ...s, perLotQty: [{ lotId: 3, qty: 50 }, { lotId: 2, qty: 50 }] })).toMatchObject({
      lotId: 3,
      requested: 50,
      alreadyTaken: 40,
    });
  });

  it("sums a lot named twice before comparing", () => {
    const s = { closeDate: "2026-06-01", lots, closures: [{ lotId: 3, qtyClosed: 40 }, { lotId: 2, qtyClosed: 60 }] };
    expect(
      findLotBoughtAfterSale({ ...s, perLotQty: [{ lotId: 3, qty: 30 }, { lotId: 3, qty: 20 }, { lotId: 2, qty: 50 }] }),
    ).toMatchObject({ lotId: 3, requested: 50 });
  });

  it("ignores zero quantities and lots it does not know", () => {
    expect(findLotBoughtAfterSale({ ...base, perLotQty: [{ lotId: 3, qty: 0 }, { lotId: 999, qty: 100 }] })).toBeNull();
  });
});
