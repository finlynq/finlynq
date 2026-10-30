/**
 * Budget v2 month loader against a real database (plan/budget-v2.md).
 *
 * One USD user in October 2026:
 *   - Chequing receives Salary 5,000 and buys Groceries 300.
 *   - A credit card buys Groceries 100 and is paid 400 from Chequing
 *     (a transfer: counts nowhere).
 *   - A business account (role excluded) buys Coffee 50: not counted.
 *   - A car loan account, linked to a schedule loan with an interest
 *     category, receives the 587 payment from Chequing and books 87 interest.
 *     The payment is the debt line; the interest shows in that line and is
 *     NOT counted again under "Loan interest".
 * Then a group budgeted as one line, rollover with a reset and an edit, and a
 * fill that copies October forward with a monthly increase.
 *
 * DB-gated (real Postgres): runs in CI's `finlynq_test` lane.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
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
import { db, schema } from "@/db";
import { buildNameFields } from "@/lib/crypto/encrypted-columns";
import { loadBudgetMonth } from "@/lib/budgets/load-month";
import { runBudgetFill, setAccountBudgetRole, setBudgetCell, setCarryover, updateLineSettings } from "@/lib/budgets/write";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

const M = "2026-10";

describeDb("budget month loader", () => {
  let userId = "";
  const ids = {} as Record<string, number>;

  async function setGroup(categoryId: number, group: string) {
    await db.update(schema.categories).set({ group }).where(sql`id = ${categoryId}`);
  }

  async function transfer(fromId: number, toId: number, date: string, amount: number, categoryId: number) {
    const link = `link-${fromId}-${toId}-${date}`;
    await db.insert(schema.transactions).values([
      { userId, date, accountId: fromId, categoryId, currency: "USD", amount: -amount, linkId: link, source: "manual", payee: "" },
      { userId, date, accountId: toId, categoryId, currency: "USD", amount, linkId: link, source: "manual", payee: "" },
    ]);
  }

  beforeAll(async () => {
    await bootstrapTestDb();
  });
  afterAll(async () => {
    await shutdownTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    await db.execute(sql`DELETE FROM budget_group_amounts`);
    userId = await createTestUser();
    await db.insert(schema.settings).values({ userId, key: "display_currency", value: "USD" });

    ids.chequing = await createAccount({ userId, name: "Chequing", currency: "USD", type: "A", isInvestment: false });
    ids.card = await createAccount({ userId, name: "Visa", currency: "USD", type: "L", isInvestment: false });
    ids.business = await createAccount({ userId, name: "Business", currency: "USD", type: "A", isInvestment: false });
    ids.carLoanAcct = await createAccount({ userId, name: "Car loan account", currency: "USD", type: "L", isInvestment: false });

    ids.salary = await createCategory({ userId, name: "Salary", type: "I" });
    ids.groceries = await createCategory({ userId, name: "Groceries", type: "E" });
    ids.coffee = await createCategory({ userId, name: "Coffee", type: "E" });
    ids.rent = await createCategory({ userId, name: "Rent", type: "E" });
    ids.interest = await createCategory({ userId, name: "Loan interest", type: "E" });
    ids.transfer = await createCategory({ userId, name: "Transfer", type: "R" });
    await setGroup(ids.salary, "Income");
    await setGroup(ids.groceries, "Food");
    await setGroup(ids.coffee, "Food");
    await setGroup(ids.rent, "Housing");
    await setGroup(ids.interest, "Financial");

    const [loan] = await db
      .insert(schema.loans)
      .values({
        userId,
        type: "loan",
        accountId: ids.carLoanAcct,
        currency: "USD",
        principal: 30000,
        annualRate: 3.48,
        termMonths: 60,
        startDate: "2026-01-01",
        paymentFrequency: "monthly",
        interestCategoryId: ids.interest,
        ...(buildNameFields(TEST_DEK, { name: "Car loan" }) as { nameCt?: string; nameLookup?: string }),
      })
      .returning({ id: schema.loans.id });
    ids.loan = loan.id;

    await recordTransaction({ userId, accountId: ids.chequing, date: `${M}-01`, categoryId: ids.salary, currency: "USD", amount: 5000 });
    await recordTransaction({ userId, accountId: ids.chequing, date: `${M}-05`, categoryId: ids.groceries, currency: "USD", amount: -300 });
    await recordTransaction({ userId, accountId: ids.card, date: `${M}-06`, categoryId: ids.groceries, currency: "USD", amount: -100 });
    await transfer(ids.chequing, ids.card, `${M}-20`, 400, ids.transfer);
    await recordTransaction({ userId, accountId: ids.business, date: `${M}-07`, categoryId: ids.coffee, currency: "USD", amount: -50 });
    await transfer(ids.chequing, ids.carLoanAcct, `${M}-01`, 587, ids.transfer);
    await recordTransaction({ userId, accountId: ids.carLoanAcct, date: `${M}-01`, categoryId: ids.interest, currency: "USD", amount: -87 });
    // September, for rollover.
    await recordTransaction({ userId, accountId: ids.chequing, date: "2026-09-03", categoryId: ids.rent, currency: "USD", amount: -900 });

    await setAccountBudgetRole(userId, ids.business, "excluded");
    await setBudgetCell(userId, "USD", `c:${ids.groceries}`, M, 500);
    await setBudgetCell(userId, "USD", `c:${ids.coffee}`, M, 60);
    await setBudgetCell(userId, "USD", `c:${ids.rent}`, "2026-09", 1000);
    await setBudgetCell(userId, "USD", `c:${ids.rent}`, M, 1000);
    await setBudgetCell(userId, "USD", `c:${ids.salary}`, M, 5000);
  });

  const line = (m: Awaited<ReturnType<typeof loadBudgetMonth>>, name: string) =>
    m.spending.flatMap((g) => g.lines).find((l) => l.name === name)!;

  it("counts each transaction in at most one line", async () => {
    const m = await loadBudgetMonth(userId, TEST_DEK, M);
    expect(line(m, "Groceries")).toMatchObject({ budgeted: 500, actual: 400, left: 100 });
    expect(line(m, "Coffee").actual).toBe(0); // business account is excluded
    // Belongs to the car loan line, so the category isn't listed at all.
    expect(m.spending.flatMap((g) => g.lines).some((l) => l.name === "Loan interest")).toBe(false);
    expect(m.income[0].lines[0]).toMatchObject({ name: "Salary", budgeted: 5000, actual: 5000, status: "received" });
    expect(m.spending.flatMap((g) => g.lines).find((l) => l.name === "Transfer")).toBeUndefined();

    expect(m.debt).toHaveLength(1);
    const car = m.debt[0];
    expect(car).toMatchObject({ name: "Car loan", paid: 587, bookedInterest: 87, source: "schedule", status: "paid" });
    expect(car.planned).toBeGreaterThan(500);
    expect(car.principal + car.interest).toBeCloseTo(car.planned, 1);

    // Groceries 400 only: Coffee is on the excluded account, the interest is the
    // car loan's, and Rent has no October spending.
    expect(m.summary.spent).toBe(400);
    expect(m.summary.leftToPlan).toBeCloseTo(5000 - (500 + 60 + 1000) - car.planned, 2);
    expect(m.accounts.find((a) => a.id === ids.carLoanAcct)).toMatchObject({ role: "debt_payment", storedRole: null });
  });

  it("moves category budgets into a group budgeted as one line", async () => {
    const res = await updateLineSettings(userId, "USD", { group: "Food" }, { byGroup: true }, M);
    expect(res.movedBudgets).toBe(2);
    const m = await loadBudgetMonth(userId, TEST_DEK, M);
    const food = m.spending.find((g) => g.name === "Food")!;
    expect(food).toMatchObject({ byGroup: true, budgeted: 560, actual: 400, left: 160 });
    expect(food.lines.every((l) => l.budgeted == null)).toBe(true);
  });

  it("rolls leftover over, and resets or edits what carries in", async () => {
    await updateLineSettings(userId, "USD", { categoryId: ids.rent }, { rollover: true }, "2026-09");
    let m = await loadBudgetMonth(userId, TEST_DEK, M);
    expect(line(m, "Rent")).toMatchObject({ carriedIn: 100, budgeted: 1000, left: 1100, rollover: true });

    await setCarryover(userId, "USD", `c:${ids.rent}`, M, 0);
    m = await loadBudgetMonth(userId, TEST_DEK, M);
    expect(line(m, "Rent")).toMatchObject({ carriedIn: 0, left: 1000 });

    await setCarryover(userId, "USD", `c:${ids.rent}`, M, 250);
    m = await loadBudgetMonth(userId, TEST_DEK, M);
    expect(line(m, "Rent").carriedIn).toBe(250);

    await setCarryover(userId, "USD", `c:${ids.rent}`, M, null);
    m = await loadBudgetMonth(userId, TEST_DEK, M);
    expect(line(m, "Rent").carriedIn).toBe(100);
  });

  it("fills later months from October with a monthly increase, previewing first", async () => {
    const req = {
      months: ["2026-11", "2026-12"],
      source: { kind: "budget" as const },
      adjust: { mode: "percent" as const, value: 10, every: "month" as const },
      overwrite: false,
      scope: { kind: "keys" as const, keys: [`c:${ids.groceries}`] },
      section: "spending" as const,
    };
    const preview = await runBudgetFill(userId, TEST_DEK, { ...req, preview: true });
    expect(preview.rows.map((r) => [r.month, r.amount])).toEqual([
      ["2026-11", 550],
      ["2026-12", 605],
    ]);
    expect((await loadBudgetMonth(userId, TEST_DEK, "2026-11")).spending.flatMap((g) => g.lines).find((l) => l.name === "Groceries")?.budgeted).toBeNull();

    await runBudgetFill(userId, TEST_DEK, { ...req, preview: false });
    const dec = await loadBudgetMonth(userId, TEST_DEK, "2026-12");
    expect(dec.spending.flatMap((g) => g.lines).find((l) => l.name === "Groceries")?.budgeted).toBe(605);
  });

  it("leaves an account out, or makes it a debt payment with a fixed amount", async () => {
    await setAccountBudgetRole(userId, ids.card, "excluded");
    let m = await loadBudgetMonth(userId, TEST_DEK, M);
    expect(line(m, "Groceries").actual).toBe(300);

    await setAccountBudgetRole(userId, ids.card, "debt_payment", 400);
    m = await loadBudgetMonth(userId, TEST_DEK, M);
    const visa = m.debt.find((d) => d.accountId === ids.card)!;
    expect(visa).toMatchObject({ planned: 400, paid: 400, source: "fixed", status: "paid" });
  });
});
