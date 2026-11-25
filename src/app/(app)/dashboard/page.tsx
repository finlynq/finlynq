"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency, getCurrentMonth, getMonthLabel } from "@/lib/currency";
import { buildTxDrillUrl } from "@/lib/transactions/drill-url";
import { Sparkline } from "@/components/sparkline";
import { niceDomain } from "@/lib/chart-series";
import { DASHBOARD_MONTH_KEYS, pickSpendMonth, splitSpendMonths, type SpendMonthMode } from "@/lib/dashboard/spend-month";
import { ArrowUpRight, ArrowDownRight, TrendingUp, CreditCard, Target, User, Upload, FileUp } from "lucide-react";
import { motion } from "framer-motion";
import { AnimatedNumber } from "./_components/animated-number";
import { StatCard } from "./_components/stat-card";
import { HealthScoreCard } from "./_components/health-score-card";
import { KeyMetrics } from "./_components/key-metrics";
import { ActionCenter } from "./_components/action-center";
import { WeeklyRecap } from "./_components/weekly-recap";
import { OnboardingTips } from "@/components/onboarding-tips";
import { OnboardingWizard } from "@/components/onboarding-wizard";
import { QuickImport } from "./_components/quick-import";
import { IncomeExpenseChart } from "./_components/income-expense-chart";
import { SpendingCategoryChart } from "./_components/spending-category-chart";
import { NetWorthHistoryChart } from "@/components/net-worth-history-chart";
import { monthOverMonth, type MonthEndNetWorthPoint } from "@/lib/net-worth-month-end";
import { AvailableToSpend } from "./_components/available-to-spend";
import { useSpendMonthMode } from "./_components/month-switch";
import { InsightsSection } from "./_components/insights-section";
import { useDevMode } from "@/hooks/use-dev-mode";
import { useDisplayCurrency } from "@/components/currency-provider";
import { CurrencyAuditBanner } from "@/components/currency-audit-banner";
import type { DashboardData, HealthData } from "./_components/types";

