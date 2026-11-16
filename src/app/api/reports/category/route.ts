import { db, schema } from "@/db";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { apiHandler } from "@/lib/api-handler";
import { AppError } from "@/lib/validate";
import { decryptName, decryptTxRows } from "@/lib/crypto/encrypted-columns";
import { getDisplayCurrency, getRateMap, convertWithRateMap } from "@/lib/fx-service";
import { convertReportingSlice, selfHealReportingAmounts } from "@/lib/fx/reporting-amount";
import { todayISO } from "@/lib/utils/date";
import {
  allTimeMonths,
  allTimeYears,
  buildCategoryDetail,
  buildCategoryYearly,
  categoryWindow,
  categoryYearWindow,
  CATEGORY_WINDOWS,
  CATEGORY_YEAR_WINDOWS,
  type CategoryTxRow,
  type CategoryType,
} from "@/lib/reports/category-detail";

/**
 * GET /api/reports/category?categoryId=&months=6|12|24|all[&currency=]
 * GET /api/reports/category?categoryId=&period=year&years=3|5|10|all[&currency=]
 *
 * One category's detail for the `/categories/[id]` page: a monthly series
 * (default) or a calendar-year series (`period=year`, 2026-11-13) with budget,
 * average / median / comparisons, share of all spending (or income), top
 * payees and recent transactions. `all` reaches back to the category's first
 * transaction. The monthly response shape is unchanged (the phone app reads
 * it); both add `period` + `range`. Math lives in the pure
 * lib/reports/category-detail.ts.
 *
 * Money follows the Reports rules (FINLYNQ-123): each row uses its STORED
 * historical `reporting_amount` when it's in the display currency, else a
 * current-rate conversion of `amount`. Budgets convert at the current rate.
 * The DEK comes from the auth context (GH #343) — it decrypts the category
 * name, payees and account names; without one, payees can't be grouped and
 * `payeesLocked` is set.
 */
