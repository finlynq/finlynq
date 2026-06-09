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
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/currency";
import { RebuildSnapshotsButton } from "@/components/portfolio/rebuild-snapshots-button";
import { prepareTimeSeries } from "@/lib/chart-series";

type Period = "6m" | "1y" | "all";

interface NetWorthPoint {
  date: string;
  value: number;
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

function fmtAxis(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1000) return `${(v / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
  return `${Math.round(v)}`;
}

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
}: {
  active?: boolean;
  payload?: { value: number }[];
  label?: string;
  currency: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-border/50 bg-card/95 backdrop-blur-sm px-3.5 py-2.5 shadow-lg">
      <p className="text-[11px] font-medium text-muted-foreground mb-1">
        {label ? fmtFullDate(label) : ""}
      </p>
      <p className="text-sm font-semibold tabular-nums">
        {formatCurrency(Number(payload[0].value), currency)}
      </p>
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
  const { data: series, domain } = useMemo(
    () =>
      prepareTimeSeries(rawSeries, {
        dateKey: "date",
        valueKeys: ["value"],
        maxPoints: 200,
      }),
    [rawSeries],
  );
  const hasAnyValue = useMemo(() => series.some((p) => p.value !== 0), [series]);

  return (
    <Card className="card-hover">
      <CardHeader className="pb-1 px-5 pt-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-sm font-semibold">{title}</CardTitle>
            <p className="text-[11px] text-muted-foreground">
              {currency} · current-rate FX
            </p>
          </div>
          <div className="flex gap-1">
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
              {accountId != null ? " balance" : " net worth"} over time. If you have
              investments but the line is flat, rebuild your investment history.
            </p>
            <RebuildSnapshotsButton onDone={load} />
          </div>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={260}>
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
                  tickFormatter={(v) => fmtAxis(Number(v))}
                  domain={domain}
                />
                <Tooltip
                  content={<HistoryTooltip currency={currency} />}
                  cursor={{ stroke: "var(--color-border)", strokeDasharray: "4 4" }}
                />
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
            </ResponsiveContainer>
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
