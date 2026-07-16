/**
 * FINLYNQ-280 — whole-user lot rebuild must NOT throw InvalidLinkPairError on
 * a cross-currency `link_id` cash transfer.
 *
 * A USD-cash → CAD-cash move is recorded as a `link_id`-paired opposite-sign
 * pair on TWO DIFFERENT holdings (source USD-cash, dest CAD-cash). The old
 * rebuild transfer-detector (opposite-sign qty + same link_id) blindly called
 * `transferLot`, whose engine guard REQUIRES identical holdingIds and threw
 * `InvalidLinkPairError` — so `buildLotsForUser(userId, null)` couldn't
 * complete for such a user. The fix classifies the pair: SAME-holding →
 * in-kind `transferLot` (byte-identical); DIFFERENT-holding / different-
 * currency → two INDEPENDENT close+open legs (each leg on its own holding via
 * the FINLYNQ-278 cash path or the buy/sell path).
 *
 * tc-1 (primary): the pure classification predicate runs everywhere; the
 * end-to-end rebuild is DB-gated and runs in CI's `finlynq_test` lane (skips
 * locally when no `*_test` DATABASE_URL is set — same pattern as the MCP
 * read-only contract harness).
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { and, eq } from "drizzle-orm";

import {
  bootstrapTestDb,
  resetTestDb,
  shutdownTestDb,
  createTestUser,
  createAccount,
  createHolding,
  recordTransaction,
} from "./helpers/portfolio-fixtures";
import {
  buildLotsForUser,
  isSameHoldingInKindPair,
} from "@/lib/portfolio/lots/backfill";
import { db, schema } from "@/db";

// ───────────────────────────────────────────────────────────────────────────
// Pure classification predicate — runs everywhere (no DB).
// ───────────────────────────────────────────────────────────────────────────
describe("isSameHoldingInKindPair (FINLYNQ-280 classification)", () => {
  it("same holdingId on both legs → in-kind transferLot", () => {
    expect(isSameHoldingInKindPair(764, 764)).toBe(true);
  });

  it("different holdingId (cross-currency / cross-account) → NOT in-kind", () => {
    // The exact throwing shape from the ticket: USD-cash 764 → CAD-cash 457.
    expect(isSameHoldingInKindPair(764, 457)).toBe(false);
  });

  it("null / undefined legs → NOT in-kind (never routes to transferLot)", () => {
    expect(isSameHoldingInKindPair(null, 457)).toBe(false);
    expect(isSameHoldingInKindPair(764, undefined)).toBe(false);
    expect(isSameHoldingInKindPair(null, null)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// End-to-end whole-user rebuild — DB-gated (finlynq_test lane).
// ───────────────────────────────────────────────────────────────────────────
const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

describeDb("buildLotsForUser — cross-currency link_id cash transfer", () => {
  beforeAll(async () => {
    await bootstrapTestDb();
  });
  afterAll(async () => {
    await shutdownTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
  });

  it("tc-1: whole-user rebuild completes (no InvalidLinkPairError) and replays the pair as two independent close+open legs", async () => {
    const userId = await createTestUser();
    const accountId = await createAccount({
      userId,
      name: "Brokerage",
      currency: "USD",
      isInvestment: true,
    });

    // Two cash sleeves — one per currency (mirrors tx 35231/35232 holdings
    // 764 USD / 457 CAD).
    const usdSleeve = await createHolding({
      userId,
      accountId,
      name: "Cash USD",
      symbol: null,
      currency: "USD",
    });
    const cadSleeve = await createHolding({
      userId,
      accountId,
      name: "Cash CAD",
      symbol: null,
      currency: "CAD",
    });
    await db
      .update(schema.portfolioHoldings)
      .set({ isCash: true })
      .where(
        and(
          eq(schema.portfolioHoldings.userId, userId),
          eq(schema.portfolioHoldings.accountId, accountId),
        ),
      );

    // Prior USD-sleeve balance so the outflow has a long lot to close.
    await recordTransaction({
      userId,
      accountId,
      currency: "USD",
      amount: 10_000,
      quantity: 10_000,
      portfolioHoldingId: usdSleeve,
      kind: "brokerage_deposit",
      date: "2026-01-01",
    });

    // Cross-currency FX transfer: USD-cash OUT (qty<0) ↔ CAD-cash IN (qty>0),
    // opposite-sign, SAME link_id, DIFFERENT holdings + currencies. This is
    // the pair the old rebuild threw on.
    const linkId = "fx-crosscur-1";
    await db.insert(schema.transactions).values([
      {
        userId,
        date: "2026-02-01",
        accountId,
        currency: "USD",
        amount: -5_000,
        quantity: -5_000,
        portfolioHoldingId: usdSleeve,
        linkId,
        kind: "fx_from",
        source: "manual",
        payee: "",
      },
      {
        userId,
        date: "2026-02-01",
        accountId,
        currency: "CAD",
        amount: 7_000,
        quantity: 7_000,
        portfolioHoldingId: cadSleeve,
        linkId,
        kind: "fx_to",
        source: "manual",
        payee: "",
      },
    ]);

    // The load-bearing assertion: the whole-user rebuild MUST NOT throw.
    const result = await buildLotsForUser(userId, null);
    expect(result.userId).toBe(userId);

    // Two INDEPENDENT legs (NOT one in-kind transfer): each sleeve carries its
    // OWN lot in its OWN currency. An in-kind `transferLot` would instead have
    // opened the dest lot inheriting the SOURCE currency (USD) on the CAD
    // sleeve — this proves the classification fix.
    const lots = await db
      .select({
        holdingId: schema.holdingLots.holdingId,
        currency: schema.holdingLots.currency,
        qtyRemaining: schema.holdingLots.qtyRemaining,
        side: schema.holdingLots.side,
        status: schema.holdingLots.status,
      })
      .from(schema.holdingLots)
      .where(eq(schema.holdingLots.userId, userId));

    const cadLots = lots.filter((l) => l.holdingId === cadSleeve);
    expect(cadLots.length).toBeGreaterThan(0);
    for (const l of cadLots) expect(l.currency).toBe("CAD");

    // tc-2: each sleeve's signed lot net == its ledger SUM(quantity).
    const signedNet = (holdingId: number) =>
      lots
        .filter((l) => l.holdingId === holdingId && l.status === "open")
        .reduce(
          (s, l) => s + (l.side === "short" ? -1 : 1) * Number(l.qtyRemaining),
          0,
        );
    // USD sleeve: +10,000 deposit − 5,000 outflow = +5,000.
    expect(signedNet(usdSleeve)).toBeCloseTo(5_000, 6);
    // CAD sleeve: +7,000 inflow.
    expect(signedNet(cadSleeve)).toBeCloseTo(7_000, 6);
  });

  it("tc-1 companion: a SAME-holding link_id pair still routes to the in-kind transferLot path", async () => {
    const userId = await createTestUser();
    const accountId = await createAccount({
      userId,
      name: "Brokerage",
      currency: "USD",
      isInvestment: true,
    });
    // A single security holding. A same-holding link_id pair (source qty<0,
    // dest qty>0 on the SAME holding) must route to transferLot → a
    // `transfer_out` closure (NOT a plain sell). We seed an opening buy so the
    // transfer has a lot to consume.
    const vti = await createHolding({
      userId,
      accountId,
      name: "Vanguard Total",
      symbol: "VTI",
      currency: "USD",
    });
    await recordTransaction({
      userId,
      accountId,
      currency: "USD",
      amount: -1_000,
      quantity: 10,
      portfolioHoldingId: vti,
      kind: "buy",
      date: "2026-01-01",
    });
    const linkId = "inkind-same-holding-1";
    await db.insert(schema.transactions).values([
      {
        userId,
        date: "2026-03-01",
        accountId,
        currency: "USD",
        amount: 0,
        quantity: -4,
        portfolioHoldingId: vti,
        linkId,
        kind: "in_kind_transfer_out",
        source: "manual",
        payee: "",
      },
      {
        userId,
        date: "2026-03-01",
        accountId,
        currency: "USD",
        amount: 0,
        quantity: 4,
        portfolioHoldingId: vti,
        linkId,
        kind: "in_kind_transfer_in",
        source: "manual",
        payee: "",
      },
    ]);

    const result = await buildLotsForUser(userId, null);
    expect(result.userId).toBe(userId);

    // Same-holding pair → a transfer_out closure exists (proves transferLot
    // ran, not the buy/sell path which would write a 'sell' closure).
    const closures = await db
      .select({ closeKind: schema.holdingLotClosures.closeKind })
      .from(schema.holdingLotClosures)
      .where(eq(schema.holdingLotClosures.userId, userId));
    expect(closures.some((c) => c.closeKind === "transfer_out")).toBe(true);
  });
});
