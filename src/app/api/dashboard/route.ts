import { NextRequest, NextResponse } from "next/server";
import {
  getAccountBalances,
  getIncomeVsExpenses,
  getSpendingByCategory,
  getNetWorthOverTime,
} from "@/lib/queries";
import { getRateMap, convertWithRateMap } from "@/lib/fx-service";
import { requireUnlock } from "@/lib/require-unlock";

export async function GET(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  const params = request.nextUrl.searchParams;
  const displayCurrency = params.get("currency") ?? "CAD";

  const now = new Date();
  const startDate =
    params.get("startDate") ??
    `${now.getFullYear() - 1}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const endDate =
    params.get("endDate") ??
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-31`;

  const rateMap = await getRateMap(displayCurrency);

  const balances = getAccountBalances();
  const convertedBalances = balances.map((b) => ({
    ...b,
    convertedBalance: convertWithRateMap(b.balance, b.currency, rateMap),
    displayCurrency,
  }));

  const incomeVsExpenses = getIncomeVsExpenses(startDate, endDate);
  const spendingByCategory = getSpendingByCategory(startDate, endDate);
  const netWorthRaw = getNetWorthOverTime();

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
}
