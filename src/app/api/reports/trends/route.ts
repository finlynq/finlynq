import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { sql, and, gte, lte, eq } from "drizzle-orm";
import { requireUnlock } from "@/lib/require-unlock";

type Period = "daily" | "weekly" | "monthly" | "quarterly";
type GroupBy = "category" | "group";

function periodExpr(period: Period) {
  switch (period) {
    case "daily":
      return sql<string>`${schema.transactions.date}`;
    case "weekly":
      // ISO week: YYYY-Www
      return sql<string>`SUBSTR(${schema.transactions.date}, 1, 4) || '-W' || SUBSTR('0' || ((CAST(STRFTIME('%j', ${schema.transactions.date}) AS INTEGER) - 1) / 7 + 1), -2)`;
    case "monthly":
      return sql<string>`SUBSTR(${schema.transactions.date}, 1, 7)`;
    case "quarterly":
      return sql<string>`SUBSTR(${schema.transactions.date}, 1, 4) || '-Q' || ((CAST(SUBSTR(${schema.transactions.date}, 6, 2) AS INTEGER) - 1) / 3 + 1)`;
  }
}

function formatPeriodLabel(key: string, period: Period): string {
  if (period === "daily") {
    const d = new Date(key + "T00:00:00");
    return d.toLocaleDateString("en-CA", { month: "short", day: "numeric" });
  }
  if (period === "weekly") return key;
  if (period === "monthly") {
    const [y, m] = key.split("-");
    const d = new Date(parseInt(y), parseInt(m) - 1);
    return d.toLocaleDateString("en-CA", { year: "numeric", month: "short" });
  }
  // quarterly
  return key;
}

export async function GET(request: NextRequest) {
  const locked = requireUnlock();
  if (locked) return locked;

  const params = request.nextUrl.searchParams;
  const startDate = params.get("startDate") ?? `${new Date().getFullYear()}-01-01`;
  const endDate = params.get("endDate") ?? new Date().toISOString().split("T")[0];
  const period = (params.get("period") ?? "monthly") as Period;
  const groupBy = (params.get("groupBy") ?? "category") as GroupBy;
  const isBusiness = params.get("business") === "true";

  const periodCol = periodExpr(period);

  // Time-series: income vs expenses per period
  const conditions = [
    gte(schema.transactions.date, startDate),
    lte(schema.transactions.date, endDate),
    sql`${schema.categories.type} IN ('I', 'E')`,
  ];
  if (isBusiness) conditions.push(eq(schema.transactions.isBusiness, 1));

  const timeseriesRows = db
    .select({
      period: periodCol,
      categoryType: schema.categories.type,
      total: sql<number>`SUM(${schema.transactions.amount})`,
    })
    .from(schema.transactions)
    .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
    .where(and(...conditions))
    .groupBy(periodCol, schema.categories.type)
    .orderBy(periodCol)
    .all();

  // Build timeseries
  const periodMap = new Map<string, { income: number; expenses: number }>();
  for (const row of timeseriesRows) {
    const key = row.period;
    if (!periodMap.has(key)) periodMap.set(key, { income: 0, expenses: 0 });
    const entry = periodMap.get(key)!;
    if (row.categoryType === "I") entry.income += row.total;
    else if (row.categoryType === "E") entry.expenses += Math.abs(row.total);
  }

  const timeseries = Array.from(periodMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => ({
      period: key,
      label: formatPeriodLabel(key, period),
      income: Math.round(val.income * 100) / 100,
      expenses: Math.round(val.expenses * 100) / 100,
      net: Math.round((val.income - val.expenses) * 100) / 100,
    }));

  // Breakdown by category or group per period
  const groupCol = groupBy === "group" ? schema.categories.group : schema.categories.name;

  const breakdownRows = db
    .select({
      period: periodCol,
      categoryType: schema.categories.type,
      groupName: groupCol,
      categoryGroup: schema.categories.group,
      total: sql<number>`SUM(${schema.transactions.amount})`,
      count: sql<number>`COUNT(*)`,
    })
    .from(schema.transactions)
    .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
    .where(and(...conditions))
    .groupBy(periodCol, groupCol, schema.categories.type)
    .orderBy(periodCol, schema.categories.type, groupCol)
    .all();

  // Build grouped breakdown (totals across all periods)
  const incomeGroups = new Map<string, { group: string; total: number; count: number; periods: Record<string, number> }>();
  const expenseGroups = new Map<string, { group: string; total: number; count: number; periods: Record<string, number> }>();

  for (const row of breakdownRows) {
    const name = row.groupName ?? "Uncategorized";
    const catGroup = row.categoryGroup ?? "";
    const target = row.categoryType === "I" ? incomeGroups : expenseGroups;
    if (!target.has(name)) target.set(name, { group: catGroup, total: 0, count: 0, periods: {} });
    const entry = target.get(name)!;
    const amt = row.categoryType === "E" ? Math.abs(row.total) : row.total;
    entry.total += amt;
    entry.count += row.count;
    entry.periods[row.period] = (entry.periods[row.period] ?? 0) + amt;
  }

  const mapToArray = (m: typeof incomeGroups) =>
    Array.from(m.entries())
      .map(([name, data]) => ({
        name,
        group: data.group,
        total: Math.round(data.total * 100) / 100,
        count: data.count,
        periods: Object.fromEntries(
          Object.entries(data.periods).map(([k, v]) => [k, Math.round(v * 100) / 100])
        ),
      }))
      .sort((a, b) => b.total - a.total);

  const totalIncome = timeseries.reduce((s, p) => s + p.income, 0);
  const totalExpenses = timeseries.reduce((s, p) => s + p.expenses, 0);

  return NextResponse.json({
    period,
    groupBy,
    startDate,
    endDate,
    timeseries,
    income: mapToArray(incomeGroups),
    expenses: mapToArray(expenseGroups),
    totalIncome: Math.round(totalIncome * 100) / 100,
    totalExpenses: Math.round(totalExpenses * 100) / 100,
    netSavings: Math.round((totalIncome - totalExpenses) * 100) / 100,
    savingsRate: totalIncome > 0 ? Math.round(((totalIncome - totalExpenses) / totalIncome) * 10000) / 100 : 0,
  });
}
