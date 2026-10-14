/**
 * Snapshot cost basis is fixed at each purchase's own exchange rate
 * (2026-10-14, owner report: "why would cost change? cost should be fixed
 * unless there is a transaction").
 *
 * The builder used to convert cost into the reporting currency at the
 * SNAPSHOT date's rate, so the Performance chart's cost line moved every day
 * the rate did. Here a CAD-reporting user holds, in a USD account, 10 shares
 * bought for 1,000 USD and 1,000 USD of cash left from a 2,000 USD deposit,
 * all on a day USD→CAD was 1.25 (the stored reporting amounts). On the next
 * two days the rate is 1.3333 and then 1.4286 with no transaction: market
 * value follows the rate, cost stays at 2,500 CAD.
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
  seedFxRate,
  seedPriceCache,
} from "./helpers/portfolio-fixtures";
import { db, schema } from "@/db";
import { buildDailySnapshot } from "@/lib/portfolio/snapshots/builder";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

const BOUGHT = "2026-03-02";
const DAY1 = "2026-03-03";
const DAY2 = "2026-03-04";

describeDb("investment snapshots: cost at the purchase-date rate", () => {
  let userId = "";
  let accountId = 0;

  beforeAll(async () => {
    await bootstrapTestDb();
  });
  afterAll(async () => {
    await shutdownTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    userId = await createTestUser();
    await db.insert(schema.settings).values({ userId, key: "display_currency", value: "CAD" });
    accountId = await createAccount({ userId, name: "US brokerage", currency: "USD", isInvestment: true });
    const stock = await createHolding({ userId, accountId, name: "Sample stock", symbol: "SMPL", currency: "USD" });
    const sleeve = await createHolding({ userId, accountId, name: "Cash", symbol: null, currency: "USD" });
    await db.update(schema.portfolioHoldings).set({ isCash: true }).where(eq(schema.portfolioHoldings.id, sleeve));

    const deposit = await recordTransaction({ userId, accountId, date: BOUGHT, currency: "USD", amount: 2000, quantity: 2000, portfolioHoldingId: sleeve, kind: "brokerage_deposit_in" });
    const buy = await recordTransaction({ userId, accountId, date: BOUGHT, currency: "USD", amount: -1000, quantity: 10, portfolioHoldingId: stock, kind: "buy", tradeLinkId: "t1" });
    const cashLeg = await recordTransaction({ userId, accountId, date: BOUGHT, currency: "USD", amount: -1000, quantity: -1000, portfolioHoldingId: sleeve, kind: "buy_cash_leg", tradeLinkId: "t1" });
    // What the app stores on every row: the amount in the reporting currency
    // at the row's own date (USD→CAD 1.25 on BOUGHT).
    for (const [id, cad] of [[deposit, 2500], [buy, -1250], [cashLeg, -1250]] as const) {
      await db.update(schema.transactions).set({ reportingCurrency: "CAD", reportingAmount: cad }).where(eq(schema.transactions.id, id));
    }

    for (const [date, cadToUsd] of [[DAY1, 0.75], [DAY2, 0.7]] as const) {
      await seedFxRate({ currency: "USD", date, rateToUsd: 1 });
      await seedFxRate({ currency: "CAD", date, rateToUsd: cadToUsd });
      await seedPriceCache({ symbol: "SMPL", date, price: 110, currency: "USD" });
    }
  });

  async function snapshot(date: string, account: number | null) {
    const [row] = await db
      .select({ mv: schema.portfolioSnapshots.marketValue, cb: schema.portfolioSnapshots.costBasis })
      .from(schema.portfolioSnapshots)
      .where(
        and(
          eq(schema.portfolioSnapshots.userId, userId),
          eq(schema.portfolioSnapshots.snapDate, date),
          account == null ? isNull(schema.portfolioSnapshots.accountId) : eq(schema.portfolioSnapshots.accountId, account),
        ),
      );
    return { mv: Number(row.mv), cb: Number(row.cb) };
  }

  it("keeps cost at 2,500 CAD while market value follows the day's rate", async () => {
    await buildDailySnapshot({ userId, date: DAY1, dek: TEST_DEK });
    await buildDailySnapshot({ userId, date: DAY2, dek: TEST_DEK });

    for (const account of [null, accountId]) {
      const d1 = await snapshot(DAY1, account);
      const d2 = await snapshot(DAY2, account);
      // 10 × 110 + 1,000 cash = 2,100 USD.
      expect(d1.mv).toBeCloseTo(2100 / 0.75, 6);
      expect(d2.mv).toBeCloseTo(2100 / 0.7, 6);
      // Shares 1,250 + cash 1,000 USD at the deposit's 1.25 = 2,500 CAD.
      expect(d1.cb).toBeCloseTo(2500, 6);
      expect(d2.cb).toBeCloseTo(2500, 6);
    }
  });

  it("falls back to the day's rate for a purchase stored without a reporting amount", async () => {
    await db.update(schema.transactions).set({ reportingCurrency: null, reportingAmount: null }).where(eq(schema.transactions.kind, "buy"));
    await buildDailySnapshot({ userId, date: DAY1, dek: TEST_DEK });
    const d1 = await snapshot(DAY1, null);
    expect(d1.cb).toBeCloseTo(1000 / 0.75 + 1250, 6);
  });
});
