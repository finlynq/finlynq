import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { sql, and, gte, lte, eq } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { getDEK } from "@/lib/crypto/dek-cache";
import { decryptName } from "@/lib/crypto/encrypted-columns";
import { getDisplayCurrency, getRateMap, convertWithRateMap } from "@/lib/fx-service";
import { selfHealReportingAmounts } from "@/lib/fx/reporting-amount";
import { todayISO } from "@/lib/utils/date";

type Period = "daily" | "weekly" | "monthly" | "quarterly";
type GroupBy = "category" | "group";

function periodExpr(period: Period) {
  switch (period) {
    case "daily":
      return sql<string>`${schema.transactions.date}`;
    case "weekly":
      // ISO week: YYYY-Www — native Postgres (transactions.date is TEXT 'YYYY-MM-DD', cast to date)
      return sql<string>`to_char(${schema.transactions.date}::date, 'IYYY"-W"IW')`;
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
  const dek = sessionId ? getDEK(sessionId, userId) : null;

  const params = request.nextUrl.searchParams;
  const startDate = params.get("startDate") ?? `${new Date().getFullYear()}-01-01`;
  const endDate = params.get("endDate") ?? todayISO();
  const period = (params.get("period") ?? "monthly") as Period;
  const groupBy = (params.get("groupBy") ?? "category") as GroupBy;
  const isBusiness = params.get("business") === "true";

  // Currency rework Phase 3 — convert to the display currency. Prefer the
  // STORED per-row historical reporting_amount; fall back to on-the-fly
  // current-rate conversion of `amount` for rows not yet (re)computed into the
  // current display currency. A guarded background recompute backfills them.
  const displayCurrency = (await getDisplayCurrency(userId, params.get("currency"))).toUpperCase();
  const rateMap = await getRateMap(displayCurrency, userId);
  void selfHealReportingAmounts(userId, displayCurrency);

  const convertGroup = (row: {
    currency: string | null;
    reportingCurrency: string | null;
    totalAmount: number | null;
    totalReporting: number | null;
  }): number => {
    if (
      row.reportingCurrency &&
      row.reportingCurrency.toUpperCase() === displayCurrency &&
      row.totalReporting != null
    ) {
      return row.totalReporting;
    }
    return convertWithRateMap(row.totalAmount ?? 0, row.currency ?? displayCurrency, rateMap);
  };

  const periodCol = periodExpr(period);

  // Time-series: income vs expenses per period. Grouped by currency +
  // reporting_currency so each (period, type, currency) slice can be resolved
  // independently (stored reporting_amount when it matches the display
  // currency, else a fallback conversion of the raw amount).
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
      currency: schema.transactions.currency,
      reportingCurrency: schema.transactions.reportingCurrency,
      totalAmount: sql<number>`SUM(${schema.transactions.amount})`,
      totalReporting: sql<number | null>`SUM(${schema.transactions.reportingAmount})`,
    })
    .from(schema.transactions)
    .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
    .where(and(...conditions))
    .groupBy(periodCol, schema.categories.type, schema.transactions.currency, schema.transactions.reportingCurrency)
    .orderBy(periodCol)
    .all();

  // Build timeseries
  const periodMap = new Map<string, { income: number; expenses: number }>();
  for (const row of timeseriesRows) {
    const key = row.period;
    if (!periodMap.has(key)) periodMap.set(key, { income: 0, expenses: 0 });
    const entry = periodMap.get(key)!;
    const val = convertGroup(row);
    if (row.categoryType === "I") entry.income += val;
    else if (row.categoryType === "E") entry.expenses += Math.abs(val);
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
  // the plaintext `categories.group` column (unencrypted). Both add
  // currency + reporting_currency to the grouping so each slice converts
  // independently (see convertGroup).
  const isCategoryMode = groupBy !== "group";

  const breakdownRows = isCategoryMode
    ? await db
        .select({
          period: periodCol,
          categoryType: schema.categories.type,
          categoryId: schema.categories.id,
          categoryNameCt: schema.categories.nameCt,
          categoryGroup: schema.categories.group,
          currency: schema.transactions.currency,
          reportingCurrency: schema.transactions.reportingCurrency,
          totalAmount: sql<number>`SUM(${schema.transactions.amount})`,
          totalReporting: sql<number | null>`SUM(${schema.transactions.reportingAmount})`,
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
          schema.transactions.currency,
          schema.transactions.reportingCurrency,
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
          currency: schema.transactions.currency,
          reportingCurrency: schema.transactions.reportingCurrency,
          totalAmount: sql<number>`SUM(${schema.transactions.amount})`,
          totalReporting: sql<number | null>`SUM(${schema.transactions.reportingAmount})`,
          count: sql<number>`COUNT(*)`,
        })
        .from(schema.transactions)
        .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
        .where(and(...conditions))
        .groupBy(periodCol, schema.categories.group, schema.categories.type, schema.transactions.currency, schema.transactions.reportingCurrency)
        .orderBy(periodCol, schema.categories.type, schema.categories.group)
        .all();

  // Build grouped breakdown (totals across all periods). Keyed on the
  // resolved display name + categoryType so income/expense rows with the
  // same label don't collide.
  // FINLYNQ-130 — carry `categoryId` so the reports UI can drill into
  // /transactions filtered by category. Only set in category-mode (group-mode
  // aggregates many categories under one label, so there is no single id);
  // left null there and the client omits the drill link.
  const incomeGroups = new Map<string, { group: string; categoryId: number | null; total: number; count: number; periods: Record<string, number> }>();
  const expenseGroups = new Map<string, { group: string; categoryId: number | null; total: number; count: number; periods: Record<string, number> }>();

  for (const row of breakdownRows) {
    // group-mode rows already have group as the display label (no encryption);
    // category-mode decrypts name_ct.
    const resolvedName = isCategoryMode
      ? decryptName(row.categoryNameCt, dek, null)
      : row.categoryGroup;
    const name = resolvedName && resolvedName !== "" ? resolvedName : "Uncategorized";
    const catGroup = row.categoryGroup ?? "";
    const target = row.categoryType === "I" ? incomeGroups : expenseGroups;
    if (!target.has(name)) target.set(name, { group: catGroup, categoryId: isCategoryMode ? (row.categoryId ?? null) : null, total: 0, count: 0, periods: {} });
    const entry = target.get(name)!;
    const converted = convertGroup(row);
    const amt = row.categoryType === "E" ? Math.abs(converted) : converted;
    entry.total += amt;
    entry.count += Number(row.count);
    entry.periods[row.period] = (entry.periods[row.period] ?? 0) + amt;
  }

  const mapToArray = (m: typeof incomeGroups) =>
    Array.from(m.entries())
      .map(([name, data]) => ({
        name,
        group: data.group,
        categoryId: data.categoryId,
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
    displayCurrency,
    timeseries,
    income: mapToArray(incomeGroups),
    expenses: mapToArray(expenseGroups),
    totalIncome: Math.round(totalIncome * 100) / 100,
    totalExpenses: Math.round(totalExpenses * 100) / 100,
    netSavings: Math.round((totalIncome - totalExpenses) * 100) / 100,
    savingsRate: totalIncome > 0 ? Math.round(((totalIncome - totalExpenses) / totalIncome) * 10000) / 100 : 0,
  });
}
