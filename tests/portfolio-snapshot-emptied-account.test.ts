/**
 * An emptied investment account reads zero in the stored snapshot history
 * (2026-10-29, in-app feedback #27).
 *
 * The builder wrote a per-account row only for accounts holding something
 * that day, and the Net Worth chart carries each account's last row forward.
 * A cash sleeve emptied by a full withdrawal therefore kept its
 * pre-withdrawal value in every later point (one report: HK$115k for five
 * years), until the live value took over on the final day. Here a USD
 * account deposits 14,799.24 and withdraws all of it the next day: from the
 * withdrawal on, its rows must exist and read 0. An account whose first
 * transaction comes later gets no row before it (no leading zero line), and
 * an account still holding shares is unaffected.
 *
 * DB-gated (real Postgres): runs in CI's `finlynq_test` lane.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import {
  TEST_DEK,
  bootstrapTestDb,
  resetTestDb,
  shutdownTestDb,
  createTestUser,
  createAccount,
  createHolding,
  recordTransaction,
  seedPriceCache,
} from "./helpers/portfolio-fixtures";
import { db, schema } from "@/db";
import { buildDailySnapshot } from "@/lib/portfolio/snapshots/builder";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

const DEPOSIT = "2021-09-27";
const WITHDRAW = "2021-09-28";
const LATER = "2021-09-29";

describeDb("investment snapshots: an emptied account reads zero", () => {
  let userId = "";
  let emptied = 0;
  let holding = 0;
  let opensLater = 0;

  beforeAll(async () => {
    await bootstrapTestDb();
  });
  afterAll(async () => {
    await shutdownTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    userId = await createTestUser();
    await db.insert(schema.settings).values({ userId, key: "display_currency", value: "USD" });

    // Deposits 14,799.24, then transfers all of it out the next day.
    emptied = await createAccount({ userId, name: "Emptied brokerage", currency: "USD", isInvestment: true });
    const sleeve = await createHolding({ userId, accountId: emptied, name: "Cash", symbol: null, currency: "USD" });
    await db.update(schema.portfolioHoldings).set({ isCash: true }).where(eq(schema.portfolioHoldings.id, sleeve));
    await recordTransaction({ userId, accountId: emptied, date: DEPOSIT, currency: "USD", amount: 14799.24, quantity: 14799.24, portfolioHoldingId: sleeve, kind: "brokerage_deposit_in" });
    await recordTransaction({ userId, accountId: emptied, date: WITHDRAW, currency: "USD", amount: -14799.24, quantity: -14799.24, portfolioHoldingId: sleeve, kind: "brokerage_withdrawal_out" });

    // Holds 10 shares throughout.
    holding = await createAccount({ userId, name: "Holding brokerage", currency: "USD", isInvestment: true });
    const stock = await createHolding({ userId, accountId: holding, name: "Sample stock", symbol: "SMPL", currency: "USD" });
    await recordTransaction({ userId, accountId: holding, date: DEPOSIT, currency: "USD", amount: -1000, quantity: 10, portfolioHoldingId: stock, kind: "buy" });

    // First transaction only on LATER.
    opensLater = await createAccount({ userId, name: "New brokerage", currency: "USD", isInvestment: true });
    const newSleeve = await createHolding({ userId, accountId: opensLater, name: "Cash", symbol: null, currency: "USD" });
    await db.update(schema.portfolioHoldings).set({ isCash: true }).where(eq(schema.portfolioHoldings.id, newSleeve));
    await recordTransaction({ userId, accountId: opensLater, date: LATER, currency: "USD", amount: 500, quantity: 500, portfolioHoldingId: newSleeve, kind: "brokerage_deposit_in" });

    for (const date of [DEPOSIT, WITHDRAW, LATER]) {
      await seedPriceCache({ symbol: "SMPL", date, price: 110, currency: "USD" });
    }
    for (const date of [DEPOSIT, WITHDRAW, LATER]) {
      await buildDailySnapshot({ userId, date, dek: TEST_DEK });
    }
  });

  async function row(date: string, account: number | null) {
    const rows = await db
      .select({
        mv: schema.portfolioSnapshots.marketValue,
        nativeMv: schema.portfolioSnapshots.nativeMarketValue,
        nativeCurrency: schema.portfolioSnapshots.nativeCurrency,
      })
      .from(schema.portfolioSnapshots)
      .where(
        and(
          eq(schema.portfolioSnapshots.userId, userId),
          eq(schema.portfolioSnapshots.snapDate, date),
          account == null ? isNull(schema.portfolioSnapshots.accountId) : eq(schema.portfolioSnapshots.accountId, account),
        ),
      );
    return rows[0] ? { mv: Number(rows[0].mv), nativeMv: Number(rows[0].nativeMv), nativeCurrency: rows[0].nativeCurrency } : null;
  }

  it("writes a zero row for the emptied account from the withdrawal on", async () => {
    expect((await row(DEPOSIT, emptied))?.mv).toBeCloseTo(14799.24, 2);
    for (const date of [WITHDRAW, LATER]) {
      expect(await row(date, emptied)).toEqual({ mv: 0, nativeMv: 0, nativeCurrency: "USD" });
    }
  });

  it("leaves accounts that hold something, or have not started yet, as before", async () => {
    for (const date of [DEPOSIT, WITHDRAW, LATER]) {
      expect((await row(date, holding))?.mv).toBeCloseTo(1100, 6);
    }
    expect(await row(DEPOSIT, opensLater)).toBeNull();
    expect(await row(WITHDRAW, opensLater)).toBeNull();
    expect((await row(LATER, opensLater))?.mv).toBeCloseTo(500, 6);
  });

  it("keeps the whole-portfolio total in step", async () => {
    expect((await row(DEPOSIT, null))?.mv).toBeCloseTo(14799.24 + 1100, 2);
    expect((await row(WITHDRAW, null))?.mv).toBeCloseTo(1100, 6);
    expect((await row(LATER, null))?.mv).toBeCloseTo(1600, 6);
  });
});
