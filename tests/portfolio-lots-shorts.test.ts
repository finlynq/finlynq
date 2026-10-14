/**
 * Shorts in the lot engine (2026-10-14): a sale beyond the shares held opens
 * a short, and a later buy closes it. Recording that worked; three tools that
 * rework a position's lots afterwards did not:
 *
 *   - Rebuild skipped the whole oversold sale ("sell shortfall") and turned
 *     the buy that closed the short into a new long lot. It also never saved
 *     `side`, so cash-sleeve shorts came back as long lots.
 *   - Edit allocation (`reassignClosureLots`) counted only the long part, so
 *     saving dropped the short and, by cascade, the buy's closing of it.
 *   - Edit all allocations (`applyHoldingAllocation`) put the short back open,
 *     because the buy that closed it is never replayed.
 *
 * Fixture throughout = the dev demo's SHORTTEST: buy 100 @ 10, sell 150 @ 25,
 * buy 50 @ 15. Correct lots: the long lot fully sold (gain 1,500), a 50-share
 * short at 25 fully closed by the buy (gain 500), nothing open.
 *
 * DB-gated (real Postgres, real ON DELETE CASCADE): runs in CI's
 * `finlynq_test` lane and skips locally when no `*_test` DATABASE_URL is set.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { and, asc, eq } from "drizzle-orm";

import {
  bootstrapTestDb,
  resetTestDb,
  shutdownTestDb,
  createTestUser,
  createAccount,
  createHolding,
  recordTransaction,
} from "./helpers/portfolio-fixtures";
import { buildLotsForUser, rebuildLotsForPosition } from "@/lib/portfolio/lots/backfill";
import {
  applyHoldingAllocation,
  applyLotEffectsForTx,
  buildLotContext,
  reassignClosureLots,
} from "@/lib/portfolio/lots/write-hooks";
import type { TxRowForLots } from "@/lib/portfolio/lots/types";
import type { TransactionSource } from "@/lib/tx-source";
import { db, schema } from "@/db";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

type Trade = { date: string; qty: number; amount: number };
const SHORTTEST: Trade[] = [
  { date: "2026-03-02", qty: 100, amount: -1000 },
  { date: "2026-05-02", qty: -150, amount: 3750 },
  { date: "2026-06-02", qty: 50, amount: -750 },
];

async function position(trades: Trade[], opts: { cash?: boolean } = {}) {
  const userId = await createTestUser();
  const accountId = await createAccount({ userId, name: "Brokerage", currency: "USD", isInvestment: true });
  const holdingId = await createHolding({
    userId,
    accountId,
    name: opts.cash ? "Cash USD" : "Short test",
    symbol: opts.cash ? null : "SHORTTEST",
    currency: "USD",
  });
  if (opts.cash) {
    await db.update(schema.portfolioHoldings).set({ isCash: true }).where(eq(schema.portfolioHoldings.id, holdingId));
  }
  const txIds: number[] = [];
  for (const t of trades) {
    txIds.push(
      await recordTransaction({
        userId,
        accountId,
        currency: "USD",
        amount: t.amount,
        quantity: t.qty,
        portfolioHoldingId: holdingId,
        kind: opts.cash ? (t.qty > 0 ? "brokerage_deposit_in" : "brokerage_withdrawal_out") : t.qty > 0 ? "buy" : "sell",
        date: t.date,
      }),
    );
  }
  return { userId, accountId, holdingId, txIds };
}

/** Lots + closures in a comparable shape (no ids beyond the trade ids). */
async function lotState(userId: string, holdingId: number) {
  const lots = await db
    .select()
    .from(schema.holdingLots)
    .where(and(eq(schema.holdingLots.userId, userId), eq(schema.holdingLots.holdingId, holdingId)))
    .orderBy(asc(schema.holdingLots.openDate), asc(schema.holdingLots.id));
  const sideById = new Map(lots.map((l) => [l.id, l.side]));
  const closures = await db
    .select()
    .from(schema.holdingLotClosures)
    .where(eq(schema.holdingLotClosures.userId, userId))
    .orderBy(asc(schema.holdingLotClosures.closeDate), asc(schema.holdingLotClosures.id));
  return {
    lots: lots.map((l) => ({
      openTxId: l.openTxId,
      side: l.side,
      status: l.status,
      qtyOriginal: Number(l.qtyOriginal),
      qtyRemaining: Number(l.qtyRemaining),
      costPerShare: Number(l.costPerShare),
    })),
    closures: closures
      .filter((c) => sideById.has(c.lotId))
      .map((c) => ({
        closeTxId: c.closeTxId,
        closeKind: c.closeKind,
        lotSide: sideById.get(c.lotId),
        qtyClosed: Number(c.qtyClosed),
        realizedGain: Number(c.realizedGain),
      })),
    openNet: lots
      .filter((l) => l.status === "open")
      .reduce((s, l) => s + (l.side === "short" ? -1 : 1) * Number(l.qtyRemaining), 0),
    realized: closures.filter((c) => sideById.has(c.lotId)).reduce((s, c) => s + Number(c.realizedGain), 0),
  };
}

