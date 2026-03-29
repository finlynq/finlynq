import { NextResponse } from "next/server";
import {
  getAccountBalances,
  getIncomeVsExpenses,
  getNetWorthOverTime,
  getBudgets,
  getSpendingByCategory,
} from "@/lib/queries";
import { calculateAgeOfMoney } from "@/lib/age-of-money";
import { requireUnlock } from "@/lib/require-unlock";

type ComponentScore = {
  name: string;
  score: number;
  weight: number;
  weighted: number;
  detail: string;
};

export async function GET() {
  const locked = requireUnlock(); if (locked) return locked;
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  // Date ranges
  const threeMonthsAgo = new Date(now);
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const sixMonthsAgo = new Date(now);
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const twelveMonthsAgo = new Date(now);
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;

  const incomeExpenses = getIncomeVsExpenses(fmt(twelveMonthsAgo), `${currentMonth}-31`);
  const balances = getAccountBalances();
  const netWorthData = getNetWorthOverTime();
  const budgetsData = getBudgets(currentMonth);
  const spending = getSpendingByCategory(
    `${currentMonth}-01`,
    `${currentMonth}-31`
  );

  // --- 1. Savings Rate (30%) ---
  // Use last 3 months average
  const recentMonths = new Set<string>();
  const monthIncome = new Map<string, number>();
  const monthExpenses = new Map<string, number>();

  incomeExpenses.forEach((row) => {
    recentMonths.add(row.month);
    if (row.type === "I") {
      monthIncome.set(row.month, (monthIncome.get(row.month) ?? 0) + row.total);
    }
    if (row.type === "E") {
      monthExpenses.set(
        row.month,
        (monthExpenses.get(row.month) ?? 0) + Math.abs(row.total)
      );
    }
  });

  const sortedMonths = Array.from(recentMonths).sort().slice(-3);
  let totalIncome = 0;
  let totalExpenses = 0;
  sortedMonths.forEach((m) => {
    totalIncome += monthIncome.get(m) ?? 0;
    totalExpenses += monthExpenses.get(m) ?? 0;
  });

  let savingsRateScore = 0;
  let savingsRateDetail = "No income data";
  if (totalIncome > 0) {
    const savingsRate = (totalIncome - totalExpenses) / totalIncome;
    // 20%+ savings rate = 100, 0% = 0, negative = 0
    savingsRateScore = Math.min(100, Math.max(0, savingsRate * 500)); // 20% => 100
    savingsRateDetail = `${Math.round(savingsRate * 100)}% savings rate`;
  }

  // --- 2. Debt-to-Income Ratio (20%) ---
  const totalLiabilities = balances
    .filter((b) => b.accountType === "L")
    .reduce((s, b) => s + Math.abs(b.balance), 0);

  const annualIncome = totalIncome > 0 ? (totalIncome / sortedMonths.length) * 12 : 0;

  let dtiScore = 0;
  let dtiDetail = "No income data";
  if (annualIncome > 0) {
    const dtiRatio = totalLiabilities / annualIncome;
    // DTI < 0.36 = 100, > 1.0 = 0
    dtiScore = Math.min(100, Math.max(0, (1 - dtiRatio) * 100));
    dtiDetail = `${Math.round(dtiRatio * 100)}% debt-to-income`;
  } else if (totalLiabilities === 0) {
    dtiScore = 100;
    dtiDetail = "No debt";
  }

  // --- 3. Emergency Fund (20%) ---
  const avgMonthlyExpenses =
    sortedMonths.length > 0 ? totalExpenses / sortedMonths.length : 0;

  // Liquid assets: checking, savings type accounts (assets not investment)
  const liquidAssets = balances
    .filter(
      (b) =>
        b.accountType === "A" &&
        !b.accountGroup.toLowerCase().includes("investment") &&
        !b.accountGroup.toLowerCase().includes("portfolio") &&
        !b.accountGroup.toLowerCase().includes("retirement")
    )
    .reduce((s, b) => s + b.balance, 0);

  let emergencyScore = 0;
  let emergencyDetail = "No expense data";
  if (avgMonthlyExpenses > 0) {
    const monthsCovered = liquidAssets / avgMonthlyExpenses;
    // 6+ months = 100, 3 months = 75, 0 = 0
    emergencyScore = Math.min(100, Math.max(0, (monthsCovered / 6) * 100));
    emergencyDetail = `${monthsCovered.toFixed(1)} months covered`;
  } else if (liquidAssets > 0) {
    emergencyScore = 50;
    emergencyDetail = "Has liquid assets";
  }

  // --- 4. Net Worth Trend (15%) ---
  // Compare last 3 months net worth growth
  const nwByMonth = new Map<string, number>();
  let runningNW = 0;
  netWorthData
    .filter((p) => p.currency === "CAD")
    .forEach((p) => {
      runningNW += p.cumulative;
      nwByMonth.set(p.month, runningNW);
    });

  const nwMonths = Array.from(nwByMonth.entries())
    .sort(([a], [b]) => a.localeCompare(b));

  let nwTrendScore = 50; // neutral default
  let nwTrendDetail = "Insufficient data";
  if (nwMonths.length >= 3) {
    const recent = nwMonths.slice(-3);
    const older = nwMonths.slice(-6, -3);
    const recentAvg = recent.reduce((s, [, v]) => s + v, 0) / recent.length;
    const olderAvg =
      older.length > 0
        ? older.reduce((s, [, v]) => s + v, 0) / older.length
        : recentAvg;

    if (olderAvg !== 0) {
      const growthPct = ((recentAvg - olderAvg) / Math.abs(olderAvg)) * 100;
      // Growing > 5% = 100, flat = 50, declining > 5% = 0
      nwTrendScore = Math.min(100, Math.max(0, 50 + growthPct * 10));
      nwTrendDetail =
        growthPct >= 0
          ? `Growing ${growthPct.toFixed(1)}%`
          : `Declining ${Math.abs(growthPct).toFixed(1)}%`;
    }
  }

  // --- 5. Budget Adherence (15%) ---
  let budgetScore = 50; // neutral if no budgets
  let budgetDetail = "No budgets set";
  if (budgetsData.length > 0) {
    const spendingByCat = new Map<number, number>();
    spending.forEach((s) => {
      if (s.categoryId != null) {
        spendingByCat.set(s.categoryId, Math.abs(s.total));
      }
    });

    let onTrack = 0;
    budgetsData.forEach((b) => {
      const spent = spendingByCat.get(b.categoryId) ?? 0;
      if (spent <= Math.abs(b.amount)) onTrack++;
    });

    const adherenceRate = onTrack / budgetsData.length;
    budgetScore = Math.round(adherenceRate * 100);
    budgetDetail = `${onTrack}/${budgetsData.length} budgets on track`;
  }

  // --- 6. Age of Money (10%) ---
  let aomScore = 50; // neutral default
  let aomDetail = "Insufficient data";
  try {
    const aom = calculateAgeOfMoney();
    if (aom.ageInDays > 0) {
      // 30+ days = 100, 14 days = 50, 0 days = 0
      aomScore = Math.min(100, Math.max(0, (aom.ageInDays / 30) * 100));
      aomDetail = `${aom.ageInDays} days`;
      if (aom.trend > 0) aomDetail += ` (+${aom.trend}d trend)`;
      else if (aom.trend < 0) aomDetail += ` (${aom.trend}d trend)`;
    }
  } catch {
    // keep defaults
  }

  // --- Composite Score ---
  const components: ComponentScore[] = [
    {
      name: "Savings Rate",
      score: Math.round(savingsRateScore),
      weight: 0.25,
      weighted: Math.round(savingsRateScore * 0.25),
      detail: savingsRateDetail,
    },
    {
      name: "Debt-to-Income",
      score: Math.round(dtiScore),
      weight: 0.2,
      weighted: Math.round(dtiScore * 0.2),
      detail: dtiDetail,
    },
    {
      name: "Emergency Fund",
      score: Math.round(emergencyScore),
      weight: 0.15,
      weighted: Math.round(emergencyScore * 0.15),
      detail: emergencyDetail,
    },
    {
      name: "Net Worth Trend",
      score: Math.round(nwTrendScore),
      weight: 0.15,
      weighted: Math.round(nwTrendScore * 0.15),
      detail: nwTrendDetail,
    },
    {
      name: "Budget Adherence",
      score: Math.round(budgetScore),
      weight: 0.15,
      weighted: Math.round(budgetScore * 0.15),
      detail: budgetDetail,
    },
    {
      name: "Age of Money",
      score: Math.round(aomScore),
      weight: 0.1,
      weighted: Math.round(aomScore * 0.1),
      detail: aomDetail,
    },
  ];

  const totalScore = components.reduce((s, c) => s + c.weighted, 0);

  return NextResponse.json({
    score: Math.min(100, Math.max(0, totalScore)),
    components,
    grade:
      totalScore >= 80
        ? "Excellent"
        : totalScore >= 60
          ? "Good"
          : totalScore >= 40
            ? "Fair"
            : "Needs Work",
  });
}
