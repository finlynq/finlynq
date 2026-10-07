import { db, schema } from "@/db";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { apiHandler } from "@/lib/api-handler";
import { AppError } from "@/lib/validate";
import { getDisplayCurrency, getRateMap } from "@/lib/fx-service";
import { convertReportingSlice, selfHealReportingAmounts } from "@/lib/fx/reporting-amount";
import {
  CALENDAR_MONTH_RE,
  buildCalendarMonth,
  monthBounds,
  type CalendarSlice,
} from "@/lib/transactions/calendar";

function optionalId(raw: string | null, name: string): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(`${name} must be a positive integer`, 400);
  return n;
}

/**
 * GET /api/transactions/calendar?month=YYYY-MM[&accountId=][&categoryId=][&currency=]
 *
 * Per-day income / spending / transaction count for one month — the data
 * behind the Transactions page's Calendar view. Honours the same account and
 * category filters as the list. Money follows the Reports flow rules
 * (FINLYNQ-123) via `convertReportingSlice`; the bucketing is the pure
 * `buildCalendarMonth` in lib/transactions/calendar.ts. DEK-free: no names.
 */
export const GET = apiHandler({ auth: "auth" }, async ({ request, userId }) => {
  const params = request.nextUrl.searchParams;
  const month = params.get("month") ?? "";
  if (!CALENDAR_MONTH_RE.test(month)) throw new AppError("month must be YYYY-MM", 400);
  const accountId = optionalId(params.get("accountId"), "accountId");
  const categoryId = optionalId(params.get("categoryId"), "categoryId");

  const displayCurrency = (await getDisplayCurrency(userId, params.get("currency"))).toUpperCase();
  const rateMap = await getRateMap(displayCurrency, userId);
  void selfHealReportingAmounts(userId, displayCurrency);

  const { start, end } = monthBounds(month);
  const t = schema.transactions;
  const conditions = [eq(t.userId, userId), gte(t.date, start), lte(t.date, end)];
  if (accountId) conditions.push(eq(t.accountId, accountId));
  if (categoryId) conditions.push(eq(t.categoryId, categoryId));

  const rows = await db
    .select({
      date: t.date,
      categoryType: schema.categories.type,
      currency: t.currency,
      reportingCurrency: t.reportingCurrency,
      totalAmount: sql<number>`SUM(${t.amount})`,
      totalReporting: sql<number | null>`SUM(${t.reportingAmount})`,
      count: sql<number>`COUNT(*)`,
    })
    .from(t)
    .leftJoin(schema.categories, eq(t.categoryId, schema.categories.id))
    .where(and(...conditions))
    .groupBy(t.date, schema.categories.type, t.currency, t.reportingCurrency)
    .all();

  const slices: CalendarSlice[] = rows.map((r) => ({
    date: r.date,
    categoryType: r.categoryType ?? null,
    value: convertReportingSlice(r, displayCurrency, rateMap),
    count: Number(r.count),
  }));

  return { month, displayCurrency, ...buildCalendarMonth(slices) };
});
