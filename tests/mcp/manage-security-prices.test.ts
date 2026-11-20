/**
 * GH #394 — MCP manage_security_prices, through the registered tool against a
 * real database: list / set (many marks, upsert) / delete / set_source, owner
 * scoping, and the snapshot-dirty stamp for a manually priced security.
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
} from "../helpers/portfolio-fixtures";
import { db, schema } from "@/db";
import { buildNameFields } from "@/lib/crypto/encrypted-columns";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

type Handler = (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }> }>;

async function createSecurity(userId: string, symbol: string, currency: string, priceSource = "auto") {
  const enc = buildNameFields(TEST_DEK, { symbol, name: `${symbol} bond` });
  const rows = await db
    .insert(schema.securities)
    .values({
      userId,
      clusterKey: `test:${symbol}`,
      assetType: "custom",
      priceSource,
      currency,
      symbolCt: enc.symbolCt as string,
      symbolLookup: enc.symbolLookup as string,
      nameCt: enc.nameCt as string,
      nameLookup: enc.nameLookup as string,
    })
    .returning({ id: schema.securities.id });
  return rows[0].id;
}

async function dirtyFrom(userId: string): Promise<string | null> {
  const r = await db.execute(sql`SELECT from_date FROM portfolio_snapshot_dirty WHERE user_id = ${userId}`);
  const rows = (r as unknown as { rows?: Array<{ from_date: string }> }).rows ?? (r as unknown as Array<{ from_date: string }>);
  return rows[0]?.from_date ?? null;
}

describeDb("MCP manage_security_prices", () => {
  let userId = "";
  let otherUser = "";
  let gd38 = 0;
  let call: (args: Record<string, unknown>) => Promise<any>;

  beforeAll(async () => {
    await bootstrapTestDb();
  });
  afterAll(async () => {
    await shutdownTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    await db.execute(sql`DELETE FROM custom_security_prices`);
    await db.execute(sql`DELETE FROM securities`);
    await db.execute(sql`DELETE FROM portfolio_snapshot_dirty`);
    userId = await createTestUser();
    otherUser = await createTestUser();
    gd38 = await createSecurity(userId, "GD38", "USD");
    const server = new McpServer({ name: "security-prices-test", version: "0.0.0" });
    registerPgTools(server, db as never, userId, TEST_DEK);
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;
    call = async (args) => {
      const res = await tools.manage_security_prices.handler(args, {});
      const text = res.content[0].text;
      try {
        return JSON.parse(text);
      } catch {
        return { success: false, text };
      }
    };
  });

  it("lists the user's securities with decrypted tickers and mark summaries", async () => {
    await createSecurity(otherUser, "AL35", "USD");
    const res = await call({ op: "list" });
    expect(res.success).toBe(true);
    expect(res.data.securities).toEqual([
      expect.objectContaining({ securityId: gd38, symbol: "GD38", priceSource: "auto", marks: { count: 0 } }),
    ]);
  });

  it("set writes many marks in the security's currency, warns while auto, and upserts by date", async () => {
    const first = await call({
      op: "set",
      security_id: gd38,
      prices: [
        { date: "2026-10-31", price: 61.2 },
        { date: "2026-11-07", price: 62.05 },
      ],
    });
    expect(first.data).toMatchObject({ written: 2, currency: "USD", firstDate: "2026-10-31", lastDate: "2026-11-07", priceSource: "auto" });
    expect(first.data.warning).toMatch(/not used/);
    // Auto-priced: marks change no chart, so nothing is stamped.
    expect(await dirtyFrom(userId)).toBeNull();

    await call({ op: "set", security_id: gd38, prices: [{ date: "2026-11-07", price: 63 }] });
    const marks = await call({ op: "list", security_id: gd38 });
    expect(marks.data.marks.map((m: { date: string; price: number }) => [m.date, m.price])).toEqual([
      ["2026-11-07", 63],
      ["2026-10-31", 61.2],
    ]);
  });

  it("set_source manual stamps history from the first mark; later sets stamp their earliest date", async () => {
    await call({ op: "set", security_id: gd38, prices: [{ date: "2026-09-30", price: 60 }] });
    const sw = await call({ op: "set_source", security_id: gd38, source: "manual" });
    expect(sw.data).toMatchObject({ priceSource: "manual", changed: true });
    expect(await dirtyFrom(userId)).toBe("2026-09-30");

    await db.execute(sql`DELETE FROM portfolio_snapshot_dirty`);
    const res = await call({
      op: "set",
      security_id: gd38,
      prices: [
        { date: "2026-11-14", price: 64 },
        { date: "2026-08-29", price: 58 },
      ],
    });
    expect(res.data.warning).toBeUndefined();
    expect(await dirtyFrom(userId)).toBe("2026-08-29");

    const again = await call({ op: "set_source", security_id: gd38, source: "manual" });
    expect(again.data.changed).toBe(false);
  });

  it("delete removes marks by date and by id", async () => {
    await call({
      op: "set",
      security_id: gd38,
      prices: [
        { date: "2026-10-01", price: 1 },
        { date: "2026-10-02", price: 2 },
        { date: "2026-10-03", price: 3 },
      ],
    });
    const listed = await call({ op: "list", security_id: gd38 });
    const idOf = (d: string) => listed.data.marks.find((m: { date: string }) => m.date === d).markId;
    const del = await call({ op: "delete", security_id: gd38, dates: ["2026-10-01"], mark_ids: [idOf("2026-10-03")] });
    expect(del.data.deleted).toBe(2);
    const left = await call({ op: "list", security_id: gd38 });
    expect(left.data.marks.map((m: { date: string }) => m.date)).toEqual(["2026-10-02"]);
  });

  it("refuses another user's security, bad dates and duplicates, writing nothing", async () => {
    const theirs = await createSecurity(otherUser, "AL41", "USD");
    expect((await call({ op: "set", security_id: theirs, prices: [{ date: "2026-11-01", price: 1 }] })).text).toMatch(/not found/);
    expect((await call({ op: "set_source", security_id: theirs, source: "manual" })).text).toMatch(/not found/);
    expect((await call({ op: "list", security_id: theirs })).text).toMatch(/not found/);

    const bad = await call({
      op: "set",
      security_id: gd38,
      prices: [
        { date: "2026-11-01", price: 1 },
        { date: "2026-02-30", price: 2 },
      ],
    });
    expect(bad.text).toMatch(/2026-02-30/);
    const dup = await call({
      op: "set",
      security_id: gd38,
      prices: [
        { date: "2026-11-01", price: 1 },
        { date: "2026-11-01", price: 2 },
      ],
    });
    expect(dup.text).toMatch(/twice/);
    expect((await call({ op: "list", security_id: gd38 })).data.marks).toEqual([]);
  });
});