export const GET = apiHandler({ auth: "auth" }, async ({ request, userId, dek }) => {
  const params = request.nextUrl.searchParams;
  const categoryId = Number(params.get("categoryId"));
  if (!Number.isInteger(categoryId) || categoryId <= 0) throw new AppError("categoryId is required", 400);
  const period = params.get("period") === "year" ? "year" : "month";

  const cat = await db
    .select({
      id: schema.categories.id,
      type: schema.categories.type,
      group: schema.categories.group,
      nameCt: schema.categories.nameCt,
    })
    .from(schema.categories)
    .where(and(eq(schema.categories.id, categoryId), eq(schema.categories.userId, userId)))
    .get();
  if (!cat) throw new AppError("Category not found", 404);
  const type = (["E", "I", "R"].includes(cat.type) ? cat.type : "E") as CategoryType;

  const displayCurrency = (await getDisplayCurrency(userId, params.get("currency"))).toUpperCase();
  const rateMap = await getRateMap(displayCurrency, userId);
  void selfHealReportingAmounts(userId, displayCurrency);

  const today = todayISO();

  // Range: a fixed count, or "all" = back to the category's first transaction.
  const rangeParam = params.get(period === "year" ? "years" : "months") ?? (period === "year" ? "all" : "12");
  const allowed: readonly number[] = period === "year" ? CATEGORY_YEAR_WINDOWS : CATEGORY_WINDOWS;
  let range: number | "all";
  let count: number;
  if (rangeParam === "all") {
    const first = await db
      .select({ minDate: sql<string | null>`MIN(${schema.transactionCategoryFlows.date})` })
      .from(schema.transactionCategoryFlows)
      .where(and(
        eq(schema.transactionCategoryFlows.userId, userId),
        eq(schema.transactionCategoryFlows.categoryId, categoryId),
        lte(schema.transactionCategoryFlows.date, today),
      ))
      .get();
    const firstDate = first?.minDate ?? null;
    range = "all";
    count = period === "year" ? allTimeYears(today, firstDate) : allTimeMonths(today, firstDate);
  } else {
    const n = Number(rangeParam);
    range = allowed.includes(n) ? n : period === "year" ? CATEGORY_YEAR_WINDOWS[1] : 12;
    count = range;
  }
  const months = count;
  const { windowStart, windowStartMonth, queryStart } =
    period === "year" ? categoryYearWindow(today, count) : categoryWindow(today, count);

  const rawRows = await db
    .select({
      id: schema.transactionCategoryFlows.id,
      date: schema.transactionCategoryFlows.date,
      payee: schema.transactionCategoryFlows.payee,
      amount: schema.transactionCategoryFlows.amount,
      currency: schema.transactionCategoryFlows.currency,
      reportingAmount: schema.transactionCategoryFlows.reportingAmount,
      reportingCurrency: schema.transactionCategoryFlows.reportingCurrency,
      accountNameCt: schema.accounts.nameCt,
    })
    .from(schema.transactionCategoryFlows)
    .leftJoin(schema.accounts, eq(schema.transactionCategoryFlows.accountId, schema.accounts.id))
    .where(and(
      eq(schema.transactionCategoryFlows.userId, userId),
      eq(schema.transactionCategoryFlows.categoryId, categoryId),
      gte(schema.transactionCategoryFlows.date, queryStart),
      lte(schema.transactionCategoryFlows.date, today),
    ))
    .all();

  const decrypted = decryptTxRows(dek, rawRows);
  const rows: CategoryTxRow[] = decrypted.map((r) => ({
    id: r.id,
    date: r.date,
    // Without a DEK the payee is still ciphertext — never show or group it.
    payee: dek ? (r.payee ?? null) : null,
    amount: r.amount,
    currency: r.currency,
    reportingAmount: r.reportingAmount,
    reportingCurrency: r.reportingCurrency,
    accountName: decryptName(r.accountNameCt, dek, null),
  }));

  const toDisplay = (r: CategoryTxRow) =>
    convertReportingSlice(
      { currency: r.currency, reportingCurrency: r.reportingCurrency, totalAmount: r.amount, totalReporting: r.reportingAmount },
      displayCurrency,
      rateMap,
    );

  const budgetRows = await db
    .select({ month: schema.budgets.month, amount: schema.budgets.amount, currency: schema.budgets.currency })
    .from(schema.budgets)
    .where(and(
      eq(schema.budgets.userId, userId),
      eq(schema.budgets.categoryId, categoryId),
      gte(schema.budgets.month, windowStartMonth),
    ))
    .all();
  const budgets = new Map<string, number>();
  for (const b of budgetRows) {
    budgets.set(b.month, convertWithRateMap(b.amount, b.currency ?? displayCurrency, rateMap));
  }

  // Denominator for "share of spending/income": every category of the same
  // type over the window, sliced by currency so each slice converts correctly.
  const typeSlices = await db
    .select({
      currency: schema.transactionCategoryFlows.currency,
      reportingCurrency: schema.transactionCategoryFlows.reportingCurrency,
      totalAmount: sql<number>`SUM(${schema.transactionCategoryFlows.amount})`,
      totalReporting: sql<number | null>`SUM(${schema.transactionCategoryFlows.reportingAmount})`,
    })
    .from(schema.transactionCategoryFlows)
    .innerJoin(schema.categories, eq(schema.transactionCategoryFlows.categoryId, schema.categories.id))
    .where(and(
      eq(schema.transactionCategoryFlows.userId, userId),
      eq(schema.categories.type, cat.type),
      gte(schema.transactionCategoryFlows.date, windowStart),
      lte(schema.transactionCategoryFlows.date, today),
    ))
    .groupBy(schema.transactionCategoryFlows.currency, schema.transactionCategoryFlows.reportingCurrency)
    .all();
  const sign = type === "I" ? 1 : -1;
  const typeTotal = sign * typeSlices.reduce((s, row) => s + convertReportingSlice(row, displayCurrency, rateMap), 0);

  const category = {
    id: cat.id,
    name: decryptName(cat.nameCt, dek, null),
    type,
    group: cat.group ?? "",
  };

  if (period === "year") {
    const yearly = buildCategoryYearly({ type, rows, budgets, today, years: count, toDisplay, typeTotal });
    return {
      period: "year" as const,
      range,
      category,
      windowYears: count,
      displayCurrency,
      payeesLocked: !dek,
      ...yearly,
    };
  }

  const detail = buildCategoryDetail({ type, rows, budgets, today, months, toDisplay, typeTotal });

  return {
    period: "month" as const,
    range,
    category,
    windowMonths: months,
    displayCurrency,
    payeesLocked: !dek,
    ...detail,
  };
});
