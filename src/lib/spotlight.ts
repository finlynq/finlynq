// Dashboard Spotlight Engine — aggregates attention items

import { db, schema } from "@/db";
import { eq, and, gte, lte, sql } from "drizzle-orm";

const { accounts, categories, transactions, budgets, goals, subscriptions } = schema;

export type SpotlightSeverity = "critical" | "warning" | "info";

export type SpotlightItem = {
  id: string;
  type: string;
  severity: SpotlightSeverity;
  title: string;
  description: string;
  actionUrl: string;
  amount?: number;
};

const SEVERITY_ORDER: Record<SpotlightSeverity, number> = { critical: 0, warning: 1, info: 2 };

function today(): string {
  return new Date().toISOString().split("T")[0];
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function daysFromNow(dateStr: string): number {
  const t = new Date(today() + "T00:00:00").getTime();
  const d = new Date(dateStr + "T00:00:00").getTime();
  return Math.round((d - t) / 86400000);
}

// 1. Overspent budgets
async function getOverspentBudgets(userId: string): Promise<SpotlightItem[]> {
  const month = currentMonth();
  const [y, m] = month.split("-").map(Number);
  const startDate = `${month}-01`;
  const endDate = `${month}-${new Date(y, m, 0).getDate()}`;

  const rows = await db
    .select({
      budgetId: budgets.id,
      categoryName: categories.name,
      budgetAmount: budgets.amount,
      spent: sql<number>`COALESCE(ABS(SUM(CASE WHEN ${transactions.date} >= ${startDate} AND ${transactions.date} <= ${endDate} THEN ${transactions.amount} ELSE 0 END)), 0)`,
    })
    .from(budgets)
    .leftJoin(categories, eq(budgets.categoryId, categories.id))
    .leftJoin(transactions, eq(transactions.categoryId, budgets.categoryId))
    .where(and(eq(budgets.month, month), eq(budgets.userId, userId)))
    .groupBy(budgets.id, categories.name, budgets.amount)
    ;

  const items: SpotlightItem[] = [];
  for (const row of rows) {
    if (row.budgetAmount > 0 && row.spent > row.budgetAmount) {
      const pctOver = Math.round(((row.spent - row.budgetAmount) / row.budgetAmount) * 100);
      items.push({
        id: `overspent-${row.budgetId}`,
        type: "overspent_budget",
        severity: pctOver > 20 ? "critical" : "warning",
        title: `${row.categoryName ?? "Unknown"} over budget`,
        description: `Spent $${row.spent.toFixed(2)} of $${row.budgetAmount.toFixed(2)} budget (${pctOver}% over)`,
        actionUrl: "/budgets",
        amount: row.spent - row.budgetAmount,
      });
    }
  }
  return items;
}

// 2. Upcoming large bills (>$100 in next 7 days)
async function getUpcomingLargeBills(userId: string): Promise<SpotlightItem[]> {
  const todayStr = today();
  const weekAhead = new Date(new Date(todayStr + "T00:00:00").getTime() + 7 * 86400000)
    .toISOString()
    .split("T")[0];

  const subs = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.status, "active"),
        gte(subscriptions.nextDate, todayStr),
        lte(subscriptions.nextDate, weekAhead)
      )
    )
    ;

  const items: SpotlightItem[] = [];
  for (const sub of subs) {
    if (Math.abs(sub.amount) >= 100) {
      const days = daysFromNow(sub.nextDate!);
      items.push({
        id: `large-bill-sub-${sub.id}`,
        type: "large_bill",
        severity: "warning",
        title: `${sub.name} due${days <= 1 ? " tomorrow" : ` in ${days} days`}`,
        description: `$${Math.abs(sub.amount).toFixed(2)} ${sub.frequency} payment`,
        actionUrl: "/transactions",
        amount: Math.abs(sub.amount),
      });
    }
  }
  return items;
}

// 3. Goal deadlines approaching (<30 days, <80% funded)
async function getGoalDeadlines(userId: string): Promise<SpotlightItem[]> {
  const goalRows = await db
    .select({
      id: goals.id,
      name: goals.name,
      targetAmount: goals.targetAmount,
      deadline: goals.deadline,
      accountId: goals.accountId,
    })
    .from(goals)
    .where(and(eq(goals.userId, userId), eq(goals.status, "active")))
    ;

  const items: SpotlightItem[] = [];
  for (const goal of goalRows) {
    if (!goal.deadline) continue;
    const days = daysFromNow(goal.deadline);
    if (days < 0 || days > 30) continue;

    let current = 0;
    if (goal.accountId) {
      const bal = await db
        .select({ total: sql<number>`COALESCE(SUM(${transactions.amount}), 0)` })
        .from(transactions)
        .where(and(eq(transactions.accountId, goal.accountId), eq(transactions.userId, userId)))
        .get();
      current = Math.abs(bal?.total ?? 0);
    }

    const pct = goal.targetAmount > 0 ? (current / goal.targetAmount) * 100 : 0;
    if (pct < 80) {
      items.push({
        id: `goal-deadline-${goal.id}`,
        type: "goal_deadline",
        severity: days <= 7 ? "critical" : "warning",
        title: `"${goal.name}" deadline in ${days} days`,
        description: `${Math.round(pct)}% funded — need $${(goal.targetAmount - current).toFixed(2)} more`,
        actionUrl: "/goals",
        amount: goal.targetAmount - current,
      });
    }
  }
  return items;
}

