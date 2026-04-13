import { NextRequest, NextResponse } from "next/server";
import {
  getAccountBalances,
  getIncomeVsExpenses,
  getSpendingByCategory,
  getNetWorthOverTime,
} from "@/lib/queries";
import { getRateMap, convertWithRateMap } from "@/lib/fx-service";
import { requireAuth } from "@/lib/auth/require-auth";
import { logApiError } from "@/lib/validate";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  const params = request.nextUrl.searchParams;
  const displayCurrency = params.get("currency") ?? "CAD";

  try {
    const now = new Date();
    const startDate =
      params.get("startDate") ??
      `${now.getFullYear() - 1}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const endDate =
      params.get("endDate") ??
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-31`;

    const rateMap = await getRateMap(displayCurrency, userId);

    const balances = await getAccountBalances(userId);
    const convertedBalances = balances.map((b: any) => ({
      ...b,
      convertedBalance: convertWithRateMap(b.balance, b.currency, rateMap),
      displayCurrency,
    }));

    const incomeVsExpenses = await getIncomeVsExpenses(userId, startDate, endDate);
    const spendingByCategory = await getSpendingByCategory(userId, startDate, endDate);
    const netWorthRaw = await getNetWorthOverTime(userId);

    // Consolidate net worth across currencies into display currency
    const netWorthByMonth = new Map<string, number>();
    for (const row of netWorthRaw) {
      const converted = convertWithRateMap(row.cumulative, row.currency ?? displayCurrency, rateMap);
      netWorthByMonth.set(row.month, (netWorthByMonth.get(row.month) ?? 0) + converted);
    }
    const netWorthOverTime = Array.from(netWorthByMonth.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, cumulative]) => ({ month, cumulative: Math.round(cumulative * 100) / 100, currency: displayCurrency }));

    return NextResponse.json({
      displayCurrency,
      balances: convertedBalances,
      incomeVsExpenses,
      spendingByCategory,
      netWorthOverTime,
    });
  } catch (error: unknown) {
    await logApiError("GET", "/api/dashboard", error, userId);
    const message = error instanceof Error ? error.message : "Failed to load dashboard data";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
