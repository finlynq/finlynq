/**
 * MCP parity with the web portfolio forms (2026-11-13):
 *   - portfolio_record_entry income_expense with settleAs:"shares" books
 *     income received as shares (reinvested dividend, RSU vest) as ONE row on
 *     the holding, through the same recordReinvestedIncomeInShares the web
 *     route uses (GH #404's one-entry vest);
 *   - manage_holdings op:"add_cash_sleeve" creates a brokerage cash sleeve,
 *     which an assistant could not do at all before, so any buy / deposit /
 *     cash income in a currency without a sleeve failed.
 * Driven through the registered tools against a real database.
 *
 * DB-gated (real Postgres): runs in CI's `finlynq_test` lane.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPgTools } from "../../mcp-server/register-tools-pg";
import {
  TEST_DEK,
  bootstrapTestDb,
  resetTestDb,
  shutdownTestDb,
  createTestUser,
  createAccount,
  createCategory,
  createHolding,
} from "../helpers/portfolio-fixtures";
import { nameLookup } from "@/lib/crypto/encrypted-columns";
import { db } from "@/db";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

type Handler = (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }> }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rows = any[];
const rows = async (q: ReturnType<typeof sql>): Promise<Rows> => {
  const r = (await db.execute(q)) as unknown as { rows?: Rows } | Rows;
  return Array.isArray(r) ? r : (r.rows ?? []);
};

describeDb("MCP income received as shares + add_cash_sleeve", () => {
  let userId = "";
  let brokerage = 0;
  let chequing = 0;
  let acme = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let call: (tool: string, args: Record<string, unknown>) => Promise<any>;

  beforeAll(async () => {
    await bootstrapTestDb();
  });
  afterAll(async () => {
    await shutdownTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    userId = await createTestUser();
    brokerage = await createAccount({ userId, name: "Brokerage", currency: "USD" });
    chequing = await createAccount({ userId, name: "Chequing", currency: "USD", type: "A", isInvestment: false });
    acme = await createHolding({ userId, accountId: brokerage, name: "Acme Corp", symbol: "ACME", currency: "USD" });
    const server = new McpServer({ name: "portfolio-parity-test", version: "0.0.0" });
    registerPgTools(server, db as never, userId, TEST_DEK);
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;
    call = async (tool, args) => {
      const res = await tools[tool].handler(args, {});
      const text = res.content[0].text;
      try {
        return JSON.parse(text);
      } catch {
        return { success: false, text };
      }
    };
  });

  it("settleAs shares books one row on the holding and opens a lot at value / quantity", async () => {
    const salary = await createCategory({ userId, name: "RSU income", type: "I" });
    const res = await call("portfolio_record_entry", {
      entry_type: "income_expense",
      account_id: brokerage,
      settleAs: "shares",
      holdingId: acme,
      quantity: 10,
      amount: 1500,
      categoryId: salary,
      date: "2026-11-12",
    });
    expect(res.success).toBe(true);
    expect(res.data.settleAs).toBe("shares");

    const txs = await rows(sql`SELECT kind, quantity, amount, currency, portfolio_holding_id, category_id, source FROM transactions WHERE user_id = ${userId}`);
    expect(txs).toHaveLength(1); // no cash leg, no sleeve touched
    expect(txs[0]).toMatchObject({ kind: "portfolio_income", portfolio_holding_id: acme, category_id: salary, source: "mcp_http", currency: "USD" });
    expect(Number(txs[0].quantity)).toBe(10);
    expect(Number(txs[0].amount)).toBe(1500);

    const lots = await rows(sql`SELECT qty_original, cost_per_share FROM holding_lots WHERE user_id = ${userId} AND holding_id = ${acme}`);
    expect(lots).toHaveLength(1);
    expect(Number(lots[0].qty_original)).toBe(10);
    expect(Number(lots[0].cost_per_share)).toBe(150);
  });

  it("incomeType dividend with no categoryId files it under Dividends", async () => {
    const res = await call("portfolio_record_entry", {
      entry_type: "income_expense",
      account_id: brokerage,
      settleAs: "shares",
      holding: "Acme Corp",
      quantity: 2,
      amount: 300,
      incomeType: "dividend",
      date: "2026-11-12",
    });
    expect(res.success).toBe(true);
    const [cat] = await rows(sql`SELECT c.name_lookup FROM transactions t JOIN categories c ON c.id = t.category_id WHERE t.user_id = ${userId}`);
    expect(cat.name_lookup).toBe(nameLookup(TEST_DEK, "Dividends"));
  });

  it("refuses an incomplete or mixed shares entry, writing nothing", async () => {
    const base = { entry_type: "income_expense", account_id: brokerage, settleAs: "shares", holdingId: acme, date: "2026-11-12" };
    expect((await call("portfolio_record_entry", { ...base, amount: 100 })).text).toMatch(/quantity/);
    expect((await call("portfolio_record_entry", { ...base, amount: -100, quantity: 1 })).text).toMatch(/positive amount/);
    expect((await call("portfolio_record_entry", { ...base, amount: 100, quantity: 1, relatedHoldingId: acme })).text).toMatch(/relatedHolding/);
    const other = await createAccount({ userId, name: "Other Brokerage", currency: "USD" });
    expect((await call("portfolio_record_entry", { ...base, account_id: other, amount: 100, quantity: 1 })).success).toBe(false);
    const [{ n }] = await rows(sql`SELECT COUNT(*)::int AS n FROM transactions WHERE user_id = ${userId}`);
    expect(n).toBe(0);
  });

  it("a cash sleeve as the target is refused with the domain message, not a crash", async () => {
    const sleeve = await call("manage_holdings", { op: "add_cash_sleeve", account_id: brokerage, currency: "USD" });
    const res = await call("portfolio_record_entry", {
      entry_type: "income_expense",
      account_id: brokerage,
      settleAs: "shares",
      holdingId: sleeve.data.holdingId,
      quantity: 1,
      amount: 10,
      date: "2026-11-12",
    });
    expect(res.success).toBe(false);
    expect(res.text).toMatch(/cash sleeve/);
  });

  it("a cash entry still needs a currency and takes no holding/quantity", async () => {
    const base = { entry_type: "income_expense", account_id: brokerage, amount: 25, date: "2026-11-12" };
    expect((await call("portfolio_record_entry", base)).text).toMatch(/currency/);
    expect((await call("portfolio_record_entry", { ...base, currency: "USD", quantity: 1 })).text).toMatch(/settleAs:'shares'/);
  });

  it("add_cash_sleeve creates the sleeve once, pairs it, and unblocks cash entries", async () => {
    // Before: no sleeve, so cash income in USD is refused.
    const before = await call("portfolio_record_entry", { entry_type: "income_expense", account_id: brokerage, currency: "USD", amount: 25, incomeType: "interest", date: "2026-11-12" });
    expect(before.success).toBe(false);

    const first = await call("manage_holdings", { op: "add_cash_sleeve", account: "Brokerage", currency: "USD" });
    expect(first.success).toBe(true);
    expect(first.data.created).toBe(true);
    const again = await call("manage_holdings", { op: "add_cash_sleeve", account_id: brokerage, currency: "USD" });
    expect(again.data.created).toBe(false);
    expect(again.data.holdingId).toBe(first.data.holdingId);

    const [h] = await rows(sql`SELECT is_cash, currency, account_id FROM portfolio_holdings WHERE id = ${first.data.holdingId}`);
    expect(h).toMatchObject({ is_cash: true, currency: "USD", account_id: brokerage });
    const pair = await rows(sql`SELECT is_primary FROM holding_accounts WHERE holding_id = ${first.data.holdingId} AND account_id = ${brokerage}`);
    expect(pair).toHaveLength(1);

    const after = await call("portfolio_record_entry", { entry_type: "income_expense", account_id: brokerage, currency: "USD", amount: 25, incomeType: "interest", date: "2026-11-12" });
    expect(after.success).toBe(true);
  });

  it("add_cash_sleeve refuses a non-investment account", async () => {
    const res = await call("manage_holdings", { op: "add_cash_sleeve", account_id: chequing, currency: "USD" });
    expect(res.success).toBe(false);
    expect(res.text).toMatch(/not an investment account/);
    const [{ n }] = await rows(sql`SELECT COUNT(*)::int AS n FROM portfolio_holdings WHERE account_id = ${chequing}`);
    expect(n).toBe(0);
  });
});
