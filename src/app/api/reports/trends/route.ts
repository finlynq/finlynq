import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { sql, and, gte, lte, eq } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { getDEK } from "@/lib/crypto/dek-cache";
import { decryptName } from "@/lib/crypto/encrypted-columns";

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
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, sessionId } = auth.context;
  // DEK is needed to resolve `categories.name_ct` for Phase-3 NULL'd users.
  // Soft-fail (null DEK) keeps legacy plaintext readable; encrypted-only
  // rows surface as "" and roll up under the existing "Uncategorized" bucket.
  const dek = sessionId ? getDEK(sessionId) : null;

  const params = request.nextUrl.searchParams;
  const startDate = params.get("startDate") ?? `${new Date().getFullYear()}-01-01`;
  const endDate = params.get("endDate") ?? new Date().toISOString().split("T")[0];
  const period = (params.get("period") ?? "monthly") as Period;
  const groupBy = (params.get("groupBy") ?? "category") as GroupBy;
  const isBusiness = params.get("business") === "true";

  const periodCol = periodExpr(period);

  // Time-series: income vs expenses per period
  const conditions = [
    eq(schema.transactions.userId, userId),
    gte(schema.transactions.date, startDate),
    lte(schema.transactions.date, endDate),
    sql`${schema.categories.type} IN ('I', 'E')`,
  ];
  if (isBusiness) conditions.push(eq(schema.transactions.isBusiness, 1));

  const timeseriesRows = await db
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

  // Breakdown by category or group per period.
  // For category-mode: group on categories.id (stable through Phase-3 NULL)
  // and decrypt name_ct after the SQL aggregation. Group-mode keeps using
  // the plaintext `categories.group` column (unencrypted).
  const isCategoryMode = groupBy !== "group";

  const breakdownRows = isCategoryMode
    ? await db
        .select({
          period: periodCol,
          categoryType: schema.categories.type,
          categoryId: schema.categories.id,
          categoryNameCt: schema.categories.nameCt,
          categoryGroup: schema.categories.group,
          total: sql<number>`SUM(${schema.transactions.amount})`,
          count: sql<number>`COUNT(*)`,
        })
        .from(schema.transactions)
        .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
        .where(and(...conditions))
        .groupBy(
          periodCol,
          schema.categories.id,
          schema.categories.nameCt,
          schema.categories.type,
          schema.categories.group,
        )
        .orderBy(periodCol, schema.categories.type, schema.categories.group)
        .all()
    : await db
        .select({
          period: periodCol,
          categoryType: schema.categories.type,
          categoryId: sql<number | null>`NULL`,
          categoryNameCt: sql<string | null>`NULL`,
          categoryGroup: schema.categories.group,
          total: sql<number>`SUM(${schema.transactions.amount})`,
          count: sql<number>`COUNT(*)`,
        })
        .from(schema.transactions)
        .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
        .where(and(...conditions))
        .groupBy(periodCol, schema.categories.group, schema.categories.type)
        .orderBy(periodCol, schema.categories.type, schema.categories.group)
        .all();

  // Build grouped breakdown (totals across all periods). Keyed on the
  // resolved display name + categoryType so income/expense rows with the
  // same label don't collide.
  const incomeGroups = new Map<string, { group: string; total: number; count: number; periods: Record<string, number> }>();
  const expenseGroups = new Map<string, { group: string; total: number; count: number; periods: Record<string, number> }>();

  for (const row of breakdownRows) {
    // group-mode rows already have group as the display label (no encryption);
    // category-mode decrypts name_ct.
    const resolvedName = isCategoryMode
      ? decryptName(row.categoryNameCt, dek, null)
      : row.categoryGroup;
    const name = resolvedName && resolvedName !== "" ? resolvedName : "Uncategorized";
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
