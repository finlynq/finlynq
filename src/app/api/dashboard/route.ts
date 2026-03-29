import { NextRequest, NextResponse } from "next/server";
import {
  getAccountBalances,
  getIncomeVsExpenses,
  getSpendingByCategory,
  getNetWorthOverTime,
} from "@/lib/queries";
import { requireUnlock } from "@/lib/require-unlock";

export async function GET(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  const params = request.nextUrl.searchParams;

  const now = new Date();
  const startDate =
    params.get("startDate") ??
    `${now.getFullYear() - 1}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const endDate =
    params.get("endDate") ??
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-31`;

  const balances = getAccountBalances();
  const incomeVsExpenses = getIncomeVsExpenses(startDate, endDate);
  const spendingByCategory = getSpendingByCategory(startDate, endDate);
  const netWorthOverTime = getNetWorthOverTime();

  return NextResponse.json({
    balances,
    incomeVsExpenses,
    spendingByCategory,
    netWorthOverTime,
  });
}
