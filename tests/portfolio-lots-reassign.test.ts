/**
 * FINLYNQ-178 — manual lot reassignment.
 *
 * Two layers:
 *   A) PURE core `planLotReassignment` (replan.ts) — hand-built fixtures, no
 *      DB. Covers the SPECIFIC allocation (drive the lot pick from
 *      perLotQty), restate-only-that-closure, transfer_out=0, and overflow→
 *      short.
 *   B) DB orchestrator `reassignClosureLots` (write-hooks.ts) — Drizzle mock
 *      (mirrors tests/portfolio-lots-replan-orchestrator.test.ts) that records
 *      which lot/closure write methods fire. Covers:
 *        tc-1: STRICT — Σ perLotQty ≠ closure total → qty_mismatch, ZERO
 *              writes; a valid commit restates ONLY that closure (siblings
 *              untouched) and never DELETE+INSERTs a `transactions` row.
 *        tc-2: overflow → short, atomic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Layer A — pure core ─────────────────────────────────────────────────

import { planLotReassignment } from "@/lib/portfolio/lots/replan";
import type {
  HoldingLot,
  HoldingLotClosure,
  TxRowForLots,
} from "@/lib/portfolio/lots/types";

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

const sellTx = (overrides: Partial<TxRowForLots> = {}): TxRowForLots => ({
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

describe("planLotReassignment — SPECIFIC pick", () => {
  it("re-points the closure from lot A onto a chosen lot B, restating only its gain", () => {
    // Sell tx 99 originally closed 10 sh from lot A (cost 100, gain 500). The
    // user reassigns it onto lot B (cost 120) — proceeds stay 150.
    // After reversal, lot A (10) + lot B (10) are both available (this close
    // tx's consumption restored).
    const lotA = lot({ id: 1, costPerShare: 100, qtyRemaining: 10 });
    const lotB = lot({ id: 2, openTxId: 2, openDate: "2024-03-01", costPerShare: 120, qtyRemaining: 10 });
    const preview = planLotReassignment({
      closeTx: sellTx(),
      originalClosures: [closure({ lotId: 1, qtyClosed: 10, costPerShare: 100, realizedGain: 500 })],
      perLotQty: [{ lotId: 2, qty: 10 }], // user picks lot B
      lots: [lotA, lotB],
    });

    expect(preview.dependentCloseTxIds).toEqual([99]);
    expect(preview.openedShortLots).toHaveLength(0);
    expect(preview.proposedClosures).toHaveLength(1);
    const pc = preview.proposedClosures[0];
    expect(pc.lotId).toBe(2); // chosen lot
    expect(pc.qtyClosed).toBe(10);
    expect(pc.costPerShare).toBe(120); // B's cost
    expect(pc.proceedsPerShare).toBe(150);
    expect(pc.realizedGain).toBe((150 - 120) * 10); // 300, was 500
    expect(pc.isNewShortLot).toBe(false);
    // Restatement: 2025 delta = new 300 − old 500 = −200.
    expect(preview.realizedGainDeltaByYear["2025"]).toBe(-200);
  });

  it("splits across two chosen lots in the user's priority order", () => {
    const lotA = lot({ id: 1, costPerShare: 100, qtyRemaining: 10 });
    const lotB = lot({ id: 2, costPerShare: 120, qtyRemaining: 10 });
    const preview = planLotReassignment({
      closeTx: sellTx({ quantity: -10 }),
      originalClosures: [closure({ lotId: 1, qtyClosed: 10, realizedGain: 500 })],
      perLotQty: [
        { lotId: 1, qty: 4 },
        { lotId: 2, qty: 6 },
      ],
      lots: [lotA, lotB],
    });
    expect(preview.proposedClosures).toHaveLength(2);
    const byLot = new Map(preview.proposedClosures.map((c) => [c.lotId, c]));
    expect(byLot.get(1)?.qtyClosed).toBe(4);
    expect(byLot.get(1)?.realizedGain).toBe((150 - 100) * 4); // 200
    expect(byLot.get(2)?.qtyClosed).toBe(6);
    expect(byLot.get(2)?.realizedGain).toBe((150 - 120) * 6); // 180
    expect(preview.openedShortLots).toHaveLength(0);
    // new gain = 200+180 = 380; old = 500 → −120.
    expect(preview.realizedGainDeltaByYear["2025"]).toBe(-120);
  });

  it("routes overflow (more than a lot holds) into one short lot", () => {
    // The user asks to close 10 from lot B which only holds 4 → 4 close, 6 short.
    const lotB = lot({ id: 2, costPerShare: 120, qtyRemaining: 4 });
    const preview = planLotReassignment({
      closeTx: sellTx({ quantity: -10 }),
      originalClosures: [closure({ lotId: 1, qtyClosed: 10, realizedGain: 500 })],
      perLotQty: [{ lotId: 2, qty: 10 }],
      lots: [lotB],
    });
    const longClosure = preview.proposedClosures.find((c) => !c.isNewShortLot);
    const shortClosure = preview.proposedClosures.find((c) => c.isNewShortLot);
    expect(longClosure?.lotId).toBe(2);
    expect(longClosure?.qtyClosed).toBe(4);
    expect(shortClosure?.qtyClosed).toBe(6);
    expect(shortClosure?.realizedGain).toBe(0); // opening a short realizes nothing
    expect(preview.openedShortLots).toHaveLength(1);
    expect(preview.openedShortLots[0].qty).toBe(6);
    expect(preview.openedShortLots[0].costPerShare).toBe(150); // proceeds price
  });

  it("names a lot with no inventory → all goes short", () => {
    const preview = planLotReassignment({
      closeTx: sellTx({ quantity: -10 }),
      originalClosures: [closure({ lotId: 1, qtyClosed: 10, realizedGain: 500 })],
      perLotQty: [{ lotId: 999, qty: 10 }], // unknown lot
      lots: [],
    });
    expect(preview.proposedClosures).toHaveLength(1);
    expect(preview.proposedClosures[0].isNewShortLot).toBe(true);
    expect(preview.openedShortLots[0].qty).toBe(10);
  });
});

// ─── Layer B — DB orchestrator (Drizzle mock) ─────────────────────────────

const writeSpy = vi.hoisted(() => ({
  inserts: 0,
  updates: 0,
  deletes: 0,
  // table name → counts, so we can assert nothing hits `transactions`
  byTable: {} as Record<string, { insert: number; update: number; delete: number }>,
  lastTable: "" as string,
  results: [] as unknown[][],
}));

vi.mock("@/db", () => {
  function bump(op: "insert" | "update" | "delete", table: string) {
    writeSpy[`${op}s` as const] += 1;
    const t = (writeSpy.byTable[table] ??= { insert: 0, update: 0, delete: 0 });
    t[op] += 1;
  }
  // The mock can't see which Drizzle table object was passed easily, so we
  // tag inserts/updates/deletes with the most recent `from`/into table guess
  // via a side channel: we attach a `__name` to each schema table object.
  function makeChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    const passthrough = ["select", "from", "where", "leftJoin", "orderBy", "groupBy", "values", "set", "limit"];
    for (const m of passthrough) chain[m] = vi.fn(() => chain);
    const resolve = () => (writeSpy.results.length ? writeSpy.results.shift()! : []);
    chain.insert = vi.fn((tbl?: { __name?: string }) => {
      bump("insert", tbl?.__name ?? "?");
      return chain;
    });
    chain.update = vi.fn((tbl?: { __name?: string }) => {
      bump("update", tbl?.__name ?? "?");
      return chain;
    });
    chain.delete = vi.fn((tbl?: { __name?: string }) => {
      bump("delete", tbl?.__name ?? "?");
      return chain;
    });
    chain.returning = vi.fn(() => resolve());
    chain.then = (r: (v: unknown) => unknown) => r(resolve());
    return chain;
  }
  const db = makeChain();
  const tbl = (name: string, cols: string[]) => {
    const o: Record<string, unknown> = { __name: name };
    for (const c of cols) o[c] = {};
    return o;
  };
  return {
    db,
    schema: {
      transactions: tbl("transactions", [
        "id", "userId", "date", "amount", "currency", "enteredAmount",
        "enteredCurrency", "quantity", "accountId", "categoryId",
        "portfolioHoldingId", "tradeLinkId", "source", "kind",
      ]),
      holdingLots: tbl("holdingLots", [
        "id", "userId", "holdingId", "accountId", "openTxId", "openDate",
        "qtyOriginal", "qtyRemaining", "costPerShare", "currency",
        "fxToUsdAtOpen", "origin", "parentLotId", "status", "side", "source",
      ]),
      holdingLotClosures: tbl("holdingLotClosures", [
        "id", "userId", "lotId", "closeTxId", "closeDate", "qtyClosed",
        "proceedsPerShare", "costPerShare", "realizedGain", "currency",
        "daysHeld", "closeKind", "source",
      ]),
      portfolioHoldings: tbl("portfolioHoldings", ["id", "userId", "currency", "isCash"]),
    },
  };
});

// dividends-category resolver is reached by buildLotContext on commit.
vi.mock("@/lib/dividends-category", () => ({
  resolveDividendsCategoryId: vi.fn(async () => null),
}));

import { reassignClosureLots } from "@/lib/portfolio/lots/write-hooks";

beforeEach(() => {
  writeSpy.inserts = 0;
  writeSpy.updates = 0;
  writeSpy.deletes = 0;
  writeSpy.byTable = {};
  writeSpy.results = [];
});

const closeTxRow = {
  id: 99, userId: "u", date: "2025-06-01", amount: -1500, currency: "USD",
  enteredAmount: -1500, enteredCurrency: "USD", quantity: -10, accountId: 100,
  categoryId: null, portfolioHoldingId: 200, tradeLinkId: null,
  source: "manual", kind: "sell",
};
const sellClosureRow = (ov: Record<string, unknown> = {}) => ({
  id: 1, userId: "u", lotId: 1, closeTxId: 99, closeDate: "2025-06-01",
  qtyClosed: 10, proceedsPerShare: 150, costPerShare: 100, realizedGain: 500,
  currency: "USD", daysHeld: 100, closeKind: "sell", source: "manual", ...ov,
});
const liveLotRow = (ov: Record<string, unknown> = {}) => ({
  id: 2, userId: "u", holdingId: 200, accountId: 100, openTxId: 2,
  openDate: "2024-03-01", qtyOriginal: 10, qtyRemaining: 10, costPerShare: 120,
  currency: "USD", fxToUsdAtOpen: null, origin: "buy", parentLotId: null,
  status: "open", side: "long", source: "manual", ...ov,
});

describe("reassignClosureLots — tc-1 STRICT validation + restate one closure", () => {
  it("rejects Σ perLotQty ≠ closure total with qty_mismatch and writes NOTHING", async () => {
    // Read order: 1) close-tx, 2) its closures, 3) holding's live lots.
    writeSpy.results = [
      [closeTxRow],
      [sellClosureRow()], // total 10
      [liveLotRow({ id: 1, openTxId: 1, costPerShare: 100 }), liveLotRow({ id: 2 })],
    ];
    const res = await reassignClosureLots(
      "u",
      { holdingId: 200, closeTxId: 99, perLotQty: [{ lotId: 2, qty: 7 }] }, // 7 ≠ 10
      { dryRun: false },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("qty_mismatch");
      if (res.code === "qty_mismatch") {
        expect(res.expected).toBe(10);
        expect(res.got).toBe(7);
      }
    }
    expect(writeSpy.inserts + writeSpy.updates + writeSpy.deletes).toBe(0);
  });

  it("dry-run preview restates only that closure and writes NOTHING", async () => {
    writeSpy.results = [
      [closeTxRow],
      [sellClosureRow()],
      [liveLotRow({ id: 1, openTxId: 1, costPerShare: 100 }), liveLotRow({ id: 2, costPerShare: 120 })],
    ];
    const res = await reassignClosureLots(
      "u",
      { holdingId: 200, closeTxId: 99, perLotQty: [{ lotId: 2, qty: 10 }] },
      { dryRun: true },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.preview.dependentCloseTxIds).toEqual([99]);
      const pc = res.preview.proposedClosures[0];
      expect(pc.lotId).toBe(2);
      expect(pc.realizedGain).toBe((150 - 120) * 10); // 300
      expect(res.preview.realizedGainDeltaByYear["2025"]).toBe(-200);
    }
    expect(writeSpy.inserts + writeSpy.updates + writeSpy.deletes).toBe(0);
  });

  it("commit reverses + re-closes ONLY lot/closure rows, never the transactions table", async () => {
    // Reads on commit path:
    //   1) close-tx, 2) its closures, 3) live lots (scope check + post-reversal),
    //   then reverseLotsForDeleteHook reads: 4) opened lots by this tx, 5) closures
    //   that closed into this tx; closeLotsForSellHook reads: 6) open lots.
    //   buildLotContext reads: 7) holdings (currency/isCash). Order can vary, so
    //   queue generously — empty results are harmless.
    writeSpy.results = [
      [closeTxRow], // close-tx
      [sellClosureRow()], // its closures
      [liveLotRow({ id: 2, costPerShare: 120, qtyRemaining: 10 })], // live lots (scope)
      [{ id: 200, currency: "USD", isCash: false }], // buildLotContext holdings
      [], // reverse: opened lots by tx99 (none)
      [sellClosureRow()], // reverse: closures closing into tx99
      [liveLotRow({ id: 2, costPerShare: 120, qtyRemaining: 20 })], // closeLotsForSellHook open lots (restored)
    ];
    const res = await reassignClosureLots(
      "u",
      { holdingId: 200, closeTxId: 99, perLotQty: [{ lotId: 2, qty: 10 }] },
      { dryRun: false, dek: null },
    );
    expect(res.ok).toBe(true);
    // Lot/closure rows are the mutation surface (some insert/update/delete fired).
    expect(writeSpy.inserts + writeSpy.updates + writeSpy.deletes).toBeGreaterThan(0);
    // CRITICAL: the `transactions` table is NEVER inserted/updated/deleted —
    // reassignment moves lot/closure rows only (NEVER DELETE+INSERT a tx row).
    const txWrites = writeSpy.byTable["transactions"] ?? { insert: 0, update: 0, delete: 0 };
    expect(txWrites.insert + txWrites.update + txWrites.delete).toBe(0);
  });
});

describe("reassignClosureLots — tc-2 overflow opens a short (atomic)", () => {
  it("a valid commit whose chosen lot underflows opens a short for the overflow", async () => {
    // close-tx total 10; user names lot 2 which holds only 4 after restore → 6 short.
    writeSpy.results = [
      [closeTxRow], // close-tx
      [sellClosureRow()], // closures (total 10)
      [liveLotRow({ id: 2, costPerShare: 120, qtyRemaining: 4 })], // live lots (scope: lot 2 holds 4)
      [{ id: 200, currency: "USD", isCash: false }], // buildLotContext
      [], // reverse: opened lots
      [sellClosureRow()], // reverse: closures into tx99
      [liveLotRow({ id: 2, costPerShare: 120, qtyRemaining: 4 })], // closeLotsForSellHook open lots
    ];
    const res = await reassignClosureLots(
      "u",
      { holdingId: 200, closeTxId: 99, perLotQty: [{ lotId: 2, qty: 10 }] },
      { dryRun: false, dek: null },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const short = res.preview.proposedClosures.find((c) => c.isNewShortLot);
      expect(short?.qtyClosed).toBe(6);
      expect(res.preview.openedShortLots[0].qty).toBe(6);
    }
    // A short lot INSERT into holdingLots fired; no transactions write.
    const txWrites = writeSpy.byTable["transactions"] ?? { insert: 0, update: 0, delete: 0 };
    expect(txWrites.insert + txWrites.update + txWrites.delete).toBe(0);
    expect((writeSpy.byTable["holdingLots"]?.insert ?? 0)).toBeGreaterThan(0);
  });

  it("refuses a non-sell closure (transfer_out) with not_reassignable, no write", async () => {
    writeSpy.results = [
      [closeTxRow],
      [sellClosureRow({ closeKind: "transfer_out", realizedGain: 0, proceedsPerShare: 100 })],
    ];
    const res = await reassignClosureLots(
      "u",
      { holdingId: 200, closeTxId: 99, perLotQty: [{ lotId: 2, qty: 10 }] },
      { dryRun: false },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_reassignable");
    expect(writeSpy.inserts + writeSpy.updates + writeSpy.deletes).toBe(0);
  });
});
