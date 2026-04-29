import { db, schema, getDialect } from "@/db";
import { eq, and, gte, lte, desc, sql, asc } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { requireHoldingForInvestmentAccount } from "@/lib/investment-account";

const { accounts, categories, transactions, portfolioHoldings, budgets, budgetTemplates } = schema;

/** Dialect-safe month extraction: strftime for SQLite, to_char for PG */
function monthExpr(dateCol: typeof transactions.date | typeof transactions.date): SQL<string> {
  return getDialect() === "postgres"
    ? sql<string>`to_char(${dateCol}::date, 'YYYY-MM')`
    : sql<string>`strftime('%Y-%m', ${dateCol})`;
}

// Accounts
//
// Stream D: getAccounts still ORDER BY plaintext `name` — it's the fallback
// column during the dual-write window. Once Phase 3 nulls plaintext out, the
// route handler must sort in memory by decrypted name (the plan calls this
// out; see src/app/api/... handlers that already paginate after decrypt).
export async function getAccounts(userId: string, opts?: { includeArchived?: boolean }) {
  const conditions = [eq(accounts.userId, userId)];
  if (!opts?.includeArchived) conditions.push(eq(accounts.archived, false));
  return db.select().from(accounts).where(and(...conditions)).orderBy(accounts.type, accounts.group, accounts.name).all();
}

export async function getAccountById(id: number, userId: string) {
  return db.select().from(accounts).where(and(eq(accounts.id, id), eq(accounts.userId, userId))).get();
}

/** CRUD write payload. `nameCt`/`nameLookup`/`aliasCt`/`aliasLookup` are set by the
 * route handler via {@link buildNameFields} when a DEK is available. */
type AccountWrite = {
  type: string;
  group: string;
  name: string;
  currency: string;
  note?: string;
  alias?: string | null;
  isInvestment?: boolean;
  nameCt?: string | null;
  nameLookup?: string | null;
  aliasCt?: string | null;
  aliasLookup?: string | null;
};

export async function createAccount(userId: string, data: AccountWrite) {
  return db.insert(accounts).values({ ...data, userId }).returning().get();
}

export async function updateAccount(
  id: number,
  userId: string,
  data: Partial<AccountWrite & { archived: boolean; isInvestment: boolean }>,
) {
  return db.update(accounts).set(data).where(and(eq(accounts.id, id), eq(accounts.userId, userId))).returning().get();
}

export async function deleteAccount(id: number, userId: string) {
  return db.delete(accounts).where(and(eq(accounts.id, id), eq(accounts.userId, userId)));
}

// Categories
export async function getCategories(userId: string) {
  return db.select().from(categories).where(eq(categories.userId, userId)).orderBy(categories.type, categories.group, categories.name).all();
}

export async function getCategoryById(id: number, userId: string) {
  return db.select().from(categories).where(and(eq(categories.id, id), eq(categories.userId, userId))).get();
}

type CategoryWrite = {
  type: string;
  group: string;
  name: string;
  note?: string;
  nameCt?: string | null;
  nameLookup?: string | null;
};

export async function createCategory(userId: string, data: CategoryWrite) {
  return db.insert(categories).values({ ...data, userId }).returning().get();
}

export async function updateCategory(id: number, userId: string, data: Partial<CategoryWrite>) {
  return db.update(categories).set(data).where(and(eq(categories.id, id), eq(categories.userId, userId))).returning().get();
}

export async function deleteCategory(id: number, userId: string) {
  return db.delete(categories).where(and(eq(categories.id, id), eq(categories.userId, userId)));
}

export async function getTransactionCountByCategory(categoryId: number, userId: string): Promise<number> {
  const result = await db.select({ count: sql<number>`count(*)` }).from(transactions).where(and(eq(transactions.categoryId, categoryId), eq(transactions.userId, userId))).get();
  return result?.count ?? 0;
}

