"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency } from "@/lib/currency";
import { Sparkline } from "@/components/sparkline";
import { DollarSign, ArrowUpRight, ArrowDownRight, TrendingUp, CreditCard, Target, User } from "lucide-react";
import { motion } from "framer-motion";
import { AnimatedNumber } from "./_components/animated-number";
import { StatCard } from "./_components/stat-card";
import { HealthScoreCard } from "./_components/health-score-card";
import { ActionCenter } from "./_components/action-center";
import { WeeklyRecap } from "./_components/weekly-recap";
import { IncomeExpenseChart } from "./_components/income-expense-chart";
import { SpendingCategoryChart } from "./_components/spending-category-chart";
import { NetWorthChart } from "./_components/net-worth-chart";
import { AvailableToSpend } from "./_components/available-to-spend";
import { InsightsSection } from "./_components/insights-section";
import { OnboardingTips } from "@/components/onboarding-tips";
import type { DashboardData } from "./_components/types";

// --- Animation variants ---
const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.06, delayChildren: 0.08 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" as const } },
};

// --- Skeleton loader ---
function DashboardSkeleton() {
  return (
    <div className="space-y-5">
      <div className="h-7 w-52 animate-shimmer rounded-lg" />
      <div className="h-4 w-36 animate-shimmer rounded-md" />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
        <div className="lg:col-span-2 h-44 animate-shimmer rounded-2xl" />
        <div className="h-44 animate-shimmer rounded-2xl" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => <div key={i} className="h-32 animate-shimmer rounded-2xl" />)}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {[1, 2].map((i) => <div key={i} className="h-72 animate-shimmer rounded-2xl" />)}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);

  useEffect(() => {
    fetch("/api/dashboard")
      .then((r) => { if (r.ok) return r.json(); })
      .then((d) => { if (d) setData(d); });
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--mouse-x", `${e.clientX - rect.left}px`);
    e.currentTarget.style.setProperty("--mouse-y", `${e.clientY - rect.top}px`);
  }, []);

  if (!data) return <DashboardSkeleton />;

  // --- Compute derived data ---
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  const balances = data.balances ?? [];
  const cadAssets = balances.filter((b) => b.accountType === "A" && b.currency === "CAD").reduce((s, b) => s + b.balance, 0);
  const cadLiabilities = balances.filter((b) => b.accountType === "L" && b.currency === "CAD").reduce((s, b) => s + b.balance, 0);
  const cadNetWorth = cadAssets + cadLiabilities;

  // Income vs Expenses monthly data
  const monthMap = new Map<string, { month: string; income: number; expenses: number }>();
  (data.incomeVsExpenses ?? []).forEach((row) => {
    const entry = monthMap.get(row.month) ?? { month: row.month, income: 0, expenses: 0 };
    if (row.type === "I") entry.income = row.total;
    if (row.type === "E") entry.expenses = Math.abs(row.total);
    monthMap.set(row.month, entry);
  });
  const incExpData = Array.from(monthMap.values()).slice(-12);
  const incExpLast6 = incExpData.slice(-6);
  const incomeSparkline = incExpLast6.map((d) => d.income);
  const expenseSparkline = incExpLast6.map((d) => d.expenses);

  // Net worth over time
  const nwMap = new Map<string, number>();
  let runningCAD = 0;
  (data.netWorthOverTime ?? [])
    .filter((p) => p.currency === "CAD")
    .forEach((p) => {
      runningCAD += p.cumulative;
      nwMap.set(p.month, runningCAD);
    });
  const netWorthData = Array.from(nwMap.entries())
    .map(([month, value]) => ({ month, value }))
    .slice(-24);
  const nwSparkline = netWorthData.slice(-6).map((d) => d.value);

  // Month-over-month change
  let momChange = 0;
  let momPct = 0;
  if (netWorthData.length >= 2) {
    const current = netWorthData[netWorthData.length - 1].value;
    const prev = netWorthData[netWorthData.length - 2].value;
    momChange = current - prev;
    momPct = prev !== 0 ? (momChange / Math.abs(prev)) * 100 : 0;
  }

  const lastMonthIncome = incExpData.length > 0 ? incExpData[incExpData.length - 1].income : 0;
  const lastMonthExpenses = incExpData.length > 0 ? incExpData[incExpData.length - 1].expenses : 0;
  const availableToSpend = lastMonthIncome - lastMonthExpenses;

  // Spending by category
  const spendingData = (data.spendingByCategory ?? [])
    .map((c) => ({ name: c.categoryName ?? "Uncategorized", value: Math.abs(c.total) }))
    .slice(0, 8);

  const budgetSparkline = incExpLast6.map((d) => d.income - d.expenses);

  // Stat cards config
  const summaryCards = [
    {
      label: "Net Worth",
      value: cadNetWorth,
      sub: `Assets ${formatCurrency(cadAssets, "CAD")}`,
      icon: DollarSign,
      iconBg: "bg-indigo-100 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400",
      sparkColor: "#6366f1",
      sparkData: nwSparkline,
      href: "/accounts",
    },
    {
      label: "Monthly Income",
      value: lastMonthIncome,
      sub: `${incExpData.length} months tracked`,
      icon: TrendingUp,
      iconBg: "bg-emerald-100 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-400",
      sparkColor: "#10b981",
      sparkData: incomeSparkline,
      href: "/transactions",
    },
    {
      label: "Monthly Expenses",
      value: lastMonthExpenses,
      sub: lastMonthIncome > 0 ? `${Math.round((lastMonthExpenses / lastMonthIncome) * 100)}% of income` : "",
      icon: CreditCard,
      iconBg: "bg-rose-100 text-rose-600 dark:bg-rose-950/60 dark:text-rose-400",
      sparkColor: "#f43f5e",
      sparkData: expenseSparkline,
      href: "/transactions",
    },
    {
      label: "Budgets",
      value: availableToSpend,
      sub: availableToSpend >= 0 ? "Available to spend" : "Over budget",
      icon: Target,
      iconBg: "bg-amber-100 text-amber-600 dark:bg-amber-950/60 dark:text-amber-400",
      sparkColor: "#f59e0b",
      sparkData: budgetSparkline,
      href: "/budgets",
    },
  ];

  return (
    <motion.div
      className="space-y-5"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      {/* ============================================
          HEADER — Greeting + Profile hint
          ============================================ */}
      <motion.div variants={itemVariants} className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{greeting}</h1>
          <p className="text-[13px] text-muted-foreground mt-0.5">Here&apos;s your financial overview</p>
        </div>
        <Link
          href="/settings"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-muted/60 hover:bg-muted transition-colors"
          title="Settings"
        >
          <User className="h-4 w-4 text-muted-foreground" />
        </Link>
      </motion.div>

      {/* Onboarding tips for first-time users */}
      <motion.div variants={itemVariants}>
        <OnboardingTips page="dashboard" />
      </motion.div>

      {/* ============================================
          ROW 1 — Hero Net Worth + Health Score
          ============================================ */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Hero Card */}
        <motion.div variants={itemVariants} className="lg:col-span-2">
          <Link href="/accounts">
            <Card
              className="relative overflow-hidden group cursor-pointer card-hover mouse-glow hover:scale-[1.005] transition-transform duration-300 rounded-2xl"
              onMouseMove={handleMouseMove}
            >
              {/* Decorative gradient orbs */}
              <div className="absolute -top-20 -right-20 w-48 h-48 rounded-full bg-indigo-500/8 blur-3xl dark:bg-indigo-400/5 pointer-events-none" />
              <div className="absolute -bottom-16 -left-16 w-40 h-40 rounded-full bg-violet-500/6 blur-3xl dark:bg-violet-400/4 pointer-events-none" />

              <CardContent className="relative pt-6 pb-6 px-6">
                <div className="flex items-start justify-between">
                  <div className="space-y-3">
                    {/* Label */}
                    <p className="text-xs font-medium text-muted-foreground tracking-wide uppercase">
                      Total Net Worth
                    </p>

                    {/* Big number */}
                    <p className="text-4xl md:text-5xl font-bold tracking-tight hero-number leading-none">
                      <AnimatedNumber value={cadNetWorth} currency="CAD" />
                    </p>

                    {/* Change pill */}
                    <div className="flex items-center gap-2.5 mt-1">
                      {momChange >= 0 ? (
                        <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-emerald-600 bg-emerald-100/80 dark:bg-emerald-950/60 dark:text-emerald-400 px-2.5 py-0.5 rounded-full">
                          <ArrowUpRight className="h-3 w-3" />
                          +{momPct.toFixed(1)}%
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-rose-600 bg-rose-100/80 dark:bg-rose-950/60 dark:text-rose-400 px-2.5 py-0.5 rounded-full">
                          <ArrowDownRight className="h-3 w-3" />
                          {momPct.toFixed(1)}%
                        </span>
                      )}
                      <span className="text-[11px] text-muted-foreground">
                        {momChange >= 0 ? "+" : ""}{formatCurrency(momChange, "CAD")} vs last month
                      </span>
                    </div>
                  </div>

                  {/* Mini sparkline */}
                  <div className="hidden md:block w-40 h-20 opacity-50 group-hover:opacity-100 transition-opacity duration-300">
                    <Sparkline data={nwSparkline} color="#6366f1" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </Link>
        </motion.div>

        {/* Health Score */}
        <HealthScoreCard />
      </div>

      {/* ============================================
          ROW 2 — 4 Metric Cards
          ============================================ */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {summaryCards.map((card) => (
          <StatCard key={card.label} {...card} />
        ))}
      </div>

      {/* ============================================
          ROW 3 — Action Center + Weekly Recap
          ============================================ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <ActionCenter />
        <WeeklyRecap />
      </div>

      {/* ============================================
          ROW 4 — Charts (Income/Expense + Spending)
          ============================================ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <IncomeExpenseChart data={incExpData} />
        <SpendingCategoryChart data={spendingData} />
      </div>

      {/* ============================================
          ROW 5 — Available to Spend + Net Worth Trend
          ============================================ */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <AvailableToSpend income={lastMonthIncome} expenses={lastMonthExpenses} />
        <NetWorthChart data={netWorthData} />
      </div>

      {/* ============================================
          ROW 6 — Insights (Alerts, Recurring, Merchants, Trends)
          ============================================ */}
      <InsightsSection />
    </motion.div>
  );
}
