import { db, schema } from "@/db";
import { eq, and, gte, lte, desc, sql, like, asc } from "drizzle-orm";

const { accounts, categories, transactions, portfolioHoldings, budgets, budgetTemplates } = schema;

// Accounts
export function getAccounts() {
  return db.select().from(accounts).orderBy(accounts.type, accounts.group, accounts.name).all();
}

export function getAccountById(id: number) {
  return db.select().from(accounts).where(eq(accounts.id, id)).get();
}

export function createAccount(data: { type: string; group: string; name: string; currency: string; note?: string }) {
  return db.insert(accounts).values(data).returning().get();
}

export function updateAccount(id: number, data: Partial<{ type: string; group: string; name: string; currency: string; note: string }>) {
  return db.update(accounts).set(data).where(eq(accounts.id, id)).returning().get();
}

export function deleteAccount(id: number) {
  return db.delete(accounts).where(eq(accounts.id, id)).run();
}

// Categories
export function getCategories() {
  return db.select().from(categories).orderBy(categories.type, categories.group, categories.name).all();
}

export function getCategoryById(id: number) {
  return db.select().from(categories).where(eq(categories.id, id)).get();
}

export function createCategory(data: { type: string; group: string; name: string; note?: string }) {
  return db.insert(categories).values(data).returning().get();
}

export function updateCategory(id: number, data: Partial<{ type: string; group: string; name: string; note: string }>) {
  return db.update(categories).set(data).where(eq(categories.id, id)).returning().get();
}

export function deleteCategory(id: number) {
  return db.delete(categories).where(eq(categories.id, id)).run();
}

export function getTransactionCountByCategory(categoryId: number): number {
  const result = db.select({ count: sql<number>`count(*)` }).from(transactions).where(eq(transactions.categoryId, categoryId)).get();
  return result?.count ?? 0;
}

// Transactions
export function getTransactions(filters?: {
  startDate?: string;
  endDate?: string;
  accountId?: number;
  categoryId?: number;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const conditions = [];
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
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(transactions.date))
    .limit(filters?.limit ?? 100)
    .offset(filters?.offset ?? 0);

  return query.all();
}

export function getTransactionCount(filters?: {
  startDate?: string;
  endDate?: string;
  accountId?: number;
  categoryId?: number;
  search?: string;
}) {
  const conditions = [];
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
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .get();

  return result?.count ?? 0;
}

export function createTransaction(data: {
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
  return db.insert(transactions).values(data).returning().get();
}

export function updateTransaction(id: number, data: Partial<{
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
  return db.update(transactions).set(data).where(eq(transactions.id, id)).returning().get();
}

export function deleteTransaction(id: number) {
  return db.delete(transactions).where(eq(transactions.id, id)).run();
}

// Portfolio
export function getPortfolioHoldings() {
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
    .orderBy(accounts.name, portfolioHoldings.name)
    .all();
}

// Budgets
export function getBudgets(month?: string) {
  const conditions = [];
  if (month) conditions.push(eq(budgets.month, month));

  return db
    .select({
      id: budgets.id,
      categoryId: budgets.categoryId,
      categoryName: categories.name,
      categoryGroup: categories.group,
      month: budgets.month,
      amount: budgets.amount,
    })
    .from(budgets)
    .leftJoin(categories, eq(budgets.categoryId, categories.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(categories.group, categories.name)
    .all();
}

export function upsertBudget(data: { categoryId: number; month: string; amount: number }) {
  const existing = db
    .select()
    .from(budgets)
    .where(and(eq(budgets.categoryId, data.categoryId), eq(budgets.month, data.month)))
    .get();

  if (existing) {
    return db.update(budgets).set({ amount: data.amount }).where(eq(budgets.id, existing.id)).returning().get();
  }
  return db.insert(budgets).values(data).returning().get();
}

export function deleteBudget(id: number) {
  return db.delete(budgets).where(eq(budgets.id, id)).run();
}

// Budget Templates
export function getBudgetTemplates() {
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
    .orderBy(budgetTemplates.name)
    .all();
}

export function createBudgetTemplate(data: { name: string; categoryId: number; amount: number }) {
  return db
    .insert(budgetTemplates)
    .values({ ...data, createdAt: new Date().toISOString() })
    .returning()
    .get();
}

export function deleteBudgetTemplate(id: number) {
  return db.delete(budgetTemplates).where(eq(budgetTemplates.id, id)).run();
}

// Budget Rollover: get previous month overspend per category
export function getBudgetRollover(currentMonth: string) {
  const [y, m] = currentMonth.split("-").map(Number);
  const prevDate = new Date(y, m - 2, 1);
  const prevMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, "0")}`;

  const prevBudgets = getBudgets(prevMonth);
  if (prevBudgets.length === 0) return [];

  const prevStartDate = `${prevMonth}-01`;
  const prevEndDate = `${prevMonth}-${new Date(prevDate.getFullYear(), prevDate.getMonth() + 1, 0).getDate()}`;
  const prevSpending = getSpendingByCategory(prevStartDate, prevEndDate);

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
export function getAccountBalances() {
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
    .groupBy(accounts.id)
    .orderBy(accounts.type, accounts.group, accounts.name)
    .all();
}

export function getMonthlySpending(startDate: string, endDate: string) {
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
    .where(and(gte(transactions.date, startDate), lte(transactions.date, endDate)))
    .groupBy(sql`strftime('%Y-%m', ${transactions.date})`, categories.name)
    .orderBy(sql`strftime('%Y-%m', ${transactions.date})`)
    .all();
}

export function getSpendingByCategory(startDate: string, endDate: string) {
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
        gte(transactions.date, startDate),
        lte(transactions.date, endDate),
        eq(categories.type, "E")
      )
    )
    .groupBy(categories.id)
    .orderBy(sql`SUM(${transactions.amount})`)
    .all();
}

export function getIncomeVsExpenses(startDate: string, endDate: string) {
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
        gte(transactions.date, startDate),
        lte(transactions.date, endDate),
        sql`${categories.type} IN ('E', 'I')`
      )
    )
    .groupBy(sql`strftime('%Y-%m', ${transactions.date})`, categories.type)
    .orderBy(sql`strftime('%Y-%m', ${transactions.date})`)
    .all();
}

export function getNetWorthOverTime() {
  return db
    .select({
      month: sql<string>`strftime('%Y-%m', ${transactions.date})`,
      currency: accounts.currency,
      cumulative: sql<number>`SUM(${transactions.amount})`,
    })
    .from(transactions)
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .groupBy(sql`strftime('%Y-%m', ${transactions.date})`, accounts.currency)
    .orderBy(sql`strftime('%Y-%m', ${transactions.date})`)
    .all();
}