// Transactions
export async function getTransactions(userId: string, filters?: {
  startDate?: string;
  endDate?: string;
  accountId?: number;
  categoryId?: number;
  portfolioHoldingId?: number;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const conditions = [eq(transactions.userId, userId)];
  if (filters?.startDate) conditions.push(gte(transactions.date, filters.startDate));
  if (filters?.endDate) conditions.push(lte(transactions.date, filters.endDate));
  if (filters?.accountId) conditions.push(eq(transactions.accountId, filters.accountId));
  if (filters?.categoryId) conditions.push(eq(transactions.categoryId, filters.categoryId));
  if (filters?.portfolioHoldingId) conditions.push(eq(transactions.portfolioHoldingId, filters.portfolioHoldingId));
  if (filters?.search) {
    conditions.push(
      sql`(${transactions.payee} LIKE ${'%' + filters.search + '%'} OR ${transactions.note} LIKE ${'%' + filters.search + '%'} OR ${transactions.tags} LIKE ${'%' + filters.search + '%'})`
    );
  }

  const query = db
    .select({
      id: transactions.id,
      date: transactions.date,
      accountId: transactions.accountId,
      accountName: accounts.name,
      // Plaintext alias + type so the UI can build a context-rich label
      // (e.g. "Credit Card · 609") for accounts whose name is terse/numeric.
      // Stream-D-correct decryption of `alias_ct` happens via the dedicated
      // /api/accounts path; same dual-write story as accounts.name.
      accountAlias: accounts.alias,
      accountType: accounts.type,
      categoryId: transactions.categoryId,
      categoryName: categories.name,
      categoryType: categories.type,
      currency: transactions.currency,
      amount: transactions.amount,
      // Phase 2 of the currency rework — surface entered-side fields so the
      // tx list shows what the user actually typed. normalizeTxRow() in
      // queries.ts handles the soft-fallback for un-backfilled rows.
      enteredCurrency: transactions.enteredCurrency,
      enteredAmount: transactions.enteredAmount,
      enteredFxRate: transactions.enteredFxRate,
      quantity: transactions.quantity,
      portfolioHolding: transactions.portfolioHolding,
      note: transactions.note,
      payee: transactions.payee,
      tags: transactions.tags,
      linkId: transactions.linkId,
    })
    .from(transactions)
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(and(...conditions))
    .orderBy(desc(transactions.date))
    .limit(filters?.limit ?? 100)
    .offset(filters?.offset ?? 0);

  return query.all();
}

export async function getTransactionCount(userId: string, filters?: {
  startDate?: string;
  endDate?: string;
  accountId?: number;
  categoryId?: number;
  portfolioHoldingId?: number;
  search?: string;
}): Promise<number> {
  const conditions = [eq(transactions.userId, userId)];
  if (filters?.startDate) conditions.push(gte(transactions.date, filters.startDate));
  if (filters?.endDate) conditions.push(lte(transactions.date, filters.endDate));
  if (filters?.accountId) conditions.push(eq(transactions.accountId, filters.accountId));
  if (filters?.categoryId) conditions.push(eq(transactions.categoryId, filters.categoryId));
  if (filters?.portfolioHoldingId) conditions.push(eq(transactions.portfolioHoldingId, filters.portfolioHoldingId));
  if (filters?.search) {
    conditions.push(
      sql`(${transactions.payee} LIKE ${'%' + filters.search + '%'} OR ${transactions.note} LIKE ${'%' + filters.search + '%'} OR ${transactions.tags} LIKE ${'%' + filters.search + '%'})`
    );
  }

  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(transactions)
    .where(and(...conditions))
    .get();

  return result?.count ?? 0;
}

export async function createTransaction(userId: string, data: {
  date: string;
  accountId: number;
  categoryId: number;
  currency?: string;
  amount?: number;
  // Phase 2 of the currency rework — entered/account trilogy. The route
  // handler converts entered→account via convertToAccountCurrency() before
  // calling this function and passes both sets of fields. enteredFxRate is
  // locked at write time so historical balances stay reproducible.
  enteredCurrency?: string | null;
  enteredAmount?: number | null;
  enteredFxRate?: number | null;
  quantity?: number;
  portfolioHolding?: string | null;
  portfolioHoldingId?: number | null;
  note?: string;
  payee?: string;
  tags?: string;
  isBusiness?: number;
  splitPerson?: string;
  splitRatio?: number;
}) {
  // Investment-account constraint: every transaction in a flagged account
  // must reference a portfolio_holdings row. Throws
  // InvestmentHoldingRequiredError when the FK is missing — the route
  // handler maps it to a 400.
  await requireHoldingForInvestmentAccount(userId, data.accountId, data.portfolioHoldingId);
  return db.insert(transactions).values({ ...data, userId }).returning().get();
}

export async function updateTransaction(id: number, userId: string, data: Partial<{
  date: string;
  accountId: number;
  categoryId: number;
  currency: string;
  amount: number;
  enteredCurrency: string | null;
  enteredAmount: number | null;
  enteredFxRate: number | null;
  quantity: number;
  portfolioHolding: string | null;
  portfolioHoldingId: number | null;
  note: string;
  payee: string;
  tags: string;
  isBusiness: number;
  splitPerson: string;
  splitRatio: number;
}>) {
  // Investment-account constraint applies to the post-merge state. Touching
  // accountId xor portfolioHoldingId can flip the row in or out of the
  // constraint, so we resolve both against the current row before checking.
  // `data.portfolioHoldingId === undefined` means the caller didn't include
  // the field; an explicit `null` is treated as a clear intent to unlink
  // (and rejected when the resulting account is investment).
  if (
    data.accountId !== undefined ||
    Object.prototype.hasOwnProperty.call(data, "portfolioHoldingId")
  ) {
    const current = await db
      .select({
        accountId: transactions.accountId,
        portfolioHoldingId: transactions.portfolioHoldingId,
      })
      .from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.userId, userId)))
      .get();
    if (current) {
      const resultingAccountId = data.accountId ?? current.accountId;
      const resultingHoldingId = Object.prototype.hasOwnProperty.call(data, "portfolioHoldingId")
        ? (data.portfolioHoldingId ?? null)
        : current.portfolioHoldingId;
      await requireHoldingForInvestmentAccount(userId, resultingAccountId, resultingHoldingId);
    }
  }
  return db.update(transactions).set(data).where(and(eq(transactions.id, id), eq(transactions.userId, userId))).returning().get();
}

