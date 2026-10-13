import {
  allocationMatches,
  allocationTotal,
  allocationUnchanged,
  buildPerLotQty,
  groupSales,
  isReassignableSale,
  saleLotChoices,
  seedAllocation,
} from "../lib/portfolio/lots";
import type { HoldingLot, LotClosure } from "../../../shared/types";

const lot = (over: Partial<HoldingLot>): HoldingLot => ({
  id: 1,
  accountId: 5,
  openTxId: 100,
  openDate: "2026-01-10",
  side: "long",
  origin: "buy",
  status: "open",
  qtyOriginal: 100,
  qtyRemaining: 100,
  costPerShare: 10,
  currency: "USD",
  ...over,
});

const closure = (over: Partial<LotClosure>): LotClosure => ({
  id: 1,
  lotId: 1,
  closeTxId: 500,
  closeDate: "2026-06-01",
  qtyClosed: 100,
  proceedsPerShare: 25,
  costPerShare: 10,
  realizedGain: 1500,
  currency: "USD",
  closeKind: "sell",
  ...over,
});

// Buy 100 at 10 (lot 1), buy 100 at 20 (lot 2), sell 100 (first in, first out
// used all of lot 1), then buy 100 at 30 (lot 3).
const lots = [
  lot({ id: 1, openDate: "2026-01-10", costPerShare: 10, qtyRemaining: 0, status: "closed" }),
  lot({ id: 2, openDate: "2026-02-10", costPerShare: 20 }),
  lot({ id: 3, openDate: "2026-07-10", costPerShare: 30 }),
];
const closures = [closure({})];

describe("groupSales", () => {
  it("adds a sale's closures together, newest sale first", () => {
    const sales = groupSales([
      closure({ id: 1, closeTxId: 500, closeDate: "2026-06-01", qtyClosed: 60, realizedGain: 900 }),
      closure({ id: 2, closeTxId: 500, closeDate: "2026-06-01", lotId: 2, qtyClosed: 40, realizedGain: 200 }),
      closure({ id: 3, closeTxId: 700, closeDate: "2026-09-01", lotId: 2, qtyClosed: 10, realizedGain: 50 }),
    ]);
    expect(sales.map((s) => s.closeTxId)).toEqual([700, 500]);
    expect(sales[1].qty).toBe(100);
    expect(sales[1].realizedGain).toBe(1100);
    expect(sales[1].closures).toHaveLength(2);
  });

  it("only a plain sale can be re-matched", () => {
    expect(isReassignableSale({ closeKind: "sell" })).toBe(true);
    expect(isReassignableSale({ closeKind: "transfer_out" })).toBe(false);
    expect(isReassignableSale({ closeKind: "short_close" })).toBe(false);
  });
});

describe("saleLotChoices", () => {
  const [sale] = groupSales(closures);

  // The lot a sale used up has nothing remaining, and it is the one the user
  // most needs to see: taking shares back off it is the point of the screen.
  it("lists the lot the sale used up, with what the sale takes from it", () => {
    const choices = saleLotChoices(lots, sale);
    const used = choices.find((c) => c.lot.id === 1);
    expect(used).toEqual({ lot: lots[0], current: 100, available: 100 });
  });

  it("offers other purchases made on or before the sale, oldest first", () => {
    expect(saleLotChoices(lots, sale).map((c) => c.lot.id)).toEqual([1, 2]);
  });

  it("leaves out a purchase made after the sale", () => {
    expect(saleLotChoices(lots, sale).some((c) => c.lot.id === 3)).toBe(false);
  });

  it("a partly used lot offers what it still holds plus what the sale takes", () => {
    const partial = [lot({ id: 1, qtyRemaining: 40 }), lot({ id: 2, openDate: "2026-02-10", costPerShare: 20 })];
    const [s] = groupSales([closure({ qtyClosed: 60 })]);
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
});

describe("the allocation form", () => {
  const [sale] = groupSales(closures);

  it("starts from the sale's current allocation", () => {
    expect(seedAllocation(sale)).toEqual({ 1: "100" });
    expect(allocationMatches(seedAllocation(sale), sale)).toBe(true);
    expect(allocationUnchanged(seedAllocation(sale), sale)).toBe(true);
  });

  it("adds up what was typed, ignoring blanks and nonsense", () => {
    expect(allocationTotal({ 1: "60", 2: "40" })).toBe(100);
    expect(allocationTotal({ 1: "", 2: "abc", 3: "-5" })).toBe(0);
    expect(allocationTotal({ 1: "12,5" })).toBe(12.5);
  });

  it("matches only when the total is exactly what was sold", () => {
    expect(allocationMatches({ 1: "60", 2: "40" }, sale)).toBe(true);
    expect(allocationMatches({ 1: "60", 2: "30" }, sale)).toBe(false);
    expect(allocationMatches({ 1: "100", 2: "100" }, sale)).toBe(false);
  });

  it("knows a real change from the same thing typed differently", () => {
    expect(allocationUnchanged({ 1: "100.0", 2: "" }, sale)).toBe(true);
    expect(allocationUnchanged({ 1: "0", 2: "100" }, sale)).toBe(false);
  });

  it("sends only the lots with a positive figure", () => {
    expect(buildPerLotQty({ 1: "0", 2: "100", 3: "" })).toEqual([{ lotId: 2, qty: 100 }]);
  });
});
