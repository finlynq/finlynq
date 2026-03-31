import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { sql, eq, and, gte, lte } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { getRateMap, convertWithRateMap } from "@/lib/fx-service";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  const params = request.nextUrl.searchParams;
  const type = params.get("type") ?? "income-statement";
  const startDate = params.get("startDate") ?? `${new Date().getFullYear()}-01-01`;
  const endDate = params.get("endDate") ?? new Date().toISOString().split("T")[0];
  const isBusiness = params.get("business") === "true";
  const displayCurrency = params.get("currency") ?? "CAD";

  const rateMap = await getRateMap(displayCurrency);

  if (type === "income-statement") {
    const conditions = [
      eq(schema.transactions.userId, userId),
      gte(schema.transactions.date, startDate),
      lte(schema.transactions.date, endDate),
    ];
    if (isBusiness) conditions.push(eq(schema.transactions.isBusiness, 1));

    const rows = await db
      .select({
        categoryType: schema.categories.type,
        categoryGroup: schema.categories.group,
        categoryName: schema.categories.name,
        currency: schema.transactions.currency,
        total: sql<number>`SUM(${schema.transactions.amount})`,
        count: sql<number>`COUNT(*)`,
      })
      .from(schema.transactions)
      .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
      .where(and(...conditions))
      .groupBy(schema.categories.id, schema.categories.type, schema.categories.group, schema.categories.name, schema.transactions.currency)
      .orderBy(schema.categories.type, schema.categories.group)
      .all();

    // Aggregate across currencies per category
    const categoryTotals = new Map<string, { categoryType: string; categoryGroup: string; categoryName: string; total: number; count: number }>();
    for (const row of rows) {
      const catType = row.categoryType ?? "";
      const catGroup = row.categoryGroup ?? "";
      const catName = row.categoryName ?? "";
      const key = `${catType}:${catGroup}:${catName}`;
      const converted = convertWithRateMap(row.total, row.currency, rateMap);
      const existing = categoryTotals.get(key);
      if (existing) {
        existing.total += converted;
        existing.count += row.count;
      } else {
        categoryTotals.set(key, {
          categoryType: catType,
          categoryGroup: catGroup,
          categoryName: catName,
          total: converted,
          count: row.count,
        });
      }
    }

    const aggregated = Array.from(categoryTotals.values());
    const income = aggregated.filter((r) => r.categoryType === "I");
    const expenses = aggregated.filter((r) => r.categoryType === "E");
    const totalIncome = income.reduce((s, r) => s + r.total, 0);
    const totalExpenses = expenses.reduce((s, r) => s + Math.abs(r.total), 0);

    return NextResponse.json({
      type: "income-statement",
      displayCurrency,
      period: { startDate, endDate },
      income: income.map((r) => ({ ...r, total: Math.round(r.total * 100) / 100 })),
      expenses: expenses.map((r) => ({ ...r, total: Math.round(Math.abs(r.total) * 100) / 100 })),
      totalIncome: Math.round(totalIncome * 100) / 100,
      totalExpenses: Math.round(totalExpenses * 100) / 100,
      netSavings: Math.round((totalIncome - totalExpenses) * 100) / 100,
      savingsRate: totalIncome > 0 ? Math.round(((totalIncome - totalExpenses) / totalIncome) * 10000) / 100 : 0,
    });
  }

  if (type === "balance-sheet") {
    const balances = await db
      .select({
        accountType: schema.accounts.type,
        accountGroup: schema.accounts.group,
        accountName: schema.accounts.name,
        currency: schema.accounts.currency,
        balance: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)`,
      })
      .from(schema.accounts)
      .leftJoin(schema.transactions, eq(schema.accounts.id, schema.transactions.accountId))
      .where(eq(schema.accounts.userId, userId))
      .groupBy(schema.accounts.id, schema.accounts.type, schema.accounts.group, schema.accounts.name, schema.accounts.currency)
      .orderBy(schema.accounts.type, schema.accounts.group)
      .all();

    const converted = balances.map((b) => ({
      ...b,
      convertedBalance: convertWithRateMap(b.balance, b.currency, rateMap),
      displayCurrency,
    }));

    const assets = converted.filter((b) => b.accountType === "A");
    const liabilities = converted.filter((b) => b.accountType === "L");
    const totalAssets = assets.reduce((s, b) => s + b.convertedBalance, 0);
    const totalLiabilities = liabilities.reduce((s, b) => s + Math.abs(b.convertedBalance), 0);

    return NextResponse.json({
      type: "balance-sheet",
      displayCurrency,
      date: endDate,
      assets: assets.map((b) => ({
        ...b,
        balance: Math.round(b.balance * 100) / 100,
        convertedBalance: Math.round(b.convertedBalance * 100) / 100,
      })),
      liabilities: liabilities.map((b) => ({
        ...b,
        balance: Math.round(Math.abs(b.balance) * 100) / 100,
        convertedBalance: Math.round(Math.abs(b.convertedBalance) * 100) / 100,
      })),
      totalAssets: Math.round(totalAssets * 100) / 100,
      totalLiabilities: Math.round(totalLiabilities * 100) / 100,
      netWorth: Math.round((totalAssets - totalLiabilities) * 100) / 100,
    });
  }

  if (type === "tax-summary") {
    const rows = await db
      .select({
        categoryGroup: schema.categories.group,
        categoryName: schema.categories.name,
        currency: schema.transactions.currency,
        total: sql<number>`SUM(${schema.transactions.amount})`,
      })
      .from(schema.transactions)
      .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
      .where(
        and(
          eq(schema.transactions.userId, userId),
          gte(schema.transactions.date, startDate),
          lte(schema.transactions.date, endDate),
          sql`${schema.categories.type} IN ('I', 'E')`
        )
      )
      .groupBy(schema.categories.id, schema.categories.group, schema.categories.name, schema.transactions.currency)
      .all();

    // Aggregate across currencies per category
    const categoryTotals = new Map<string, { group: string; category: string; total: number; isIncome: boolean }>();
    for (const r of rows) {
      const group = r.categoryGroup ?? "";
      const category = r.categoryName ?? "";
      const key = `${group}:${category}`;
      const converted = convertWithRateMap(r.total, r.currency, rateMap);
      const existing = categoryTotals.get(key);
      if (existing) {
        existing.total += converted;
      } else {
        categoryTotals.set(key, {
          group,
          category,
          total: converted,
          isIncome: r.total > 0,
        });
      }
    }

    return NextResponse.json({
      type: "tax-summary",
      displayCurrency,
      period: { startDate, endDate },
      items: Array.from(categoryTotals.values()).map((r) => ({
        ...r,
        total: Math.round(Math.abs(r.total) * 100) / 100,
      })),
    });
  }

  return NextResponse.json({ error: "Invalid report type" }, { status: 400 });
}
