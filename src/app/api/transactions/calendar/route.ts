import { db, schema } from "@/db";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { apiHandler } from "@/lib/api-handler";
import { AppError } from "@/lib/validate";
import { getDisplayCurrency, getRateMap } from "@/lib/fx-service";
import { convertReportingSlice, selfHealReportingAmounts } from "@/lib/fx/reporting-amount";
import {
  CALENDAR_DATE_RE,
  CALENDAR_MONTH_RE,
  MAX_CALENDAR_RANGE_DAYS,
  buildCalendarMonth,
  daysInRange,
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
 * GET /api/transactions/calendar?start=YYYY-MM-DD&end=YYYY-MM-DD[&…same filters]
 *
 * Per-day income / spending / transaction count for one month, or for any
 * range up to a year (the week and year views) — the data behind the
 * Transactions page's Calendar view. Honours the same account and
 * category filters as the list. Money follows the Reports flow rules
 * (FINLYNQ-123) via `convertReportingSlice`; the bucketing is the pure
 * `buildCalendarMonth` in lib/transactions/calendar.ts. DEK-free: no names.
 */
export const GET = apiHandler({ auth: "auth" }, async ({ request, userId }) => {
  const params = request.nextUrl.searchParams;
  // Either one month (`month=YYYY-MM`, what the month grid and the mobile app
  // send) or an explicit range (`start`/`end`, the week and year views).
  const month = params.get("month");
  let start: string;
  let end: string;
  if (month != null) {
    if (!CALENDAR_MONTH_RE.test(month)) throw new AppError("month must be YYYY-MM", 400);
    ({ start, end } = monthBounds(month));
  } else {
    start = params.get("start") ?? "";
    end = params.get("end") ?? "";
    if (!CALENDAR_DATE_RE.test(start) || !CALENDAR_DATE_RE.test(end)) {
      throw new AppError("pass month=YYYY-MM, or start and end as YYYY-MM-DD", 400);
    }
    const span = daysInRange(start, end);
    if (span < 1 || span > MAX_CALENDAR_RANGE_DAYS) {
      throw new AppError(`start must be on or before end, at most ${MAX_CALENDAR_RANGE_DAYS} days apart`, 400);
    }
  }
  const accountId = optionalId(params.get("accountId"), "accountId");
  const categoryId = optionalId(params.get("categoryId"), "categoryId");

  const displayCurrency = (await getDisplayCurrency(userId, params.get("currency"))).toUpperCase();
  const rateMap = await getRateMap(displayCurrency, userId);
  void selfHealReportingAmounts(userId, displayCurrency);

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

  return { ...(month != null ? { month } : {}), start, end, displayCurrency, ...buildCalendarMonth(slices) };
});
