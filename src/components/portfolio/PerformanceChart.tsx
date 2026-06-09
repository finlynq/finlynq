"use client";

/**
 * PerformanceChart — Phase 3 of plan/portfolio-lots-and-performance.md.
 *
 * Reads /api/portfolio/performance and renders a Recharts line chart of
 * market_value over time, with TWRR / MWRR shown in the header. Period
 * picker drives the query; account picker is the caller's
 * responsibility (this component takes `accountId` as a prop).
 *
 * Empty-state messages distinguish "no snapshots yet" (cron hasn't
 * run / backfill not done) from "no data in this range".
 */

import { useEffect, useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/currency";
import { prepareTimeSeries } from "@/lib/chart-series";

type Period = "1m" | "3m" | "6m" | "ytd" | "1y" | "all";

interface SeriesPoint {
  date: string;
  marketValue: number;
  costBasis: number;
  contribution: number;
  gapsFilled: boolean;
}

interface ApiResponse {
  success: boolean;
  data: {
    period: Period;
    accountId: number | null;
    from: string;
    to: string;
    currency: string;
    series: SeriesPoint[];
    twrr: { period: number; annualized: number; hadContributions: boolean };
    mwrr: { irr: number; converged: boolean };
    gapsFilledDays: number;
  };
}

const PERIODS: Period[] = ["1m", "3m", "6m", "ytd", "1y", "all"];

export interface PerformanceChartProps {
  /** Restrict the chart to one account; null/undefined = whole portfolio aggregate. */
  accountId?: number | null;
}

export function PerformanceChart({ accountId }: PerformanceChartProps) {
  const [period, setPeriod] = useState<Period>("1y");
  const [data, setData] = useState<ApiResponse["data"] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const params = new URLSearchParams();
    params.set("period", period);
    if (accountId != null) params.set("accountId", String(accountId));
    setLoading(true);
    fetch(`/api/portfolio/performance?${params.toString()}`)
      .then((r) => r.json())
      .then((json: ApiResponse) => {
        if (json.success) setData(json.data);
        else setData(null);
      })
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [period, accountId]);

  const fmtPct = (v: number) => `${(v * 100).toFixed(2)}%`;

  const rawChartData = useMemo(() => data?.series ?? [], [data]);
  const { data: chartData, domain, spansZero } = useMemo(
    () =>
      prepareTimeSeries(rawChartData, {
        dateKey: "date",
        // contribution is not plotted — exclude from domain computation
        valueKeys: ["marketValue", "costBasis"],
        maxPoints: 200,
      }),
    [rawChartData],
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Performance</CardTitle>
          <div className="flex gap-1">
            {PERIODS.map((p) => (
              <Button
                key={p}
                size="sm"
                variant={period === p ? "default" : "outline"}
                onClick={() => setPeriod(p)}
              >
                {p.toUpperCase()}
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !data || chartData.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No snapshots yet. The nightly cron starts populating data on first run;
            for historical fill, run scripts/backfill-portfolio-snapshots.ts.
          </p>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap gap-3">
              <Badge variant="default" className="px-3 py-1">
                TWRR (period): {fmtPct(data.twrr.period)}
              </Badge>
              <Badge variant="secondary" className="px-3 py-1">
                TWRR (annualized): {fmtPct(data.twrr.annualized)}
              </Badge>
              {data.mwrr.converged && (
                <Badge variant="secondary" className="px-3 py-1">
                  MWRR (XIRR): {fmtPct(data.mwrr.irr)}
                </Badge>
              )}
              {data.gapsFilledDays > 0 && (
                <Badge variant="destructive" className="px-3 py-1">
                  Incomplete history: {data.gapsFilledDays} day{data.gapsFilledDays === 1 ? "" : "s"} filled
                </Badge>
              )}
            </div>
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData}>
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    tickFormatter={(v) => formatCurrency(Number(v), data.currency)}
                    domain={domain}
                  />
                  <Tooltip
                    formatter={(v) => formatCurrency(Number(v), data.currency)}
                  />
                  {spansZero && <ReferenceLine y={0} stroke="#888" />}
                  <Line
                    type="monotone"
                    dataKey="marketValue"
                    stroke="#06b6d4"
                    strokeWidth={2}
                    dot={false}
                    name="Market value"
                  />
                  <Line
                    type="monotone"
                    dataKey="costBasis"
                    stroke="#94a3b8"
                    strokeWidth={1}
                    strokeDasharray="3 3"
                    dot={false}
                    name="Cost basis"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
