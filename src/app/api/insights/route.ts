import { NextRequest, NextResponse } from "next/server";
import { getMonthlySpending, getTransactions } from "@/lib/queries";
import { detectAnomalies, analyzeTrends, analyzeMerchants, spendingByDayOfWeek } from "@/lib/spending-insights";
import { getCurrentMonth } from "@/lib/currency";
import { requireAuth } from "@/lib/auth/require-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  const now = new Date();
  const startDate = `${now.getFullYear() - 1}-01-01`;
  const endDate = `${now.getFullYear()}-12-31`;
  const currentMonth = getCurrentMonth();

  const monthlySpending = await getMonthlySpending(userId, startDate, endDate);
  const anomalies = detectAnomalies(
    monthlySpending.map((r) => ({
      month: r.month,
      categoryName: r.categoryName ?? "",
      categoryGroup: r.categoryGroup ?? "",
      total: r.total,
    })),
    currentMonth
  );

  const trends = analyzeTrends(
    monthlySpending.map((r) => ({
      month: r.month,
      categoryName: r.categoryName ?? "",
      categoryGroup: r.categoryGroup ?? "",
      total: r.total,
    }))
  );

  // Merchant analysis (last 6 months)
  const sixMonthsAgo = new Date(now);
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const recentTxns = await getTransactions(userId, {
    startDate: sixMonthsAgo.toISOString().split("T")[0],
    endDate: endDate,
    limit: 5000,
  });

  const merchants = analyzeMerchants(
    recentTxns.map((t) => ({ payee: t.payee ?? "", amount: t.amount }))
  );

  const dayOfWeek = spendingByDayOfWeek(
    recentTxns.map((t) => ({ date: t.date, amount: t.amount }))
  );

  return NextResponse.json({
    anomalies,
    trends: trends.slice(0, 15),
    topMerchants: merchants.slice(0, 20),
    spendingByDay: dayOfWeek,
  });
}
