"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  AreaChart, Area,
} from "recharts";
import { ChartTooltip } from "./chart-tooltip";
import { motion } from "framer-motion";
import type { MonthlyData } from "./types";

const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" as const } },
};

export function IncomeExpenseChart({ data }: { data: MonthlyData[] }) {
  return (
    <motion.div variants={itemVariants}>
      <Card className="card-hover">
        <CardHeader className="pb-1 px-5 pt-5">
          <CardTitle className="text-sm font-semibold">Income vs Expenses</CardTitle>
          <p className="text-[11px] text-muted-foreground">Last 12 months</p>
        </CardHeader>
        <CardContent className="px-5 pb-5">
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
                tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`}
              />
              <Tooltip content={<ChartTooltip />} cursor={{ stroke: "var(--color-border)", strokeDasharray: "4 4" }} />
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
        </CardContent>
      </Card>
    </motion.div>
  );
}