// --- Quick Import Widget ---
function QuickImportWidget() {
  const router = useRouter();
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    router.push("/import");
  }

  function handleFileChange() {
    router.push("/import");
  }

  return (
    <Card
      className={`relative overflow-hidden border-dashed transition-colors cursor-pointer ${
        dragOver
          ? "border-primary bg-primary/5"
          : "border-border/60 hover:border-primary/50 hover:bg-muted/30"
      }`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
    >
      <input ref={inputRef} type="file" accept=".csv,.ofx,.qfx" className="hidden" onChange={handleFileChange} />
      <CardContent className="flex flex-col items-center justify-center py-8 gap-3 text-center">
        <div className={`flex h-12 w-12 items-center justify-center rounded-2xl transition-colors ${
          dragOver ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
        }`}>
          {dragOver ? <FileUp className="h-6 w-6" /> : <Upload className="h-6 w-6" />}
        </div>
        <div>
          <p className="text-sm font-medium">{dragOver ? "Drop to import" : "Quick Import"}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Drop CSV, OFX, or QFX files here</p>
        </div>
        <Link
          href="/import"
          className="text-xs text-primary hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          Or browse files →
        </Link>
      </CardContent>
    </Card>
  );
}

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
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => <div key={i} className="h-32 animate-shimmer rounded-2xl" />)}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {[1, 2, 3].map((i) => <div key={i} className="h-52 animate-shimmer rounded-2xl" />)}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const devMode = useDevMode();
  const { displayCurrency, isLoading: currencyLoading } = useDisplayCurrency();
  const [data, setData] = useState<DashboardData | null>(null);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [nwPoints, setNwPoints] = useState<MonthEndNetWorthPoint[]>([]);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [userInfo, setUserInfo] = useState<{ email: string; displayName?: string } | null>(null);
  // GH #447: each card switches between last month and this month on its own.
  const [incomeMode, toggleIncomeMode] = useSpendMonthMode(DASHBOARD_MONTH_KEYS.income);
  const [expensesMode, toggleExpensesMode] = useSpendMonthMode(DASHBOARD_MONTH_KEYS.expenses);
  const [budgetsMode, toggleBudgetsMode] = useSpendMonthMode(DASHBOARD_MONTH_KEYS.budgets);

  useEffect(() => {
    if (currencyLoading) return; // wait until provider has read settings
    fetch(`/api/dashboard?currency=${encodeURIComponent(displayCurrency)}`)
      .then((r) => { if (r.ok) return r.json(); })
      .then((d) => { if (d) setData(d); });

    // The hero card's line + "vs last month": month-end points of the accurate
    // net-worth history (investments at market, today live), so the line ends
    // on the hero number. A failure just leaves the card without a line.
    fetch(`/api/net-worth-history?period=1y&resolution=month&currency=${encodeURIComponent(displayCurrency)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && Array.isArray(d.series)) setNwPoints(d.series); })
      .catch(() => {});

    // Financial-health payload feeds both the Health Score card and the
    // KeyMetrics strip (savings rate + DTI) — fetched once here and passed down
    // so the two consumers don't each hit the (query-heavy) endpoint.
    fetch(`/api/health-score?currency=${encodeURIComponent(displayCurrency)}`)
      .then((r) => { if (r.ok) return r.json(); })
      .then((d) => { if (d) setHealth(d); });

    // Check if onboarding is needed (managed mode only). Username-only users
    // (no email on file) also see the wizard — fall back to username for the
    // "Signed in as …" line.
    fetch("/api/auth/session")
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (d && d.authenticated && d.onboardingComplete === false) {
          const identity = d.email ?? d.username ?? "";
          if (identity) {
            setUserInfo({ email: identity, displayName: d.displayName ?? undefined });
            setShowOnboarding(true);
          }
        }
      })
      .catch(() => {});
  }, [displayCurrency, currencyLoading]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--mouse-x", `${e.clientX - rect.left}px`);
    e.currentTarget.style.setProperty("--mouse-y", `${e.clientY - rect.top}px`);
  }, []);

  if (!data) return <DashboardSkeleton />;

  // --- Compute derived data ---
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  // Sum the API's already-converted balances in the user's display currency.
  // The API converts every account's native balance via the rate map and
  // returns convertedBalance + displayCurrency on each row.
  const balances = data.balances ?? [];
  const apiDisplayCurrency = data.displayCurrency ?? displayCurrency;
  const totalAssets = balances
    .filter((b) => b.accountType === "A")
    .reduce((s, b) => s + (b.convertedBalance ?? b.balance), 0);
  const totalLiabilities = balances
    .filter((b) => b.accountType === "L")
    .reduce((s, b) => s + (b.convertedBalance ?? b.balance), 0);
  const totalNetWorth = totalAssets + totalLiabilities;

  // Income vs Expenses monthly data — totals are summed across currencies
  // server-side (raw native amounts) and converted at the dashboard level
  // through the same rate path on the next pass. For now we use the
  // unconverted figures on income/expenses since the queries don't yet
  // tag them per-currency; this is fine while users have a single dominant
  // tx currency. Phase 2 will tag rows with their account currency and
  // convert at aggregation.
  const monthMap = new Map<string, { month: string; income: number; expenses: number }>();
  (data.incomeVsExpenses ?? []).forEach((row) => {
    const entry = monthMap.get(row.month) ?? { month: row.month, income: 0, expenses: 0 };
    if (row.type === "I") entry.income = row.total;
    if (row.type === "E") entry.expenses = Math.abs(row.total);
    monthMap.set(row.month, entry);
  });
  // FINLYNQ-128 — attach the per-category tooltip breakdown (keyed by the same
  // "YYYY-MM" month) so the Income vs Expenses tooltip can show contributors.
  const ieBreakdown = data.incomeExpenseBreakdown ?? {};
  const incExpData = Array.from(monthMap.values())
    .map((m) => ({
      ...m,
      incomeBreakdown: ieBreakdown[m.month]?.income,
      expenseBreakdown: ieBreakdown[m.month]?.expenses,
    }))
    .slice(-12);
  const incExpLast6 = incExpData.slice(-6);
  // "YYYY-MM" labels parallel to the income/expense/budget sparklines — drive the
  // hover tooltip's date line (formatted via getMonthLabel inside Sparkline).
  const incExpSparkLabels = incExpLast6.map((d) => d.month);
  const incomeSparkline = incExpLast6.map((d) => d.income);
  const expenseSparkline = incExpLast6.map((d) => d.expenses);

  // Total Net Worth line: last day of each month from the accurate history
  // (the same series as the Net Worth chart), ending on today's live value.
  const nwSparkline = nwPoints.map((d) => d.value);
  const nwSparkLabels = nwPoints.map((d) => d.month);
  const nwChange = monthOverMonth(nwPoints);

  // FINLYNQ-291 (C1) + GH #447 — the Monthly Income / Expenses / Budgets tiles
  // and the Available to Spend card each summarize one month: the last complete
  // month by default (the current month is incomplete mid-month: before payroll
  // lands its income reads $0), or the current month so far when the user
  // switches THAT card. Each card has its own choice. A brand-new user with no
  // complete month yet sees the current month and no switch. A card's figure,
  // subtitle and drill-through all come from its own month.
  const currentMonthKey = getCurrentMonth();
  const spendMonths = splitSpendMonths(incExpData, currentMonthKey);

  // FINLYNQ-130 — drill-through: the Income / Expenses tiles link into
  // /transactions scoped to exactly the month that produced the figure.
  const monthDrillUrl = (monthKey: string) => {
    const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
    if (!m) return buildTxDrillUrl({ startDate: "", endDate: "" });
    const year = Number(m[1]);
    const month = Number(m[2]); // 1-12
    // Day 0 of the next month = last day of this month.
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return buildTxDrillUrl({ startDate: `${m[1]}-${m[2]}-01`, endDate: `${m[1]}-${m[2]}-${String(last).padStart(2, "0")}` });
  };
  const cardMonth = (mode: SpendMonthMode, onToggle: () => void) => {
    const { showingCurrent, figures } = pickSpendMonth(spendMonths, mode);
    return {
      showingCurrent,
      figures,
      label: showingCurrent ? `${getMonthLabel(figures.month)} so far` : getMonthLabel(figures.month),
      monthSwitch: spendMonths.last ? { showingCurrent, onToggle } : undefined,
    };
  };
  const incomeCard = cardMonth(incomeMode, toggleIncomeMode);
  const expensesCard = cardMonth(expensesMode, toggleExpensesMode);
  const budgetsCard = cardMonth(budgetsMode, toggleBudgetsMode);
  const budgetLeft = budgetsCard.figures.income - budgetsCard.figures.expenses;
  const expensePct = expensesCard.figures.income > 0
    ? ` · ${Math.round((expensesCard.figures.expenses / expensesCard.figures.income) * 100)}% of income`
    : "";
  const budgetSparkline = incExpLast6.map((d) => d.income - d.expenses);

  // Dev-mode: spending by category for charts
  const spendingData = (data.spendingByCategory ?? [])
    .map((c) => ({ name: c.categoryName ?? "Uncategorized", value: Math.abs(c.total) }))
    .slice(0, 8);

  // Stat cards config
  const summaryCards = [
    {
      label: "Monthly Income",
      // Name the month the figure covers, so a closed month and the month so
      // far can't be mistaken for each other.
      value: incomeCard.figures.income,
      sub: incomeCard.label,
      icon: TrendingUp,
      iconBg: "bg-emerald-100 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-400",
      sparkColor: "#10b981",
      sparkData: incomeSparkline,
      sparkLabels: incExpSparkLabels,
      href: monthDrillUrl(incomeCard.figures.month),
      monthSwitch: incomeCard.monthSwitch,
    },
    {
      label: "Monthly Expenses",
      value: expensesCard.figures.expenses,
      sub: `${expensesCard.label}${expensePct}`,
      icon: CreditCard,
      iconBg: "bg-rose-100 text-rose-600 dark:bg-rose-950/60 dark:text-rose-400",
      sparkColor: "#f43f5e",
      sparkData: expenseSparkline,
      sparkLabels: incExpSparkLabels,
      href: monthDrillUrl(expensesCard.figures.month),
      monthSwitch: expensesCard.monthSwitch,
    },
    {
      label: "Budgets",
      value: budgetLeft,
      sub: budgetsCard.showingCurrent
        ? (budgetLeft >= 0 ? "Available to spend" : "Over budget")
        : (budgetLeft >= 0 ? "Left over" : "Overspent"),
      icon: Target,
      iconBg: "bg-amber-100 text-amber-600 dark:bg-amber-950/60 dark:text-amber-400",
      sparkColor: "#f59e0b",
      sparkData: budgetSparkline,
      sparkLabels: incExpSparkLabels,
      href: "/budgets",
      monthSwitch: budgetsCard.monthSwitch,
    },
  ];

  return (
    <>
      {showOnboarding && userInfo && (
        <OnboardingWizard
          userEmail={userInfo.email}
          displayName={userInfo.displayName}
          onComplete={() => setShowOnboarding(false)}
        />
      )}
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
          href="/settings/general"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-muted/60 hover:bg-muted transition-colors"
          title="Settings"
        >
          <User className="h-4 w-4 text-muted-foreground" />
        </Link>
      </motion.div>

      {/* Currency audit banner — shown only when there are unresolved cross-currency rows */}
      <motion.div variants={itemVariants}>
        <CurrencyAuditBanner />
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
              {/* GH #434: the net worth line fills the whole tile behind the
                  text, scaled to the data's own range so an ordinary month's
                  change is visible (from 0, a 2.7% drop on a six-figure
                  balance drew as a flat line). GH #446: hovering it shows
                  each month's value; the text layer above ignores the mouse
                  so the line gets hover everywhere, and a click still lands
                  on the card's link. */}
              {nwSparkline.length > 1 && (
                <div className="absolute inset-0">
                  <Sparkline data={nwSparkline} labels={nwSparkLabels} currency={apiDisplayCurrency} color="#6366f1" fill areaClassName="opacity-60 group-hover:opacity-90 transition-opacity duration-300" domain={niceDomain(nwSparkline, { padPct: 0.15, clampZeroFloor: false })} />
                </div>
              )}

              {/* Decorative gradient orbs */}
              <div className="absolute -top-20 -right-20 w-48 h-48 rounded-full bg-indigo-500/8 blur-3xl dark:bg-indigo-400/5 pointer-events-none" />
              <div className="absolute -bottom-16 -left-16 w-40 h-40 rounded-full bg-violet-500/6 blur-3xl dark:bg-violet-400/4 pointer-events-none" />

              <CardContent className="relative pt-6 pb-6 px-6 pointer-events-none">
                <div className="flex items-start justify-between">
                  <div className="space-y-3">
                    {/* Label */}
                    <p className="text-xs font-medium text-muted-foreground tracking-wide uppercase">
                      Total Net Worth
                    </p>

                    {/* Big number */}
                    <p className="text-4xl md:text-5xl font-bold tracking-tight hero-number leading-none">
                      <AnimatedNumber value={totalNetWorth} currency={apiDisplayCurrency} />
                    </p>

                    {/* Change pill */}
                    {nwChange && (
                    <div className="flex items-center gap-2.5 mt-1">
                      {nwChange.change >= 0 ? (
                        <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-emerald-600 bg-emerald-100/80 dark:bg-emerald-950/60 dark:text-emerald-400 px-2.5 py-0.5 rounded-full">
                          <ArrowUpRight className="h-3 w-3" />
                          {nwChange.pct != null && `+${nwChange.pct.toFixed(1)}%`}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-rose-600 bg-rose-100/80 dark:bg-rose-950/60 dark:text-rose-400 px-2.5 py-0.5 rounded-full">
                          <ArrowDownRight className="h-3 w-3" />
                          {nwChange.pct != null && `${nwChange.pct.toFixed(1)}%`}
                        </span>
                      )}
                      <span className="text-[11px] text-muted-foreground">
                        {nwChange.change >= 0 ? "+" : ""}{formatCurrency(nwChange.change, apiDisplayCurrency)} vs last month
                      </span>
                    </div>
                    )}
                  </div>

                </div>
              </CardContent>
            </Card>
          </Link>
        </motion.div>

        {/* Health Score */}
        <HealthScoreCard health={health} />
      </div>

      {/* ============================================
          ROW 2 — 3 Metric Cards (the small Net Worth tile was dropped: the
          hero card above shows it)
          ============================================ */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {summaryCards.map((card) => (
          <StatCard key={card.label} {...card} currency={apiDisplayCurrency} />
        ))}
      </div>

      {/* ============================================
          ROW 2.25 — Key ratios: Savings Rate + DTI (FINLYNQ-291)
          Standalone headline figures (previously buried as 0-100 sub-scores
          inside the Financial Health card). Fed by the same /api/health-score
          payload the Health card uses.
          ============================================ */}
      <KeyMetrics health={health} />

      {/* ============================================
          ROW 2.5 — Net Worth Over Time (always visible)
          Accurate merged series: cash live from transactions + investments
          from stored snapshots; latest point matches the hero above.
          plan/net-worth-over-time.md Part A.
          ============================================ */}
      <motion.div variants={itemVariants}>
        <NetWorthHistoryChart />
      </motion.div>

      {/* ============================================
          ROW 3 — Action Center + Weekly Recap + Quick Import
          ============================================ */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <ActionCenter />
        <WeeklyRecap />
        <QuickImport />
      </div>

      {/* ============================================
          ROW 4–6 — Dev-only: Charts, Available to Spend, Insights
          ============================================ */}
      {devMode && (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <IncomeExpenseChart data={incExpData} currency={apiDisplayCurrency} />
            <SpendingCategoryChart data={spendingData} currency={apiDisplayCurrency} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            <AvailableToSpend {...spendMonths} currency={apiDisplayCurrency} />
          </div>
          <InsightsSection currency={apiDisplayCurrency} />
        </>
      )}

    </motion.div>
    </>
  );
}
