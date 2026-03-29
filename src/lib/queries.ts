import { db, schema } from "@/db";
import { eq, and, gte, lte, desc, sql, asc } from "drizzle-orm";

const { accounts, categories, transactions, portfolioHoldings, budgets, budgetTemplates } = schema;

// Accounts
export function getAccounts(userId: string) {
  return db.select().from(accounts).where(eq(accounts.userId, userId)).orderBy(accounts.type, accounts.group, accounts.name).all();
}

export function getAccountById(id: number, userId: string) {
  return db.select().from(accounts).where(and(eq(accounts.id, id), eq(accounts.userId, userId))).get();
}

export function createAccount(userId: string, data: { type: string; group: string; name: string; currency: string; note?: string }) {
  return db.insert(accounts).values({ ...data, userId }).returning().get();
}

export function updateAccount(id: number, userId: string, data: Partial<{ type: string; group: string; name: string; currency: string; note: string }>) {
  return db.update(accounts).set(data).where(and(eq(accounts.id, id), eq(accounts.userId, userId))).returning().get();
}

export function deleteAccount(id: number, userId: string) {
  return db.delete(accounts).where(and(eq(accounts.id, id), eq(accounts.userId, userId))).run();
}

// Categories
export function getCategories(userId: string) {
  return db.select().from(categories).where(eq(categories.userId, userId)).orderBy(categories.type, categories.group, categories.name).all();
}

export function getCategoryById(id: number, userId: string) {
  return db.select().from(categories).where(and(eq(categories.id, id), eq(categories.userId, userId))).get();
}

export function createCategory(userId: string, data: { type: string; group: string; name: string; note?: string }) {
  return db.insert(categories).values({ ...data, userId }).returning().get();
}

export function updateCategory(id: number, userId: string, data: Partial<{ type: string; group: string; name: string; note: string }>) {
  return db.update(categories).set(data).where(and(eq(categories.id, id), eq(categories.userId, userId))).returning().get();
}

export function deleteCategory(id: number, userId: string) {
  return db.delete(categories).where(and(eq(categories.id, id), eq(categories.userId, userId))).run();
}

export function getTransactionCountByCategory(categoryId: number, userId: string): number {
  const result = db.select({ count: sql<number>`count(*)` }).from(transactions).where(and(eq(transactions.categoryId, categoryId), eq(transactions.userId, userId))).get();
  return result?.count ?? 0;
}

