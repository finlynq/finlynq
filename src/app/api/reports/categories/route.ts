import { db, schema } from "@/db";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { apiHandler } from "@/lib/api-handler";
import { AppError } from "@/lib/validate";
import { decryptName } from "@/lib/crypto/encrypted-columns";
import { getDisplayCurrency, getRateMap, convertWithRateMap } from "@/lib/fx-service";
import { convertReportingSlice, selfHealReportingAmounts } from "@/lib/fx/reporting-amount";
import { todayISO } from "@/lib/utils/date";
import { CATEGORY_WINDOWS, monthKey, shiftMonth } from "@/lib/reports/category-detail";
import { buildCategoryOverview, type OverviewSlice } from "@/lib/reports/category-overview";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * GET /api/reports/categories?month=YYYY-MM&type=E|I&months=6|12|24[&currency=]
 *
 * Every category of one type for one month (default: this month, expenses,
 * 12-month window): amount, share of the month, usual month (average), budget
 * and a trend. Feeds the web `/categories` page and the mobile Category
 * reports screen. Money follows the Reports rules (FINLYNQ-123) via
 * `convertReportingSlice`; math in the pure lib/reports/category-overview.ts.
 */
export const GET = apiHandler({ auth: "auth" }, async ({ request, userId, dek }) => {
  const params = request.nextUrl.searchParams;
  const today = todayISO();
  const currentMonth = monthKey(today);

  const monthParam = params.get("month") ?? currentMonth;
  if (!MONTH_RE.test(monthParam)) throw new AppError("month must be YYYY-MM", 400);
  const month = monthParam > currentMonth ? currentMonth : monthParam;
  const typeParam = (params.get("type") ?? "E").toUpperCase();
  if (typeParam !== "E" && typeParam !== "I") throw new AppError("type must be E or I", 400);
  const type = typeParam as "E" | "I";
  const requested = Number(params.get("months") ?? 12);
  const months = (CATEGORY_WINDOWS as readonly number[]).includes(requested) ? requested : 12;

  const displayCurrency = (await getDisplayCurrency(userId, params.get("currency"))).toUpperCase();
  const rateMap = await getRateMap(displayCurrency, userId);
  void selfHealReportingAmounts(userId, displayCurrency);

  const windowStart = `${shiftMonth(month, -(months - 1))}-01`;
  const windowEnd = month === currentMonth ? today : `${month}-31`;

  const cats = await db
    .select({ id: schema.categories.id, nameCt: schema.categories.nameCt, group: schema.categories.group })
    .from(schema.categories)
    .where(and(eq(schema.categories.userId, userId), eq(schema.categories.type, type)))
    .all();

  const monthExpr = sql<string>`SUBSTR(${schema.transactionCategoryFlows.date}, 1, 7)`;
  const rows = await db
    .select({
      categoryId: schema.transactionCategoryFlows.categoryId,
      month: monthExpr,
      currency: schema.transactionCategoryFlows.currency,
      reportingCurrency: schema.transactionCategoryFlows.reportingCurrency,
      totalAmount: sql<number>`SUM(${schema.transactionCategoryFlows.amount})`,
      totalReporting: sql<number | null>`SUM(${schema.transactionCategoryFlows.reportingAmount})`,
    })
    .from(schema.transactionCategoryFlows)
    .innerJoin(schema.categories, eq(schema.transactionCategoryFlows.categoryId, schema.categories.id))
    .where(and(
      eq(schema.transactionCategoryFlows.userId, userId),
      eq(schema.categories.type, type),
      gte(schema.transactionCategoryFlows.date, windowStart),
      lte(schema.transactionCategoryFlows.date, windowEnd),
    ))
    .groupBy(schema.transactionCategoryFlows.categoryId, monthExpr, schema.transactionCategoryFlows.currency, schema.transactionCategoryFlows.reportingCurrency)
    .all();

  const slices: OverviewSlice[] = rows
    .filter((r) => r.categoryId != null)
    .map((r) => ({
      categoryId: r.categoryId as number,
      month: r.month,
      value: convertReportingSlice(r, displayCurrency, rateMap),
    }));

  const budgetRows = await db
    .select({ categoryId: schema.budgets.categoryId, amount: schema.budgets.amount, currency: schema.budgets.currency })
    .from(schema.budgets)
    .where(and(eq(schema.budgets.userId, userId), eq(schema.budgets.month, month)))
    .all();
  const typeIds = new Set(cats.map((c) => c.id));
  const budgets = new Map<number, number>();
  for (const b of budgetRows) {
    if (!typeIds.has(b.categoryId)) continue;
    budgets.set(b.categoryId, convertWithRateMap(b.amount, b.currency ?? displayCurrency, rateMap));
  }

  const overview = buildCategoryOverview({
    type,
    month,
    currentMonth,
    months,
    categories: cats.map((c) => ({ id: c.id, name: decryptName(c.nameCt, dek, null), group: c.group ?? "" })),
    slices,
    budgets,
  });

  return { type, windowMonthsCount: months, displayCurrency, ...overview };
});
