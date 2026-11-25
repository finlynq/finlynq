"use client";

/**
 * /forecast — Forecast, Phase 1 (plan/forecast-scenarios.md).
 *
 * One request loads a snapshot of your real data plus the Baseline result;
 * every change on the page (horizon, assumptions, layers) re-runs the same
 * pure engine in the browser, so there is no Recalculate button and nothing
 * is stored. Lines with no budget stay blank (owner decision 2026-11-25).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErrorState } from "@/components/error-state";
import { PageSkeleton } from "@/components/page-skeleton";
import { formatCurrency } from "@/lib/currency";
import { runForecast, yearlyView } from "@/lib/forecast/engine";
import { traceCell } from "@/lib/forecast/layers";
import { HORIZON_CHOICES, scenarioConfigSchema, type ScenarioConfig } from "@/lib/forecast/config";
import type { ForecastInputs, ForecastResult } from "@/lib/forecast/types";
import { BalancesChart, CashFlowChart, type BalancePoint, type FlowPoint } from "./_components/forecast-charts";
import { ForecastTable, type TableModel } from "./_components/forecast-table";
import { AlertTriangle, Info, RefreshCw } from "lucide-react";

type RunResponse = { inputs: ForecastInputs; scenario: ScenarioConfig; result: ForecastResult };

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (ym: string) => `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;
const monthLong = (ym: string) => `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

function horizonLabel(months: number) {
  return months % 12 === 0 ? `${months / 12} year${months === 12 ? "" : "s"}` : `${months} months`;
}

export default function ForecastPage() {
  const [data, setData] = useState<RunResponse | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<ScenarioConfig | null>(null);
  const [view, setView] = useState<"monthly" | "yearly">("yearly");
  const [real, setReal] = useState(false);
  const [selected, setSelected] = useState<{ key: string; column: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch("/api/forecast/run");
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { data: RunResponse };
      setData(body.data);
      setConfig((c) => c ?? body.data.scenario);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The engine runs here, on every change (milliseconds).
  const result = useMemo(() => (data && config ? runForecast(data.inputs, config) : null), [data, config]);

  const update = (patch: Partial<ScenarioConfig>) => {
    if (!config) return;
    const next = scenarioConfigSchema.safeParse({ ...config, ...patch });
    if (next.success) setConfig(next.data);
  };
  const setLayerEnabled = (id: string, enabled: boolean) =>
    config && update({ layers: config.layers.map((l) => (l.id === id ? { ...l, enabled } : l)) });
  const setAssumption = (k: keyof ScenarioConfig["assumptions"], raw: string) => {
    if (!config) return;
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    update({ assumptions: { ...config.assumptions, [k]: v } });
  };

  const model = useMemo((): { table: TableModel; balances: BalancePoint[]; flows: FlowPoint[] } | null => {
    if (!result) return null;
    const adj = (arr: number[], defl: number[]) => (real ? arr.map((v, i) => v / defl[i]) : arr);
    const adjN = (arr: Array<number | null>, defl: number[]) => (real ? arr.map((v, i) => (v == null ? v : v / defl[i])) : arr);
    if (view === "yearly") {
      const y = yearlyView(result);
      const d = y.deflator;
      return {
        table: {
          columns: y.years,
          columnLabels: y.years,
          lines: y.lines.map((l) => ({ ...l, amounts: adjN(l.amounts, d) })),
          totals: { income: adj(y.totals.income, d), expense: adj(y.totals.expense, d), debtPayment: adj(y.totals.debtPayment, d), net: adj(y.totals.net, d) },
          balances: { cash: adj(y.balances.cash, d), investments: adj(y.balances.investments, d), loans: adj(y.balances.loans, d), netWorth: adj(y.balances.netWorth, d) },
        },
        balances: y.years.map((yr, i) => ({
          date: `${yr}-12-01`, label: yr,
          netWorth: adj(y.balances.netWorth, d)[i], cash: adj(y.balances.cash, d)[i],
          investments: adj(y.balances.investments, d)[i], loans: adj(y.balances.loans, d)[i],
        })),
        flows: y.years.map((yr, i) => ({
          label: yr, income: adj(y.totals.income, d)[i], spending: adj(y.totals.expense, d)[i], debt: adj(y.totals.debtPayment, d)[i],
        })),
      };
    }
    const d = result.deflator;
    const b = result.balances;
    return {
      table: {
        columns: result.months,
        columnLabels: result.months.map(monthLabel),
        lines: result.lines.map((l) => ({ ...l, amounts: adjN(l.amounts, d) })),
        totals: { income: adj(result.totals.income, d), expense: adj(result.totals.expense, d), debtPayment: adj(result.totals.debtPayment, d), net: adj(result.totals.net, d) },
        balances: { cash: adj(b.cash, d), investments: adj(b.investments, d), loans: adj(b.loans, d), netWorth: adj(b.netWorth, d) },
      },
      balances: result.months.map((m, i) => ({
        date: `${m}-01`, label: monthLabel(m),
        netWorth: adj(b.netWorth, d)[i], cash: adj(b.cash, d)[i], investments: adj(b.investments, d)[i], loans: adj(b.loans, d)[i],
      })),
      flows: result.months.map((m, i) => ({
        label: monthLabel(m), income: adj(result.totals.income, d)[i], spending: adj(result.totals.expense, d)[i], debt: adj(result.totals.debtPayment, d)[i],
      })),
    };
  }, [result, view, real]);

  const trace = useMemo(() => {
    if (!selected || !data || !config || view !== "monthly") return null;
    const line = data.inputs.lines.find((l) => l.key === selected.key);
    return { label: line?.label ?? selected.key, month: selected.column, steps: traceCell(data.inputs, config, selected.key, selected.column) };
  }, [selected, data, config, view]);

  if (loading && !data) return <PageSkeleton variant="table" rows={8} />;
  if (error && !data) return <ErrorState message="We couldn't build your forecast. Please try again." onRetry={load} />;
  if (!data || !config || !result || !model) return null;

  const cur = result.currency;
  const last = result.months.length - 1;
  const endNW = real ? result.balances.netWorth[last] / result.deflator[last] : result.balances.netWorth[last];
  const minCashIdx = result.balances.cash.reduce((mi, v, i, a) => (v < a[mi] ? i : mi), 0);
  const debtFree = result.milestones.find((m) => m.kind === "debt_free");
  const runsOut = result.milestones.find((m) => m.kind === "cash_negative" || m.kind === "investments_depleted");
  const budgetLayer = config.layers.find((l) => l.kind === "budget");
  const inflationLayer = config.layers.find((l) => l.kind === "growth");
  const blankIncome = result.blankLines.filter((l) => l.type === "income");
  const blankSpending = result.blankLines.filter((l) => l.type === "expense");

  return (
    <div className="space-y-5 max-w-7xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Forecast</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            From {monthLong(result.startMonth)}, starting from today&apos;s balances. Based on your data as of{" "}
            {new Date(data.inputs.inputsAsOf).toLocaleString()}.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={String(config.horizonMonths)} onValueChange={(v) => update({ horizonMonths: Number(v) })}>
            <SelectTrigger className="h-8 w-32 text-xs" aria-label="Forecast length"><SelectValue /></SelectTrigger>
            <SelectContent>
              {HORIZON_CHOICES.filter((h) => h <= data.inputs.maxHorizonMonths).map((h) => (
                <SelectItem key={h} value={String(h)}>{horizonLabel(h)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={view} onValueChange={(v) => setView(v === "monthly" ? "monthly" : "yearly")}>
            <SelectTrigger className="h-8 w-28 text-xs" aria-label="Table view"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="yearly">By year</SelectItem>
              <SelectItem value="monthly">By month</SelectItem>
            </SelectContent>
          </Select>
          <Select value={real ? "real" : "nominal"} onValueChange={(v) => setReal(v === "real")}>
            <SelectTrigger className="h-8 w-40 text-xs" aria-label="Money shown in"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="nominal">Future money</SelectItem>
              <SelectItem value="real">Today&apos;s money</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" className="h-8" onClick={load} disabled={loading}>
            <RefreshCw className="h-3.5 w-3.5 mr-1" /> Refresh data
          </Button>
        </div>
      </div>

      {/* Milestones */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Card><CardContent className="py-4">
          <p className="text-xs text-muted-foreground">Net worth</p>
          <p className="text-lg font-semibold tabular-nums">{formatCurrency(endNW, cur, { decimals: 0 })}</p>
          <p className="text-xs text-muted-foreground">in {monthLong(result.months[last])} (today {formatCurrency(result.opening.netWorth, cur, { decimals: 0 })})</p>
        </CardContent></Card>
        <Card><CardContent className="py-4">
          <p className="text-xs text-muted-foreground">Lowest cash</p>
          <p className={`text-lg font-semibold tabular-nums ${result.balances.cash[minCashIdx] < 0 ? "text-rose-600" : ""}`}>
            {formatCurrency(result.balances.cash[minCashIdx], cur, { decimals: 0 })}
          </p>
          <p className="text-xs text-muted-foreground">in {monthLong(result.months[minCashIdx])}</p>
        </CardContent></Card>
        <Card><CardContent className="py-4">
          <p className="text-xs text-muted-foreground">Loans</p>
          {result.loans.length === 0 ? (
            <p className="text-lg font-semibold">No loans</p>
          ) : debtFree ? (
            <><p className="text-lg font-semibold">Paid off {monthLong(debtFree.month)}</p>
              <p className="text-xs text-muted-foreground">{formatCurrency(result.loans.reduce((s, l) => s + l.interestTotal, 0), cur, { decimals: 0 })} interest until then</p></>
          ) : (
            <><p className="text-lg font-semibold tabular-nums">{formatCurrency(result.balances.loans[last], cur, { decimals: 0 })} owed</p>
              <p className="text-xs text-muted-foreground">at the end of the forecast</p></>
          )}
        </CardContent></Card>
        <Card><CardContent className="py-4">
          <p className="text-xs text-muted-foreground">Money runs out</p>
          {runsOut ? (
            <><p className="text-lg font-semibold text-rose-600">{monthLong(runsOut.month)}</p>
              <p className="text-xs text-muted-foreground">{runsOut.label}</p></>
          ) : (
            <><p className="text-lg font-semibold">Not in this forecast</p>
              <p className="text-xs text-muted-foreground">cash stays above zero</p></>
          )}
        </CardContent></Card>
      </div>

      {/* Settings */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Layers and assumptions</CardTitle>
          <CardDescription>Changes recalculate straight away. They are not saved yet (saved scenarios come next).</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Layers, applied in order</p>
            {budgetLayer && (
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input type="checkbox" className="mt-0.5" checked={budgetLayer.enabled} onChange={(e) => setLayerEnabled(budgetLayer.id, e.target.checked)} />
                <span><span className="font-medium">Budget</span>: your budgets and budget rules. Lines with no budget stay blank.</span>
              </label>
            )}
            {inflationLayer && (
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input type="checkbox" className="mt-0.5" checked={inflationLayer.enabled} onChange={(e) => setLayerEnabled(inflationLayer.id, e.target.checked)} />
                <span><span className="font-medium">Inflation</span>: grows spending budgets carried past {monthLong(data.inputs.budgetHorizonEnd)}, the end of your budget months. Budgets you typed are never changed.</span>
              </label>
            )}
            <p className="text-xs text-muted-foreground">More layers (your spending history, scheduled payments, manual changes) and events (retire, buy a home) come in the next phases.</p>
          </div>
          <div className="grid grid-cols-2 gap-3 content-start">
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="fc-infl">Inflation, % a year</Label>
              <Input id="fc-infl" type="number" step="0.1" className="h-8" defaultValue={config.assumptions.inflationPct} onBlur={(e) => setAssumption("inflationPct", e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="fc-ret">Investment return, % a year</Label>
              <Input id="fc-ret" type="number" step="0.1" className="h-8" defaultValue={config.assumptions.investmentReturnPct} onBlur={(e) => setAssumption("investmentReturnPct", e.target.value)} />
            </div>
            <div className="space-y-1 col-span-2">
              <Label className="text-xs">If cash goes below zero</Label>
              <Select value={config.shortfall} onValueChange={(v) => update({ shortfall: v === "draw_investments" ? "draw_investments" : "negative" })}>
                <SelectTrigger className="h-8 text-xs" aria-label="If cash goes below zero"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="negative">Let it go negative and warn me</SelectItem>
                  <SelectItem value="draw_investments">Sell investments to cover it</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {(result.warnings.length > 0 || blankIncome.length + blankSpending.length > 0 || data.inputs.leftOut.length > 0) && (
        <div className="space-y-2">
          {result.warnings.map((w, i) => (
            <div key={i} className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" /> {w.message}
            </div>
          ))}
          {blankIncome.length + blankSpending.length > 0 && budgetLayer?.enabled && (
            <div className="flex gap-2 rounded-md border p-3 text-sm text-muted-foreground">
              <Info className="h-4 w-4 shrink-0 mt-0.5" />
              <span>
                {blankIncome.length + blankSpending.length} {blankIncome.length + blankSpending.length === 1 ? "line has" : "lines have"} no budget in this period, so {blankIncome.length + blankSpending.length === 1 ? "it is" : "they are"} blank
                {blankIncome.length > 0 ? ` (including ${blankIncome.length} income)` : ""}. Add budgets on the <Link href="/budgets" className="underline">Budgets page</Link> to include them.
              </span>
            </div>
          )}
          {data.inputs.leftOut.map((l) => (
            <div key={l.key} className="flex gap-2 rounded-md border p-3 text-sm text-muted-foreground">
              <Info className="h-4 w-4 shrink-0 mt-0.5" /> <span><span className="font-medium">{l.label}</span>: {l.reason}</span>
            </div>
          ))}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-base">Balances</CardTitle><CardDescription>Net worth, cash, investments and loans owed{real ? ", in today's money" : ""}</CardDescription></CardHeader>
          <CardContent><BalancesChart points={model.balances} currency={cur} /></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-base">Cash flow</CardTitle><CardDescription>Income, spending and debt payments {view === "yearly" ? "per year" : "per month"}</CardDescription></CardHeader>
          <CardContent><CashFlowChart points={model.flows} currency={cur} /></CardContent>
        </Card>
      </div>

      <ForecastTable
        model={model.table}
        currency={cur}
        selected={view === "monthly" ? selected : null}
        onSelect={view === "monthly" ? (key, column) => setSelected({ key, column }) : null}
      />
      <p className="text-xs text-muted-foreground">
        {view === "monthly" ? "Click an income or spending amount to see how it was worked out. " : "Switch to By month to see how an amount was worked out. "}
        Loan payments come from each loan&apos;s schedule; their interest is inside the payment, not a separate expense. Card balances are assumed paid in full each month. Taxes are not modelled: enter income as take-home pay.
      </p>

      {trace && (
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-base">{trace.label}, {monthLong(trace.month)}</CardTitle></CardHeader>
          <CardContent>
            {trace.steps.length === 0 ? (
              <p className="text-sm text-muted-foreground">No layer applies to this line.</p>
            ) : (
              <ol className="space-y-1 text-sm">
                {trace.steps.map((s, i) => (
                  <li key={i} className="flex flex-wrap gap-x-2">
                    <span className="font-medium">{s.label}</span>
                    <span className="text-muted-foreground">{s.detail ?? s.op}</span>
                    <span className="tabular-nums">
                      {s.before == null ? "blank" : formatCurrency(s.before, cur)} → {s.after == null ? "blank" : formatCurrency(s.after, cur)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
