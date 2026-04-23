"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { PieTooltip } from "./chart-tooltip";
import { formatCurrency } from "@/lib/currency";
import { motion } from "framer-motion";

const CHART_COLORS = [
  "#6366f1", "#8b5cf6", "#06b6d4", "#10b981", "#f59e0b",
  "#f43f5e", "#14b8a6", "#ec4899", "#f97316", "#84cc16",
];

const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" as const } },
};

type SpendingItem = { name: string; value: number };

export function SpendingCategoryChart({ data }: { data: SpendingItem[] }) {
  const total = data.reduce((s, d) => s + d.value, 0);

  return (
    <motion.div variants={itemVariants}>
      <Card className="card-hover">
        <CardHeader className="pb-1 px-5 pt-5">
          <CardTitle className="text-sm font-semibold">Spending by Category</CardTitle>
          <p className="text-[11px] text-muted-foreground">Current month breakdown</p>
        </CardHeader>
        <CardContent className="px-5 pb-5">
          <div className="flex items-center gap-5">
            {/* Donut chart */}
            <div className="w-44 h-44 shrink-0 relative">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <PieChart>
                  <Pie
                    data={data}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={52}
                    outerRadius={72}
                    strokeWidth={2}
                    stroke="var(--color-card)"
                    paddingAngle={2}
                  >
                    {data.map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip content={<PieTooltip />} />
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <span className="text-[10px] text-muted-foreground">Total</span>
                <span className="text-sm font-bold tabular-nums">{formatCurrency(total, "CAD")}</span>
              </div>
            </div>

            {/* Legend */}
            <div className="flex-1 space-y-2 min-w-0">
              {data.slice(0, 6).map((cat, i) => {
                const pct = total > 0 ? Math.round((cat.value / total) * 100) : 0;
                return (
                  <div key={cat.name} className="group/legend">
                    <div className="flex items-center gap-2 mb-0.5">
                      <div className="h-2 w-2 rounded-full shrink-0" style={{ background: CHART_COLORS[i] }} />
                      <span className="truncate text-[11px] text-muted-foreground flex-1">{cat.name}</span>
                      <span className="text-[11px] font-semibold tabular-nums">{pct}%</span>
                    </div>
                    {/* Mini bar */}
                    <div className="ml-4 h-1 rounded-full bg-muted/40 overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${pct}%`, background: CHART_COLORS[i] }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
