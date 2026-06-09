// Weekly Financial Recap Generator

import { db, schema } from "@/db";
import { eq, and, gte, lte, sql, desc } from "drizzle-orm";
import { tryDecryptField } from "@/lib/crypto/envelope";
import { getDisplayCurrency, getRateMap, convertWithRateMap } from "@/lib/fx-service";
import { convertReportingSlice } from "@/lib/fx/reporting-amount";

const { accounts, categories, transactions, budgets } = schema;

type RateCtx = { displayCurrency: string; rateMap: Map<string, number> };

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

async function getSpendingForPeriod(userId: string, start: string, end: string, dek: Buffer | null, fx: RateCtx) {
  // Stream D Phase 4 — plaintext name dropped; ciphertext only.
  // FINLYNQ-123 — spending is a FLOW figure, so aggregate per
  // (category, currency, reporting_currency) slice and convert each to the
  // display currency via the stored historical reporting_amount (falling back
  // to a current-rate conversion). ABS the converted slice, not raw amount.
  const rows = await db
    .select({
      categoryId: categories.id,
      categoryNameCt: categories.nameCt,
      currency: transactions.currency,
      reportingCurrency: transactions.reportingCurrency,
      totalAmount: sql<number>`SUM(${transactions.amount})`,
      totalReporting: sql<number | null>`SUM(${transactions.reportingAmount})`,
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
    .groupBy(categories.id, categories.nameCt, transactions.currency, transactions.reportingCurrency)
    .all();

  // Collapse the per-currency slices back to one converted total per category.
  const byCategory = new Map<number | string, { name: string; total: number }>();
  for (const r of rows) {
    const converted = convertReportingSlice(r, fx.displayCurrency, fx.rateMap);
    const key = r.categoryId ?? "uncategorized";
    const name = (r.categoryNameCt && dek ? tryDecryptField(dek, r.categoryNameCt, "categories.name_ct") : null) ?? "Uncategorized";
    const cur = byCategory.get(key) ?? { name, total: 0 };
    cur.total += converted;
    byCategory.set(key, cur);
  }

  const total = Array.from(byCategory.values()).reduce((s, c) => s + Math.abs(c.total), 0);
  const topCategories = Array.from(byCategory.values())
    .map((c) => ({ name: c.name, total: Math.round(Math.abs(c.total) * 100) / 100 }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 3);

  return { total: Math.round(total * 100) / 100, topCategories };
}

async function getIncomeForPeriod(userId: string, start: string, end: string, fx: RateCtx): Promise<number> {
  // FINLYNQ-123 — income is a FLOW figure: convert each
  // (currency, reporting_currency) slice via stored reporting_amount.
  const rows = await db
    .select({
      currency: transactions.currency,
      reportingCurrency: transactions.reportingCurrency,
      totalAmount: sql<number>`SUM(${transactions.amount})`,
      totalReporting: sql<number | null>`SUM(${transactions.reportingAmount})`,
    })
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
    .groupBy(transactions.currency, transactions.reportingCurrency)
    .all();
  const total = rows.reduce((s, r) => s + convertReportingSlice(r, fx.displayCurrency, fx.rateMap), 0);
  return Math.round(total * 100) / 100;
}

export async function generateWeeklyRecap(userId: string, endDate?: string, dek?: Buffer | null): Promise<WeeklyRecap> {
  const { weekStart, weekEnd, prevWeekStart, prevWeekEnd } = getWeekBounds(endDate);

  // FINLYNQ-123 — resolve the display currency + current-rate map once. Flow
  // figures (spending / income / net flow / net-worth change) prefer the stored
  // historical reporting_amount; budget "spent" + notable-transaction amounts
  // convert at the current rate (small, display-only figures).
  const displayCurrency = await getDisplayCurrency(userId);
  const rateMap = await getRateMap(displayCurrency, userId);
  const fx: RateCtx = { displayCurrency, rateMap };

  // Spending
  const currentSpending = await getSpendingForPeriod(userId, weekStart, weekEnd, dek ?? null, fx);
  const prevSpending = await getSpendingForPeriod(userId, prevWeekStart, prevWeekEnd, dek ?? null, fx);
  const spendingChange = prevSpending.total > 0
    ? Math.round(((currentSpending.total - prevSpending.total) / prevSpending.total) * 100)
    : 0;

  // Income
  const currentIncome = await getIncomeForPeriod(userId, weekStart, weekEnd, fx);
  const prevIncome = await getIncomeForPeriod(userId, prevWeekStart, prevWeekEnd, fx);

  // Net cash flow
  const netCashFlow = Math.round((currentIncome - currentSpending.total) * 100) / 100;

  // Budget status for current month
  const now = new Date(weekEnd + "T00:00:00");
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [y, m] = month.split("-").map(Number);
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${new Date(y, m, 0).getDate()}`;

  // Stream D Phase 4 — plaintext name dropped.
  // FINLYNQ-123 — budget "spent" is a month-to-date FLOW figure compared against
  // a display-currency budget amount, so aggregate per
  // (category, currency, reporting_currency) and convert each slice before the
  // pctUsed comparison. Never compare a raw mixed-currency sum to the budget.
  const budgetRows = await db
    .select({
      budgetId: budgets.id,
      categoryId: categories.id,
      categoryCt: categories.nameCt,
      budget: budgets.amount,
      currency: transactions.currency,
      reportingCurrency: transactions.reportingCurrency,
      totalAmount: sql<number>`COALESCE(SUM(CASE WHEN ${transactions.date} >= ${monthStart} AND ${transactions.date} <= ${monthEnd} THEN ${transactions.amount} ELSE 0 END), 0)`,
      totalReporting: sql<number | null>`SUM(CASE WHEN ${transactions.date} >= ${monthStart} AND ${transactions.date} <= ${monthEnd} THEN ${transactions.reportingAmount} ELSE 0 END)`,
    })
    .from(budgets)
    .leftJoin(categories, eq(budgets.categoryId, categories.id))
    .leftJoin(transactions, eq(transactions.categoryId, budgets.categoryId))
    .where(and(eq(budgets.month, month), eq(budgets.userId, userId)))
    .groupBy(budgets.id, categories.id, categories.nameCt, budgets.amount, transactions.currency, transactions.reportingCurrency)
    .all();

  const budgetMap = new Map<number, { category: string; budget: number; spent: number }>();
  for (const r of budgetRows) {
    const converted = convertReportingSlice(r, fx.displayCurrency, fx.rateMap);
    const entry = budgetMap.get(r.budgetId) ?? {
      category: (r.categoryCt && dek ? tryDecryptField(dek, r.categoryCt, "categories.name_ct") : null) ?? "Unknown",
      budget: r.budget,
      spent: 0,
    };
    entry.spent += converted;
    budgetMap.set(r.budgetId, entry);
  }

  const budgetStatus = Array.from(budgetMap.values())
    .map((r) => {
      const spent = Math.abs(r.spent);
      return {
        category: r.category,
        budget: r.budget,
        spent: Math.round(spent * 100) / 100,
        pctUsed: r.budget > 0 ? Math.round((spent / r.budget) * 100) : 0,
      };
    })
    .sort((a, b) => b.pctUsed - a.pctUsed);

  // Stream D Phase 4 — plaintext name dropped.
  // FINLYNQ-123 — convert each notable expense to the display currency before
  // sorting/display. Prefer the stored historical reporting_amount; fall back
  // to a current-rate conversion. Over-fetch then sort by converted magnitude
  // so the "largest" expenses are correct across currencies.
  const notable = await db
    .select({
      date: transactions.date,
      payee: transactions.payee,
      categoryNameCt: categories.nameCt,
      amount: transactions.amount,
      currency: transactions.currency,
      reportingCurrency: transactions.reportingCurrency,
      reportingAmount: transactions.reportingAmount,
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
    .limit(50)
    .all();

  const notableTransactions = notable
    .map((t) => {
      const converted =
        t.reportingCurrency && t.reportingCurrency.toUpperCase() === displayCurrency.toUpperCase() && t.reportingAmount != null
          ? t.reportingAmount
          : convertWithRateMap(t.amount, t.currency ?? displayCurrency, rateMap);
      return {
        date: t.date,
        payee: (dek ? (tryDecryptField(dek, t.payee, "transactions.payee") ?? t.payee) : t.payee) ?? "",
        category: (t.categoryNameCt && dek ? tryDecryptField(dek, t.categoryNameCt, "categories.name_ct") : null) ?? "Uncategorized",
        amount: Math.round(Math.abs(converted) * 100) / 100,
      };
    })
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);

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

  // FINLYNQ-123 — subscription cost is a point-in-time figure (what it costs
  // NOW), so convert at the current rate. Subscriptions carry their own currency.
  const upcomingBills = subs.map((s) => ({
    name: ((s.nameCt && dek ? tryDecryptField(dek, s.nameCt, "subscriptions.name_ct") : null) ?? ""),
    amount: Math.abs(convertWithRateMap(s.amount, (s.currency ?? displayCurrency), rateMap)),
    date: s.nextDate ?? "",
  }));

  // Net worth change over the week — a FLOW figure (sum of the week's deltas
  // across all accounts/currencies). FINLYNQ-123 — convert each
  // (currency, reporting_currency) slice to the display currency, never sum raw.
  const nwSlices = await db
    .select({
      currency: transactions.currency,
      reportingCurrency: transactions.reportingCurrency,
      totalAmount: sql<number>`COALESCE(SUM(${transactions.amount}), 0)`,
      totalReporting: sql<number | null>`SUM(${transactions.reportingAmount})`,
    })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), gte(transactions.date, weekStart), lte(transactions.date, weekEnd)))
    .groupBy(transactions.currency, transactions.reportingCurrency)
    .all();

  const netWorthChange =
    Math.round(
      nwSlices.reduce((s, r) => s + convertReportingSlice(r, displayCurrency, rateMap), 0) * 100,
    ) / 100;

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
