import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { sql, and, gte, lte, eq, inArray } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { getDEK } from "@/lib/crypto/dek-cache";
import { decryptName } from "@/lib/crypto/encrypted-columns";
import { getDisplayCurrency, getRateMap, convertWithRateMap } from "@/lib/fx-service";
import { selfHealReportingAmounts } from "@/lib/fx/reporting-amount";
import { parseAccountIdsParam, ACCOUNT_IDS_PARAM } from "@/lib/reports/account-filter";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId, sessionId } = auth.context;
  // Soft-DEK policy mirrors the income-statement endpoint: legacy plaintext
  // stays readable when the cache is cold; Phase-3 NULL'd rows degrade to
  // "Uncategorized" rather than 423-ing the whole report.
  const dek = sessionId ? getDEK(sessionId, userId) : null;
  const params = request.nextUrl.searchParams;
  const currentYear = new Date().getFullYear();
  const year1 = parseInt(params.get("year1") ?? String(currentYear - 1), 10);
  const year2 = parseInt(params.get("year2") ?? String(currentYear), 10);
  // Reports-page account scoping. `null` = every account (see account-filter.ts).
  const accountIds = parseAccountIdsParam(params.get(ACCOUNT_IDS_PARAM));

  // Currency rework Phase 3 — convert to the display currency, preferring the
  // STORED per-row historical reporting_amount with an on-the-fly fallback.
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

  // Category comparison for each year — keyed on categories.id so Phase-3
  // NULL plaintext doesn't collapse every category into a single bucket.
  // Grouped by currency + reporting_currency so each slice converts
  // independently; converted slices are re-aggregated per category.
  async function getCategoryTotals(year: number) {
    const rows = await db
      .select({
        categoryId: schema.categories.id,
        categoryNameCt: schema.categories.nameCt,
        categoryType: schema.categories.type,
        categoryGroup: schema.categories.group,
        currency: schema.transactions.currency,
        reportingCurrency: schema.transactions.reportingCurrency,
        totalAmount: sql<number>`SUM(${schema.transactions.amount})`,
        totalReporting: sql<number | null>`SUM(${schema.transactions.reportingAmount})`,
      })
      .from(schema.transactions)
      .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
      .where(
        and(
          eq(schema.transactions.userId, userId),
          gte(schema.transactions.date, `${year}-01-01`),
          lte(schema.transactions.date, `${year}-12-31`),
          ...(accountIds ? [inArray(schema.transactions.accountId, accountIds)] : []),
        )
      )
      .groupBy(
        schema.categories.id,
        schema.categories.nameCt,
        schema.categories.type,
        schema.categories.group,
        schema.transactions.currency,
        schema.transactions.reportingCurrency,
      )
      .all();
    const byCat = new Map<string | number, {
      categoryId: number | null;
      categoryName: string;
      categoryType: string | null;
      categoryGroup: string | null;
      total: number;
    }>();
    for (const r of rows) {
      const categoryName = decryptName(r.categoryNameCt, dek, null) ?? "";
      const key = r.categoryId ?? `null:${r.categoryType}:${categoryName}`;
      const converted = convertGroup(r);
      const ex = byCat.get(key);
      if (ex) {
        ex.total += converted;
      } else {
        byCat.set(key, {
          categoryId: r.categoryId,
          categoryName,
          categoryType: r.categoryType,
          categoryGroup: r.categoryGroup,
          total: converted,
        });
      }
    }
    return Array.from(byCat.values());
  }

  // Monthly totals for each year (converted to display currency per slice)
  async function getMonthlyTotals(year: number) {
    const rows = await db
      .select({
        month: sql<string>`SUBSTR(${schema.transactions.date}, 6, 2)`,
        categoryType: schema.categories.type,
        currency: schema.transactions.currency,
        reportingCurrency: schema.transactions.reportingCurrency,
        totalAmount: sql<number>`SUM(${schema.transactions.amount})`,
        totalReporting: sql<number | null>`SUM(${schema.transactions.reportingAmount})`,
      })
      .from(schema.transactions)
      .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
      .where(
        and(
          eq(schema.transactions.userId, userId),
          gte(schema.transactions.date, `${year}-01-01`),
          lte(schema.transactions.date, `${year}-12-31`),
          sql`${schema.categories.type} IN ('I', 'E')`,
          ...(accountIds ? [inArray(schema.transactions.accountId, accountIds)] : []),
        )
      )
      .groupBy(
        sql`SUBSTR(${schema.transactions.date}, 6, 2)`,
        schema.categories.type,
        schema.transactions.currency,
        schema.transactions.reportingCurrency,
      )
      .all();
    return rows.map((r) => ({ month: r.month, categoryType: r.categoryType, total: convertGroup(r) }));
  }

  const cat1 = await getCategoryTotals(year1);
  const cat2 = await getCategoryTotals(year2);
  const monthly1 = await getMonthlyTotals(year1);
  const monthly2 = await getMonthlyTotals(year2);

  // Build category comparison
  const allCategories = new Set([
    ...cat1.filter((c) => c.categoryType === "E").map((c) => c.categoryName ?? "Uncategorized"),
    ...cat2.filter((c) => c.categoryType === "E").map((c) => c.categoryName ?? "Uncategorized"),
  ]);

  const cat1Map = new Map(cat1.map((c) => [c.categoryName, c.total]));
  const cat2Map = new Map(cat2.map((c) => [c.categoryName, c.total]));

  const categories = Array.from(allCategories).map((name) => {
    const y1 = Math.abs(cat1Map.get(name) ?? 0);
    const y2 = Math.abs(cat2Map.get(name) ?? 0);
    const change = y1 > 0 ? Math.round(((y2 - y1) / y1) * 10000) / 100 : y2 > 0 ? 100 : 0;
    return {
      name,
      year1Amount: Math.round(y1 * 100) / 100,
      year2Amount: Math.round(y2 * 100) / 100,
      change,
    };
  }).sort((a, b) => b.year2Amount - a.year2Amount);

  // Build monthly comparison
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function buildMonthMap(rows: { month: string; categoryType: string | null; total: number }[]) {
    const map: Record<string, { income: number; expenses: number }> = {};
    for (const row of rows) {
      const m = row.month;
      if (!map[m]) map[m] = { income: 0, expenses: 0 };
      if (row.categoryType === "I") map[m].income += row.total;
      else if (row.categoryType === "E") map[m].expenses += Math.abs(row.total);
    }
    return map;
  }

  const m1 = buildMonthMap(monthly1);
  const m2 = buildMonthMap(monthly2);

  const monthly = monthNames.map((name, i) => {
    const key = String(i + 1).padStart(2, "0");
    return {
      month: name,
      year1Income: Math.round((m1[key]?.income ?? 0) * 100) / 100,
      year1Expenses: Math.round((m1[key]?.expenses ?? 0) * 100) / 100,
      year2Income: Math.round((m2[key]?.income ?? 0) * 100) / 100,
      year2Expenses: Math.round((m2[key]?.expenses ?? 0) * 100) / 100,
    };
  });

  return NextResponse.json({ year1, year2, displayCurrency, categories, monthly });
}
