/**
 * Forecast inputs against the real database (DB-gated): the budget numbers
 * must equal the budget page's, the loan must be projected like the Loans
 * page, accounts land in the right pools, loan interest the payment covers is
 * left out, and a first forecast month adds up.
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
import { setBudgetCell } from "@/lib/budgets/write";
import { buildLoanSchedule } from "@/lib/loan-calculator";
import { projectLoanFromToday } from "@/lib/loans/projection";
import { loadForecastInputs } from "@/lib/forecast/inputs";
import { runForecast } from "@/lib/forecast/engine";
import { baselineScenario } from "@/lib/forecast/config";
import { shiftMonth } from "@/lib/forecast/layers";
import { todayISO } from "@/lib/utils/date";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

describeDb("forecast inputs", () => {
  let userId = "";
  const ids = {} as Record<string, number>;
  const today = todayISO();
  const next = shiftMonth(today.slice(0, 7), 1);
  const after = shiftMonth(next, 1);

  beforeAll(async () => {
    await bootstrapTestDb();
  });
  afterAll(async () => {
    await shutdownTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    userId = await createTestUser();
    await db.insert(schema.settings).values({ userId, key: "display_currency", value: "USD" });
    ids.chequing = await createAccount({ userId, name: "Chequing", currency: "USD", type: "A", isInvestment: false });
    ids.card = await createAccount({ userId, name: "Visa", currency: "USD", type: "L", isInvestment: false });
    ids.loanAcct = await createAccount({ userId, name: "Car loan account", currency: "USD", type: "L", isInvestment: false });
    ids.salary = await createCategory({ userId, name: "Salary", type: "I" });
    ids.groceries = await createCategory({ userId, name: "Groceries", type: "E" });
    ids.dining = await createCategory({ userId, name: "Dining", type: "E" });
    ids.interest = await createCategory({ userId, name: "Loan interest", type: "E" });
    await db.update(schema.categories).set({ group: "Food" }).where(sql`id IN (${ids.groceries}, ${ids.dining})`);

    await db.insert(schema.loans).values({
      userId,
      type: "loan",
      accountId: ids.loanAcct,
      currency: "USD",
      principal: 30000,
      annualRate: 3.48,
      termMonths: 60,
      startDate: "2026-01-01",
      paymentFrequency: "monthly",
      interestCategoryId: ids.interest,
      ...(buildNameFields(TEST_DEK, { name: "Car loan" }) as { nameCt?: string; nameLookup?: string }),
    });

    await recordTransaction({ userId, accountId: ids.chequing, date: "2026-01-02", currency: "USD", amount: 3000 });
    await recordTransaction({ userId, accountId: ids.card, date: "2026-01-03", currency: "USD", amount: -250 });
    await recordTransaction({ userId, accountId: ids.loanAcct, date: "2026-01-01", currency: "USD", amount: -20000, kind: "opening_balance" });

    await setBudgetCell(userId, "USD", `c:${ids.salary}`, next, 5000);
    await setBudgetCell(userId, "USD", `c:${ids.groceries}`, next, 500);
    await setBudgetCell(userId, "USD", `c:${ids.groceries}`, after, 600);
    await setBudgetCell(userId, "USD", `c:${ids.interest}`, next, 80);
  });

  it("budget numbers equal the budget page's; unbudgeted lines have no series", async () => {
    const inputs = await loadForecastInputs(userId, TEST_DEK, { horizonMonths: 24 });
    expect(inputs.startMonth).toBe(next);
    const month = await loadBudgetMonth(userId, TEST_DEK, next);
    const page = month.spending.flatMap((g) => g.lines).find((l) => l.name === "Groceries")!;
    expect(inputs.budget[`c:${ids.groceries}`].months[next]).toBe(page.budgeted);
    expect(inputs.budget[`c:${ids.groceries}`].months[after]).toBe(600);
    expect(inputs.budget[`c:${ids.dining}`]).toBeUndefined();
    expect(inputs.lines.map((l) => l.label)).toEqual(expect.arrayContaining(["Salary", "Groceries", "Dining", "Car loan"]));
  });

  it("leaves out loan interest the payment covers, saying why", async () => {
    const inputs = await loadForecastInputs(userId, TEST_DEK, { horizonMonths: 24 });
    expect(inputs.lines.some((l) => l.key === `c:${ids.interest}`)).toBe(false);
    expect(inputs.leftOut).toEqual([expect.objectContaining({ key: `c:${ids.interest}`, label: "Loan interest" })]);
  });

  it("projects the loan from the account balance, like the Loans page", async () => {
    const inputs = await loadForecastInputs(userId, TEST_DEK, { horizonMonths: 120 });
    const loan = inputs.loans[0];
    expect(loan).toMatchObject({ accountId: ids.loanAcct, label: "Car loan", openingBalance: 20000, balanceSource: "account" });
    const [row] = await db.select().from(schema.loans).where(sql`account_id = ${ids.loanAcct}`);
    const summary = buildLoanSchedule({
      principal: row.principal, annualRate: row.annualRate, termMonths: row.termMonths, startDate: row.startDate,
      paymentAmount: row.paymentAmount, paymentFrequency: row.paymentFrequency, extraPayment: 0, residualValue: row.residualValue,
    });
    const p = projectLoanFromToday(row, summary, { balance: -20000, txCount: 1 }, today);
    const months = Object.keys(loan.months).filter((m) => loan.months[m].payment > 0).sort();
    expect(months[months.length - 1]).toBe(p.payoffDate.slice(0, 7));
    expect(loan.months[next].payment).toBeCloseTo(p.upcoming.find((r) => r.date.startsWith(next))!.payment, 2);
  });

  it("puts accounts in pools and the first month adds up", async () => {
    const inputs = await loadForecastInputs(userId, TEST_DEK, { horizonMonths: 24 });
    const pool = Object.fromEntries(inputs.accounts.map((a) => [a.label, a.pool]));
    expect(pool).toMatchObject({ Chequing: "cash", Visa: "otherLiabilities", "Car loan account": "loans" });
    const r = runForecast(inputs, baselineScenario(12));
    expect(r.opening).toMatchObject({ cash: 3000, otherLiabilities: 250, loans: 20000 });
    const pay = inputs.loans[0].months[next].payment;
    expect(r.balances.cash[0]).toBeCloseTo(3000 + 5000 - 500 - pay, 2);
    expect(r.totals.expense[0]).toBe(500); // interest budget not counted again
  });

  it("works without a key (names fall back, nothing throws)", async () => {
    const inputs = await loadForecastInputs(userId, null, { horizonMonths: 12 });
    expect(inputs.lines.length).toBeGreaterThan(0);
  });
});
