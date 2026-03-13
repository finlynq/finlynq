import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { sql, eq, and, gte, lte } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const type = params.get("type") ?? "income-statement";
  const startDate = params.get("startDate") ?? `${new Date().getFullYear()}-01-01`;
  const endDate = params.get("endDate") ?? new Date().toISOString().split("T")[0];
  const isBusiness = params.get("business") === "true";

  if (type === "income-statement") {
    const conditions = [
      gte(schema.transactions.date, startDate),
      lte(schema.transactions.date, endDate),
    ];
    if (isBusiness) conditions.push(eq(schema.transactions.isBusiness, 1));

    const rows = db
      .select({
        categoryType: schema.categories.type,
        categoryGroup: schema.categories.group,
        categoryName: schema.categories.name,
        total: sql<number>`SUM(${schema.transactions.amount})`,
        count: sql<number>`COUNT(*)`,
      })
      .from(schema.transactions)
      .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
      .where(and(...conditions))
      .groupBy(schema.categories.id)
      .orderBy(schema.categories.type, schema.categories.group)
      .all();

    const income = rows.filter((r) => r.categoryType === "I");
    const expenses = rows.filter((r) => r.categoryType === "E");
    const totalIncome = income.reduce((s, r) => s + r.total, 0);
    const totalExpenses = expenses.reduce((s, r) => s + Math.abs(r.total), 0);

    return NextResponse.json({
      type: "income-statement",
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
    const balances = db
      .select({
        accountType: schema.accounts.type,
        accountGroup: schema.accounts.group,
        accountName: schema.accounts.name,
        currency: schema.accounts.currency,
        balance: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)`,
      })
      .from(schema.accounts)
      .leftJoin(schema.transactions, eq(schema.accounts.id, schema.transactions.accountId))
      .groupBy(schema.accounts.id)
      .orderBy(schema.accounts.type, schema.accounts.group)
      .all();

    const assets = balances.filter((b) => b.accountType === "A");
    const liabilities = balances.filter((b) => b.accountType === "L");
    const totalAssets = assets.reduce((s, b) => s + b.balance, 0);
    const totalLiabilities = liabilities.reduce((s, b) => s + Math.abs(b.balance), 0);

    return NextResponse.json({
      type: "balance-sheet",
      date: endDate,
      assets: assets.map((b) => ({ ...b, balance: Math.round(b.balance * 100) / 100 })),
      liabilities: liabilities.map((b) => ({ ...b, balance: Math.round(Math.abs(b.balance) * 100) / 100 })),
      totalAssets: Math.round(totalAssets * 100) / 100,
      totalLiabilities: Math.round(totalLiabilities * 100) / 100,
      netWorth: Math.round((totalAssets - totalLiabilities) * 100) / 100,
    });
  }

  if (type === "tax-summary") {
    const rows = db
      .select({
        categoryGroup: schema.categories.group,
        categoryName: schema.categories.name,
        total: sql<number>`SUM(${schema.transactions.amount})`,
      })
      .from(schema.transactions)
      .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
      .where(
        and(
          gte(schema.transactions.date, startDate),
          lte(schema.transactions.date, endDate),
          sql`${schema.categories.type} IN ('I', 'E')`
        )
      )
      .groupBy(schema.categories.id)
      .all();

    return NextResponse.json({
      type: "tax-summary",
      period: { startDate, endDate },
      items: rows.map((r) => ({
        group: r.categoryGroup,
        category: r.categoryName,
        total: Math.round(Math.abs(r.total) * 100) / 100,
        isIncome: r.total > 0,
      })),
    });
  }

  return NextResponse.json({ error: "Invalid report type" }, { status: 400 });
}
