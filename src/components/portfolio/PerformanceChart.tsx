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
 *
 * 2026-10-14: TWRR / XIRR now strip out new money (deposits, withdrawals,
 * transfers, plan contributions booked as reinvested income…), computed by
 * the shared lib/portfolio/performance/returns.ts; the header shows how much
 * was excluded. A Value & cost / Value / Cost switch picks the lines drawn,
 * and the Y axis fits only those, so "Value" shows how the balance moved.
 */

import { useEffect, useMemo, useState } from "react";
import {
  LineChart,
  Line,
  AreaChart,
  Area,
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
import { formatCompactNumber } from "@/lib/utils/number";
import { prepareTimeSeries } from "@/lib/chart-series";
import {
  buildStackedSeries,
  type StackPoint,
} from "@/lib/chart-stack";
import { StackedChartLegend } from "@/components/chart-stack-legend";
import { StackedAreaTooltip } from "@/components/chart-stack-tooltip";

type Period = "1m" | "3m" | "6m" | "ytd" | "1y" | "all";
/** Which value lines the (unstacked) chart draws. */
type Lines = "both" | "value" | "cost";
const LINE_OPTIONS: { key: Lines; label: string; title: string }[] = [
  { key: "both", label: "Value & cost", title: "Market value and cost basis" },
  { key: "value", label: "Value", title: "Market value only: how the balance moved" },
  { key: "cost", label: "Cost", title: "Cost basis only: what was put in, at cost" },
];
/** FINLYNQ-172 — stacked grouping mode (was a boolean in FINLYNQ-129). */
type GroupMode = "off" | "holding" | "account";

interface SeriesPoint {
  date: string;
  marketValue: number;
  costBasis: number;
  contribution: number;
  gapsFilled: boolean;
}

/** One sampled grid point of per-holding market value (FINLYNQ-129). */
interface HoldingsPoint {
  date: string;
  total: number;
  members: { id: number; name: string; value: number }[];
}

interface HoldingsApiResponse {
  success: boolean;
  data?: { currency: string; points: HoldingsPoint[] };
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
    /** New money over the period (+ in, − out), excluded from both returns. */
    netNewMoney?: number;
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
  const [lines, setLines] = useState<Lines>("both");
  const [data, setData] = useState<ApiResponse["data"] | null>(null);
  const [loading, setLoading] = useState(true);
  // FINLYNQ-129/172 — component-only stacked grouping toggle (resets on reload).
  // "holding" = per-holding bands, "account" = per-account bands; both pull from
  // the SAME lazily-fetched endpoint (prices+FX per holding per grid day) via the
  // groupBy param, so only load it once the user opts into a stacked mode.
  const [groupMode, setGroupMode] = useState<GroupMode>("off");
  const [holdings, setHoldings] = useState<{ currency: string; points: HoldingsPoint[] } | null>(null);
  const [holdingsLoading, setHoldingsLoading] = useState(false);
  // "By account" is meaningless when the chart is already scoped to one account
  // (it'd be a single band) — only offer it for the whole-portfolio aggregate (tc-4).
  const canGroupByAccount = accountId == null;

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

  // If the chart re-scopes to a single account while "By account" is active,
  // that mode no longer makes sense (one band) — fall back to "off" (tc-4).
  useEffect(() => {
    if (!canGroupByAccount && groupMode === "account") setGroupMode("off");
  }, [canGroupByAccount, groupMode]);

  // Lazy member fetch — only when a stacked mode is on. Re-fetches on
  // mode/period/account change so the stack re-ranks (and re-groups) for the
  // new window. groupBy selects per-holding vs per-account bands (FINLYNQ-172).
  useEffect(() => {
    if (groupMode === "off") return;
    const params = new URLSearchParams();
    params.set("period", period);
    params.set("groupBy", groupMode);
    if (accountId != null) params.set("accountId", String(accountId));
    setHoldingsLoading(true);
    fetch(`/api/portfolio/performance/holdings?${params.toString()}`)
      .then((r) => r.json())
      .then((json: HoldingsApiResponse) => {
        if (json.success && json.data) setHoldings(json.data);
        else setHoldings(null);
      })
      .catch(() => setHoldings(null))
      .finally(() => setHoldingsLoading(false));
  }, [groupMode, period, accountId]);

  const fmtPct = (v: number) => `${(v * 100).toFixed(2)}%`;

  const rawChartData = useMemo(() => data?.series ?? [], [data]);
  const { data: chartData, domain, spansZero } = useMemo(
    () =>
      prepareTimeSeries(rawChartData, {
        dateKey: "date",
        // contribution is not plotted — exclude from domain computation; the
        // axis fits only the lines shown.
        valueKeys:
          lines === "value" ? ["marketValue"] : lines === "cost" ? ["costBasis"] : ["marketValue", "costBasis"],
        maxPoints: 200,
      }),
    [rawChartData, lines],
  );

  const stackCurrency = holdings?.currency ?? data?.currency ?? "USD";
  const { rows: stackedRows, legend } = useMemo(
    () =>
      buildStackedSeries(
        (holdings?.points ?? []).map(
          (p): StackPoint => ({ date: p.date, total: p.total, members: p.members }),
        ),
        { maxMembers: 10 },
      ),
    [holdings],
  );
  const stacked = groupMode !== "off";
  const showStacked = stacked && legend.length > 0;
  const axisGroupLabel = groupMode === "account" ? "account" : "holding";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Performance</CardTitle>
          <div className="flex flex-wrap items-center gap-1">
            <Button
              size="sm"
              variant={groupMode === "holding" ? "default" : "outline"}
              onClick={() => setGroupMode((m) => (m === "holding" ? "off" : "holding"))}
              title="Stack per-holding market value (dollar axis)"
            >
              By holding (value)
            </Button>
            {canGroupByAccount && (
              <Button
                size="sm"
                variant={groupMode === "account" ? "default" : "outline"}
                onClick={() => setGroupMode((m) => (m === "account" ? "off" : "account"))}
                title="Stack per-account market value (dollar axis)"
              >
                By account
              </Button>
            )}
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
              {data.netNewMoney != null && Math.abs(data.netNewMoney) >= 0.5 && (
                <Badge
                  variant="outline"
                  className="px-3 py-1"
                  title="Money put in or taken out in this period (deposits, withdrawals, transfers, plan contributions). It is not counted as return."
                >
                  Net new money: {data.netNewMoney > 0 ? "+" : ""}
                  {formatCurrency(data.netNewMoney, data.currency)}
                </Badge>
              )}
              {data.gapsFilledDays > 0 && (
                <Badge variant="destructive" className="px-3 py-1">
                  Incomplete history: {data.gapsFilledDays} day{data.gapsFilledDays === 1 ? "" : "s"} filled
                </Badge>
              )}
            </div>
            {/* Axis-unit label — flips from the TWRR/value line to a per-holding
                dollar stack in stacked mode (tc-2: "y-axis switches to $"). */}
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] text-muted-foreground">
                {showStacked
                  ? `Market value by ${axisGroupLabel} (${stackCurrency})`
                  : `${lines === "cost" ? "Cost basis" : lines === "value" ? "Market value" : "Market value and cost basis"} (${data.currency})`}
              </p>
              {!showStacked && (
                <div className="flex items-center gap-1" role="group" aria-label="Lines shown">
                  {LINE_OPTIONS.map((o) => (
                    <Button
                      key={o.key}
                      size="sm"
                      variant={lines === o.key ? "default" : "outline"}
                      className="h-6 px-2 text-[11px]"
                      title={o.title}
                      aria-pressed={lines === o.key}
                      onClick={() => setLines(o.key)}
                    >
                      {o.label}
                    </Button>
                  ))}
                </div>
              )}
            </div>
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                {showStacked ? (
                  <AreaChart data={stackedRows}>
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis
                      tick={{ fontSize: 11 }}
                      tickFormatter={(v) => formatCompactNumber(Number(v))}
                    />
                    <Tooltip
                      content={
                        // Shared stacked-area tooltip (FINLYNQ-192) — colored dot
                        // per band, full names, rows mirror the visual stack.
                        <StackedAreaTooltip currency={stackCurrency} legend={legend} wide />
                      }
                    />
                    {legend.map((b) => (
                      <Area
                        key={b.key}
                        type="monotone"
                        dataKey={b.key}
                        name={b.name}
                        stackId="perf"
                        stroke={b.color}
                        strokeWidth={1}
                        fill={b.color}
                        fillOpacity={0.55}
                        dot={false}
                        isAnimationActive={false}
                      />
                    ))}
                  </AreaChart>
                ) : (
                  <LineChart data={chartData}>
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis
                      tick={{ fontSize: 11 }}
                      tickFormatter={(v) => formatCompactNumber(Number(v))}
                      domain={domain}
                    />
                    <Tooltip
                      formatter={(v) => formatCurrency(Number(v), data.currency)}
                    />
                    {spansZero && <ReferenceLine y={0} stroke="#888" />}
                    {lines !== "cost" && (
                      <Line
                        type="monotone"
                        dataKey="marketValue"
                        stroke="#06b6d4"
                        strokeWidth={2}
                        dot={false}
                        name="Market value"
                      />
                    )}
                    {lines !== "value" && (
                      <Line
                        type="monotone"
                        dataKey="costBasis"
                        stroke="#94a3b8"
                        strokeWidth={lines === "cost" ? 2 : 1}
                        strokeDasharray={lines === "cost" ? undefined : "3 3"}
                        dot={false}
                        name="Cost basis"
                      />
                    )}
                  </LineChart>
                )}
              </ResponsiveContainer>
            </div>
            {stacked && holdingsLoading && (
              <p className="text-xs text-muted-foreground mt-2">Loading per-holding values…</p>
            )}
            {stacked && !holdingsLoading && legend.length === 0 && (
              <p className="text-xs text-muted-foreground mt-2">
                No per-holding values to stack for this range.
              </p>
            )}
            {showStacked && <StackedChartLegend legend={legend} />}
          </>
        )}
      </CardContent>
    </Card>
  );
}
