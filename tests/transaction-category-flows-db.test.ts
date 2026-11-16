/**
 * Split rows count in reports, against a real database (2026-11-16).
 *
 * Owner report: early-imported payroll deposits had no category on the
 * transaction and a "Wages & salary" split row, and never showed as wages,
 * because every report summed transactions by transactions.category_id.
 * Reports now read transaction_category_flows, where a split transaction is
 * one row per split row (plus a remainder row under the parent's category
 * when the rows don't add up).
 *
 * DB-gated (real Postgres): runs in CI's `finlynq_test` lane.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import {
  bootstrapTestDb,
  resetTestDb,
  shutdownTestDb,
  createTestUser,
  createAccount,
  createCategory,
  recordTransaction,
} from "./helpers/portfolio-fixtures";
import { db, schema } from "@/db";
import { getIncomeExpenseByCategory, getIncomeVsExpenses } from "@/lib/queries";
import { normalizeDbRows } from "@/lib/db-utils";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

describeDb("transaction_category_flows", () => {
  let userId = "";
  const ids = {} as Record<string, number>;

  async function split(transactionId: number, categoryId: number | null, amount: number) {
    await db.insert(schema.transactionSplits).values({ transactionId, categoryId, amount });
  }

  async function setReporting(id: number, reportingAmount: number, rate: number) {
    await db
      .update(schema.transactions)
      .set({ reportingCurrency: "USD", reportingAmount, reportingRate: rate })
      .where(sql`id = ${id}`);
  }

  async function flows(id: number) {
    return normalizeDbRows<{ category_id: number | null; amount: number; reporting_amount: number | null }>(
      await db.execute(sql`
        SELECT category_id, amount, reporting_amount FROM transaction_category_flows
         WHERE id = ${id} ORDER BY split_id NULLS FIRST
      `),
    ).map((r) => ({
      categoryId: r.category_id == null ? null : Number(r.category_id),
      amount: Number(r.amount),
      reportingAmount: r.reporting_amount == null ? null : Math.round(Number(r.reporting_amount) * 100) / 100,
    }));
  }

  beforeAll(async () => {
    await bootstrapTestDb();
  });
  afterAll(async () => {
    await shutdownTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    userId = await createTestUser();
    ids.chequing = await createAccount({ userId, name: "Chequing", currency: "CAD", type: "A", isInvestment: false });
    ids.wages = await createCategory({ userId, name: "Wages & salary", type: "I" });
    ids.groceries = await createCategory({ userId, name: "Groceries", type: "E" });
    ids.shopping = await createCategory({ userId, name: "General shopping", type: "E" });
  });

  it("an unsplit transaction is one row, exactly as stored", async () => {
    const id = await recordTransaction({ userId, accountId: ids.chequing, date: "2024-12-01", categoryId: ids.groceries, currency: "CAD", amount: -50 });
    await setReporting(id, -36.5, 0.73);
    expect(await flows(id)).toEqual([{ categoryId: ids.groceries, amount: -50, reportingAmount: -36.5 }]);
  });

  it("a payroll deposit with no category counts as wages through its split row", async () => {
    const id = await recordTransaction({ userId, accountId: ids.chequing, date: "2024-12-05", categoryId: null, currency: "CAD", amount: 3300.46 });
    await split(id, ids.wages, 3300.46);
    expect(await flows(id)).toEqual([{ categoryId: ids.wages, amount: 3300.46, reportingAmount: null }]);

    const rows = await getIncomeExpenseByCategory(userId, "2024-12-01", "2024-12-31");
    const wages = rows.filter((r) => r.categoryId === ids.wages);
    expect(wages.reduce((s, r) => s + Number(r.totalAmount), 0)).toBeCloseTo(3300.46, 2);
  });

  it("a split purchase counts each part under its own category, never the parent's", async () => {
    const id = await recordTransaction({ userId, accountId: ids.chequing, date: "2024-12-11", categoryId: ids.shopping, currency: "CAD", amount: -63.85 });
    await setReporting(id, -46.61, 0.73);
    await split(id, ids.groceries, -20.51);
    await split(id, ids.shopping, -43.34);
    const rows = await flows(id);
    expect(rows.map((r) => [r.categoryId, r.amount])).toEqual([[ids.groceries, -20.51], [ids.shopping, -43.34]]);
    // The parent's reporting amount is shared out in proportion.
    expect(rows.reduce((s, r) => s + (r.reportingAmount ?? 0), 0)).toBeCloseTo(-46.61, 2);

    const byType = await getIncomeVsExpenses(userId, "2024-12-01", "2024-12-31");
    expect(byType.reduce((s, r) => s + Number(r.totalAmount), 0)).toBeCloseTo(-63.85, 2);
  });

  it("rows that don't add up leave a remainder under the parent's category, so totals still match the account", async () => {
    const id = await recordTransaction({ userId, accountId: ids.chequing, date: "2024-11-22", categoryId: null, currency: "CAD", amount: 3300.46 });
    await split(id, ids.wages, 3900.46);
    const rows = await flows(id);
    expect(rows).toEqual([
      { categoryId: null, amount: expect.closeTo(-600, 2), reportingAmount: null },
      { categoryId: ids.wages, amount: 3900.46, reportingAmount: null },
    ]);
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBeCloseTo(3300.46, 2);
  });

  it("a zero split row adds nothing", async () => {
    const id = await recordTransaction({ userId, accountId: ids.chequing, date: "2024-06-07", categoryId: null, currency: "CAD", amount: 3576.56 });
    await split(id, ids.wages, 3576.56);
    await split(id, null, 0);
    expect(await flows(id)).toEqual([{ categoryId: ids.wages, amount: 3576.56, reportingAmount: null }]);
  });
});
