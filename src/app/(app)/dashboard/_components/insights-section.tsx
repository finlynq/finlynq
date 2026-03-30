"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/currency";
import { AlertTriangle, RefreshCw, Store, TrendingUp, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { motion } from "framer-motion";
import type { InsightsData, RecurringData } from "./types";

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.08, delayChildren: 0.1 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" as const } },
};

function InsightCard({
  icon: Icon,
  iconBg,
  title,
  subtitle,
  children,
}: {
  icon: typeof AlertTriangle;
  iconBg: string;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <motion.div variants={itemVariants}>
      <Card className="card-hover">
        <CardHeader className="pb-2 px-5 pt-5">
          <div className="flex items-center gap-2.5">
            <div className={`flex h-8 w-8 items-center justify-center rounded-xl ${iconBg}`}>
              <Icon className="h-4 w-4" />
            </div>
            <div>
              <CardTitle className="text-sm font-semibold">{title}</CardTitle>
              <p className="text-[11px] text-muted-foreground">{subtitle}</p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-5 pb-4">{children}</CardContent>
      </Card>
    </motion.div>
  );
}

export function InsightsSection() {
  const [insights, setInsights] = useState<InsightsData | null>(null);
  const [recurring, setRecurring] = useState<RecurringData | null>(null);

  useEffect(() => {
    fetch("/api/insights").then((r) => r.json()).then(setInsights);
    fetch("/api/recurring").then((r) => r.json()).then(setRecurring);
  }, []);

  return (
    <motion.div
      className="grid grid-cols-1 lg:grid-cols-2 gap-5"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      {/* Spending Alerts */}
      {insights && insights.anomalies.length > 0 && (
        <InsightCard
          icon={AlertTriangle}
          iconBg="bg-amber-100 text-amber-600 dark:bg-amber-950/60 dark:text-amber-400"
          title="Spending Alerts"
          subtitle="Categories above average"
        >
          <div className="space-y-1.5">
            {insights.anomalies.slice(0, 5).map((a, i) => (
              <div
                key={i}
                className="flex items-center justify-between p-2.5 rounded-xl bg-amber-50/50 border border-amber-100/80 dark:bg-amber-950/20 dark:border-amber-900/30"
              >
                <div className="min-w-0">
                  <p className="text-[13px] font-medium">{a.category}</p>
                  <p className="text-[11px] text-muted-foreground">{a.percentAbove}% above avg</p>
                </div>
                <div className="text-right shrink-0 ml-2">
                  <p className="text-[13px] font-mono font-semibold text-amber-700 dark:text-amber-400 tabular-nums">
                    {formatCurrency(a.currentMonth, "CAD")}
                  </p>
                  <p className="text-[10px] text-muted-foreground tabular-nums">
                    avg {formatCurrency(a.average, "CAD")}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </InsightCard>
      )}

      {/* Recurring */}
      {recurring && recurring.count > 0 && (
        <InsightCard
          icon={RefreshCw}
          iconBg="bg-cyan-100 text-cyan-600 dark:bg-cyan-950/60 dark:text-cyan-400"
          title={`Recurring (${recurring.count})`}
          subtitle={`${formatCurrency(recurring.monthlyRecurringTotal, "CAD")}/month`}
        >
          <div className="divide-y divide-border/40">
            {recurring.recurring.slice(0, 8).map((r, i) => (
              <div key={i} className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium">{r.payee}</p>
                  <p className="text-[11px] text-muted-foreground">{r.frequency} &middot; next: {r.nextDate}</p>
                </div>
                <p className={`text-[13px] font-mono font-semibold tabular-nums shrink-0 ml-2 ${r.avgAmount < 0 ? "text-rose-500" : "text-emerald-500"}`}>
                  {formatCurrency(r.avgAmount, "CAD")}
                </p>
              </div>
            ))}
          </div>
        </InsightCard>
      )}

      {/* Top Merchants */}
      {insights && insights.topMerchants.length > 0 && (
        <InsightCard
          icon={Store}
          iconBg="bg-violet-100 text-violet-600 dark:bg-violet-950/60 dark:text-violet-400"
          title="Top Merchants"
          subtitle="Last 6 months spending"
        >
          <div className="divide-y divide-border/40">
            {insights.topMerchants.slice(0, 8).map((m, i) => (
              <div key={i} className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium">{m.payee}</p>
                  <p className="text-[11px] text-muted-foreground">{m.count} transactions</p>
                </div>
                <p className="text-[13px] font-mono font-semibold text-rose-500 tabular-nums shrink-0 ml-2">
                  {formatCurrency(m.totalSpent, "CAD")}
                </p>
              </div>
            ))}
          </div>
        </InsightCard>
      )}

      {/* Category Trends */}
      {insights && insights.trends.length > 0 && (
        <InsightCard
          icon={TrendingUp}
          iconBg="bg-indigo-100 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400"
          title="Category Trends"
          subtitle="Spending direction by category"
        >
          <div className="divide-y divide-border/40">
            {insights.trends.slice(0, 8).map((t, i) => (
              <div key={i} className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
                <p className="text-[13px]">{t.category}</p>
                <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full ${
                  t.trend === "rising"
                    ? "bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-400"
                    : t.trend === "declining"
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400"
                      : "bg-muted text-muted-foreground"
                }`}>
                  {t.trend === "rising" ? <ArrowUpRight className="h-3 w-3" /> : t.trend === "declining" ? <ArrowDownRight className="h-3 w-3" /> : null}
                  {t.trend === "rising" ? "+" : ""}{t.changePercent}%
                </span>
              </div>
            ))}
          </div>
        </InsightCard>
      )}
    </motion.div>
  );
}
