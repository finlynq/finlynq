/**
 * The payee list behind the Payee field's suggestions (2026-11-24).
 *
 * Pure: the suggestion rules. Static: which write paths feed the list.
 * DB-gated (real Postgres, CI's `finlynq_test` lane): the store, through the
 * registered MCP tool for the recording side.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPgTools } from "../mcp-server/register-tools-pg";
import {
  TEST_DEK,
  bootstrapTestDb,
  resetTestDb,
  shutdownTestDb,
  createTestUser,
  createAccount,
  createCategory,
} from "./helpers/portfolio-fixtures";
import { db } from "@/db";
import { encryptField } from "@/lib/crypto/envelope";
import { cleanPayeeName, suggestPayees, PAYEE_MAX_LENGTH, type PayeeOption } from "@/lib/payees/suggest";
import { forgetPayee, listPayees, rememberPayee, rememberPayeeIfChanged } from "@/lib/payees/store";

const all: PayeeOption[] = [
  { id: 1, name: "Corner Cafe", count: 9, categoryId: 4 },
  { id: 2, name: "Costco", count: 20, categoryId: 5 },
  { id: 3, name: "City Hydro", count: 3, categoryId: null },
  { id: 4, name: "Second Cup Coffee", count: 2, categoryId: 4 },
];

describe("suggestPayees", () => {
  it("offers nothing for an empty box", () => {
    expect(suggestPayees(all, "  ")).toEqual([]);
  });
  it("puts names starting with the text first, most used first, then names containing it", () => {
    expect(suggestPayees(all, "co").map((p) => p.name)).toEqual(["Costco", "Corner Cafe", "Second Cup Coffee"]);
  });
  it("ignores case and extra spaces", () => {
    expect(suggestPayees(all, "CORNER  ca").map((p) => p.name)).toEqual(["Corner Cafe"]);
  });
  it("offers nothing once the text is exactly the only match", () => {
    expect(suggestPayees(all, "City Hydro")).toEqual([]);
    expect(suggestPayees(all, "city hydro").length).toBe(1);
  });
});

describe("cleanPayeeName", () => {
  it("trims, collapses spaces and refuses blank, non-text and over-long names", () => {
    expect(cleanPayeeName("  Corner   Cafe ")).toBe("Corner Cafe");
    expect(cleanPayeeName("")).toBeNull();
    expect(cleanPayeeName(undefined)).toBeNull();
    expect(cleanPayeeName("x".repeat(PAYEE_MAX_LENGTH + 1))).toBeNull();
  });
});

describe("which saves feed the payee list", () => {
  const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
  it("the web transaction routes and MCP manage_transactions do", () => {
    const route = read("src/app/api/transactions/route.ts");
    expect(route).toContain("await rememberPayee(auth.userId, auth.dek, data.payee");
    expect(route).toContain("await rememberPayeeIfChanged(auth.userId, auth.dek, id, data.payee");
    const mcp = read("mcp-server/tools/transactions.ts");
    expect(mcp.match(/await rememberPayee\(userId, dek,/g)?.length).toBe(2);
    expect(mcp).toContain("await rememberPayeeIfChanged(userId, dek, id, payee");
  });
  it("the import and reconcile paths do not", () => {
    for (const f of [
      "src/lib/import-pipeline.ts",
      "src/lib/reconcile/materialize-transaction.ts",
      "src/lib/import/send-to-bank-ledger.ts",
    ]) {
      expect(read(f)).not.toContain("rememberPayee");
    }
  });
  it("Clear All Data removes the list", () => {
    expect(read("src/lib/auth/queries.ts")).toContain("tx.delete(s.payees)");
  });
});

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

type Handler = (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }> }>;

describeDb("payee store", () => {
  let userId = "";
  let other = "";
  let acct = 0;
  let food = 0;
  let fun = 0;

  beforeAll(async () => {
    await bootstrapTestDb();
  });
  afterAll(async () => {
    await shutdownTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    await db.execute(sql`DELETE FROM payees`);
    userId = await createTestUser();
    other = await createTestUser();
    acct = await createAccount({ userId, name: "Chequing", currency: "USD", type: "A", isInvestment: false });
    food = await createCategory({ userId, name: "Food", type: "E" });
    fun = await createCategory({ userId, name: "Fun", type: "E" });
  });

  it("adds a payee once, counts later uses and keeps the newest category", async () => {
    await rememberPayee(userId, TEST_DEK, "Corner Cafe", food);
    await rememberPayee(userId, TEST_DEK, "  corner   cafe ", null);
    await rememberPayee(userId, TEST_DEK, "Corner Cafe", fun);
    await rememberPayee(userId, TEST_DEK, "   ", food);
    const list = await listPayees(userId, TEST_DEK);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Corner Cafe", count: 3, categoryId: fun });
  });

  it("stores the name encrypted and keeps users apart", async () => {
    await rememberPayee(userId, TEST_DEK, "Secret Shop", null);
    const raw = await db.execute(sql`SELECT name_ct FROM payees WHERE user_id = ${userId}`);
    const rows = (raw as unknown as { rows?: Array<{ name_ct: string }> }).rows ?? (raw as unknown as Array<{ name_ct: string }>);
    expect(rows[0].name_ct).not.toContain("Secret");
    expect(rows[0].name_ct.startsWith("v1:")).toBe(true);
    expect(await listPayees(other, TEST_DEK)).toEqual([]);
    expect(await listPayees(userId, null)).toEqual([]);
  });

  it("forgets one payee, only for its owner", async () => {
    await rememberPayee(userId, TEST_DEK, "Typo Shpo", null);
    const [p] = await listPayees(userId, TEST_DEK);
    expect((await forgetPayee(other, p.id)).removed).toBe(0);
    expect((await forgetPayee(userId, p.id)).removed).toBe(1);
    expect(await listPayees(userId, TEST_DEK)).toEqual([]);
  });

  it("fills the list once from typed and assistant-recorded transactions, not imports or transfers", async () => {
    const ins = (payee: string, source: string, categoryId: number | null, date: string, linkId: string | null = null) =>
      db.execute(sql`
        INSERT INTO transactions (user_id, date, account_id, category_id, currency, amount, payee, source, link_id)
        VALUES (${userId}, ${date}, ${acct}, ${categoryId}, 'USD', -1, ${encryptField(TEST_DEK, payee)}, ${source}, ${linkId})
      `);
    await ins("Corner Cafe", "manual", food, "2026-01-01");
    await ins("Corner Cafe", "mcp_http", fun, "2026-02-01");
    await ins("SQ *CORNER CAFE 1234", "import", food, "2026-02-02");
    await ins("To savings", "manual", null, "2026-02-03", "11111111-1111-1111-1111-111111111111");
    const list = await listPayees(userId, TEST_DEK);
    expect(list.map((p) => p.name)).toEqual(["Corner Cafe"]);
    expect(list[0]).toMatchObject({ count: 2, categoryId: fun });

    // One time only: a payee removed afterwards stays removed.
    await forgetPayee(userId, list[0].id);
    expect(await listPayees(userId, TEST_DEK)).toEqual([]);
  });

  it("an edit adds the payee only when its text changes", async () => {
    await db.execute(sql`
      INSERT INTO transactions (user_id, date, account_id, currency, amount, payee, source)
      VALUES (${userId}, '2026-03-01', ${acct}, 'USD', -1, ${encryptField(TEST_DEK, "SQ *BANK TEXT 99")}, 'import')
    `);
    const r = await db.execute(sql`SELECT id FROM transactions WHERE user_id = ${userId}`);
    const id = Number(((r as unknown as { rows?: Array<{ id: number }> }).rows ?? (r as unknown as Array<{ id: number }>))[0].id);
    await listPayees(userId, TEST_DEK); // run the one-time fill first (it skips the import)
    await rememberPayeeIfChanged(userId, TEST_DEK, id, "SQ *BANK TEXT 99", food);
    expect(await listPayees(userId, TEST_DEK)).toEqual([]);
    await rememberPayeeIfChanged(userId, TEST_DEK, id, "Bank Text Cafe", food);
    expect((await listPayees(userId, TEST_DEK)).map((p) => p.name)).toEqual(["Bank Text Cafe"]);
  });

  it("MCP manage_transactions record adds the payee with its category", async () => {
    const server = new McpServer({ name: "payees-test", version: "0.0.0" });
    registerPgTools(server, db as never, userId, TEST_DEK);
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;
    const res = await tools.manage_transactions.handler(
      { op: "record", account_id: acct, amount: -4, payee: "Assistant Bakery", category_id: food, date: "2026-04-01" },
      {},
    );
    expect(JSON.parse(res.content[0].text).success).toBe(true);
    const list = await listPayees(userId, TEST_DEK);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Assistant Bakery", count: 1, categoryId: food });
  });
});
