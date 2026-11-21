/**
 * GH #427: the Reports tag filter. Tags are encrypted, so the report first
 * finds the tagged transactions on decrypted tags, then sums only their
 * category rows (`transaction_category_flows`, split parts included).
 *
 * DB-gated (real Postgres) except the tag-list splitting.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { encryptField } from "@/lib/crypto/envelope";
import { flowIdIn, parseTagParam, transactionIdsWithTag } from "@/lib/reports/tag-filter";
import { listUserTags, splitTags } from "@/lib/transactions/tag-list";
import {
  TEST_DEK,
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

describe("tag parsing", () => {
  it("splits tags the way the tag filter matches them", () => {
    expect(splitTags(" spending-money, food ,,food")).toEqual(["spending-money", "food"]);
    expect(splitTags(null)).toEqual([]);
  });
  it("reads the tag parameter", () => {
    expect(parseTagParam("  food ")).toBe("food");
    expect(parseTagParam("   ")).toBeNull();
    expect(parseTagParam(null)).toBeNull();
  });
});

describeDb("reports tag filter", () => {
  let userId = "";
  let accountId = 0;
  let groceries = 0;
  let dining = 0;

  async function tag(txId: number, tags: string) {
    await db.update(schema.transactions).set({ tags: encryptField(TEST_DEK, tags) }).where(eq(schema.transactions.id, txId));
  }

  async function spendingWithTag(t: string, start: string, end: string) {
    const ids = await transactionIdsWithTag(userId, TEST_DEK, t, { startDate: start, endDate: end });
    const f = schema.transactionCategoryFlows;
    const rows = await db
      .select({ categoryId: f.categoryId, total: sql<number>`SUM(${f.amount})` })
      .from(f)
      .where(and(eq(f.userId, userId), flowIdIn(ids)))
      .groupBy(f.categoryId);
    return Object.fromEntries(rows.map((r) => [r.categoryId, Number(r.total)]));
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
    accountId = await createAccount({ userId, name: "Chequing", currency: "USD", type: "A", isInvestment: false });
    groceries = await createCategory({ userId, name: "Groceries", type: "E" });
    dining = await createCategory({ userId, name: "Dining", type: "E" });
  });

  it("counts only transactions carrying the tag exactly, split parts by their own category", async () => {
    const a = await recordTransaction({ userId, accountId, date: "2026-03-01", categoryId: groceries, currency: "USD", amount: -40 });
    const b = await recordTransaction({ userId, accountId, date: "2026-03-02", categoryId: dining, currency: "USD", amount: -25 });
    const c = await recordTransaction({ userId, accountId, date: "2026-03-03", categoryId: dining, currency: "USD", amount: -99 });
    const d = await recordTransaction({ userId, accountId, date: "2026-03-04", categoryId: groceries, currency: "USD", amount: -60 });
    await tag(a, "spending-money");
    await tag(b, "food, spending-money");
    await tag(c, "spending-money-extra"); // not an exact match
    await tag(d, "spending-money");
    // d is split: 20 of it was dining.
    await db.insert(schema.transactionSplits).values({ transactionId: d, categoryId: dining, accountId, amount: -20 });

    expect(await spendingWithTag("spending-money", "2026-01-01", "2026-12-31")).toEqual({
      [groceries]: -80, // 40 + the 40 left of d
      [dining]: -45, // 25 + d's 20 split
    });
    // The window limits the scan.
    expect(await spendingWithTag("spending-money", "2026-03-02", "2026-03-02")).toEqual({ [dining]: -25 });
    // No match: nothing, not everything.
    expect(await spendingWithTag("nope", "2026-01-01", "2026-12-31")).toEqual({});

    expect(await listUserTags(userId, TEST_DEK)).toEqual([
      { tag: "food", count: 1 },
      { tag: "spending-money", count: 3 },
      { tag: "spending-money-extra", count: 1 },
    ]);
  });

  it("matches nothing without the key", async () => {
    const a = await recordTransaction({ userId, accountId, date: "2026-03-01", categoryId: groceries, currency: "USD", amount: -40 });
    await tag(a, "spending-money");
    expect(await transactionIdsWithTag(userId, null, "spending-money", {})).toEqual([]);
    expect(await listUserTags(userId, null)).toEqual([]);
  });
});
