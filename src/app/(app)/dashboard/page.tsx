"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency } from "@/lib/currency";
import { Sparkline } from "@/components/sparkline";
import { DollarSign, ArrowUpRight, ArrowDownRight, TrendingUp, CreditCard, Target, User, Upload, FileText, CheckCircle2, AlertCircle, X } from "lucide-react";
import { motion } from "framer-motion";
import { AnimatedNumber } from "./_components/animated-number";
import { StatCard } from "./_components/stat-card";
import { HealthScoreCard } from "./_components/health-score-card";
import { ActionCenter } from "./_components/action-center";
import { WeeklyRecap } from "./_components/weekly-recap";
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

// --- Quick Import widget ---
type ImportStatus = "idle" | "ready" | "importing" | "success" | "error";

function QuickImport() {
  const [isDragging, setIsDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [importType, setImportType] = useState("transactions");
  const [status, setStatus] = useState<ImportStatus>("idle");
  const [message, setMessage] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setFile(null);
    setStatus("idle");
    setMessage("");
  };

  const handleFile = (f: File) => {
    setFile(f);
    setStatus("ready");
    setMessage("");
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  };

  const handleImport = async () => {
    if (!file) return;
    setStatus("importing");
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("type", importType);
      const res = await fetch("/api/import", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Import failed");
      const count = data.imported ?? data.count ?? "?";
      setStatus("success");
      setMessage(`${count} records imported`);
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Import failed");
    }
  };

  if (status === "success") {
    return (
      <Card className="card-hover">
        <CardContent className="flex flex-col items-center justify-center py-8 text-center gap-3">
          <div className="h-12 w-12 rounded-full bg-emerald-100 dark:bg-emerald-950/50 flex items-center justify-center">
            <CheckCircle2 className="h-6 w-6 text-emerald-600" />
          </div>
          <div>
            <p className="font-semibold text-sm">Import complete</p>
            <p className="text-xs text-muted-foreground mt-0.5">{message}</p>
          </div>
          <button onClick={reset} className="text-xs text-indigo-600 hover:underline">Import another file</button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="card-hover">
      <CardContent className="pt-4 pb-4 px-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Upload className="h-4 w-4 text-indigo-500" />
            <span className="text-sm font-semibold">Quick Import</span>
          </div>
          <Link href="/import" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
            Full import →
          </Link>
        </div>

        {/* Drop zone */}
        <div
          className={`relative rounded-xl border-2 border-dashed transition-all duration-200 cursor-pointer
            ${isDragging
              ? "border-indigo-400 bg-indigo-50/60 dark:bg-indigo-950/30"
              : file
                ? "border-indigo-300 bg-indigo-50/30 dark:bg-indigo-950/10"
                : "border-border/50 hover:border-indigo-300 hover:bg-muted/30"
            }`}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => !file && fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.ofx,.qfx"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          />

          {file ? (
            <div className="flex items-center gap-3 px-4 py-3">
              <FileText className="h-5 w-5 text-indigo-500 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{file.name}</p>
                <p className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</p>
              </div>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); reset(); }}
                className="h-6 w-6 flex items-center justify-center rounded-full hover:bg-muted/60 transition-colors"
              >
                <X className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center py-6 gap-1.5">
              <Upload className="h-7 w-7 text-muted-foreground/60" />
              <p className="text-sm text-muted-foreground">Drop CSV or OFX file here</p>
              <p className="text-xs text-muted-foreground/70">or click to browse</p>
            </div>
          )}
        </div>

        {/* Type selector + import button */}
        {file && (
          <div className="flex items-center gap-2 mt-3">
            <select
              value={importType}
              onChange={(e) => setImportType(e.target.value)}
              className="flex-1 text-xs h-8 rounded-md border border-input bg-background px-2 focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="transactions">Transactions</option>
              <option value="accounts">Accounts</option>
              <option value="portfolio">Portfolio</option>
            </select>
            <button
              onClick={handleImport}
              disabled={status === "importing"}
              className="h-8 px-3 rounded-md bg-indigo-600 text-white text-xs font-medium hover:bg-indigo-700 disabled:opacity-60 transition-colors"
            >
              {status === "importing" ? "Importing…" : "Import"}
            </button>
          </div>
        )}

        {status === "error" && (
          <div className="flex items-center gap-1.5 mt-2 text-xs text-rose-600">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {message}
          </div>
        )}
      </CardContent>
    </Card>
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
          ROW 4 — Quick Import
          ============================================ */}
      <motion.div variants={itemVariants}>
        <QuickImport />
      </motion.div>
    </motion.div>
  );
}
