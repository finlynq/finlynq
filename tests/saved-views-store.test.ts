/**
 * GH #427: saved reports and saved Transactions views against a real
 * database, through the store (what /api/saved-views calls) and the MCP
 * `get_saved_views` tool.
 *
 * DB-gated (real Postgres): runs in CI's `finlynq_test` lane.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPgTools } from "../mcp-server/register-tools-pg";
import { TEST_DEK, bootstrapTestDb, resetTestDb, shutdownTestDb, createTestUser } from "./helpers/portfolio-fixtures";
import { db } from "@/db";
import {
  createSavedView,
  deleteSavedView,
  findSavedViewByName,
  listSavedViews,
  updateSavedView,
} from "@/lib/saved-views/store";
import { clearAllUserData } from "@/lib/auth/queries";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

type Handler = (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }> }>;

function tools(userId: string, dek: Buffer | null) {
  const server = new McpServer({ name: "saved-views-test", version: "0.0.0" });
  registerPgTools(server, db as never, userId, dek as Buffer);
  const reg = (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;
  return async (tool: string, args: Record<string, unknown>) => {
    const text = (await reg[tool].handler(args, {})).content[0].text;
    try {
      return JSON.parse(text);
    } catch {
      return { success: false, text };
    }
  };
}

const reportConfig = {
  tab: "income",
  date: { kind: "preset", preset: "last-12" },
  period: "monthly",
  groupBy: "category",
  accountIds: [],
  tag: "spending-money",
  business: false,
  yoy: null,
};
const txConfig = { date: { kind: "preset", preset: "ytd" }, tag: "spending-money", view: "list" };

describeDb("saved views store", () => {
  let userId = "";

  beforeAll(async () => {
    await bootstrapTestDb();
  });
  afterAll(async () => {
    await shutdownTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    await db.execute(sql`DELETE FROM saved_views`);
    userId = await createTestUser();
  });

  it("saves a report encrypted at rest and reads it back", async () => {
    const created = await createSavedView(userId, TEST_DEK, { kind: "report", name: "Spending money", config: reportConfig });
    expect(created).toMatchObject({ ok: true, view: { kind: "report", name: "Spending money", isDefault: false, unreadable: false } });

    const raw = await db.execute(sql`SELECT name_ct, config_ct FROM saved_views WHERE user_id = ${userId}`);
    const row = (raw as unknown as { rows: Array<{ name_ct: string; config_ct: string }> }).rows[0];
    expect(row.name_ct.startsWith("v1:")).toBe(true);
    expect(row.config_ct.startsWith("v1:")).toBe(true);
    expect(row.config_ct).not.toContain("spending-money");

    const [view] = await listSavedViews(userId, TEST_DEK, "report");
    expect(view.config).toMatchObject({ date: { kind: "preset", preset: "last-12" }, tag: "spending-money" });
  });

  it("refuses an invalid config and a duplicate name (same kind only)", async () => {
    expect(await createSavedView(userId, TEST_DEK, { kind: "report", name: "Bad", config: { tab: "nope" } })).toMatchObject({
      ok: false,
      code: "invalid",
    });
    await createSavedView(userId, TEST_DEK, { kind: "report", name: "Monthly", config: reportConfig });
    expect(await createSavedView(userId, TEST_DEK, { kind: "report", name: "  monthly ", config: reportConfig })).toMatchObject({
      ok: false,
      code: "duplicate_name",
    });
    // A Transactions view may share a report's name.
    expect((await createSavedView(userId, TEST_DEK, { kind: "transactions", name: "Monthly", config: txConfig })).ok).toBe(true);
  });

  it("keeps at most one default Transactions view, and none for reports", async () => {
    const a = await createSavedView(userId, TEST_DEK, { kind: "transactions", name: "A", config: txConfig, isDefault: true });
    const b = await createSavedView(userId, TEST_DEK, { kind: "transactions", name: "B", config: txConfig });
    if (!a.ok || !b.ok) throw new Error("setup");
    expect((await updateSavedView(userId, TEST_DEK, b.view.id, { isDefault: true })).ok).toBe(true);
    const views = await listSavedViews(userId, TEST_DEK, "transactions");
    expect(views.filter((v) => v.isDefault).map((v) => v.name)).toEqual(["B"]);

    expect(
      await createSavedView(userId, TEST_DEK, { kind: "report", name: "R", config: reportConfig, isDefault: true }),
    ).toMatchObject({ ok: false, code: "invalid" });
  });

  it("renames, saves changes and deletes, scoped to the owner", async () => {
    const created = await createSavedView(userId, TEST_DEK, { kind: "report", name: "Old", config: reportConfig });
    if (!created.ok) throw new Error("setup");
    const id = created.view.id;
    const other = await createTestUser();

    expect(await updateSavedView(other, TEST_DEK, id, { name: "Stolen" })).toMatchObject({ ok: false, code: "not_found" });
    expect(await deleteSavedView(other, id)).toBe(false);

    const renamed = await updateSavedView(userId, TEST_DEK, id, {
      name: "New",
      config: { ...reportConfig, date: { kind: "custom", start: "2026-01-01", end: "2026-03-31" } },
    });
    expect(renamed).toMatchObject({ ok: true, view: { name: "New", config: { date: { kind: "custom", start: "2026-01-01" } } } });
    expect((await findSavedViewByName(userId, TEST_DEK, "report", "new")).map((v) => v.id)).toEqual([id]);

    expect(await deleteSavedView(userId, id)).toBe(true);
    expect(await listSavedViews(userId, TEST_DEK)).toEqual([]);
  });

  it("returns rows as unreadable without the key", async () => {
    await createSavedView(userId, TEST_DEK, { kind: "report", name: "Locked", config: reportConfig });
    const [view] = await listSavedViews(userId, null);
    expect(view).toMatchObject({ unreadable: true, name: "", config: null });
  });

  it("Clear All Data removes saved views", async () => {
    await createSavedView(userId, TEST_DEK, { kind: "report", name: "Gone", config: reportConfig });
    await clearAllUserData(userId);
    expect(await listSavedViews(userId, TEST_DEK)).toEqual([]);
  });

  it("MCP get_saved_views lists views with today's dates, by name too, and needs the key", async () => {
    await createSavedView(userId, TEST_DEK, { kind: "report", name: "Spending money", config: reportConfig });
    await createSavedView(userId, TEST_DEK, { kind: "transactions", name: "Tagged", config: txConfig, isDefault: true });

    const call = tools(userId, TEST_DEK);
    const all = await call("get_saved_views", {});
    expect(all.success).toBe(true);
    expect(all.data.views).toHaveLength(2);
    const report = all.data.views.find((v: { kind: string }) => v.kind === "report");
    expect(report).toMatchObject({ name: "Spending money", dateRange: "Last 12 Months", tab: "Income Statement" });
    expect(report.startDate).toMatch(/^\d{4}-\d{2}-01$/);
    expect(report.path).toBe(`/reports?savedView=${report.id}`);
    expect(report.howToRun).toContain("get_income_statement");

    const one = await call("get_saved_views", { name: "spending MONEY" });
    expect(one.data.views.map((v: { name: string }) => v.name)).toEqual(["Spending money"]);

    const missing = await call("get_saved_views", { name: "Nope" });
    expect(missing.text).toMatch(/No saved view called/);

    const locked = await tools(userId, null)("get_saved_views", {});
    expect(locked.text).toMatch(/encrypted/);
  });
});
