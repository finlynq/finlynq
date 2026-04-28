"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/currency";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { Calendar, ChevronDown, ChevronUp, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import type { WeeklyRecapData } from "./types";

const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" as const } },
};

export function WeeklyRecap() {
  const [recap, setRecap] = useState<WeeklyRecapData | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    fetch("/api/recap").then((r) => r.json()).then(setRecap);
  }, []);

  if (!recap) return null;

  const spendingUp = recap.spending.changePercent > 0;

  const chartData = recap.spending.topCategories.map((cat) => ({
    name: cat.name.length > 12 ? cat.name.slice(0, 12) + "..." : cat.name,
    amount: cat.total,
  }));

  return (
    <motion.div variants={itemVariants}>
      <Card className="card-hover relative overflow-hidden">
        <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full bg-indigo-500/5 blur-3xl pointer-events-none" />

        <CardHeader className="pb-2 px-5 pt-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400">
                <Calendar className="h-4 w-4" />
              </div>
              <div>
                <CardTitle className="text-sm font-semibold">Weekly Recap</CardTitle>
                <p className="text-[11px] text-muted-foreground">
                  {recap.weekStart} — {recap.weekEnd}
                </p>
              </div>
            </div>
            <button
              onClick={() => setExpanded(!expanded)}
              className="p-1.5 rounded-lg hover:bg-muted/50 transition-colors"
            >
              {expanded ? (
                <ChevronUp className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              )}
            </button>
          </div>
        </CardHeader>

        <CardContent className="px-5">
          {/* Summary: Spent / Income / Cash Flow */}
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div>
              <p className="text-[11px] text-muted-foreground mb-0.5">Spent</p>
              <p className="text-lg font-bold tracking-tight tabular-nums">
                {formatCurrency(recap.spending.total, "CAD")}
              </p>
              <span className={`inline-flex items-center gap-0.5 text-[11px] font-semibold ${spendingUp ? "text-rose-500" : "text-emerald-500"}`}>
                {spendingUp ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                {Math.abs(recap.spending.changePercent)}%
              </span>
            </div>
            <div>
              <p className="text-[11px] text-muted-foreground mb-0.5">Income</p>
              <p className="text-lg font-bold tracking-tight text-emerald-600 dark:text-emerald-400 tabular-nums">
                {formatCurrency(recap.income.total, "CAD")}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-muted-foreground mb-0.5">Net Flow</p>
              <p className={`text-lg font-bold tracking-tight tabular-nums ${recap.netCashFlow >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-500"}`}>
                {formatCurrency(recap.netCashFlow, "CAD")}
              </p>
            </div>
          </div>

          {/* Top categories bar chart */}
          {chartData.length > 0 && (
            <div>
              <p className="text-[11px] font-medium text-muted-foreground mb-2">Top categories</p>
              <ResponsiveContainer width="100%" height={110} minWidth={0}>
                <BarChart data={chartData} layout="vertical" barSize={12}>
                  <XAxis type="number" hide />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={85}
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fill: "var(--color-muted-foreground)" }}
                  />
                  <Tooltip
                    formatter={(v) => formatCurrency(Number(v), "CAD")}
                    contentStyle={{
                      background: "var(--color-card)",
                      border: "1px solid var(--color-border)",
                      borderRadius: "10px",
                      fontSize: "12px",
                    }}
                  />
                  <Bar dataKey="amount" fill="#6366f1" radius={[0, 6, 6, 0]} name="Spent" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Expanded details */}
          <AnimatePresence>
            {expanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="overflow-hidden"
              >
                <div className="border-t mt-3 pt-3 space-y-4">
                  {/* Budget status */}
                  {recap.budgetStatus.length > 0 && (
                    <div>
                      <p className="text-[11px] font-medium text-muted-foreground mb-2">Budget Status (MTD)</p>
                      <div className="space-y-2.5">
                        {recap.budgetStatus.slice(0, 5).map((b) => (
                          <div key={b.category}>
                            <div className="flex items-center justify-between text-[11px] mb-1">
                              <span>{b.category}</span>
                              <span className={`font-semibold tabular-nums ${b.pctUsed > 100 ? "text-rose-500" : b.pctUsed > 80 ? "text-amber-500" : "text-muted-foreground"}`}>
                                {b.pctUsed}%
                              </span>
                            </div>
                            <div className="w-full bg-muted/60 rounded-full h-1.5 overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all ${b.pctUsed > 100 ? "bg-rose-500" : b.pctUsed > 80 ? "bg-amber-500" : "bg-indigo-500"}`}
                                style={{ width: `${Math.min(100, b.pctUsed)}%` }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Notable transactions */}
                  {recap.notableTransactions.length > 0 && (
                    <div>
                      <p className="text-[11px] font-medium text-muted-foreground mb-2">Largest Expenses</p>
                      <div className="space-y-0.5">
                        {recap.notableTransactions.map((t, i) => (
                          <div key={i} className="flex items-center justify-between text-[12px] py-1.5 px-2 rounded-lg hover:bg-muted/30 transition-colors">
                            <div className="min-w-0">
                              <span className="font-medium">{t.payee || t.category}</span>
                              <span className="text-muted-foreground ml-2 text-[11px]">{t.date}</span>
                            </div>
                            <span className="font-mono font-semibold text-rose-500 tabular-nums shrink-0 ml-2">
                              {formatCurrency(t.amount, "CAD")}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Upcoming bills */}
                  {recap.upcomingBills.length > 0 && (
                    <div>
                      <p className="text-[11px] font-medium text-muted-foreground mb-2">Upcoming Bills</p>
                      <div className="space-y-0.5">
                        {recap.upcomingBills.map((b, i) => (
                          <div key={i} className="flex items-center justify-between text-[12px] py-1.5 px-2 rounded-lg hover:bg-muted/30 transition-colors">
                            <div className="min-w-0">
                              <span className="font-medium">{b.name}</span>
                              <span className="text-muted-foreground ml-2 text-[11px]">{b.date}</span>
                            </div>
                            <span className="font-mono font-semibold tabular-nums shrink-0 ml-2">
                              {formatCurrency(b.amount, "CAD")}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Net worth change */}
                  <div className="flex items-center justify-between text-[12px] border-t pt-2.5">
                    <span className="text-muted-foreground">Net worth change this week</span>
                    <span className={`font-semibold tabular-nums ${recap.netWorthChange >= 0 ? "text-emerald-500" : "text-rose-500"}`}>
                      {recap.netWorthChange >= 0 ? "+" : ""}{formatCurrency(recap.netWorthChange, "CAD")}
                    </span>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </CardContent>
      </Card>
    </motion.div>
  );
}