/** Record the trades' lot effects one by one, the way saving each trade does. */
async function recordLive(userId: string, txIds: number[]) {
  const ctx = await buildLotContext(userId, null);
  for (const id of txIds) {
    const [r] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, id));
    const tx: TxRowForLots = {
      id: r.id,
      userId: r.userId,
      date: r.date,
      amount: Number(r.amount),
      currency: r.currency ?? "USD",
      enteredAmount: r.enteredAmount,
      enteredCurrency: r.enteredCurrency,
      quantity: r.quantity,
      accountId: r.accountId,
      categoryId: r.categoryId,
      portfolioHoldingId: r.portfolioHoldingId,
      tradeLinkId: r.tradeLinkId,
      source: r.source as TransactionSource,
    };
    await applyLotEffectsForTx(tx, ctx);
  }
}

describeDb("lot shorts — rebuild, Edit allocation, Edit all allocations", () => {
  beforeAll(async () => {
    await bootstrapTestDb();
  });
  afterAll(async () => {
    await shutdownTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
  });

  it("rebuild opens the short and lets the later buy close it", async () => {
    const p = await position(SHORTTEST);
    const result = await rebuildLotsForPosition(p.userId, null, { holdingIds: [p.holdingId], accountId: p.accountId });
    expect(result.errors).toEqual([]); // no "sell shortfall"

    const s = await lotState(p.userId, p.holdingId);
    expect(s.lots).toEqual([
      { openTxId: p.txIds[0], side: "long", status: "closed", qtyOriginal: 100, qtyRemaining: 0, costPerShare: 10 },
      { openTxId: p.txIds[1], side: "short", status: "closed", qtyOriginal: 50, qtyRemaining: 0, costPerShare: 25 },
    ]);
    expect(s.closures).toEqual([
      { closeTxId: p.txIds[1], closeKind: "sell", lotSide: "long", qtyClosed: 100, realizedGain: 1500 },
      { closeTxId: p.txIds[2], closeKind: "short_close", lotSide: "short", qtyClosed: 50, realizedGain: 500 },
    ]);
    expect(s.openNet).toBe(0); // matches the position: 100 − 150 + 50
    expect(s.realized).toBe(2000);
  });

  it("a rebuild gives the same lots as recording the trades one by one", async () => {
    const trades: Trade[] = [
      ...SHORTTEST,
      // A buy bigger than the open short: closes it, then opens a long.
      { date: "2026-07-01", qty: -80, amount: 1600 },
      { date: "2026-08-01", qty: 120, amount: -1440 },
    ];
    const p = await position(trades);
    await recordLive(p.userId, p.txIds);
    const live = await lotState(p.userId, p.holdingId);

    await rebuildLotsForPosition(p.userId, null, { holdingIds: [p.holdingId], accountId: p.accountId });
    const rebuilt = await lotState(p.userId, p.holdingId);

    expect(rebuilt).toEqual(live);
    expect(rebuilt.openNet).toBe(40); // 100 − 150 + 50 − 80 + 120
    // The last buy closed the 80-share short at 12 and opened 40 long at 12.
    expect(rebuilt.lots.at(-1)).toEqual({
      openTxId: p.txIds[4], side: "long", status: "open", qtyOriginal: 40, qtyRemaining: 40, costPerShare: 12,
    });
  });

  it("rebuild saves cash-sleeve shorts as shorts", async () => {
    const p = await position(
      [
        { date: "2026-01-01", qty: 100, amount: 100 },
        { date: "2026-02-01", qty: -150, amount: -150 },
      ],
      { cash: true },
    );
    await buildLotsForUser(p.userId, null);
    const s = await lotState(p.userId, p.holdingId);
    expect(s.lots.map((l) => [l.side, l.status, l.qtyRemaining])).toEqual([
      ["long", "closed", 0],
      ["short", "open", 50],
    ]);
    expect(s.openNet).toBe(-50);
  });

  it("Edit allocation refuses a sale whose short a later buy closed, and changes nothing", async () => {
    const p = await position(SHORTTEST);
    await rebuildLotsForPosition(p.userId, null, { holdingIds: [p.holdingId], accountId: p.accountId });
    const before = await lotState(p.userId, p.holdingId);
    const longLotId = (
      await db.select().from(schema.holdingLots).where(eq(schema.holdingLots.openTxId, p.txIds[0]))
    )[0].id;

    for (const dryRun of [true, false]) {
      const res = await reassignClosureLots(
        p.userId,
        { holdingId: p.holdingId, closeTxId: p.txIds[1], perLotQty: [{ lotId: longLotId, qty: 100 }, { lotId: 0, qty: 50 }] },
        { dryRun, dek: null },
      );
      expect(res).toEqual({ ok: false, code: "short_already_covered", closeTxId: p.txIds[1], shortQty: 50, coveredQty: 50 });
    }
    expect(await lotState(p.userId, p.holdingId)).toEqual(before);
  });

  it("Edit allocation keeps an open short: the total is the whole sale, the short entered as lot 0", async () => {
    const p = await position(SHORTTEST.slice(0, 2)); // no covering buy yet
    await rebuildLotsForPosition(p.userId, null, { holdingIds: [p.holdingId], accountId: p.accountId });
    const before = await lotState(p.userId, p.holdingId);
    expect(before.openNet).toBe(-50);
    const longLotId = (
      await db.select().from(schema.holdingLots).where(eq(schema.holdingLots.openTxId, p.txIds[0]))
    )[0].id;
    const args = (perLotQty: { lotId: number; qty: number }[]) => ({
      holdingId: p.holdingId,
      closeTxId: p.txIds[1],
      perLotQty,
    });

    // The long part alone used to be accepted, and saving dropped the short.
    const longOnly = await reassignClosureLots(p.userId, args([{ lotId: longLotId, qty: 100 }]), { dryRun: true });
    expect(longOnly).toEqual({ ok: false, code: "qty_mismatch", expected: 150, got: 100, soldShort: 50 });

    const preview = await reassignClosureLots(
      p.userId,
      args([{ lotId: longLotId, qty: 100 }, { lotId: 0, qty: 50 }]),
      { dryRun: true },
    );
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(preview.preview.openedShortLots.map((s) => s.qty)).toEqual([50]);
      expect(preview.preview.realizedGainDeltaByYear).toEqual({});
    }

    const saved = await reassignClosureLots(
      p.userId,
      args([{ lotId: longLotId, qty: 100 }, { lotId: 0, qty: 50 }]),
      { dryRun: false, dek: null },
    );
    expect(saved.ok).toBe(true);
    expect(await lotState(p.userId, p.holdingId)).toEqual(before); // short still open, same figures
  });

  it("Edit all allocations refuses when a later buy closed a sale's short, and changes nothing", async () => {
    const p = await position(SHORTTEST);
    await rebuildLotsForPosition(p.userId, null, { holdingIds: [p.holdingId], accountId: p.accountId });
    const before = await lotState(p.userId, p.holdingId);
    const longLotId = (
      await db.select().from(schema.holdingLots).where(eq(schema.holdingLots.openTxId, p.txIds[0]))
    )[0].id;
    const spec = { [p.txIds[1]]: [{ lotId: longLotId, qty: 100 }, { lotId: 0, qty: 50 }] };

    for (const dryRun of [true, false]) {
      const res = await applyHoldingAllocation(
        p.userId,
        { holdingId: p.holdingId, accountId: p.accountId, spec },
        { dryRun, dek: null },
      );
      expect(res).toEqual({ ok: false, code: "short_already_covered", closeTxId: p.txIds[1], shortQty: 50, coveredQty: 50 });
    }
    expect(await lotState(p.userId, p.holdingId)).toEqual(before);
  });
});
