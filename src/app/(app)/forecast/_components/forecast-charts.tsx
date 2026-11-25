"use client";

/**
 * Forecast charts: balances over time (value-over-time → prepareTimeSeries,
 * off-zero domain) and monthly/yearly cash flow (bars, 0-anchored).
 */
import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { formatCurrency } from "@/lib/currency";
import { formatCompactNumber } from "@/lib/utils/number";
import { prepareTimeSeries } from "@/lib/chart-series";
import { CHART_COLORS } from "@/lib/chart-colors";

export type BalancePoint = { date: string; label: string; netWorth: number; cash: number; investments: number; loans: number };
export type FlowPoint = { label: string; income: number; spending: number; debt: number };

const C = CHART_COLORS.categories;

export function BalancesChart({ points, currency }: { points: BalancePoint[]; currency: string }) {
  const prepared = prepareTimeSeries(points, {
    dateKey: "date",
    valueKeys: ["netWorth", "cash", "investments", "loans"],
    clampZeroFloor: false,
  });
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={prepared.data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={24} />
        <YAxis domain={prepared.domain} tickFormatter={(v) => formatCompactNumber(Number(v))} tick={{ fontSize: 11 }} width={48} />
        <Tooltip formatter={(v) => formatCurrency(Number(v), currency)} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Line type="monotone" dataKey="netWorth" name="Net worth" stroke={C[0]} strokeWidth={2.5} dot={false} />
        <Line type="monotone" dataKey="cash" name="Cash" stroke={C[2]} strokeWidth={1.5} dot={false} />
        <Line type="monotone" dataKey="investments" name="Investments" stroke={C[4]} strokeWidth={1.5} dot={false} />
        <Line type="monotone" dataKey="loans" name="Loans owed" stroke={C[3]} strokeWidth={1.5} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function CashFlowChart({ points, currency }: { points: FlowPoint[]; currency: string }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={points} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={16} />
        <YAxis tickFormatter={(v) => formatCompactNumber(Number(v))} tick={{ fontSize: 11 }} width={48} />
        <Tooltip formatter={(v) => formatCurrency(Number(v), currency)} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="income" name="Income" fill={C[2]} />
        <Bar dataKey="spending" name="Spending" fill={C[3]} />
        <Bar dataKey="debt" name="Debt payments" fill={C[1]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
