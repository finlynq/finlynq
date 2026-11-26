"use client";

/**
 * Forecast charts: balances over time (value-over-time → prepareTimeSeries)
 * and monthly/yearly cash flow (bars, 0-anchored: income beside money out,
 * which stacks spending and debt payments).
 *
 * The balances chart can mark events on the timeline (a dashed line at the
 * event's point, numbered, with a key below) and draw the net worth of the scenario you
 * compare with as a dotted line. Its axis starts at 0 when no shown line goes
 * below zero, and draws a 0 line when one does.
 *
 * Both charts have a clickable legend: a click hides that line or bar, a
 * second click shows it again; the axis fits what is shown.
 */
import { useState } from "react";
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { formatCurrency } from "@/lib/currency";
import { formatCompactNumber } from "@/lib/utils/number";
import { prepareTimeSeries } from "@/lib/chart-series";
import { CHART_COLORS } from "@/lib/chart-colors";
import { cn } from "@/lib/utils";

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

export type LegendItem = { key: string; label: string; color: string; dashed?: boolean; bar?: boolean };

/** Toggle buttons under a chart: pressed = shown. */
export function SeriesLegend({
  items,
  hidden,
  onToggle,
}: {
  items: LegendItem[];
  hidden: ReadonlySet<string>;
  onToggle: (key: string) => void;
}) {
  return (
    <div role="group" aria-label="Show or hide lines" className="flex flex-wrap justify-center gap-x-1 gap-y-1 pt-1">
      {items.map((it) => {
        const shown = !hidden.has(it.key);
        return (
          <button
            key={it.key}
            type="button"
            aria-pressed={shown}
            title={shown ? `Hide ${it.label}` : `Show ${it.label}`}
            onClick={() => onToggle(it.key)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors hover:bg-muted",
              !shown && "text-muted-foreground line-through opacity-60",
            )}
          >
            {it.bar ? (
              <span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm" style={{ background: shown ? it.color : "transparent", border: `1.5px solid ${it.color}` }} />
            ) : (
              <span aria-hidden="true" className="w-4" style={{ borderTop: `2px ${it.dashed ? "dashed" : "solid"} ${it.color}` }} />
            )}
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Events on the timeline, numbered in date order, one marker per chart point
 * (events that land on the same point share it). The chart shows only the
 * numbers and a key below names them, so close events never overlap.
 */
export function numberMarkers(
  markers: ChartMarker[],
  data: Array<{ date: string; label: string }>,
): { marks: Array<{ at: string; numbers: number[] }>; key: Array<{ n: number; text: string; at: string }> } {
  const sorted = [...markers].sort((a, b) => a.date.localeCompare(b.date));
  const key: Array<{ n: number; text: string; at: string }> = [];
  const byPoint = new Map<string, number[]>();
  for (const m of sorted) {
    // Snap to the first point on or after the event (the data may be downsampled); drop events past the end.
    const p = data.find((d) => d.date >= m.date);
    if (!p) continue;
    const n = key.length + 1;
    key.push({ n, text: m.text, at: p.label });
    byPoint.set(p.label, [...(byPoint.get(p.label) ?? []), n]);
  }
  return { marks: [...byPoint.entries()].map(([at, numbers]) => ({ at, numbers })), key };
}

function useHidden() {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  return { hidden, toggle };
}

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
  const { hidden, toggle } = useHidden();
  const hasCompare = !!compareLabel && points.some((p) => p.compare != null);
  const series: Array<LegendItem & { key: keyof BalancePoint; width: number; dash?: string }> = [
    { key: "cash", label: "Cash", color: C[2], width: 1.5 },
    { key: "investments", label: "Investments", color: C[4], width: 1.5 },
    { key: "loans", label: "Loans owed", color: C[3], width: 1.5, dashed: true, dash: "6 4" },
    { key: "netWorth", label: "Net worth", color: C[0], width: 2.75 },
    ...(hasCompare ? [{ key: "compare" as const, label: compareLabel!, color: "#71717a", width: 2, dashed: true, dash: "2 4" }] : []),
  ];
  const shownKeys = series.filter((s) => !hidden.has(s.key)).map((s) => s.key);
  const prepared = prepareTimeSeries(points, {
    dateKey: "date",
    // The axis fits the lines shown; with nothing shown, fall back to all.
    valueKeys: shownKeys.length ? shownKeys : series.map((s) => s.key),
    // Start at 0 unless a shown line goes below zero.
    clampZeroFloor: true,
  });
  const spansZero = prepared.domain[0] < 0 && prepared.domain[1] > 0;
  const { marks, key: markerKey } = numberMarkers(markers, prepared.data);
  return (
    <div>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={prepared.data} margin={{ top: 18, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={24} />
          <YAxis domain={prepared.domain} tickFormatter={(v) => formatCompactNumber(Number(v))} tick={{ fontSize: 11 }} width={48} />
          <Tooltip formatter={(v) => formatCurrency(Number(v), currency)} />
          {spansZero && <ReferenceLine y={0} stroke="currentColor" strokeOpacity={0.35} />}
          {marks.map((m) => (
            <ReferenceLine
              key={m.at}
              x={m.at}
              stroke="var(--color-primary, #f59e0b)"
              strokeDasharray="3 4"
              strokeOpacity={0.7}
              label={{ value: m.numbers.join(","), position: "top", fontSize: 11, fontWeight: 600, fill: "var(--color-primary, #f59e0b)", offset: 4 }}
            />
          ))}
          {/* Net worth last so it draws on top. */}
          {[...series].sort((a, b) => (a.key === "netWorth" ? 1 : b.key === "netWorth" ? -1 : 0)).map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={s.color}
              strokeWidth={s.width}
              strokeDasharray={s.dash}
              dot={false}
              hide={hidden.has(s.key)}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <SeriesLegend items={series} hidden={hidden} onToggle={toggle} />
      {markerKey.length > 0 && (
        <ol aria-label="Events on the chart" className="mt-1 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {markerKey.map((k) => (
            <li key={k.n} className="flex items-center gap-1.5">
              <span className="font-semibold text-primary">{k.n}</span>
              <span>{k.text}</span>
              <span className="opacity-70">({k.at})</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function CashFlowChart({ points, currency, height = 300 }: { points: FlowPoint[]; currency: string; height?: number }) {
  const { hidden, toggle } = useHidden();
  const items: LegendItem[] = [
    { key: "income", label: "Income", color: C[2], bar: true },
    { key: "spending", label: "Spending", color: C[3], bar: true },
    { key: "debt", label: "Debt payments", color: C[1], bar: true },
  ];
  return (
    <div>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={points} margin={{ top: 18, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={16} />
          <YAxis tickFormatter={(v) => formatCompactNumber(Number(v))} tick={{ fontSize: 11 }} width={48} />
          <Tooltip formatter={(v) => formatCurrency(Number(v), currency)} />
          <Bar dataKey="income" name="Income" fill={C[2]} hide={hidden.has("income")} />
          {/* Money out as one bar: spending with debt payments stacked on top. */}
          <Bar dataKey="spending" name="Spending" stackId="out" fill={C[3]} hide={hidden.has("spending")} />
          <Bar dataKey="debt" name="Debt payments" stackId="out" fill={C[1]} hide={hidden.has("debt")} />
        </BarChart>
      </ResponsiveContainer>
      <SeriesLegend items={items} hidden={hidden} onToggle={toggle} />
    </div>
  );
}
