import { NextRequest, NextResponse } from "next/server";
import { getMonthlySpending, getTransactions, getMerchantSpendRows } from "@/lib/queries";
import { detectAnomalies, comparePeriods, merchantSpending, spendingByDayOfWeek } from "@/lib/spending-insights";
import { getCurrentMonth } from "@/lib/currency";
import { getDisplayCurrency, getRateMap } from "@/lib/fx-service";
import { convertReportingSlice } from "@/lib/fx/reporting-amount";
import { requireAuth } from "@/lib/auth/require-auth";
import { tryDecryptField } from "@/lib/crypto/envelope";
import { todayISO } from "@/lib/utils/date";
import {
  DEFAULT_INSIGHT_PERIOD,
  INSIGHT_PERIODS,
  isInsightPeriod,
  resolveInsightPeriod,
} from "@/lib/insights/period";

/**
 * GET /api/insights[?period=last_3] — the dashboard Insights cards.
 *
 * Out of dev mode since GH #457 (2026-11-25), which also changed what they
 * count:
 *  - Spending Alerts + Category Trends read EXPENSE categories only (income
 *    and transfer categories used to appear, through Math.abs), with refunds
 *    netted inside a category.
 *  - Top Merchants is net spending at each merchant in expense categories,
 *    leaving out transfer / trade legs and opening balances / adjustments,
 *    converted to the display currency (it used to sum raw amounts of every
 *    row in every currency).
 *  - `period` (see lib/insights/period.ts) sets the months Top Merchants and
 *    Category Trends cover; trends compare it with the same number of months
 *    just before. Spending Alerts stays "this month vs your average".
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, dek } = auth.context;

  const rawPeriod = request.nextUrl.searchParams.get("period");
  if (rawPeriod != null && !isInsightPeriod(rawPeriod)) {
    return NextResponse.json(
      { error: `period must be one of ${INSIGHT_PERIODS.map((p) => p.key).join(", ")}` },
      { status: 400 },
    );
  }
  const today = todayISO();
  const period = resolveInsightPeriod(rawPeriod ?? DEFAULT_INSIGHT_PERIOD, today);
  const currentMonth = getCurrentMonth();
  const year = Number(today.slice(0, 4));

  const { decryptName } = await import("@/lib/crypto/encrypted-columns");
  const displayCurrency = await getDisplayCurrency(userId);
  const rateMap = await getRateMap(displayCurrency, userId);

  // FINLYNQ-123 — monthly spending slices are converted to the display
  // currency (stored historical reporting_amount when it matches, else a
  // current-rate fallback) and collapsed per (month, category), so an FX swing
  // never reads as a spending change. Expense categories only.
  async function expenseMonths(startDate: string, endDate: string) {
    const rows = await getMonthlySpending(userId, startDate, endDate);
    const norm = new Map<string, { month: string; categoryName: string; categoryGroup: string; total: number }>();
    for (const r of rows) {
      if (r.categoryType !== "E") continue;
      const categoryName = decryptName(r.categoryNameCt, dek, null) ?? "";
      const key = `${r.month}|${categoryName}`;
      const entry = norm.get(key) ?? { month: r.month, categoryName, categoryGroup: r.categoryGroup ?? "", total: 0 };
      entry.total += convertReportingSlice(r, displayCurrency, rateMap);
      norm.set(key, entry);
    }
    return Array.from(norm.values());
  }

  // Alerts: this month against the earlier months since January last year.
  // detectAnomalies reads magnitudes, so hand it spending (refunds netted,
  // a net refund month counts as 0).
  const alertMonths = (await expenseMonths(`${year - 1}-01-01`, `${year}-12-31`)).map((r) => ({
    ...r,
    total: Math.max(0, -r.total),
  }));
  const anomalies = detectAnomalies(alertMonths, currentMonth);

  const trendMonths = await expenseMonths(period.previousFrom, period.to);
  const trends = comparePeriods(trendMonths, period.months, period.previousMonths);

  // Merchant spending in the period. Payees are decrypted in memory (each
  // ciphertext has its own IV, so SQL can't group them).
  const merchantRows = await getMerchantSpendRows(userId, period.from, period.to);
  const merchants = merchantSpending(
    merchantRows.map((r) => ({
      payee: (dek ? tryDecryptField(dek, r.payee, "transactions.payee") : null) ?? "",
      amount: convertReportingSlice(
        { currency: r.currency, reportingCurrency: r.reportingCurrency, totalAmount: r.amount, totalReporting: r.reportingAmount },
        displayCurrency,
        rateMap,
      ),
    })),
  );

  // Day-of-week (API callers only; no card shows it): last 6 months, as before.
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const recentTxns = await getTransactions(userId, {
    startDate: sixMonthsAgo.toISOString().split("T")[0],
    endDate: `${year}-12-31`,
    limit: 5000,
  });
  const dayOfWeek = spendingByDayOfWeek(recentTxns.map((t) => ({ date: t.date, amount: t.amount })));

  return NextResponse.json({
    period: {
      key: period.key,
      label: period.label,
      previousLabel: period.previousLabel,
      from: period.from,
      to: period.to,
    },
    displayCurrency,
    payeesLocked: !dek,
    anomalies,
    trends: trends.slice(0, 15),
    topMerchants: merchants.slice(0, 20),
    spendingByDay: dayOfWeek,
  });
}