/**
 * Soft-fallback for the entered-fields trilogy on read paths. Un-backfilled
 * legacy rows have entered_* NULL — for those we surface the recorded
 * (account-currency) values as if the user typed them, since that's the
 * only data we have. Single chokepoint so we don't sprinkle `?? amount`
 * across 30 read sites.
 */
export function normalizeTxRow<T extends {
  amount: number | null;
  currency: string | null;
  enteredAmount?: number | null;
  enteredCurrency?: string | null;
  enteredFxRate?: number | null;
}>(row: T): T & { enteredAmount: number; enteredCurrency: string; enteredFxRate: number } {
  return {
    ...row,
    enteredAmount: row.enteredAmount ?? row.amount ?? 0,
    enteredCurrency: row.enteredCurrency ?? row.currency ?? "CAD",
    enteredFxRate: row.enteredFxRate ?? 1,
  };
}

export async function deleteTransaction(id: number, userId: string) {
  return db.delete(transactions).where(and(eq(transactions.id, id), eq(transactions.userId, userId)));
}

// Portfolio
//
// Stream D: include *_ct columns alongside plaintext. Callers decrypt via
// decryptNamedRows() — queries.ts stays dialect-pure. ORDER BY dropped because
// sorting by ciphertext produces meaningless order; callers that need sorted
// output should sort by decrypted name in memory.
export async function getPortfolioHoldings(userId: string) {
  // Aggregate share count per holding via the FK so callers (transactions UI,
  // transfer dialog destination picker) can show "X shares" without a second
  // round-trip. Uses a correlated subquery so we keep one SELECT per holding
  // rather than a GROUP BY rewrite of the whole query.
  return db
    .select({
      id: portfolioHoldings.id,
      accountId: portfolioHoldings.accountId,
      accountName: accounts.name,
      accountNameCt: accounts.nameCt,
      name: portfolioHoldings.name,
      nameCt: portfolioHoldings.nameCt,
      symbol: portfolioHoldings.symbol,
      symbolCt: portfolioHoldings.symbolCt,
      currency: portfolioHoldings.currency,
      note: portfolioHoldings.note,
      // Sum of every tx's quantity column for this holding. Plaintext
      // metadata, no decryption needed. NULL coalesces to 0. Cast to
      // double precision so the pg driver returns a JS number rather than
      // a numeric string (PG SUM defaults to numeric, which the pg driver
      // parses as string and which would skip our share-count formatting
      // client-side — `Number(stringValue)` works but `(value as number).toLocaleString()`
      // on a string raw value renders as the original digits without grouping).
      currentShares: sql<number>`COALESCE((
        SELECT SUM(${transactions.quantity})
        FROM ${transactions}
        WHERE ${transactions.userId} = ${userId}
          AND ${transactions.portfolioHoldingId} = ${portfolioHoldings.id}
      ), 0)::float`,
    })
    .from(portfolioHoldings)
    .leftJoin(accounts, eq(portfolioHoldings.accountId, accounts.id))
    .where(eq(portfolioHoldings.userId, userId))
    .all();
}

