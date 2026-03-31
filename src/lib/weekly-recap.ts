// Weekly Financial Recap Generator

import { db, schema } from "@/db";
import { eq, and, gte, lte, sql, desc } from "drizzle-orm";

const { accounts, categories, transactions, budgets } = schema;

export type WeeklyRecap = {
  weekStart: string;
  weekEnd: string;
  spending: {
    total: number;
    previousWeekTotal: number;
    changePercent: number;
    topCategories: { name: string; total: number }[];
  };
  income: {
    total: number;
    previousWeekTotal: number;
  };
  netCashFlow: number;
  budgetStatus: { category: string; budget: number; spent: number; pctUsed: number }[];
  notableTransactions: { date: string; payee: string; category: string; amount: number }[];
  upcomingBills: { name: string; amount: number; date: string }[];
  netWorthChange: number;
};

function getWeekBounds(endDate?: string): { weekStart: string; weekEnd: string; prevWeekStart: string; prevWeekEnd: string } {
  const end = endDate ? new Date(endDate + "T00:00:00") : new Date();
  // Find the Sunday of the current week (or use endDate's week)
  const dayOfWeek = end.getDay();
  const weekEnd = new Date(end);
  // Set to Saturday end of week
  weekEnd.setDate(weekEnd.getDate() + (6 - dayOfWeek));
  const weekStart = new Date(weekEnd);
  weekStart.setDate(weekStart.getDate() - 6);

  const prevWeekEnd = new Date(weekStart);
  prevWeekEnd.setDate(prevWeekEnd.getDate() - 1);
  const prevWeekStart = new Date(prevWeekEnd);
  prevWeekStart.setDate(prevWeekStart.getDate() - 6);

  return {
    weekStart: weekStart.toISOString().split("T")[0],
    weekEnd: weekEnd.toISOString().split("T")[0],
    prevWeekStart: prevWeekStart.toISOString().split("T")[0],
    prevWeekEnd: prevWeekEnd.toISOString().split("T")[0],
  };
}

async function getSpendingForPeriod(userId: string, start: string, end: string) {
  const rows = await db
    .select({
      categoryName: categories.name,
      total: sql<number>`ABS(SUM(${transactions.amount}))`,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(
      and(
        eq(transactions.userId, userId),
        gte(transactions.date, start),
        lte(transactions.date, end),
        eq(categories.type, "E")
      )
    )
    .groupBy(categories.id)
    .all();

  const total = rows.reduce((s, r) => s + (r.total ?? 0), 0);
  const topCategories = rows
    .map((r) => ({ name: r.categoryName ?? "Uncategorized", total: Math.round((r.total ?? 0) * 100) / 100 }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 3);

  return { total: Math.round(total * 100) / 100, topCategories };
}

async function getIncomeForPeriod(userId: string, start: string, end: string): Promise<number> {
  const result = await db
    .select({ total: sql<number>`COALESCE(SUM(${transactions.amount}), 0)` })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(
      and(
        eq(transactions.userId, userId),
        gte(transactions.date, start),
        lte(transactions.date, end),
        eq(categories.type, "I")
      )
    )
    .get();
  return Math.round((result?.total ?? 0) * 100) / 100;
}

export async function generateWeeklyRecap(userId: string, endDate?: string): Promise<WeeklyRecap> {
  const { weekStart, weekEnd, prevWeekStart, prevWeekEnd } = getWeekBounds(endDate);

  // Spending
  const currentSpending = await getSpendingForPeriod(userId, weekStart, weekEnd);
  const prevSpending = await getSpendingForPeriod(userId, prevWeekStart, prevWeekEnd);
  const spendingChange = prevSpending.total > 0
    ? Math.round(((currentSpending.total - prevSpending.total) / prevSpending.total) * 100)
    : 0;

  // Income
  const currentIncome = await getIncomeForPeriod(userId, weekStart, weekEnd);
  const prevIncome = await getIncomeForPeriod(userId, prevWeekStart, prevWeekEnd);

  // Net cash flow
  const netCashFlow = Math.round((currentIncome - currentSpending.total) * 100) / 100;

  // Budget status for current month
  const now = new Date(weekEnd + "T00:00:00");
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [y, m] = month.split("-").map(Number);
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${new Date(y, m, 0).getDate()}`;

  const budgetRows = await db
    .select({
      category: categories.name,
      budget: budgets.amount,
      spent: sql<number>`COALESCE(ABS(SUM(CASE WHEN ${transactions.date} >= ${monthStart} AND ${transactions.date} <= ${monthEnd} THEN ${transactions.amount} ELSE 0 END)), 0)`,
    })
    .from(budgets)
    .leftJoin(categories, eq(budgets.categoryId, categories.id))
    .leftJoin(transactions, eq(transactions.categoryId, budgets.categoryId))
    .where(and(eq(budgets.month, month), eq(budgets.userId, userId)))
    .groupBy(budgets.id)
    .all();

  const budgetStatus = budgetRows
    .map((r) => ({
      category: r.category ?? "Unknown",
      budget: r.budget,
      spent: Math.round((r.spent ?? 0) * 100) / 100,
      pctUsed: r.budget > 0 ? Math.round(((r.spent ?? 0) / r.budget) * 100) : 0,
    }))
    .sort((a, b) => b.pctUsed - a.pctUsed);

  // Notable transactions (largest expenses this week)
  const notable = await db
    .select({
      date: transactions.date,
      payee: transactions.payee,
      categoryName: categories.name,
      amount: transactions.amount,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(
      and(
        eq(transactions.userId, userId),
        gte(transactions.date, weekStart),
        lte(transactions.date, weekEnd),
        eq(categories.type, "E")
      )
    )
    .orderBy(sql`${transactions.amount} ASC`)
    .limit(5)
    .all();

  const notableTransactions = notable.map((t) => ({
    date: t.date,
    payee: t.payee ?? "",
    category: t.categoryName ?? "Uncategorized",
    amount: Math.round(Math.abs(t.amount) * 100) / 100,
  }));

  // Upcoming bills (subscriptions in next 7 days from weekEnd)
  const weekAhead = new Date(new Date(weekEnd + "T00:00:00").getTime() + 7 * 86400000)
    .toISOString()
    .split("T")[0];

  const subs = await db
    .select()
    .from(schema.subscriptions)
    .where(
      and(
        eq(schema.subscriptions.userId, userId),
        eq(schema.subscriptions.status, "active"),
        gte(schema.subscriptions.nextDate, weekEnd),
        lte(schema.subscriptions.nextDate, weekAhead)
      )
    )
    .all();

  const upcomingBills = subs.map((s) => ({
    name: s.name,
    amount: Math.abs(s.amount),
    date: s.nextDate ?? "",
  }));

  // Net worth change over the week
  const nwThisWeek = await db
    .select({ total: sql<number>`COALESCE(SUM(${transactions.amount}), 0)` })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), gte(transactions.date, weekStart), lte(transactions.date, weekEnd)))
    .get();

  const netWorthChange = Math.round((nwThisWeek?.total ?? 0) * 100) / 100;

  return {
    weekStart,
    weekEnd,
    spending: {
      total: currentSpending.total,
      previousWeekTotal: prevSpending.total,
      changePercent: spendingChange,
      topCategories: currentSpending.topCategories,
    },
    income: {
      total: currentIncome,
      previousWeekTotal: prevIncome,
    },
    netCashFlow,
    budgetStatus,
    notableTransactions,
    upcomingBills,
    netWorthChange,
  };
}
