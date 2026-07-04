"use client";

/**
 * NetWorthHistoryChart — accurate daily "Net Worth Over Time" (dashboard) and
 * per-account "Balance Over Time" (account detail).
 *
 * Reads /api/net-worth-history (cash computed live from transactions +
 * investments from stored snapshots, latest point = live holdings so it
 * matches the dashboard hero). Period picker (6M / 1Y / ALL) mirrors the
 * PerformanceChart pattern; the area-chart markup reuses NetWorthChart's
 * gradient + axes.
 *
 * plan/net-worth-over-time.md Part A.
 */

import { useEffect, useMemo, useState } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/currency";
import { formatCompactNumber } from "@/lib/utils/number";
import { RebuildSnapshotsButton } from "@/components/portfolio/rebuild-snapshots-button";
import { prepareTimeSeries } from "@/lib/chart-series";
import { TooltipBreakdownList, type BreakdownRow } from "@/components/chart-breakdown-list";
import { StackedAreaTooltip } from "@/components/chart-stack-tooltip";
import { buildStackedSeries, type StackPoint } from "@/lib/chart-stack";
import { StackedChartLegend } from "@/components/chart-stack-legend";
import type { BreakdownMember } from "@/lib/chart-breakdown";

type Period = "6m" | "1y" | "all";

interface NetWorthPoint {
  date: string;
  value: number;
  /** Per-account top-10 (+ "Other") breakdown, pre-ranked by the API (FINLYNQ-128). */
  breakdown?: BreakdownRow[];
  /** FULL per-account members (with ids) for the stacked "By account" view (FINLYNQ-129). */
  members?: BreakdownMember[];
}

interface ApiResponse {
  displayCurrency: string;
  period: Period;
  accountId: number | null;
  series: NetWorthPoint[];
  hasInvestmentData: boolean;
  fxApproximation: boolean;
}

const PERIODS: { key: Period; label: string }[] = [
  { key: "6m", label: "6M" },
  { key: "1y", label: "1Y" },
  { key: "all", label: "ALL" },
];

function fmtTick(d: string, period: Period): string {
  const dt = new Date(`${d}T00:00:00Z`);
  return dt.toLocaleDateString(
    "en-US",
    period === "all"
      ? { month: "short", year: "2-digit", timeZone: "UTC" }
      : { month: "short", day: "numeric", timeZone: "UTC" },
  );
}

