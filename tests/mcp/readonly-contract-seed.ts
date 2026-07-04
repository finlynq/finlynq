/**
 * Seed helper for the MCP read-only contract test (FINLYNQ-260).
 *
 * Builds ONE coherent demo user against a real `finlynq_test` Postgres — a
 * trimmed, self-contained analogue of `scripts/seed-demo.ts` (which is a raw-pg
 * CLI bound to the published demo user id + an `assertDemoDatabase` guard, so it
 * can't be pointed at an arbitrary test DB). We reuse the load-bearing row
 * builders from `tests/helpers/portfolio-fixtures.ts` (PostgresAdapter bootstrap,
 * `*_test`-only DB guard, TEST_DEK, holding_accounts dual-write) and add the few
 * entities the read-only tool surface needs beyond the portfolio cohort: a loan,
 * a goal (+ join), a subscription, a budget, a recurring transaction, and a
 * staged import.
 *
 * Every name column is written with the same TEST_DEK the contract test hands to
 * `registerPgTools`, so name-decrypting reads return real strings.
 */
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { buildNameFields } from "@/lib/crypto/encrypted-columns";
import {
  TEST_DEK,
  bootstrapTestDb,
  createAccount,
  createCategory,
  createHolding,
  recordTransaction,
  seedFxRate,
  seedPriceCache,
} from "../helpers/portfolio-fixtures";

export { TEST_DEK, bootstrapTestDb };

export interface SeededWorld {
  userId: string;
  cashAccountId: number;
  investmentAccountId: number;
  incomeCategoryId: number;
  expenseCategoryId: number;
  holdingId: number;
  holdingSymbol: string;
  cashSleeveHoldingId: number;
  transactionId: number;
  loanId: number;
  goalId: number;
  subscriptionId: number;
  stagedImportId: string;
}

function todayISO(): string {
  return new Date().toISOString().split("T")[0];
}

/** Insert a user carrying a stub wrapped-DEK; the contract test passes TEST_DEK
 *  directly to the tools, so the wrapped columns are never unwrapped here. */
