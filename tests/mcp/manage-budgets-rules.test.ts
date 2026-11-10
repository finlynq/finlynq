/**
 * MCP manage_budgets rule ops + get_budget_summary's rule breakdown, through
 * the registered tools against a real database (plan/budget-rules.md).
 * "Today" is pinned to 2026-11-15.
 *
 * DB-gated (real Postgres): runs in CI's `finlynq_test` lane.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPgTools } from "../../mcp-server/register-tools-pg";
import {
  TEST_DEK,
  bootstrapTestDb,
  resetTestDb,
  shutdownTestDb,
  createTestUser,
  createCategory,
} from "../helpers/portfolio-fixtures";
import { db, schema } from "@/db";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

type Handler = (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }> }>;

describeDb("MCP manage_budgets rule ops", () => {
  let userId = "";
  let groceries = 0;
  let call: (tool: string, args: Record<string, unknown>) => Promise<any>;

  beforeAll(async () => {
    await bootstrapTestDb();
  });
  afterAll(async () => {
    await shutdownTestDb();
  });
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
    await resetTestDb();
    await db.execute(sql`DELETE FROM budget_group_amounts`);
    await db.execute(sql`DELETE FROM budget_rules`);
    await db.execute(sql`DELETE FROM settings`);
    userId = await createTestUser();
    await db.insert(schema.settings).values({ userId, key: "display_currency", value: "USD" });
    groceries = await createCategory({ userId, name: "Groceries", type: "E" });
    const server = new McpServer({ name: "budget-rules-test", version: "0.0.0" });
    registerPgTools(server, db as never, userId, TEST_DEK);
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;
    call = async (tool, args) => {
      // The handler is called directly, so zod defaults (preview: true) are not
      // applied: pass every flag explicitly. Refusals come back as plain text.
      const res = await tools[tool].handler(args, {});
      const text = res.content[0].text;
      try {
        return JSON.parse(text);
      } catch {
        return { success: false, text };
      }
    };
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("add_rule, rules, adjust, update_rule, delete_rule", async () => {
    const added = await call("manage_budgets", {
      op: "add_rule",
      category_id: groceries,
      amount: 100,
      start_month: "2026-10",
      increase: { mode: "percent", value: 3, every: "year", step_month: 1 },
    });
    expect(added.success).toBe(true);
    const ruleId = added.data.rule.rule_id;
    expect(added.data.rule).toMatchObject({ amount: 100, start_month: "2026-10", end_month: null, increase: { mode: "percent", value: 3, every: "year", step_month: 1 } });

    const view = await call("manage_budgets", { op: "rules", category_id: groceries, month: "2026-11" });
    expect(view.data.first_open_month).toBe("2026-11");
    expect(view.data.next_12_months[0]).toMatchObject({ month: "2026-11", from_rules: 100, budget: 100 });
    expect(view.data.next_12_months[2]).toMatchObject({ month: "2027-01", from_rules: 103, budget: 103 });

    const adj = await call("manage_budgets", { op: "adjust", category_id: groceries, month: "2026-11", adjustment: -30 });
    expect(adj.data).toMatchObject({ from_rules: 100, adjustment: -30, budget: 70 });

    const summary = await call("get_budget_summary", { month: "2026-11" });
    const line = summary.data.spending.flatMap((g: { lines: unknown[] }) => g.lines).find((l: { category_id: number }) => l.category_id === groceries);
    expect(line.budgeted).toBe(70);
    expect(line.rules).toEqual({ rule_count: 1, from_rules: 100, adjustment: -30, only_this_amount: false, month_ended: false });

    // Partial update: only the amount changes; the increase and start stay.
    const upd = await call("manage_budgets", { op: "update_rule", rule_id: ruleId, amount: 200 });
    expect(upd.data.rule).toMatchObject({ amount: 200, start_month: "2026-10", increase: { value: 3 } });
    const after = await call("manage_budgets", { op: "rules", category_id: groceries });
    expect(after.data.next_12_months[0].budget).toBe(170);

    const only = await call("manage_budgets", { op: "adjust", category_id: groceries, month: "2026-12", only_this_amount: 55 });
    expect(only.data).toMatchObject({ only_this_amount: true, budget: 55 });

    const del = await call("manage_budgets", { op: "delete_rule", rule_id: ruleId });
    expect(del.data.deleted).toBe(true);
    const gone = await call("manage_budgets", { op: "rules", category_id: groceries });
    expect(gone.data.rules).toEqual([]);
    expect(gone.data.next_12_months[0].budget).toBe(-30); // the adjustment stays as a plain value
  });

  it("fill mode:'rules' previews, then adds a rule and ends the overlapping one", async () => {
    await call("manage_budgets", { op: "add_rule", category_id: groceries, amount: 100, start_month: "2026-09" });
    const args = {
      op: "fill",
      months: ["2027-01"],
      source: { kind: "fixed", amount: 250 },
      scope: { kind: "keys", keys: [`c:${groceries}`] },
      mode: "rules",
      noEnd: true,
      overwrite: false,
      section: "spending",
      preview: true,
    };
    const preview = await call("manage_budgets", args);
    expect(preview.data.preview).toBe(true);
    expect(preview.data.rules[0]).toMatchObject({ amount: 250, start_month: "2027-01", end_month: null });
    expect(preview.data.rules[0].replaces[0]).toMatchObject({ action: "end", newEndMonth: "2026-12" });
    const saved = await call("manage_budgets", { ...args, preview: false });
    expect(saved.data.rules_added).toBe(1);
    const view = await call("manage_budgets", { op: "rules", category_id: groceries });
    expect(view.data.rules.map((r: { start_month: string; end_month: string | null }) => [r.start_month, r.end_month])).toEqual([
      ["2026-09", "2026-12"],
      ["2027-01", null],
    ]);
  });

  it("refuses an unknown rule and an adjustment on a month that has ended", async () => {
    const missing = await call("manage_budgets", { op: "delete_rule", rule_id: 999999 });
    expect(missing.success).toBe(false);
    const past = await call("manage_budgets", { op: "adjust", category_id: groceries, month: "2026-10", adjustment: 5 });
    expect(past.success).toBe(false);
    expect(JSON.stringify(past)).toMatch(/ended/);
  });
});