// Budgets
export async function getBudgets(userId: string, month?: string) {
  const conditions = [eq(budgets.userId, userId)];
  if (month) conditions.push(eq(budgets.month, month));

  return db
    .select({
      id: budgets.id,
      categoryId: budgets.categoryId,
      categoryName: categories.name,
      categoryGroup: categories.group,
      month: budgets.month,
      amount: budgets.amount,
      currency: budgets.currency,
    })
    .from(budgets)
    .leftJoin(categories, eq(budgets.categoryId, categories.id))
    .where(and(...conditions))
    .orderBy(categories.group, categories.name)
    .all();
}

export async function upsertBudget(userId: string, data: { categoryId: number; month: string; amount: number; currency?: string }) {
  const existing = await db
    .select()
    .from(budgets)
    .where(and(eq(budgets.categoryId, data.categoryId), eq(budgets.month, data.month), eq(budgets.userId, userId)))
    .get();

  if (existing) {
    const update: { amount: number; currency?: string } = { amount: data.amount };
    if (data.currency) update.currency = data.currency;
    return db.update(budgets).set(update).where(eq(budgets.id, existing.id)).returning().get();
  }
  return db.insert(budgets).values({ ...data, userId, currency: data.currency ?? "CAD" }).returning().get();
}

export async function deleteBudget(id: number, userId: string) {
  return db.delete(budgets).where(and(eq(budgets.id, id), eq(budgets.userId, userId)));
}

// Budget Templates
export async function getBudgetTemplates(userId: string) {
  return db
    .select({
      id: budgetTemplates.id,
      name: budgetTemplates.name,
      categoryId: budgetTemplates.categoryId,
      categoryName: categories.name,
      categoryGroup: categories.group,
      amount: budgetTemplates.amount,
      createdAt: budgetTemplates.createdAt,
    })
    .from(budgetTemplates)
    .leftJoin(categories, eq(budgetTemplates.categoryId, categories.id))
    .where(eq(budgetTemplates.userId, userId))
    .orderBy(budgetTemplates.name)
    .all();
}

export async function createBudgetTemplate(userId: string, data: { name: string; categoryId: number; amount: number }) {
  return db
    .insert(budgetTemplates)
    .values({ ...data, userId, createdAt: new Date().toISOString() })
    .returning()
    .get();
}

export async function deleteBudgetTemplate(id: number, userId: string) {
  return db.delete(budgetTemplates).where(and(eq(budgetTemplates.id, id), eq(budgetTemplates.userId, userId)));
}

