"use client";

import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  XAxis, YAxis, Tooltip, ResponsiveContainer,
  AreaChart, Area,
} from "recharts";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/currency";
import { formatCompactNumber } from "@/lib/utils/number";
import { ChartTooltip } from "./chart-tooltip";
import { buildStackedSeries, type StackPoint } from "@/lib/chart-stack";
import { StackedChartLegend } from "@/components/chart-stack-legend";
import { motion } from "framer-motion";
import type { MonthlyData } from "./types";

const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" as const } },
};

/**
 * One stacked-by-category sub-chart (income OR expense). FINLYNQ-129 — the "By
 * category" toggle splits the dual-line chart into two of these, stacked
 * vertically in place of the original. Each band's per-month value comes from
 * the FINLYNQ-128 per-(month,type) category breakdown; the outer edge ties to
 * the original income/expense line at every month (residual = total − top10).
 */
function StackedSideChart({
  title,
  data,
  valueKey,
  breakdownKey,
  currency,
}: {
  title: string;
  data: MonthlyData[];
  valueKey: "income" | "expenses";
  breakdownKey: "incomeBreakdown" | "expenseBreakdown";
  currency: string;
}) {
  const { rows, legend } = useMemo(
    () =>
      buildStackedSeries(
        data.map(
          (m): StackPoint => ({
            date: m.month,
            total: m[valueKey],
            // Breakdown rows are { name, value } — keyed by name (categories are
            // named consistently across months, so the band stays stable).
            members: (m[breakdownKey] ?? []).map((b) => ({ name: b.name, value: b.value })),
          }),
        ),
        { maxMembers: 10 },
      ),
    [data, valueKey, breakdownKey],
  );

  return (
    <div>
      <p className="text-[11px] font-medium text-muted-foreground mb-1">{title}</p>
      <ResponsiveContainer width="100%" height={170}>
        <AreaChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: -10 }}>
          <XAxis
            dataKey="date"
            fontSize={10}
            tickLine={false}
            axisLine={false}
            tick={{ fill: "var(--color-muted-foreground)" }}
          />
          <YAxis
            fontSize={10}
            tickLine={false}
            axisLine={false}
            tick={{ fill: "var(--color-muted-foreground)" }}
            tickFormatter={(v) => formatCompactNumber(Number(v))}
          />
          <Tooltip
            formatter={(v, n) => [formatCurrency(Number(v), currency), n]}
            cursor={{ stroke: "var(--color-border)", strokeDasharray: "4 4" }}
          />
          {legend.map((b) => (
            <Area
              key={b.key}
              type="monotone"
              dataKey={b.key}
              name={b.name}
              stackId={valueKey}
              stroke={b.color}
              strokeWidth={1}
              fill={b.color}
              fillOpacity={0.55}
              dot={false}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
      <StackedChartLegend legend={legend} />
    </div>
  );
}

export function IncomeExpenseChart({
  data,
  currency = "USD",
}: {
  data: MonthlyData[];
  currency?: string;
}) {
  // FINLYNQ-129 — component-only "By category" toggle (resets on reload).
  const [stacked, setStacked] = useState(false);
  // Only offer stacking when at least one month carries a category breakdown.
  const stackable = useMemo(
    () => data.some((m) => (m.incomeBreakdown?.length ?? 0) > 0 || (m.expenseBreakdown?.length ?? 0) > 0),
    [data],
  );
  const showStacked = stacked && stackable;

  return (
    <motion.div variants={itemVariants}>
      <Card className="card-hover">
        <CardHeader className="pb-1 px-5 pt-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-sm font-semibold">Income vs Expenses</CardTitle>
              <p className="text-[11px] text-muted-foreground">Last 12 months</p>
            </div>
            {stackable && (
              <Button
                size="sm"
                variant={stacked ? "default" : "outline"}
                onClick={() => setStacked((s) => !s)}
                title="Split into stacked top-10 category views"
              >
                By category
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="px-5 pb-5">
          {showStacked ? (
            <div className="space-y-4">
              <StackedSideChart
                title="Income by category"
                data={data}
                valueKey="income"
                breakdownKey="incomeBreakdown"
                currency={currency}
              />
              <StackedSideChart
                title="Expenses by category"
                data={data}
                valueKey="expenses"
                breakdownKey="expenseBreakdown"
                currency={currency}
              />
            </div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -10 }}>
                  <defs>
                    <linearGradient id="incomeGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#10b981" stopOpacity={0.2} />
                      <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="expenseGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#f43f5e" stopOpacity={0.15} />
                      <stop offset="100%" stopColor="#f43f5e" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="month"
                    fontSize={10}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fill: "var(--color-muted-foreground)" }}
                  />
                  <YAxis
                    fontSize={10}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fill: "var(--color-muted-foreground)" }}
                    tickFormatter={(v) => formatCompactNumber(Number(v))}
                  />
                  <Tooltip content={<ChartTooltip currency={currency} />} cursor={{ stroke: "var(--color-border)", strokeDasharray: "4 4" }} />
                  <Area
                    type="monotone"
                    dataKey="income"
                    stroke="#10b981"
                    strokeWidth={2}
                    fill="url(#incomeGrad)"
                    name="Income"
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 2, fill: "var(--color-card)" }}
                  />
                  <Area
                    type="monotone"
                    dataKey="expenses"
                    stroke="#f43f5e"
                    strokeWidth={2}
                    fill="url(#expenseGrad)"
                    name="Expenses"
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 2, fill: "var(--color-card)" }}
                  />
                </AreaChart>
              </ResponsiveContainer>

              {/* Legend */}
              <div className="flex items-center justify-center gap-5 mt-2">
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <div className="h-2 w-2 rounded-full bg-emerald-500" /> Income
                </div>
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <div className="h-2 w-2 rounded-full bg-rose-500" /> Expenses
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}
