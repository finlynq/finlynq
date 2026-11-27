/**
 * GH #465 — whole-day totals for the Transactions "By day" view
 * (`loadDayTotals`, behind GET /api/transactions?dayTotals=1). A day is
 * totalled over EVERY transaction the list filters allow, not just the page,
 * with the Calendar / Reports money rules and split parts under their own
 * category.
 *
 * DB-gated (real Postgres).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { db, schema } from "@/db";
import { loadDayTotals } from "@/lib/transactions/day-totals";
import {
  bootstrapTestDb,
  resetTestDb,
  shutdownTestDb,
  createTestUser,
  createAccount,
  createCategory,
  recordTransaction,
} from "./helpers/portfolio-fixtures";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

describeDb("loadDayTotals", () => {
  let userId = "";
  let chequing = 0;
  let savings = 0;
  let salary = 0;
  let groceries = 0;
  let dining = 0;
  let transfer = 0;

  beforeAll(async () => {
    await bootstrapTestDb();
  });
  afterAll(async () => {
    await shutdownTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    userId = await createTestUser();
    chequing = await createAccount({ userId, name: "Chequing", currency: "USD", type: "A", isInvestment: false });
    savings = await createAccount({ userId, name: "Savings", currency: "USD", type: "A", isInvestment: false });
    salary = await createCategory({ userId, name: "Salary", type: "I" });
    groceries = await createCategory({ userId, name: "Groceries", type: "E" });
    dining = await createCategory({ userId, name: "Dining", type: "E" });
    transfer = await createCategory({ userId, name: "Transfer", type: "R" });
  });

  const tx = (accountId: number, date: string, categoryId: number | null, amount: number) =>
    recordTransaction({ userId, accountId, date, categoryId, currency: "USD", amount });

  it("totals a day with the money rules, a split transaction counting once", async () => {
    await tx(chequing, "2026-11-27", salary, 1200);
    await tx(chequing, "2026-11-27", groceries, -50);
    await tx(chequing, "2026-11-27", groceries, 10); // refund nets out
    await tx(chequing, "2026-11-27", transfer, -200); // counted, not money
    await tx(chequing, "2026-11-27", null, -30); // uncategorized: counted, not money
    const split = await tx(chequing, "2026-11-27", groceries, -63.85);
    await db.insert(schema.transactionSplits).values([
      { transactionId: split, categoryId: groceries, accountId: chequing, amount: -20.51 },
      { transactionId: split, categoryId: dining, accountId: chequing, amount: -43.34 },
    ]);

    const result = await loadDayTotals(userId, {}, ["2026-11-27"], null);
    expect(result.displayCurrency).toBe("USD");
    expect(result.days).toEqual([{ date: "2026-11-27", income: 1200, spending: 103.85, count: 6 }]);
  });

  it("covers the whole day whatever the page size, and only the asked days", async () => {
    await tx(chequing, "2026-11-26", groceries, -10);
    await tx(chequing, "2026-11-26", groceries, -20);
    await tx(chequing, "2026-11-26", dining, -30);
    await tx(chequing, "2026-11-25", dining, -99);

    const result = await loadDayTotals(userId, { limit: 1, offset: 0 }, ["2026-11-26", "2026-11-26"], null);
    expect(result.days).toEqual([{ date: "2026-11-26", income: 0, spending: 60, count: 3 }]);
  });

  it("follows the list filters and the text-filter matches", async () => {
    const a = await tx(chequing, "2026-11-24", groceries, -10);
    await tx(chequing, "2026-11-24", dining, -20);
    await tx(savings, "2026-11-24", groceries, -40);

    expect((await loadDayTotals(userId, { accountId: chequing }, ["2026-11-24"], null)).days).toEqual([
      { date: "2026-11-24", income: 0, spending: 30, count: 2 },
    ]);
    expect((await loadDayTotals(userId, { categoryIds: [groceries] }, ["2026-11-24"], null)).days).toEqual([
      { date: "2026-11-24", income: 0, spending: 50, count: 2 },
    ]);
    // A search matched only `a`: only `a` counts.
    expect((await loadDayTotals(userId, {}, ["2026-11-24"], [a])).days).toEqual([
      { date: "2026-11-24", income: 0, spending: 10, count: 1 },
    ]);
    // Nothing matched: no days, not every row.
    expect((await loadDayTotals(userId, {}, ["2026-11-24"], [])).days).toEqual([]);
    expect((await loadDayTotals(userId, {}, [], null)).days).toEqual([]);
  });

  it("never counts another user's transactions", async () => {
    const other = await createTestUser();
    const otherAccount = await createAccount({ userId: other, name: "Theirs", currency: "USD", type: "A", isInvestment: false });
    const otherCat = await createCategory({ userId: other, name: "Theirs", type: "E" });
    const theirs = await recordTransaction({ userId: other, accountId: otherAccount, date: "2026-11-23", categoryId: otherCat, currency: "USD", amount: -500 });
    await tx(chequing, "2026-11-23", dining, -5);

    expect((await loadDayTotals(userId, {}, ["2026-11-23"], [theirs])).days).toEqual([]);
    expect((await loadDayTotals(userId, {}, ["2026-11-23"], null)).days).toEqual([
      { date: "2026-11-23", income: 0, spending: 5, count: 1 },
    ]);
  });
});