// Budget Rollover: get previous month overspend per category
export async function getBudgetRollover(userId: string, currentMonth: string) {
  const [y, m] = currentMonth.split("-").map(Number);
  const prevDate = new Date(y, m - 2, 1);
  const prevMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, "0")}`;

  const prevBudgets = await getBudgets(userId, prevMonth);
  if (prevBudgets.length === 0) return [];

  const prevStartDate = `${prevMonth}-01`;
  const prevEndDate = `${prevMonth}-${new Date(prevDate.getFullYear(), prevDate.getMonth() + 1, 0).getDate()}`;
  const prevSpending = await getSpendingByCategory(userId, prevStartDate, prevEndDate);

  const spendMap = new Map<number, number>();
  prevSpending.forEach((s) => {
    if (s.categoryId != null) {
      spendMap.set(s.categoryId, Math.abs(s.total));
    }
  });

  return prevBudgets
    .map((b) => {
      const spent = spendMap.get(b.categoryId) ?? 0;
      const overspend = spent - b.amount;
      return {
        categoryId: b.categoryId,
        categoryName: b.categoryName,
        budgetAmount: b.amount,
        spent,
        rolloverAmount: overspend > 0 ? overspend : 0,
      };
    })
    .filter((r) => r.rolloverAmount > 0);
}

// Dashboard aggregations
//
// Stream D: GROUP BY `accounts.name` + `alias` works only while plaintext
// columns are still populated (Phase 1 + 2). Post-Phase 3 this will need to
// GROUP BY accounts.id only and pull encrypted names via a separate lookup.
// Until then, we keep plaintext in the GROUP BY so result shape is unchanged.
// The returned rows carry both plaintext and *_ct columns so callers can
// pass them through decryptNamedRows().
export async function getAccountBalances(userId: string, opts?: { includeArchived?: boolean }) {
  const conditions = [eq(accounts.userId, userId)];
  if (!opts?.includeArchived) conditions.push(eq(accounts.archived, false));
  return db
    .select({
      accountId: accounts.id,
      accountName: accounts.name,
      accountNameCt: accounts.nameCt,
      accountType: accounts.type,
      accountGroup: accounts.group,
      currency: accounts.currency,
      archived: accounts.archived,
      isInvestment: accounts.isInvestment,
      alias: accounts.alias,
      aliasCt: accounts.aliasCt,
      balance: sql<number>`COALESCE(SUM(${transactions.amount}), 0)`,
    })
    .from(accounts)
    .leftJoin(transactions, eq(accounts.id, transactions.accountId))
    .where(and(...conditions))
    .groupBy(
      accounts.id,
      accounts.name,
      accounts.nameCt,
      accounts.type,
      accounts.group,
      accounts.currency,
      accounts.archived,
      accounts.isInvestment,
      accounts.alias,
      accounts.aliasCt,
    )
    .orderBy(accounts.type, accounts.group, accounts.name)
    .all();
}

export async function getMonthlySpending(userId: string, startDate: string, endDate: string) {
  return db
    .select({
      month: monthExpr(transactions.date),
      categoryGroup: categories.group,
      categoryName: categories.name,
      categoryType: categories.type,
      total: sql<number>`SUM(${transactions.amount})`,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(and(eq(transactions.userId, userId), gte(transactions.date, startDate), lte(transactions.date, endDate)))
    .groupBy(monthExpr(transactions.date), categories.name, categories.group, categories.type)
    .orderBy(monthExpr(transactions.date))
    .all();
}

export async function getSpendingByCategory(userId: string, startDate: string, endDate: string) {
  return db
    .select({
      categoryId: categories.id,
      categoryName: categories.name,
      categoryGroup: categories.group,
      categoryType: categories.type,
      total: sql<number>`SUM(${transactions.amount})`,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(
      and(
        eq(transactions.userId, userId),
        gte(transactions.date, startDate),
        lte(transactions.date, endDate),
        eq(categories.type, "E")
      )
    )
    .groupBy(categories.id, categories.name, categories.group, categories.type)
    .orderBy(sql`SUM(${transactions.amount})`)
    .all();
}

export async function getSpendingByCategoryAndCurrency(userId: string, startDate: string, endDate: string) {
  return db
    .select({
      categoryId: categories.id,
      categoryName: categories.name,
      categoryGroup: categories.group,
      categoryType: categories.type,
      currency: transactions.currency,
      total: sql<number>`SUM(${transactions.amount})`,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(
      and(
        eq(transactions.userId, userId),
        gte(transactions.date, startDate),
        lte(transactions.date, endDate),
        eq(categories.type, "E")
      )
    )
    .groupBy(categories.id, categories.name, categories.group, categories.type, transactions.currency)
    .orderBy(sql`SUM(${transactions.amount})`)
    .all();
}

export async function getIncomeVsExpenses(userId: string, startDate: string, endDate: string) {
  return db
    .select({
      month: monthExpr(transactions.date),
      type: categories.type,
      total: sql<number>`SUM(${transactions.amount})`,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(
      and(
        eq(transactions.userId, userId),
        gte(transactions.date, startDate),
        lte(transactions.date, endDate),
        sql`${categories.type} IN ('E', 'I')`
      )
    )
    .groupBy(monthExpr(transactions.date), categories.type)
    .orderBy(monthExpr(transactions.date))
    .all();
}

export async function getNetWorthOverTime(userId: string) {
  return db
    .select({
      month: monthExpr(transactions.date),
      currency: accounts.currency,
      cumulative: sql<number>`SUM(${transactions.amount})`,
    })
    .from(transactions)
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(eq(transactions.userId, userId))
    .groupBy(monthExpr(transactions.date), accounts.currency)
    .orderBy(monthExpr(transactions.date))
    .all();
}