// 4. Spending anomalies (>30% vs 3-month avg)
async function getSpendingAnomalies(userId: string): Promise<SpotlightItem[]> {
  const month = currentMonth();
  const [y, m] = month.split("-").map(Number);
  const startDate = `${month}-01`;
  const endDate = `${month}-${new Date(y, m, 0).getDate()}`;

  const threeMonthsAgo = new Date(y, m - 4, 1);
  const prevStart = threeMonthsAgo.toISOString().split("T")[0];
  const prevEndMonth = new Date(y, m - 1, 0);
  const prevEnd = prevEndMonth.toISOString().split("T")[0];

  const currentSpend = await db
    .select({
      categoryId: categories.id,
      categoryName: categories.name,
      total: sql<number>`ABS(SUM(${transactions.amount}))`,
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
    .groupBy(categories.id, categories.name)
    ;

  const prevSpend = await db
    .select({
      categoryId: categories.id,
      avgTotal: sql<number>`ABS(SUM(${transactions.amount})) / 3.0`,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(
      and(
        eq(transactions.userId, userId),
        gte(transactions.date, prevStart),
        lte(transactions.date, prevEnd),
        eq(categories.type, "E")
      )
    )
    .groupBy(categories.id)
    ;

  const prevMap = new Map(prevSpend.map((r) => [r.categoryId, r.avgTotal]));

  const items: SpotlightItem[] = [];
  for (const row of currentSpend) {
    const avg = prevMap.get(row.categoryId) ?? 0;
    if (avg <= 0) continue;
    const pctAbove = ((row.total - avg) / avg) * 100;
    if (pctAbove > 30) {
      items.push({
        id: `anomaly-${row.categoryId}`,
        type: "spending_anomaly",
        severity: pctAbove > 50 ? "warning" : "info",
        title: `${row.categoryName ?? "Unknown"} spending spike`,
        description: `$${row.total.toFixed(2)} this month vs $${avg.toFixed(2)} avg (+${Math.round(pctAbove)}%)`,
        actionUrl: "/transactions",
        amount: row.total - avg,
      });
    }
  }
  return items;
}

// 5. Uncategorized transactions
async function getUncategorizedTransactions(userId: string): Promise<SpotlightItem[]> {
  const month = currentMonth();
  const [y, m] = month.split("-").map(Number);
  const startDate = `${month}-01`;
  const endDate = `${month}-${new Date(y, m, 0).getDate()}`;

  const result = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        gte(transactions.date, startDate),
        lte(transactions.date, endDate),
        sql`${transactions.categoryId} IS NULL`
      )
    )
    .get();

  const count = result?.count ?? 0;
  if (count > 0) {
    return [
      {
        id: "uncategorized",
        type: "uncategorized",
        severity: count > 10 ? "warning" : "info",
        title: `${count} uncategorized transaction${count > 1 ? "s" : ""}`,
        description: "Categorize them for better budget tracking",
        actionUrl: "/transactions",
      },
    ];
  }
  return [];
}

// 6. Low account balances (<$500)
async function getLowBalances(userId: string): Promise<SpotlightItem[]> {
  const rows = await db
    .select({
      accountId: accounts.id,
      accountName: accounts.name,
      accountType: accounts.type,
      balance: sql<number>`COALESCE(SUM(${transactions.amount}), 0)`,
    })
    .from(accounts)
    .leftJoin(transactions, eq(accounts.id, transactions.accountId))
    .where(and(eq(accounts.userId, userId), eq(accounts.type, "A")))
    .groupBy(accounts.id, accounts.name, accounts.type)
    ;

  const items: SpotlightItem[] = [];
  for (const row of rows) {
    const group = row.accountName?.toLowerCase() ?? "";
    if (group.includes("rrsp") || group.includes("tfsa") || group.includes("invest")) continue;

    if (row.balance >= 0 && row.balance < 500) {
      items.push({
        id: `low-balance-${row.accountId}`,
        type: "low_balance",
        severity: row.balance < 100 ? "critical" : "warning",
        title: `${row.accountName} balance is low`,
        description: `Current balance: $${row.balance.toFixed(2)}`,
        actionUrl: "/accounts",
        amount: row.balance,
      });
    }
  }
  return items;
}

// 7. Subscription renewals (next 7 days)
async function getUpcomingSubscriptions(userId: string): Promise<SpotlightItem[]> {
  const todayStr = today();
  const weekAhead = new Date(new Date(todayStr + "T00:00:00").getTime() + 7 * 86400000)
    .toISOString()
    .split("T")[0];

  const subs = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.status, "active"),
        gte(subscriptions.nextDate, todayStr),
        lte(subscriptions.nextDate, weekAhead)
      )
    )
    ;

  return subs
    .filter((s) => Math.abs(s.amount) < 100)
    .map((s) => {
      const days = daysFromNow(s.nextDate!);
      return {
        id: `sub-renewal-${s.id}`,
        type: "subscription_renewal",
        severity: "info" as SpotlightSeverity,
        title: `${s.name} renewing${days <= 1 ? " tomorrow" : ` in ${days} days`}`,
        description: `$${Math.abs(s.amount).toFixed(2)} ${s.frequency}`,
        actionUrl: "/transactions",
        amount: Math.abs(s.amount),
      };
    });
}

export async function getSpotlightItems(userId: string): Promise<SpotlightItem[]> {
  const [
    overspent,
    largeBills,
    goalDeadlines,
    anomalies,
    uncategorized,
    lowBalances,
    upcomingSubs,
  ] = await Promise.all([
    getOverspentBudgets(userId),
    getUpcomingLargeBills(userId),
    getGoalDeadlines(userId),
    getSpendingAnomalies(userId),
    getUncategorizedTransactions(userId),
    getLowBalances(userId),
    getUpcomingSubscriptions(userId),
  ]);

  const items: SpotlightItem[] = [
    ...overspent,
    ...largeBills,
    ...goalDeadlines,
    ...anomalies,
    ...uncategorized,
    ...lowBalances,
    ...upcomingSubs,
  ];

  return items.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
