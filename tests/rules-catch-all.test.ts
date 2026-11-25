/**
 * GH #456 — the one-click catch-all rule. Pure rules, first-match behaviour
 * through the real matcher, the wiring (route, Rules page, the MCP "apply
 * rules to uncategorized" tools skipping trades and transfer legs), and a
 * DB-gated run of createCatchAllRule.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import {
  CATCH_ALL_MAX_PRIORITY,
  catchAllCondition,
  catchAllPriority,
  isAnyAmountCondition,
  isCatchAllRule,
} from "@/lib/rules/catch-all";
import { applyRules, type TransactionRule } from "@/lib/auto-categorize";
import { ConditionGroup } from "@/lib/rules/schema";
import { MAX_REASONABLE_AMOUNT } from "@/lib/utils/number";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("catch-all rule shape", () => {
  it("its condition is a valid rule condition covering any storable amount", () => {
    const c = catchAllCondition();
    expect(ConditionGroup.safeParse({ all: [c] }).success).toBe(true);
    expect(isAnyAmountCondition(c)).toBe(true);
    expect(c).toMatchObject({ field: "amount", op: "between", min: -MAX_REASONABLE_AMOUNT, max: MAX_REASONABLE_AMOUNT });
  });

  it("is recognised by shape, whatever its name", () => {
    const cats = { conditions: { all: [catchAllCondition()] }, actions: [{ kind: "set_category", categoryId: 9 }] };
    expect(isCatchAllRule(cats)).toBe(true);
    // a narrower amount range, a second condition, or no category is not one
    expect(isCatchAllRule({ ...cats, conditions: { all: [{ field: "amount", op: "between", min: -100, max: 100 }] } })).toBe(false);
    expect(isCatchAllRule({ ...cats, conditions: { all: [catchAllCondition(), { field: "payee", op: "contains", value: "x" } as never] } })).toBe(false);
    expect(isCatchAllRule({ ...cats, actions: [{ kind: "set_tags" }] })).toBe(false);
    expect(isCatchAllRule({ conditions: null, actions: null })).toBe(false);
  });

  it("gets a priority below every rule and never above -1000", () => {
    expect(catchAllPriority([])).toBe(CATCH_ALL_MAX_PRIORITY);
    expect(catchAllPriority([0, 5, 10])).toBe(-1000);
    expect(catchAllPriority([0, -1500])).toBe(-1501);
  });
});

describe("catch-all through the real matcher", () => {
  const specific: TransactionRule = {
    id: 1, name: "Coffee", isActive: true, priority: 0,
    conditions: { all: [{ field: "payee", op: "contains", value: "coffee" }] },
    actions: [{ kind: "set_category", categoryId: 11 }],
  };
  const catchAll: TransactionRule = {
    id: 2, name: "Anything no other rule matches", isActive: true, priority: catchAllPriority([0]),
    conditions: { all: [catchAllCondition()] },
    actions: [{ kind: "set_category", categoryId: 99 }],
  };

  it("lets any other matching rule win, and catches the rest", () => {
    // catch-all listed first on purpose: priority, not order, decides
    expect(applyRules({ payee: "Corner Coffee", amount: -4.5 }, [catchAll, specific])?.rule.id).toBe(1);
    expect(applyRules({ payee: "New Shoe Store", amount: -12.34 }, [catchAll, specific])?.rule.id).toBe(2);
    expect(applyRules({ payee: "Payroll", amount: 2500 }, [catchAll, specific])?.rule.id).toBe(2);
    expect(applyRules({ payee: "", amount: 0 }, [catchAll, specific])?.rule.id).toBe(2);
  });

  it("does nothing once disabled", () => {
    expect(applyRules({ payee: "New Shoe Store", amount: -12.34 }, [{ ...catchAll, isActive: false }, specific])).toBeNull();
  });
});

describe("wiring", () => {
  it("the route is an encrypted apiHandler over createCatchAllRule", () => {
    const route = read("src/app/api/rules/catch-all/route.ts");
    expect(route).toContain('apiHandler({ auth: "encryption" }');
    expect(route).toContain("createCatchAllRule(userId");
  });

  it("the Rules page offers it only when the user has none, and the To categorize tab points to it", () => {
    const page = read("src/app/(app)/settings/rules/page.tsx");
    expect(page).toContain('fetch("/api/rules/catch-all", { method: "POST" })');
    expect(page).toContain("!catchAllRule");
    expect(read("src/components/inbox/inbox-to-categorize-tab.tsx")).toContain("/settings/rules#catch-all");
  });

  it("apply_rules_to_uncategorized skips trades and linked legs on both MCP transports", () => {
    for (const f of ["mcp-server/tools/rules.ts", "mcp-server/register-core-tools.ts"]) {
      const src = read(f);
      expect(src, f).toContain("AND portfolio_holding_id IS NULL");
      expect(src, f).toContain("AND link_id IS NULL AND trade_link_id IS NULL AND swap_link_id IS NULL");
    }
  });
});

// ── DB-gated ────────────────────────────────────────────────────────────────
const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

describeDb("createCatchAllRule", () => {
  // Imported lazily so the pure suites above run without a database.
  let fx: typeof import("./helpers/portfolio-fixtures");
  let store: typeof import("@/lib/rules/catch-all-server");
  let dbMod: typeof import("@/db");
  let userId = "";

  beforeAll(async () => {
    fx = await import("./helpers/portfolio-fixtures");
    store = await import("@/lib/rules/catch-all-server");
    dbMod = await import("@/db");
    await fx.bootstrapTestDb();
  });
  afterAll(async () => {
    await fx.shutdownTestDb();
  });
  beforeEach(async () => {
    await fx.resetTestDb();
    await dbMod.db.execute(sql`DELETE FROM transaction_rules`);
    userId = await fx.createTestUser();
  });

  async function rulesOf(uid: string) {
    const raw = await dbMod.db.execute(sql`
      SELECT id, priority, is_active, conditions, actions, name FROM transaction_rules WHERE user_id = ${uid} ORDER BY id
    `);
    return ((raw as unknown as { rows?: unknown[] }).rows ?? (raw as unknown as unknown[])) as Array<{
      id: number; priority: number; is_active: boolean; conditions: unknown; actions: Array<{ kind: string; categoryId?: number }>; name: string;
    }>;
  }

  it("makes the Uncategorized category and a lowest-priority rule, once", async () => {
    await dbMod.db.execute(sql`
      INSERT INTO transaction_rules (user_id, name, conditions, actions, is_active, priority, created_at)
      VALUES (${userId}, 'low', ${JSON.stringify({ all: [{ field: "amount", op: "gt", value: 1 }] })}::jsonb,
              ${JSON.stringify([{ kind: "set_tags", tags: "x" }])}::jsonb, true, -2000, '2026-01-01')
    `);
    const first = await store.createCatchAllRule(userId, fx.TEST_DEK);
    expect(first).toMatchObject({ created: true, categoryCreated: true, isActive: true });

    const rules = await rulesOf(userId);
    const made = rules.find((r) => r.id === first.ruleId)!;
    expect(made.priority).toBe(-2001);
    expect(made.name.startsWith("v1:")).toBe(true); // rule names are encrypted like any rule
    expect(isCatchAllRule({ conditions: made.conditions as never, actions: made.actions })).toBe(true);
    expect(made.actions[0].categoryId).toBe(first.categoryId);

    const cat = await dbMod.db.execute(sql`SELECT type, user_id FROM categories WHERE id = ${first.categoryId}`);
    const catRow = ((cat as unknown as { rows?: unknown[] }).rows ?? (cat as unknown as unknown[]))[0] as { type: string; user_id: string };
    expect(catRow).toMatchObject({ type: "E", user_id: userId });

    const again = await store.createCatchAllRule(userId, fx.TEST_DEK);
    expect(again).toMatchObject({ created: false, ruleId: first.ruleId, categoryId: first.categoryId });
    expect(await rulesOf(userId)).toHaveLength(2);
  });

  it("reuses an existing Uncategorized category and rebuilds after a delete", async () => {
    const existing = await fx.createCategory({ userId, name: "Uncategorized", type: "E" });
    const first = await store.createCatchAllRule(userId, fx.TEST_DEK);
    expect(first).toMatchObject({ created: true, categoryCreated: false, categoryId: existing });

    await dbMod.db.execute(sql`DELETE FROM transaction_rules WHERE id = ${first.ruleId}`);
    const rebuilt = await store.createCatchAllRule(userId, fx.TEST_DEK);
    expect(rebuilt.created).toBe(true);
    expect(rebuilt.categoryId).toBe(existing);
  });

  it("keeps users apart", async () => {
    const other = await fx.createTestUser();
    await store.createCatchAllRule(userId, fx.TEST_DEK);
    expect(await rulesOf(other)).toHaveLength(0);
    const theirs = await store.createCatchAllRule(other, fx.TEST_DEK);
    expect(theirs.created).toBe(true);
  });
});