async function createUser(): Promise<string> {
  const id = randomUUID();
  const nowIso = new Date().toISOString();
  await db.insert(schema.users).values({
    id,
    username: `roc-${id.slice(0, 8)}`,
    email: `${id.slice(0, 8)}@test.local`,
    passwordHash: "test-bcrypt-stub",
    role: "user",
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  return id;
}

/**
 * TRUNCATE every table this seed touches, then rebuild a single coherent user.
 * Idempotent across runs. Returns the ids the contract test's arg-table needs.
 */
export async function seedContractWorld(): Promise<SeededWorld> {
  await bootstrapTestDb();
  await db.execute(sql`TRUNCATE TABLE
    transactions,
    transaction_splits,
    holding_accounts,
    portfolio_holdings,
    categories,
    goal_accounts,
    goals,
    loans,
    subscriptions,
    budgets,
    recurring_transactions,
    staged_transactions,
    staged_imports,
    accounts,
    users,
    price_cache,
    fx_rates,
    fx_overrides
    RESTART IDENTITY CASCADE`);

  const userId = await createUser();

  // FX + prices so the valuation paths short-circuit external providers.
  await seedFxRate({ currency: "USD", rateToUsd: 1 });
  await seedFxRate({ currency: "CAD", rateToUsd: 0.73 });
  await seedPriceCache({ symbol: "VTI", price: 250, currency: "USD" });

  const cashAccountId = await createAccount({
    userId,
    name: "Chequing",
    currency: "USD",
    type: "A",
    group: "Banks",
    isInvestment: false,
  });
  const investmentAccountId = await createAccount({
    userId,
    name: "Brokerage",
    currency: "USD",
    type: "A",
    group: "Investments",
    isInvestment: true,
  });

  const incomeCategoryId = await createCategory({ userId, name: "Salary", type: "I" });
  const expenseCategoryId = await createCategory({ userId, name: "Groceries", type: "E" });

  // A tradable holding + its cash sleeve.
  const holdingSymbol = "VTI";
  const holdingId = await createHolding({
    userId,
    accountId: investmentAccountId,
    name: "Vanguard Total Stock",
    symbol: holdingSymbol,
    currency: "USD",
  });
  const cashSleeveHoldingId = await createHolding({
    userId,
    accountId: investmentAccountId,
    name: "Cash USD",
    symbol: null,
    currency: "USD",
  });

  // Cash-side transaction (payee-bearing so search_transactions / test_rule match).
  const transactionId = await recordTransaction({
    userId,
    accountId: cashAccountId,
    categoryId: expenseCategoryId,
    currency: "USD",
    amount: -42.5,
    payee: "Whole Foods Market",
    date: todayISO(),
  });
  // An income row + a buy leg so flow + portfolio tools have data.
  await recordTransaction({
    userId,
    accountId: cashAccountId,
    categoryId: incomeCategoryId,
    currency: "USD",
    amount: 3000,
    payee: "Acme Payroll",
    date: todayISO(),
  });
  await recordTransaction({
    userId,
    accountId: investmentAccountId,
    currency: "USD",
    amount: -2500,
    quantity: 10,
    portfolioHoldingId: holdingId,
    payee: "Buy VTI",
    kind: "buy",
    date: todayISO(),
  });

  // Loan.
  const loanNames = buildNameFields(TEST_DEK, { name: "Car Loan" });
  const [loanRow] = await db
    .insert(schema.loans)
    .values({
      userId,
      type: "auto",
      currency: "USD",
      principal: 20000,
      annualRate: 0.06,
      termMonths: 60,
      startDate: todayISO(),
      paymentFrequency: "monthly",
      ...(loanNames as { nameCt?: string | null; nameLookup?: string | null }),
    })
    .returning({ id: schema.loans.id });
  const loanId = loanRow.id;

  // Goal + join.
  const goalNames = buildNameFields(TEST_DEK, { name: "Emergency Fund" });
  const [goalRow] = await db
    .insert(schema.goals)
    .values({
      userId,
      type: "savings",
      currency: "USD",
      targetAmount: 10000,
      accountId: cashAccountId,
      priority: 1,
      status: "active",
      ...(goalNames as { nameCt?: string | null; nameLookup?: string | null }),
    })
    .returning({ id: schema.goals.id });
  const goalId = goalRow.id;
  await db.insert(schema.goalAccounts).values({ userId, goalId, accountId: cashAccountId });

  // Subscription.
  const subNames = buildNameFields(TEST_DEK, { name: "Netflix" });
  const [subRow] = await db
    .insert(schema.subscriptions)
    .values({
      userId,
      amount: 15.99,
      currency: "USD",
      frequency: "monthly",
      categoryId: expenseCategoryId,
      accountId: cashAccountId,
      nextDate: todayISO(),
      status: "active",
      ...(subNames as { nameCt?: string | null; nameLookup?: string | null }),
    })
    .returning({ id: schema.subscriptions.id });
  const subscriptionId = subRow.id;

  // Budget + recurring txn (for get_budget_summary / get_recurring_transactions).
  await db.insert(schema.budgets).values({
    userId,
    categoryId: expenseCategoryId,
    month: todayISO().slice(0, 7),
    amount: 500,
    currency: "USD",
  });
  await db.insert(schema.recurringTransactions).values({
    userId,
    payee: "Rent",
    amount: -1500,
    frequency: "monthly",
    categoryId: expenseCategoryId,
    accountId: cashAccountId,
    nextDate: todayISO(),
    active: 1,
  });

  // Staged import (pending) so get_staged_import / list_staged_imports have a row.
  const stagedImportId = randomUUID();
  const expiresAt = new Date(Date.now() + 14 * 24 * 3600 * 1000);
  await db.insert(schema.stagedImports).values({
    id: stagedImportId,
    userId,
    source: "upload",
    status: "pending",
    totalRowCount: 1,
    duplicateCount: 0,
    expiresAt,
    boundAccountId: cashAccountId,
    fileFormat: "csv",
    originalFilename: "statement.csv",
    encryptionTier: "user",
  });

  return {
    userId,
    cashAccountId,
    investmentAccountId,
    incomeCategoryId,
    expenseCategoryId,
    holdingId,
    holdingSymbol,
    cashSleeveHoldingId,
    transactionId,
    loanId,
    goalId,
    subscriptionId,
    stagedImportId,
  };
}

export const CONTRACT_DEK: Buffer = TEST_DEK;