// Transactions
export function getTransactions(userId: string, filters?: {
  startDate?: string;
  endDate?: string;
  accountId?: number;
  categoryId?: number;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const conditions = [eq(transactions.userId, userId)];
  if (filters?.startDate) conditions.push(gte(transactions.date, filters.startDate));
  if (filters?.endDate) conditions.push(lte(transactions.date, filters.endDate));
  if (filters?.accountId) conditions.push(eq(transactions.accountId, filters.accountId));
  if (filters?.categoryId) conditions.push(eq(transactions.categoryId, filters.categoryId));
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
      categoryId: transactions.categoryId,
      categoryName: categories.name,
      categoryType: categories.type,
      currency: transactions.currency,
      amount: transactions.amount,
      quantity: transactions.quantity,
      portfolioHolding: transactions.portfolioHolding,
      note: transactions.note,
      payee: transactions.payee,
      tags: transactions.tags,
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

export function getTransactionCount(userId: string, filters?: {
  startDate?: string;
  endDate?: string;
  accountId?: number;
  categoryId?: number;
  search?: string;
}) {
  const conditions = [eq(transactions.userId, userId)];
  if (filters?.startDate) conditions.push(gte(transactions.date, filters.startDate));
  if (filters?.endDate) conditions.push(lte(transactions.date, filters.endDate));
  if (filters?.accountId) conditions.push(eq(transactions.accountId, filters.accountId));
  if (filters?.categoryId) conditions.push(eq(transactions.categoryId, filters.categoryId));
  if (filters?.search) {
    conditions.push(
      sql`(${transactions.payee} LIKE ${'%' + filters.search + '%'} OR ${transactions.note} LIKE ${'%' + filters.search + '%'} OR ${transactions.tags} LIKE ${'%' + filters.search + '%'})`
    );
  }

  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(transactions)
    .where(and(...conditions))
    .get();

  return result?.count ?? 0;
}

export function createTransaction(userId: string, data: {
  date: string;
  accountId: number;
  categoryId: number;
  currency: string;
  amount: number;
  quantity?: number;
  portfolioHolding?: string;
  note?: string;
  payee?: string;
  tags?: string;
  isBusiness?: number;
  splitPerson?: string;
  splitRatio?: number;
}) {
  return db.insert(transactions).values({ ...data, userId }).returning().get();
}

export function updateTransaction(id: number, userId: string, data: Partial<{
  date: string;
  accountId: number;
  categoryId: number;
  currency: string;
  amount: number;
  quantity: number;
  portfolioHolding: string;
  note: string;
  payee: string;
  tags: string;
  isBusiness: number;
  splitPerson: string;
  splitRatio: number;
}>) {
  return db.update(transactions).set(data).where(and(eq(transactions.id, id), eq(transactions.userId, userId))).returning().get();
}

export function deleteTransaction(id: number, userId: string) {
  return db.delete(transactions).where(and(eq(transactions.id, id), eq(transactions.userId, userId))).run();
}

// Portfolio
export function getPortfolioHoldings(userId: string) {
  return db
    .select({
      id: portfolioHoldings.id,
      accountId: portfolioHoldings.accountId,
      accountName: accounts.name,
      name: portfolioHoldings.name,
      symbol: portfolioHoldings.symbol,
      currency: portfolioHoldings.currency,
      note: portfolioHoldings.note,
    })
    .from(portfolioHoldings)
    .leftJoin(accounts, eq(portfolioHoldings.accountId, accounts.id))
    .where(eq(portfolioHoldings.userId, userId))
    .orderBy(accounts.name, portfolioHoldings.name)
    .all();
}

// Budgets
export function getBudgets(userId: string, month?: string) {
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

export function upsertBudget(userId: string, data: { categoryId: number; month: string; amount: number; currency?: string }) {
  const existing = db
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

export function deleteBudget(id: number, userId: string) {
  return db.delete(budgets).where(and(eq(budgets.id, id), eq(budgets.userId, userId))).run();
}

// Budget Templates
export function getBudgetTemplates(userId: string) {
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

export function createBudgetTemplate(userId: string, data: { name: string; categoryId: number; amount: number }) {
  return db
    .insert(budgetTemplates)
    .values({ ...data, userId, createdAt: new Date().toISOString() })
    .returning()
    .get();
}

export function deleteBudgetTemplate(id: number, userId: string) {
  return db.delete(budgetTemplates).where(and(eq(budgetTemplates.id, id), eq(budgetTemplates.userId, userId))).run();
}

// Budget Rollover: get previous month overspend per category
export function getBudgetRollover(userId: string, currentMonth: string) {
  const [y, m] = currentMonth.split("-").map(Number);
  const prevDate = new Date(y, m - 2, 1);
  const prevMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, "0")}`;

  const prevBudgets = getBudgets(userId, prevMonth);
  if (prevBudgets.length === 0) return [];

  const prevStartDate = `${prevMonth}-01`;
  const prevEndDate = `${prevMonth}-${new Date(prevDate.getFullYear(), prevDate.getMonth() + 1, 0).getDate()}`;
  const prevSpending = getSpendingByCategory(userId, prevStartDate, prevEndDate);

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
export function getAccountBalances(userId: string) {
  return db
    .select({
      accountId: accounts.id,
      accountName: accounts.name,
      accountType: accounts.type,
      accountGroup: accounts.group,
      currency: accounts.currency,
      balance: sql<number>`COALESCE(SUM(${transactions.amount}), 0)`,
    })
    .from(accounts)
    .leftJoin(transactions, eq(accounts.id, transactions.accountId))
    .where(eq(accounts.userId, userId))
    .groupBy(accounts.id)
    .orderBy(accounts.type, accounts.group, accounts.name)
    .all();
}

export function getMonthlySpending(userId: string, startDate: string, endDate: string) {
  return db
    .select({
      month: sql<string>`strftime('%Y-%m', ${transactions.date})`,
      categoryGroup: categories.group,
      categoryName: categories.name,
      categoryType: categories.type,
      total: sql<number>`SUM(${transactions.amount})`,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(and(eq(transactions.userId, userId), gte(transactions.date, startDate), lte(transactions.date, endDate)))
    .groupBy(sql`strftime('%Y-%m', ${transactions.date})`, categories.name)
    .orderBy(sql`strftime('%Y-%m', ${transactions.date})`)
    .all();
}

export function getSpendingByCategory(userId: string, startDate: string, endDate: string) {
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
    .groupBy(categories.id)
    .orderBy(sql`SUM(${transactions.amount})`)
    .all();
}

export function getSpendingByCategoryAndCurrency(userId: string, startDate: string, endDate: string) {
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
    .groupBy(categories.id, transactions.currency)
    .orderBy(sql`SUM(${transactions.amount})`)
    .all();
}

export function getIncomeVsExpenses(userId: string, startDate: string, endDate: string) {
  return db
    .select({
      month: sql<string>`strftime('%Y-%m', ${transactions.date})`,
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
    .groupBy(sql`strftime('%Y-%m', ${transactions.date})`, categories.type)
    .orderBy(sql`strftime('%Y-%m', ${transactions.date})`)
    .all();
}

export function getNetWorthOverTime(userId: string) {
  return db
    .select({
      month: sql<string>`strftime('%Y-%m', ${transactions.date})`,
      currency: accounts.currency,
      cumulative: sql<number>`SUM(${transactions.amount})`,
    })
    .from(transactions)
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(eq(transactions.userId, userId))
    .groupBy(sql`strftime('%Y-%m', ${transactions.date})`, accounts.currency)
    .orderBy(sql`strftime('%Y-%m', ${transactions.date})`)
    .all();
}
