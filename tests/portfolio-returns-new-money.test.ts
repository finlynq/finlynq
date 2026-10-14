/**
 * Portfolio returns strip out NEW MONEY (2026-10-14, owner report: "the
 * performance calculation includes contributions and withdrawals").
 * `computePortfolioReturns` (lib/portfolio/performance/returns.ts) is what the
 * Performance chart and MCP `get_portfolio_returns` both call.
 *
 * Five days, value in CAD:
 *   d0 1000
 *   d1 1100  payroll contribution +100, booked as reinvested income in an
 *            "Employer contribution" income category      → new money, r = 0
 *   d2 1210  dividend +110 in "Dividends"                 → return,    r = 10%
 *   d3 1110  withdrawal −100 booked as an expense in a Transfer category
 *                                                         → new money, r = 0
 *   d4 1221  price gain                                   → return,    r = 10%
 * Correct TWRR = 1.1 × 1.1 − 1 = 21%. The old calculation, which only knew
 * transfer legs, scored the contribution as a 10% gain and the withdrawal as
 * a 9% loss.
 *
 * DB-gated (real Postgres): runs in CI's `finlynq_test` lane.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  TEST_DEK,
  bootstrapTestDb,
  resetTestDb,
  shutdownTestDb,
  createTestUser,
  createAccount,
  createCategory,
  createHolding,
  recordTransaction,
} from "./helpers/portfolio-fixtures";
import { computePortfolioReturns } from "@/lib/portfolio/performance/returns";
import { db, schema } from "@/db";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

const DAYS = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"];
const VALUES = [1000, 1100, 1210, 1110, 1221];

describeDb("computePortfolioReturns — new money is not return", () => {
  let userId = "";

  beforeAll(async () => {
    await bootstrapTestDb();
  });
  afterAll(async () => {
    await shutdownTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    userId = await createTestUser();
    const accountId = await createAccount({ userId, name: "Group plan", currency: "CAD", isInvestment: true });
    const fund = await createHolding({ userId, accountId, name: "Equity fund", symbol: "FUND", currency: "CAD" });
    const sleeve = await createHolding({ userId, accountId, name: "Cash", symbol: null, currency: "CAD" });
    const employer = await createCategory({ userId, name: "Employer contribution", type: "I" });
    const dividends = await createCategory({ userId, name: "Dividends", type: "I" });
    const transfers = await createCategory({ userId, name: "Transfer", type: "R" });

    await recordTransaction({ userId, accountId, date: DAYS[1], currency: "CAD", amount: 100, quantity: 1, portfolioHoldingId: fund, kind: "portfolio_income", categoryId: employer });
    await recordTransaction({ userId, accountId, date: DAYS[2], currency: "CAD", amount: 110, quantity: 1.1, portfolioHoldingId: fund, kind: "portfolio_income", categoryId: dividends });
    await recordTransaction({ userId, accountId, date: DAYS[3], currency: "CAD", amount: -100, quantity: -100, portfolioHoldingId: sleeve, kind: "portfolio_expense", categoryId: transfers });

    for (let i = 0; i < DAYS.length; i++) {
      for (const account of [accountId, null]) {
        await db.insert(schema.portfolioSnapshots).values({
          userId,
          snapDate: DAYS[i],
          accountId: account,
          marketValue: VALUES[i],
          costBasis: 1000,
          netContribution: 0, // the stored figure is no longer what returns read
          currency: "CAD",
          gapsFilled: false,
          source: "cron",
        });
      }
    }
  });

  it("scores the contribution and the withdrawal as new money, the dividend and the price move as return", async () => {
    const r = await computePortfolioReturns({ userId, dek: TEST_DEK, period: "all", accountId: null, asOfDate: DAYS[4] });
    expect(r.series.map((p) => p.contribution)).toEqual([0, 100, 0, -100, 0]);
    expect(r.netNewMoney).toBe(0);
    expect(r.twrr.period).toBeCloseTo(0.21, 10);
    expect(r.incomeCategoriesResolved).toBe(true);
    expect(r.mwrr.converged).toBe(true);
  });

  it("gives the same answer scoped to the account", async () => {
    const accountId = (await db.select({ id: schema.accounts.id }).from(schema.accounts))[0].id;
    const r = await computePortfolioReturns({ userId, dek: TEST_DEK, period: "all", accountId, asOfDate: DAYS[4] });
    expect(r.twrr.period).toBeCloseTo(0.21, 10);
  });

  it("without the key, income categories can't be told apart: the contribution stays return, the Transfer still doesn't", async () => {
    const r = await computePortfolioReturns({ userId, dek: null, period: "all", accountId: null, asOfDate: DAYS[4] });
    expect(r.incomeCategoriesResolved).toBe(false);
    expect(r.series.map((p) => p.contribution)).toEqual([0, 0, 0, -100, 0]);
    expect(r.twrr.period).toBeCloseTo(1.1 ** 3 - 1, 10);
  });
});
