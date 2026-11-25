"use client";

/**
 * Forecast charts: balances over time (value-over-time → prepareTimeSeries,
 * off-zero domain) and monthly/yearly cash flow (bars, 0-anchored).
 *
 * The balances chart can mark events on the timeline (a dashed line at the
 * event's point with its name) and draw the net worth of the scenario you
 * compare with as a dotted line.
 */
import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { formatCurrency } from "@/lib/currency";
import { formatCompactNumber } from "@/lib/utils/number";
import { prepareTimeSeries } from "@/lib/chart-series";
import { CHART_COLORS } from "@/lib/chart-colors";

export type BalancePoint = {
  date: string;
  label: string;
  netWorth: number;
  cash: number;
  investments: number;
  loans: number;
  /** Net worth of the scenario being compared with, when there is one. */
  compare?: number | null;
};
export type FlowPoint = { label: string; income: number; spending: number; debt: number };
/** An event drawn on the timeline (`date` = "YYYY-MM-01"). */
export type ChartMarker = { date: string; text: string };

const C = CHART_COLORS.categories;

export function BalancesChart({
  points,
  currency,
  markers = [],
  compareLabel,
  height = 300,
}: {
  points: BalancePoint[];
  currency: string;
  markers?: ChartMarker[];
  compareLabel?: string;
  height?: number;
}) {
  const hasCompare = !!compareLabel && points.some((p) => p.compare != null);
  const prepared = prepareTimeSeries(points, {
    dateKey: "date",
    valueKeys: hasCompare ? ["netWorth", "cash", "investments", "loans", "compare"] : ["netWorth", "cash", "investments", "loans"],
    clampZeroFloor: false,
  });
  // Snap each event to the first point on or after it (the data may be
  // downsampled), and drop events past the end.
  const marks = markers.flatMap((m) => {
    const p = prepared.data.find((d) => d.date >= m.date);
    return p ? [{ at: p.label, text: m.text }] : [];
  });
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={prepared.data} margin={{ top: 18, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={24} />
        <YAxis domain={prepared.domain} tickFormatter={(v) => formatCompactNumber(Number(v))} tick={{ fontSize: 11 }} width={48} />
        <Tooltip formatter={(v) => formatCurrency(Number(v), currency)} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {marks.map((m, i) => (
          <ReferenceLine
            key={`${m.at}-${i}`}
            x={m.at}
            stroke="var(--color-primary, #f59e0b)"
            strokeDasharray="3 4"
            strokeOpacity={0.7}
            label={{ value: m.text, position: "insideTopLeft", fontSize: 11, fill: "currentColor", offset: 6 }}
          />
        ))}
        {hasCompare && (
          <Line type="monotone" dataKey="compare" name={compareLabel} stroke="#71717a" strokeWidth={2} strokeDasharray="2 4" dot={false} />
        )}
        <Line type="monotone" dataKey="investments" name="Investments" stroke={C[4]} strokeWidth={1.5} dot={false} />
        <Line type="monotone" dataKey="cash" name="Cash" stroke={C[2]} strokeWidth={1.5} dot={false} />
        <Line type="monotone" dataKey="loans" name="Loans owed" stroke={C[3]} strokeWidth={1.5} strokeDasharray="6 4" dot={false} />
        <Line type="monotone" dataKey="netWorth" name="Net worth" stroke={C[0]} strokeWidth={2.75} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function CashFlowChart({ points, currency, height = 300 }: { points: FlowPoint[]; currency: string; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={points} margin={{ top: 18, right: 12, left: 0, bottom: 0 }}>
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
