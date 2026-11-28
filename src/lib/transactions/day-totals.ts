/**
 * SERVER ONLY. Whole-day totals for the Transactions "By day" view (GH #465).
 *
 * `GET /api/transactions?dayTotals=1` calls this with the SAME parsed filters
 * the page of rows came from, and the dates on that page. For each of those
 * days it totals EVERY transaction the filters allow, not just the rows on
 * the page, so a day whose rows run onto the next page still shows its full
 * total (and the same total on both pages).
 *
 *   1. ids + dates of every matching transaction on those days
 *      (`getTransactionIdsOnDates`, the list's own SQL filter builder). When
 *      the request has encrypted-text filters (search, tag, filter_*), the
 *      caller passes the full matched-id list too and only those count.
 *   2. their category rows from `transaction_category_flows` (a split
 *      transaction counts under each part's own category, as in Reports),
 *      grouped by day × category type × currency and converted to the display
 *      currency with `convertReportingSlice` (FINLYNQ-123: stored historical
 *      reporting amount, else today's rate; never a mixed-currency SUM).
 *   3. the pure `buildDayTotals` folds them with the Calendar's money rules.
 */
import { db, schema } from "@/db";
import { and, eq, sql } from "drizzle-orm";
import { getTransactionIdsOnDates, type TxSortFilter } from "@/lib/queries";
import { getDisplayCurrency, getRateMap } from "@/lib/fx-service";
import { convertReportingSlice } from "@/lib/fx/reporting-amount";
import { flowIdIn } from "@/lib/reports/tag-filter";
import type { CalendarSlice } from "@/lib/transactions/calendar";
import { buildDayTotals, type DayTotalsPayload } from "@/lib/transactions/by-day";

export async function loadDayTotals(
  userId: string,
  filters: TxSortFilter,
  dates: string[],
  /** Every id the encrypted-text filters matched, or null when there are none. */
  matchedIds: number[] | null,
): Promise<DayTotalsPayload> {
  const displayCurrency = (await getDisplayCurrency(userId)).toUpperCase();
  const uniqueDates = [...new Set(dates)];
  if (uniqueDates.length === 0) return { displayCurrency, days: [] };

  let rows = await getTransactionIdsOnDates(userId, filters, uniqueDates);
  if (matchedIds) {
    const keep = new Set(matchedIds);
    rows = rows.filter((r) => keep.has(r.id));
  }
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.date, (counts.get(r.date) ?? 0) + 1);
  if (rows.length === 0) return { displayCurrency, days: [] };

  const rateMap = await getRateMap(displayCurrency, userId);
  const f = schema.transactionCategoryFlows;
  const groups = await db
    .select({
      date: f.date,
      categoryType: schema.categories.type,
      currency: f.currency,
      reportingCurrency: f.reportingCurrency,
      totalAmount: sql<number>`SUM(${f.amount})`,
      totalReporting: sql<number | null>`SUM(${f.reportingAmount})`,
      count: sql<number>`COUNT(*)`,
    })
    .from(f)
    .leftJoin(schema.categories, eq(f.categoryId, schema.categories.id))
    .where(and(eq(f.userId, userId), flowIdIn(rows.map((r) => r.id))))
    .groupBy(f.date, schema.categories.type, f.currency, f.reportingCurrency)
    .all();

  const slices: CalendarSlice[] = groups.map((g) => ({
    date: g.date,
    categoryType: g.categoryType ?? null,
    value: convertReportingSlice(
      {
        currency: g.currency,
        reportingCurrency: g.reportingCurrency,
        totalAmount: g.totalAmount == null ? null : Number(g.totalAmount),
        totalReporting: g.totalReporting == null ? null : Number(g.totalReporting),
      },
      displayCurrency,
      rateMap,
    ),
    count: Number(g.count),
  }));

  return { displayCurrency, days: buildDayTotals(slices, counts) };
}