function fmtFullDate(d: string): string {
  const dt = new Date(`${d}T00:00:00Z`);
  return dt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function HistoryTooltip({
  active,
  payload,
  label,
  currency,
  accountScoped,
}: {
  active?: boolean;
  payload?: { value: number; payload?: NetWorthPoint }[];
  label?: string;
  currency: string;
  /** True for a single-account "Balance Over Time" chart — hide the (redundant) per-account breakdown. */
  accountScoped?: boolean;
}) {
  if (!active || !payload?.length) return null;
  const breakdown = accountScoped ? undefined : payload[0].payload?.breakdown;
  return (
    <div className="rounded-xl border border-border/50 bg-card/95 backdrop-blur-sm px-3.5 py-2.5 shadow-lg max-w-[260px]">
      <p className="text-[11px] font-medium text-muted-foreground mb-1">
        {label ? fmtFullDate(label) : ""}
      </p>
      <p className="text-sm font-semibold tabular-nums">
        {formatCurrency(Number(payload[0].value), currency)}
      </p>
      <TooltipBreakdownList rows={breakdown} currency={currency} heading="By account" />
    </div>
  );
}

export interface NetWorthHistoryChartProps {
  /** Restrict to one account; null/undefined = whole net worth. */
  accountId?: number | null;
  title?: string;
}

export function NetWorthHistoryChart({
  accountId,
  title = "Net Worth Over Time",
}: NetWorthHistoryChartProps) {
  const [period, setPeriod] = useState<Period>("6m");
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // FINLYNQ-129 — component-only stacked-member toggle (resets on reload). The
  // per-account "By account" stack is hidden for single-account (balance) charts.
  const [stacked, setStacked] = useState(false);
  const stackable = accountId == null;

  function load() {
    const params = new URLSearchParams();
    params.set("period", period);
    if (accountId != null) params.set("accountId", String(accountId));
    setLoading(true);
    setError(false);
    fetch(`/api/net-worth-history?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("request failed"))))
      .then((json: ApiResponse) => setData(json))
      .catch(() => {
        setData(null);
        setError(true);
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, accountId]);

  const currency = data?.displayCurrency ?? "CAD";
  const rawSeries = useMemo(() => data?.series ?? [], [data]);
  const { data: series, domain, spansZero } = useMemo(
    () =>
      prepareTimeSeries(rawSeries, {
        dateKey: "date",
        valueKeys: ["value"],
        maxPoints: 200,
      }),
    [rawSeries],
  );
  const hasAnyValue = useMemo(() => series.some((p) => p.value !== 0), [series]);

  // FINLYNQ-129 — build the per-account stacked series from the SAME downsampled
  // points the aggregate chart plots, so toggling never shifts the X grid. The
  // outer stack boundary equals `value` at every point (residual = total − top10).
  const { rows: stackedRows, legend } = useMemo(
    () =>
      buildStackedSeries(
        series.map(
          (p): StackPoint => ({
            date: p.date,
            total: p.value,
            members: p.members ?? [],
          }),
        ),
        // FINLYNQ-187 — sign-split so liability accounts (negative per-account
        // contribution) stack BELOW the zero axis; the reconciled net (top of
        // positive stack − bottom of negative stack) still equals `value`.
        { maxMembers: 10, signSplit: true },
      ),
    [series],
  );
  const showStacked = stackable && stacked && legend.length > 0;

  return (
    <Card className="card-hover">
      <CardHeader className="pb-1 px-5 pt-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-sm font-semibold">{title}</CardTitle>
            <p className="text-[11px] text-muted-foreground">{currency}</p>
          </div>
          <div className="flex items-center gap-1">
            {stackable && (
              <Button
                size="sm"
                variant={stacked ? "default" : "outline"}
                onClick={() => setStacked((s) => !s)}
                title="Break the total into a stacked top-10 view by account"
              >
                By account
              </Button>
            )}
            {PERIODS.map((p) => (
              <Button
                key={p.key}
                size="sm"
                variant={period === p.key ? "default" : "outline"}
                onClick={() => setPeriod(p.key)}
              >
                {p.label}
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-5 pb-5">
        {loading ? (
          <p className="text-sm text-muted-foreground py-16 text-center">Loading…</p>
        ) : error || !data ? (
          <p className="text-sm text-muted-foreground py-16 text-center">
            Could not load history. Try again shortly.
          </p>
        ) : !hasAnyValue ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <p className="text-sm text-muted-foreground max-w-sm">
              No history to chart yet. Add accounts and transactions to see your
              {accountId != null ? " balance" : " net worth"} over time. If the
              chart looks stale or flat, rebuild your balance history.
            </p>
            <RebuildSnapshotsButton onDone={load} />
          </div>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={260}>
              {showStacked ? (
                <AreaChart data={stackedRows} margin={{ top: 8, right: 4, bottom: 0, left: -10 }}>
                  <XAxis
                    dataKey="date"
                    fontSize={10}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={48}
                    interval="preserveStartEnd"
                    tickFormatter={(d) => fmtTick(String(d), period)}
                    tick={{ fill: "var(--color-muted-foreground)" }}
                  />
                  <YAxis
                    fontSize={10}
                    tickLine={false}
                    axisLine={false}
                    width={48}
                    tick={{ fill: "var(--color-muted-foreground)" }}
                    tickFormatter={(v) => formatCompactNumber(Number(v))}
                  />
                  <Tooltip
                    content={
                      // FINLYNQ-192 — unified stacked-area tooltip: one row per
                      // account with a colored dot matching its band + legend
                      // color, full (untruncated) names, and a date + total
                      // heading. Replaces the recharts-default `Name : value` text.
                      <StackedAreaTooltip
                        currency={currency}
                        legend={legend}
                        formatLabel={(d) => fmtFullDate(String(d))}
                        showTotal
                        wide
                      />
                    }
                    cursor={{ stroke: "var(--color-border)", strokeDasharray: "4 4" }}
                  />
                  {/* FINLYNQ-187 sign-split puts liability accounts below the
                      axis, so a stacked "By account" view spans zero whenever
                      liabilities exist — always draw a visible zero line. */}
                  <ReferenceLine y={0} stroke="#888" />
                  {legend.map((b) => (
                    <Area
                      key={b.key}
                      type="monotone"
                      dataKey={b.key}
                      name={b.name}
                      // FINLYNQ-187 — per-band stackId from the sign-split:
                      // positive→above-axis, negative→below-axis. Falls back to
                      // the single "nw" stack if sign-split were ever disabled.
                      stackId={b.stackId ?? "nw"}
                      stroke={b.color}
                      strokeWidth={1}
                      fill={b.color}
                      // FINLYNQ-192 — raise fill opacity so adjacent bands read
                      // as more solid/distinct (paired with the wider palette).
                      fillOpacity={0.7}
                      dot={false}
                      isAnimationActive={false}
                    />
                  ))}
                </AreaChart>
              ) : (
              <AreaChart data={series} margin={{ top: 8, right: 4, bottom: 0, left: -10 }}>
                <defs>
                  <linearGradient id="nwHistGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#6366f1" stopOpacity={0.25} />
                    <stop offset="50%" stopColor="#6366f1" stopOpacity={0.08} />
                    <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="date"
                  fontSize={10}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={48}
                  interval="preserveStartEnd"
                  tickFormatter={(d) => fmtTick(String(d), period)}
                  tick={{ fill: "var(--color-muted-foreground)" }}
                />
                <YAxis
                  fontSize={10}
                  tickLine={false}
                  axisLine={false}
                  width={48}
                  tick={{ fill: "var(--color-muted-foreground)" }}
                  tickFormatter={(v) => formatCompactNumber(Number(v))}
                  domain={domain}
                />
                <Tooltip
                  content={
                    <HistoryTooltip currency={currency} accountScoped={accountId != null} />
                  }
                  cursor={{ stroke: "var(--color-border)", strokeDasharray: "4 4" }}
                />
                {/* FINLYNQ-192 — visible zero line when the (single-line) series
                    crosses zero (e.g. a liability account's Balance Over Time, or
                    a net worth that dips negative). Mirrors PerformanceChart. */}
                {spansZero && <ReferenceLine y={0} stroke="#888" />}
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke="#6366f1"
                  strokeWidth={2.5}
                  fill="url(#nwHistGradient)"
                  name={accountId != null ? "Balance" : "Net Worth"}
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, fill: "var(--color-card)" }}
                />
              </AreaChart>
              )}
            </ResponsiveContainer>
            {showStacked && <StackedChartLegend legend={legend} />}
            {!data.hasInvestmentData && accountId == null && (
              <p className="text-[11px] text-muted-foreground mt-2">
                Cash &amp; liabilities only — no investment snapshots found.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
