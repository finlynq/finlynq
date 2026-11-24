/**
 * GH #450 — an external id on transactions, through the registered MCP tools
 * against a real database: record (single + bulk) stores it and refuses to
 * record the same id twice in one account, update sets / clears it and
 * refuses a taken one, search_transactions finds by it. Rows recorded
 * without an id behave as before.
 *
 * The pure part (normalizeExternalId) runs without a database.
 * DB-gated part: runs in CI's `finlynq_test` lane.
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
} from "../helpers/portfolio-fixtures";
import { db } from "@/db";
import { EXTERNAL_ID_MAX_LENGTH, normalizeExternalId } from "@/lib/transactions/external-id";

describe("normalizeExternalId", () => {
  it("treats nothing, null and blank as no id", () => {
    expect(normalizeExternalId(undefined)).toEqual({ ok: true, value: null });
    expect(normalizeExternalId(null)).toEqual({ ok: true, value: null });
    expect(normalizeExternalId("   ")).toEqual({ ok: true, value: null });
  });
  it("trims", () => {
    expect(normalizeExternalId("  plaid:abc-123 ")).toEqual({ ok: true, value: "plaid:abc-123" });
  });
  it("refuses a non-string, an over-long id and control characters", () => {
    expect(normalizeExternalId(5).ok).toBe(false);
    expect(normalizeExternalId("x".repeat(EXTERNAL_ID_MAX_LENGTH + 1)).ok).toBe(false);
    expect(normalizeExternalId("a\nb").ok).toBe(false);
    expect(normalizeExternalId("x".repeat(EXTERNAL_ID_MAX_LENGTH)).ok).toBe(true);
  });
});

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

type Handler = (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }> }>;

async function rowsOf(q: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  const r = await db.execute(q);
  return (r as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? (r as unknown as Array<Record<string, unknown>>);
}

describeDb("MCP transactions external_id", () => {
  let userId = "";
  let acctA = 0;
  let acctB = 0;
  let tx: (args: Record<string, unknown>) => Promise<any>;
  let search: (args: Record<string, unknown>) => Promise<any>;

  beforeAll(async () => {
    await bootstrapTestDb();
  });
  afterAll(async () => {
    await shutdownTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    userId = await createTestUser();
    acctA = await createAccount({ userId, name: "Card A", currency: "USD", type: "L", isInvestment: false });
    acctB = await createAccount({ userId, name: "Card B", currency: "USD", type: "L", isInvestment: false });
    const server = new McpServer({ name: "external-id-test", version: "0.0.0" });
    registerPgTools(server, db as never, userId, TEST_DEK);
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;
    const wrap = (name: string) => async (args: Record<string, unknown>) => {
      const res = await tools[name].handler(args, {});
      const text = res.content[0].text;
      try {
        return JSON.parse(text);
      } catch {
        return { success: false, text };
      }
    };
    tx = wrap("manage_transactions");
    search = wrap("search_transactions");
  });

  const count = async () =>
    Number((await rowsOf(sql`SELECT count(*)::int AS n FROM transactions WHERE user_id = ${userId}`))[0].n);

  it("records the id once per account and reports the existing row on a repeat", async () => {
    const first = await tx({ op: "record", account_id: acctA, amount: -12.5, payee: "Coffee", date: "2026-11-01", external_id: "plaid:abc" });
    expect(first.success).toBe(true);
    expect(first.data.externalId).toBe("plaid:abc");
    const id = first.data.transactionId;

    const again = await tx({ op: "record", account_id: acctA, amount: -12.5, payee: "Coffee", date: "2026-11-01", external_id: " plaid:abc " });
    expect(again.success).toBe(true);
    expect(again.data.alreadyRecorded).toBe(true);
    expect(again.data.transactionId).toBe(id);
    expect(await count()).toBe(1);

    // The same id in ANOTHER account is a different charge.
    const other = await tx({ op: "record", account_id: acctB, amount: -3, payee: "Tea", date: "2026-11-01", external_id: "plaid:abc" });
    expect(other.data.alreadyRecorded).toBeUndefined();
    expect(await count()).toBe(2);
  });

  it("leaves rows without an id exactly as before", async () => {
    const a = await tx({ op: "record", account_id: acctA, amount: -1, payee: "Same", date: "2026-11-02" });
    const b = await tx({ op: "record", account_id: acctA, amount: -1, payee: "Same", date: "2026-11-02" });
    expect(a.data.transactionId).not.toBe(b.data.transactionId);
    expect(a.data.externalId).toBeUndefined();
    const rows = await rowsOf(sql`SELECT external_id FROM transactions WHERE user_id = ${userId}`);
    expect(rows.map((r) => r.external_id)).toEqual([null, null]);
  });

  it("bulk: skips rows already recorded, also within the batch, and counts them apart", async () => {
    await tx({ op: "record", account_id: acctA, amount: -5, payee: "Old", date: "2026-11-03", external_id: "x-1" });
    const res = await tx({
      op: "record",
      account_id: acctA,
      transactions: [
        { amount: -5, payee: "Old", date: "2026-11-03", external_id: "x-1" },
        { amount: -6, payee: "New", date: "2026-11-03", external_id: "x-2" },
        { amount: -6, payee: "New again", date: "2026-11-03", external_id: "x-2" },
        { amount: -7, payee: "No id", date: "2026-11-03" },
      ],
    });
    expect(res.success).toBe(true);
    expect(res.data.imported).toBe(2);
    expect(res.data.alreadyRecorded).toBe(2);
    expect(res.data.failed).toBe(0);
    expect(res.data.results[0].alreadyRecorded).toBe(true);
    expect(typeof res.data.results[0].transactionId).toBe("number");
    expect(res.data.results[1].externalId).toBe("x-2");
    expect(res.data.results[2].alreadyRecorded).toBe(true);
    expect(await count()).toBe(3);
  });

  it("update sets, refuses a taken id, and clears", async () => {
    const a = await tx({ op: "record", account_id: acctA, amount: -1, payee: "A", date: "2026-11-04", external_id: "id-a" });
    const b = await tx({ op: "record", account_id: acctA, amount: -2, payee: "B", date: "2026-11-04" });

    const taken = await tx({ op: "update", id: b.data.transactionId, external_id: "id-a" });
    expect(JSON.stringify(taken)).toContain("already on transaction");

    const set = await tx({ op: "update", id: b.data.transactionId, external_id: "id-b" });
    expect(set.success).toBe(true);
    // Setting a row's own id again is not a conflict.
    expect((await tx({ op: "update", id: a.data.transactionId, external_id: "id-a" })).success).toBe(true);

    const cleared = await tx({ op: "update", id: b.data.transactionId, external_id: null });
    expect(cleared.success).toBe(true);
    const rows = await rowsOf(sql`SELECT id, external_id FROM transactions WHERE user_id = ${userId} ORDER BY id`);
    expect(rows.map((r) => r.external_id)).toEqual(["id-a", null]);
  });

  it("search_transactions finds by the id and returns it", async () => {
    await tx({ op: "record", account_id: acctA, amount: -1, payee: "A", date: "2026-11-05", external_id: "find-me" });
    await tx({ op: "record", account_id: acctA, amount: -2, payee: "B", date: "2026-11-05" });
    const res = await search({ external_id: "find-me" });
    const list = res.data?.results ?? [];
    const found = Array.isArray(list) ? list : [];
    expect(found.length).toBe(1);
    expect(found[0].external_id).toBe("find-me");
  });

  it("the database refuses a second row with the same id in one account", async () => {
    await tx({ op: "record", account_id: acctA, amount: -1, payee: "A", date: "2026-11-06", external_id: "dup" });
    await expect(
      db.execute(sql`
        INSERT INTO transactions (user_id, date, account_id, currency, amount, external_id)
        VALUES (${userId}, '2026-11-06', ${acctA}, 'USD', -1, 'dup')
      `),
    ).rejects.toThrow();
  });
});
