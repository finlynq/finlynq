"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency, getCurrentMonth, getMonthLabel } from "@/lib/currency";
import { buildTxDrillUrl } from "@/lib/transactions/drill-url";
import { Sparkline } from "@/components/sparkline";
import { DollarSign, ArrowUpRight, ArrowDownRight, TrendingUp, CreditCard, Target, User, Upload, FileUp } from "lucide-react";
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
import { AvailableToSpend } from "./_components/available-to-spend";
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
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => <div key={i} className="h-32 animate-shimmer rounded-2xl" />)}
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
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [userInfo, setUserInfo] = useState<{ email: string; displayName?: string } | null>(null);

  useEffect(() => {
    if (currencyLoading) return; // wait until provider has read settings
    fetch(`/api/dashboard?currency=${encodeURIComponent(displayCurrency)}`)
      .then((r) => { if (r.ok) return r.json(); })
      .then((d) => { if (d) setData(d); });

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

  // Net worth over time — API returns rows already converted to display
  // currency (route.ts collapses currencies via getRateMap + convertWithRateMap
  // before returning).
  const nwMap = new Map<string, number>();
  let runningTotal = 0;
  (data.netWorthOverTime ?? [])
    .forEach((p) => {
      runningTotal += p.cumulative;
      nwMap.set(p.month, runningTotal);
    });
  const netWorthData = Array.from(nwMap.entries())
    .map(([month, value]) => ({ month, value }))
    .slice(-24);
  // Net Worth sparkline shows the last twelve months (hero + stat tile share it).
  const nwSparkPoints = netWorthData.slice(-12);
  const nwSparkline = nwSparkPoints.map((d) => d.value);
  const nwSparkLabels = nwSparkPoints.map((d) => d.month);

  // Month-over-month change
  let momChange = 0;
  let momPct = 0;
  if (netWorthData.length >= 2) {
    const current = netWorthData[netWorthData.length - 1].value;
    const prev = netWorthData[netWorthData.length - 2].value;
    momChange = current - prev;
    momPct = prev !== 0 ? (momChange / Math.abs(prev)) * 100 : 0;
  }

  // FINLYNQ-291 (C1) — the Monthly Income / Expenses / Budgets tiles summarize a
  // single reference month. The newest tracked month is usually the CURRENT
  // calendar month, which is incomplete mid-month: before payroll lands its
  // income reads $0, so the Monthly Income tile looked broken. Prefer the last
  // COMPLETE month — if the newest entry is the current calendar month and an
  // earlier month exists, step back one. A brand-new user with only the current
  // month still sees it. Income + expenses + drill-through all key off this one
  // index so the trio stays internally consistent.
  const currentMonthKey = getCurrentMonth();
  let refIdx = incExpData.length - 1;
  if (refIdx > 0 && incExpData[refIdx].month === currentMonthKey) {
    refIdx -= 1;
  }
  const refMonth = incExpData.length > 0 ? incExpData[refIdx] : null;
  const lastMonthIncome = refMonth ? refMonth.income : 0;
  const lastMonthExpenses = refMonth ? refMonth.expenses : 0;
  const availableToSpend = lastMonthIncome - lastMonthExpenses;

  // FINLYNQ-130 — drill-through: the Monthly Income / Expenses tiles show the
  // reference month above (incExpData is "YYYY-MM" sorted asc). Derive that
  // month's [startDate, endDate] so the tile links into /transactions scoped to
  // exactly the rows that produced the figure. Empty range ⇒ plain /transactions.
  const lastMonthKey = refMonth ? refMonth.month : "";
  const monthDrill = (() => {
    const m = /^(\d{4})-(\d{2})$/.exec(lastMonthKey);
    if (!m) return { startDate: "", endDate: "" };
    const year = Number(m[1]);
    const month = Number(m[2]); // 1-12
    const startDate = `${m[1]}-${m[2]}-01`;
    // Day 0 of the next month = last day of this month.
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const endDate = `${m[1]}-${m[2]}-${String(last).padStart(2, "0")}`;
    return { startDate, endDate };
  })();
  const budgetSparkline = incExpLast6.map((d) => d.income - d.expenses);

  // Dev-mode: spending by category for charts
  const spendingData = (data.spendingByCategory ?? [])
    .map((c) => ({ name: c.categoryName ?? "Uncategorized", value: Math.abs(c.total) }))
    .slice(0, 8);

  // Stat cards config
  const summaryCards = [
    {
      label: "Net Worth",
      value: totalNetWorth,
      sub: `Assets ${formatCurrency(totalAssets, apiDisplayCurrency)}`,
      icon: DollarSign,
      iconBg: "bg-primary/10 text-primary",
      sparkColor: "#6366f1",
      sparkData: nwSparkline,
      sparkLabels: nwSparkLabels,
      href: "/accounts",
    },
    {
      label: "Monthly Income",
      // Name the month the figure covers — it's the last COMPLETE month, not
      // necessarily the current one (FINLYNQ-291 C1), so the label must be explicit.
      value: lastMonthIncome,
      sub: lastMonthKey ? getMonthLabel(lastMonthKey) : `${incExpData.length} months tracked`,
      icon: TrendingUp,
      iconBg: "bg-emerald-100 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-400",
      sparkColor: "#10b981",
      sparkData: incomeSparkline,
      sparkLabels: incExpSparkLabels,
      href: buildTxDrillUrl({ startDate: monthDrill.startDate, endDate: monthDrill.endDate }),
    },
    {
      label: "Monthly Expenses",
      value: lastMonthExpenses,
      sub: lastMonthIncome > 0 ? `${Math.round((lastMonthExpenses / lastMonthIncome) * 100)}% of income` : "",
      icon: CreditCard,
      iconBg: "bg-rose-100 text-rose-600 dark:bg-rose-950/60 dark:text-rose-400",
      sparkColor: "#f43f5e",
      sparkData: expenseSparkline,
      sparkLabels: incExpSparkLabels,
      href: buildTxDrillUrl({ startDate: monthDrill.startDate, endDate: monthDrill.endDate }),
    },
    {
      label: "Budgets",
      value: availableToSpend,
      sub: availableToSpend >= 0 ? "Available to spend" : "Over budget",
      icon: Target,
      iconBg: "bg-amber-100 text-amber-600 dark:bg-amber-950/60 dark:text-amber-400",
      sparkColor: "#f59e0b",
      sparkData: budgetSparkline,
      sparkLabels: incExpSparkLabels,
      href: "/budgets",
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
                      <AnimatedNumber value={totalNetWorth} currency={apiDisplayCurrency} />
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
                        {momChange >= 0 ? "+" : ""}{formatCurrency(momChange, apiDisplayCurrency)} vs last month
                      </span>
                    </div>
                  </div>

                  {/* Mini sparkline */}
                  <div className="hidden md:block w-40 h-20 opacity-50 group-hover:opacity-100 transition-opacity duration-300">
                    <Sparkline data={nwSparkline} color="#6366f1" labels={nwSparkLabels} currency={apiDisplayCurrency} />
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
          ROW 2 — 4 Metric Cards
          ============================================ */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
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
            <AvailableToSpend income={lastMonthIncome} expenses={lastMonthExpenses} currency={apiDisplayCurrency} />
          </div>
          <InsightsSection currency={apiDisplayCurrency} />
        </>
      )}

    </motion.div>
    </>
  );
}
