/**
 * Budget rules against a real database (plan/budget-rules.md). "Today" is
 * pinned to 2026-11-15, so November is the open (current) month and October
 * has ended.
 *
 * Load-bearing: a rule only ever fills the current and later months, and a
 * month that has ended keeps its value whatever happens to the rules later.
 *
 * DB-gated (real Postgres): runs in CI's `finlynq_test` lane.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  TEST_DEK,
  bootstrapTestDb,
  resetTestDb,
  shutdownTestDb,
  createTestUser,
  createCategory,
} from "./helpers/portfolio-fixtures";
import { db, schema } from "@/db";
import { loadBudgetMonth } from "@/lib/budgets/load-month";
import { runBudgetFill, setBudgetAdjustment, setBudgetCell, updateLineSettings } from "@/lib/budgets/write";
import { createBudgetRule, deleteBudgetRule, loadLineRulesView, loadRules, updateBudgetRule } from "@/lib/budgets/rule-store";
import type { BudgetMonth } from "@/lib/budgets/month";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

function today(iso: string) {
  vi.setSystemTime(new Date(`${iso}T12:00:00Z`));
}

describeDb("budget rules store", () => {
  let userId = "";
  let groceries = 0;
  let coffee = 0;
  let salary = 0;
  const key = () => `c:${groceries}`;

  async function stored(categoryId: number, month: string) {
    const rows = await db.execute(
      sql`SELECT amount, rules_amount, override FROM budgets WHERE user_id = ${userId} AND category_id = ${categoryId} AND month = ${month}`,
    );
    const r = ((rows as unknown as { rows?: unknown[] }).rows ?? (rows as unknown as unknown[]))[0] as
      | { amount: number; rules_amount: number | null; override: boolean }
      | undefined;
    return r ? { amount: Number(r.amount), rulesAmount: r.rules_amount == null ? null : Number(r.rules_amount), override: !!r.override } : null;
  }
  const amountOf = async (categoryId: number, month: string) => (await stored(categoryId, month))?.amount ?? null;

  function line(m: BudgetMonth, categoryId: number) {
    for (const g of [...m.spending, ...m.income]) for (const l of g.lines) if (l.categoryId === categoryId) return l;
    throw new Error("line not found");
  }

  beforeAll(async () => {
    await bootstrapTestDb();
  });
  afterAll(async () => {
    await shutdownTestDb();
  });
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    today("2026-11-15");
    await resetTestDb();
    await db.execute(sql`DELETE FROM budget_group_amounts`);
    await db.execute(sql`DELETE FROM budget_rules`);
    await db.execute(sql`DELETE FROM settings`);
    userId = await createTestUser();
    await db.insert(schema.settings).values({ userId, key: "display_currency", value: "USD" });
    groceries = await createCategory({ userId, name: "Groceries", type: "E" });
    coffee = await createCategory({ userId, name: "Coffee", type: "E" });
    salary = await createCategory({ userId, name: "Salary", type: "I" });
    await db.update(schema.categories).set({ group: "Food" }).where(sql`id IN (${groceries}, ${coffee})`);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a rule with a past start fills only the current month and later", async () => {
    await createBudgetRule(userId, key(), { amount: 100, startMonth: "2026-09" });
    expect(await stored(groceries, "2026-09")).toBeNull();
    expect(await stored(groceries, "2026-10")).toBeNull();
    expect(await stored(groceries, "2026-11")).toEqual({ amount: 100, rulesAmount: 100, override: false });
    // 36 months stored: Nov 2026 .. Oct 2029.
    expect(await amountOf(groceries, "2029-10")).toBe(100);
    expect(await stored(groceries, "2029-11")).toBeNull();

    const nov = await loadBudgetMonth(userId, TEST_DEK, "2026-11");
    expect(line(nov, groceries).budgeted).toBe(100);
    expect(line(nov, groceries).plan).toMatchObject({ ruleCount: 1, fromRules: 100, adjustment: 0, override: false, open: true });
    // Beyond what is stored, the page works it out from the rule.
    const far = await loadBudgetMonth(userId, TEST_DEK, "2031-03");
    expect(line(far, groceries).budgeted).toBe(100);
    // A month that has ended shows no rule amount.
    const oct = await loadBudgetMonth(userId, TEST_DEK, "2026-10");
    expect(line(oct, groceries).budgeted).toBeNull();
    expect(line(oct, groceries).plan).toMatchObject({ ruleCount: 1, fromRules: null, open: false });
  });

  it("history keeps its values when a rule changes, even after the month moves on", async () => {
    await setBudgetCell(userId, "USD", key(), "2026-10", 80);
    const { id } = await createBudgetRule(userId, key(), { amount: 100, startMonth: "2026-09" });
    await updateBudgetRule(userId, id, { amount: 150, startMonth: "2026-09" });
    expect(await amountOf(groceries, "2026-10")).toBe(80);
    expect(await amountOf(groceries, "2026-11")).toBe(150);

    // December now: November has ended.
    today("2026-12-10");
    await updateBudgetRule(userId, id, { amount: 200, startMonth: "2026-01" });
    expect(await amountOf(groceries, "2026-10")).toBe(80);
    expect(await amountOf(groceries, "2026-11")).toBe(150);
    expect(await amountOf(groceries, "2026-12")).toBe(200);

    await deleteBudgetRule(userId, id);
    expect(await amountOf(groceries, "2026-11")).toBe(150);
    expect(await stored(groceries, "2026-12")).toBeNull();
    expect(await stored(groceries, "2027-06")).toBeNull();
  });

  it("increases count from the rule's start; moving the start restarts the count", async () => {
    const { id } = await createBudgetRule(userId, key(), {
      amount: 100,
      startMonth: "2026-10",
      endMonth: "2027-07",
      increase: { mode: "percent", value: 3, every: "year", stepMonth: 1 },
    });
    await createBudgetRule(userId, key(), { amount: 300, startMonth: "2027-01" });
    expect(await amountOf(groceries, "2026-12")).toBe(100);
    expect(await amountOf(groceries, "2027-01")).toBe(403);
    expect(await amountOf(groceries, "2027-07")).toBe(403);
    expect(await amountOf(groceries, "2027-08")).toBe(300);

    await updateBudgetRule(userId, id, {
      amount: 100,
      startMonth: "2027-01",
      endMonth: "2027-07",
      increase: { mode: "percent", value: 3, every: "year", stepMonth: 1 },
    });
    expect(await stored(groceries, "2026-12")).toBeNull();
    expect(await amountOf(groceries, "2027-01")).toBe(400);
  });

  it("typed amounts stay as typed and rules add to them; an adjustment can go negative", async () => {
    await setBudgetCell(userId, "USD", key(), "2026-12", 50);
    await createBudgetRule(userId, key(), { amount: 100, startMonth: "2026-11" });
    expect(await amountOf(groceries, "2026-12")).toBe(150);

    await setBudgetAdjustment(userId, key(), "2026-11", { adjustment: 25 });
    expect(await stored(groceries, "2026-11")).toEqual({ amount: 125, rulesAmount: 100, override: false });
    const [rule] = await loadRules(userId, key());
    await updateBudgetRule(userId, rule.id, { amount: 300, startMonth: "2026-11" });
    expect(await amountOf(groceries, "2026-11")).toBe(325);
    expect(await amountOf(groceries, "2026-12")).toBe(350);

    await setBudgetAdjustment(userId, key(), "2026-11", { adjustment: -400 });
    expect(await amountOf(groceries, "2026-11")).toBe(-100);

    await expect(setBudgetAdjustment(userId, key(), "2026-10", { adjustment: 5 })).rejects.toThrow(/ended/);
  });

  it("'use only this amount' ignores the rules for the month; stopping it brings them back", async () => {
    const { id } = await createBudgetRule(userId, key(), { amount: 100, startMonth: "2026-11" });
    await setBudgetAdjustment(userId, key(), "2026-11", { override: 60 });
    await updateBudgetRule(userId, id, { amount: 500, startMonth: "2026-11" });
    expect(await stored(groceries, "2026-11")).toEqual({ amount: 60, rulesAmount: null, override: true });
    expect(await amountOf(groceries, "2026-12")).toBe(500);

    await setBudgetAdjustment(userId, key(), "2026-11", { override: null, adjustment: 10 });
    expect(await stored(groceries, "2026-11")).toEqual({ amount: 510, rulesAmount: 500, override: false });
  });

  it("typing a rule-covered month (older phones, MCP) gives exactly that amount; clearing it leaves the rules", async () => {
    await createBudgetRule(userId, key(), { amount: 100, startMonth: "2026-11" });
    await setBudgetCell(userId, "USD", key(), "2026-11", 70);
    expect(await stored(groceries, "2026-11")).toEqual({ amount: 70, rulesAmount: null, override: true });
    await setBudgetCell(userId, "USD", key(), "2026-11", null);
    expect(await stored(groceries, "2026-11")).toEqual({ amount: 100, rulesAmount: 100, override: false });
  });

  it("deleting a rule removes rule-only months and keeps typed adjustments as plain values", async () => {
    const { id } = await createBudgetRule(userId, key(), { amount: 100, startMonth: "2026-11" });
    await setBudgetAdjustment(userId, key(), "2026-12", { adjustment: 20 });
    await deleteBudgetRule(userId, id);
    expect(await stored(groceries, "2026-11")).toBeNull();
    expect(await stored(groceries, "2026-12")).toEqual({ amount: 20, rulesAmount: null, override: false });
  });

  it("Fill 'this and future months' adds a rule per line and ends the overlapping ones", async () => {
    await createBudgetRule(userId, key(), { amount: 100, startMonth: "2026-09" });
    const req = {
      months: ["2027-01"],
      source: { kind: "fixed" as const, amount: 200 },
      adjust: { mode: "percent" as const, value: 3, every: "year" as const, stepMonth: 1 },
      overwrite: false,
      scope: { kind: "keys" as const, keys: [key()] },
      section: "spending" as const,
      mode: "rules" as const,
      noEnd: true,
    };
    const preview = await runBudgetFill(userId, TEST_DEK, { ...req, preview: true });
    expect(preview.applied).toBe(false);
    expect(preview.rules).toHaveLength(1);
    expect(preview.rules[0]).toMatchObject({ amount: 200, startMonth: "2027-01", endMonth: null });
    expect(preview.rules[0].replaces).toEqual([
      expect.objectContaining({ amount: 100, startMonth: "2026-09", action: "end", newEndMonth: "2026-12" }),
    ]);
    expect(await amountOf(groceries, "2027-01")).toBe(100);

    await runBudgetFill(userId, TEST_DEK, { ...req, preview: false });
    expect(await amountOf(groceries, "2026-12")).toBe(100);
    expect(await amountOf(groceries, "2027-01")).toBe(200);
    expect(await amountOf(groceries, "2028-01")).toBe(206);
    const rules = await loadRules(userId, key());
    expect(rules.map((r) => [r.startMonth, r.endMonth])).toEqual([
      ["2026-09", "2026-12"],
      ["2027-01", null],
    ]);
  });

  it("Fill 'this and future months' from a past month writes the ended months as plain values where empty", async () => {
    await setBudgetCell(userId, "USD", key(), "2026-09", 10);
    await runBudgetFill(userId, TEST_DEK, {
      months: ["2026-09", "2026-10", "2026-11", "2026-12"],
      source: { kind: "fixed", amount: 40 },
      adjust: null,
      overwrite: false,
      scope: { kind: "keys", keys: [key()] },
      section: "spending",
      mode: "rules",
      noEnd: false,
      preview: false,
    });
    expect(await amountOf(groceries, "2026-09")).toBe(10); // had a budget: kept
    expect(await stored(groceries, "2026-10")).toEqual({ amount: 40, rulesAmount: null, override: false });
    expect(await stored(groceries, "2026-11")).toEqual({ amount: 40, rulesAmount: 40, override: false });
    expect(await amountOf(groceries, "2026-12")).toBe(40);
    expect(await stored(groceries, "2027-01")).toBeNull();
  });

  it("Fill 'only this month' sets one month and ignores the line's rules there", async () => {
    await createBudgetRule(userId, key(), { amount: 100, startMonth: "2026-11" });
    const base = {
      months: ["2026-12", "2027-01"],
      source: { kind: "fixed" as const, amount: 75 },
      adjust: null,
      scope: { kind: "keys" as const, keys: [key(), `c:${coffee}`] },
      section: "spending" as const,
      mode: "this_month" as const,
    };
    const skip = await runBudgetFill(userId, TEST_DEK, { ...base, overwrite: false, preview: true });
    expect(skip.rows.map((r) => r.key)).toEqual([`c:${coffee}`]); // groceries already has a December budget
    await runBudgetFill(userId, TEST_DEK, { ...base, overwrite: true, preview: false });
    expect(await stored(groceries, "2026-12")).toEqual({ amount: 75, rulesAmount: null, override: true });
    expect(await stored(coffee, "2026-12")).toEqual({ amount: 75, rulesAmount: null, override: false });
    expect(await amountOf(groceries, "2027-01")).toBe(100);
  });

  it("income lines take rules too", async () => {
    await createBudgetRule(userId, `c:${salary}`, { amount: 5000, startMonth: "2026-11" });
    const nov = await loadBudgetMonth(userId, TEST_DEK, "2026-11");
    expect(nov.summary.plannedIncome).toBe(5000);
  });

  it("budgeting a group as one line moves its categories' rules to the group without counting them twice", async () => {
    await createBudgetRule(userId, key(), { amount: 100, startMonth: "2026-11" });
    await setBudgetAdjustment(userId, key(), "2026-11", { adjustment: 15 });
    await createBudgetRule(userId, `c:${coffee}`, { amount: 30, startMonth: "2026-11" });
    await updateLineSettings(userId, "USD", { group: "Food" }, { byGroup: true }, "2026-11");
    const rules = await loadRules(userId, "g:Food");
    expect(rules).toHaveLength(2);
    const nov = await loadBudgetMonth(userId, TEST_DEK, "2026-11");
    const food = nov.spending.find((g) => g.key === "g:Food")!;
    expect(food.budgeted).toBe(145);
    expect(food.plan).toMatchObject({ fromRules: 130, adjustment: 15 });
    const dec = await loadBudgetMonth(userId, TEST_DEK, "2026-12");
    expect(dec.spending.find((g) => g.key === "g:Food")!.budgeted).toBe(130);
  });

  it("the Rules panel view: rules and the next 12 months", async () => {
    await createBudgetRule(userId, key(), { amount: 100, startMonth: "2026-09", increase: { mode: "amount", value: 10, every: "month" } });
    await setBudgetAdjustment(userId, key(), "2026-12", { override: 5 });
    const view = await loadLineRulesView(userId, key(), "2026-10");
    expect(view.from).toBe("2026-11");
    expect(view.rules[0].fromMonthAmount).toBe(120);
    expect(view.months).toHaveLength(12);
    expect(view.months[0]).toMatchObject({ month: "2026-11", fromRules: 120, total: 120 });
    expect(view.months[1]).toMatchObject({ month: "2026-12", override: true, total: 5 });
  });

  it("refuses another user's category and a rule ending before it starts", async () => {
    const other = await createTestUser();
    const theirs = await createCategory({ userId: other, name: "Theirs", type: "E" });
    await expect(createBudgetRule(userId, `c:${theirs}`, { amount: 1, startMonth: "2026-11" })).rejects.toThrow(/not found/);
    await expect(createBudgetRule(userId, key(), { amount: 1, startMonth: "2026-11", endMonth: "2026-10" })).rejects.toThrow(/before/);
  });
});
