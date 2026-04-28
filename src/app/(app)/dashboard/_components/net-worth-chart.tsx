"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { ChartTooltip } from "./chart-tooltip";
import { motion } from "framer-motion";

const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" as const } },
};

type NWPoint = { month: string; value: number };

export function NetWorthChart({ data }: { data: NWPoint[] }) {
  return (
    <motion.div variants={itemVariants} className="lg:col-span-2">
      <Card className="card-hover">
        <CardHeader className="pb-1 px-5 pt-5">
          <CardTitle className="text-sm font-semibold">Net Worth Over Time</CardTitle>
          <p className="text-[11px] text-muted-foreground">CAD cumulative trend</p>
        </CardHeader>
        <CardContent className="px-5 pb-5">
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -10 }}>
              <defs>
                <linearGradient id="nwGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#6366f1" stopOpacity={0.25} />
                  <stop offset="50%" stopColor="#6366f1" stopOpacity={0.08} />
                  <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
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
                dataKey="value"
                stroke="#6366f1"
                strokeWidth={2.5}
                fill="url(#nwGradient)"
                name="Net Worth"
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, fill: "var(--color-card)" }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </motion.div>
  );
}
