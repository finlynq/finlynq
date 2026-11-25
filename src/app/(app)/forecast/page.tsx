"use client";

/**
 * /forecast — Forecast (plan/forecast-scenarios.md), Phases 1-2.
 *
 * One request loads a snapshot of your real data plus the Baseline result;
 * every change on the page (horizon, assumptions, layers) re-runs the same
 * pure engine in the browser, so there is no Recalculate button and nothing
 * is stored unless you save a scenario or freeze a snapshot. Lines with no
 * budget stay blank (owner decision 2026-11-25); a History layer can fill them.
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
import { compareResults, planVsActual } from "@/lib/forecast/compare";
import type { ForecastInputs, ForecastResult } from "@/lib/forecast/types";
import { BalancesChart, CashFlowChart, type BalancePoint, type FlowPoint } from "./_components/forecast-charts";
import { ForecastTable, type TableModel } from "./_components/forecast-table";
import { LayerPanel } from "./_components/layer-panel";
import { ScenarioBar } from "./_components/scenario-bar";
import { ComparePanel, PlanVsActualCard } from "./_components/compare-panel";
import { EventsPanel, newEvent } from "./_components/events-panel";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { layerSchema } from "@/lib/forecast/config";
import { useForecastScenarios } from "./_components/use-forecast-scenarios";
import { AlertTriangle, ChevronDown, Info, RefreshCw, Sparkles } from "lucide-react";

type RunResponse = { inputs: ForecastInputs; scenario: ScenarioConfig; result: ForecastResult };

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (ym: string) => `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;
const monthLong = (ym: string) => `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

/** Months from `startMonth` to the December of the year the user turns `age` (capped at 50 years). */
function monthsToAge(startMonth: string, birthYear: number, age: number): number {
  const [y, m] = startMonth.split("-").map(Number);
  const end = (birthYear + age) * 12 + 11;
  return Math.max(1, Math.min(600, end - (y * 12 + (m - 1)) + 1));
}

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
  const [editorKey, setEditorKey] = useState(0);
  const [compareWith, setCompareWith] = useState("");
  const [compareSource, setCompareSource] = useState<
    { label: string; config: ScenarioConfig | null; result: ForecastResult | null; note?: string } | null
  >(null);
  const sc = useForecastScenarios(data?.scenario ?? null);
  // The settings as they were before a preset was applied, to compare against.
  const [beforePreset, setBeforePreset] = useState<{ label: string; config: ScenarioConfig } | null>(null);
  const [debtPresetOpen, setDebtPresetOpen] = useState(false);
  const [debtExtra, setDebtExtra] = useState("300");
  const [debtMethod, setDebtMethod] = useState<"avalanche" | "snowball">("avalanche");
  const [retirePresetOpen, setRetirePresetOpen] = useState(false);
  const [retireForm, setRetireForm] = useState({ birthYear: "", age: "65", spending: "80", pension: "", pensionAge: "65", method: "cover_shortfall" as "cover_shortfall" | "fixed_pct" });
  const [retireError, setRetireError] = useState("");

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

  const dirty = !!(sc.open && config && JSON.stringify(sc.open.saved) !== JSON.stringify(config));

  const onOpened = (c: ScenarioConfig) => {
    setConfig(c);
    setEditorKey((k) => k + 1);
    setSelected(null);
  };

  // What to compare with: a saved scenario / the Baseline re-run on today's
  // data, or a frozen snapshot's stored numbers.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!compareWith || !config) {
        setCompareSource(null);
        return;
      }
      if (compareWith === "before") {
        setCompareSource(beforePreset ? { label: beforePreset.label, config: beforePreset.config, result: null } : null);
        return;
      }
      if (compareWith.startsWith("snapshot:")) {
        const id = Number(compareWith.slice(9));
        const snap = sc.snapshots.find((x) => x.id === id);
        const r = await sc.snapshotResult(id);
        if (!cancelled) {
          setCompareSource({
            label: snap ? `snapshot "${snap.name}"` : "snapshot",
            config: null,
            result: r,
            note: snap ? `Frozen on ${new Date(snap.createdAt).toLocaleDateString()} from data of ${new Date(snap.inputsAsOf).toLocaleDateString()}.` : undefined,
          });
        }
        return;
      }
      const target = compareWith === "builtin" ? "builtin" : Number(compareWith.slice(9));
      const cfg = await sc.configOf(target, config.horizonMonths);
      const name = target === "builtin" ? "Baseline" : sc.scenarios.find((x) => x.id === target)?.name ?? "scenario";
      if (!cancelled) setCompareSource({ label: name, config: cfg, result: null });
    })();
    return () => {
      cancelled = true;
    };
    // config.horizonMonths only matters for the built-in Baseline's length.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareWith, sc.snapshots, sc.scenarios, beforePreset]);

  const comparison = useMemo(() => {
    if (!compareSource || !data || !result) return null;
    const other = compareSource.result ?? (compareSource.config ? runForecast(data.inputs, compareSource.config) : null);
    return other ? compareResults(result, other) : null;
  }, [compareSource, data, result]);

  const planActual = useMemo(() => {
    if (!compareWith.startsWith("snapshot:") || !compareSource?.result || !data) return null;
    return planVsActual(compareSource.result, data.inputs);
  }, [compareWith, compareSource, data]);

  const applyDebtPreset = () => {
    if (!config || !data) return;
    const extra = Number(debtExtra);
    if (!Number.isFinite(extra) || extra < 0) return;
    const ev = newEvent("debt_strategy", data.inputs.startMonth);
    const strategy = { ...ev, label: `${debtMethod === "avalanche" ? "Avalanche" : "Snowball"}: ${extra} extra a month`, params: { method: debtMethod, extraPerMonth: extra } } as typeof ev;
    setBeforePreset({ label: "before the debt plan", config });
    setConfig({ ...config, events: [...config.events.filter((e) => e.kind !== "debt_strategy"), strategy] });
    setCompareWith("before");
    setDebtPresetOpen(false);
  };

  const openRetirePreset = () => {
    setRetireForm((f) => ({ ...f, birthYear: data?.inputs.birthYear ? String(data.inputs.birthYear) : f.birthYear }));
    setRetireError("");
    setRetirePresetOpen(true);
  };

  const applyRetirePreset = async () => {
    if (!config || !data) return;
    const by = Number(retireForm.birthYear);
    const age = Number(retireForm.age);
    const thisYear = new Date().getUTCFullYear();
    if (!Number.isInteger(by) || by < 1900 || by > thisYear) return setRetireError(`Birth year: a year from 1900 to ${thisYear}.`);
    if (!Number.isInteger(age) || age < 30 || age > 90) return setRetireError("Retirement age: from 30 to 90.");
    const retireMonth = `${by + age}-01`;
    if (retireMonth < data.inputs.startMonth) return setRetireError("That age has already passed.");
    // Save the birth year (plaintext year only) when it is new.
    if (data.inputs.birthYear !== by) {
      const res = await fetch("/api/settings/birth-year", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ birthYear: by }) });
      if (!res.ok) return setRetireError("Couldn't save your birth year. Try again.");
      setData({ ...data, inputs: { ...data.inputs, birthYear: by } });
    }
    const pension = Number(retireForm.pension);
    const pensions = Number.isFinite(pension) && pension > 0
      ? [{ label: "Pension / benefit", amount: pension, startMonth: `${by + Number(retireForm.pensionAge || age)}-01`, growthPct: null }]
      : [];
    const ev = newEvent("retire", retireMonth);
    const retire = {
      ...ev,
      label: `Retire at ${age}`,
      params: {
        ...(ev.params as object),
        spendingFactor: Number(retireForm.spending) / 100,
        pensions,
        withdrawal: retireForm.method === "fixed_pct" ? { method: "fixed_pct", pct: 4, growWithInflation: true } : { method: "cover_shortfall" },
      },
    } as typeof ev;
    setBeforePreset({ label: "before retiring", config });
    setConfig(scenarioConfigSchema.parse({
      ...config,
      horizonMonths: monthsToAge(data.inputs.startMonth, by, 100),
      events: [...config.events.filter((e) => e.kind !== "retire"), retire],
    }));
    setReal(true);
    setView("yearly");
    setCompareWith("before");
    setRetirePresetOpen(false);
  };

  const applyThreeMonthPreset = () => {
    if (!config) return;
    setBeforePreset({ label: "before the 3-month view", config });
    setConfig(
      scenarioConfigSchema.parse({
        ...config,
        horizonMonths: 3,
        layers: [
          layerSchema.parse({ id: "budget", kind: "budget", label: "Budget", op: "fill" }),
          layerSchema.parse({ id: "history-3m", kind: "history", label: "Your history", op: "fill", params: { lookbackMonths: 6, method: "average", seasonal: false } }),
          layerSchema.parse({ id: "scheduled-3m", kind: "scheduled", label: "Scheduled payments", op: "floor" }),
        ],
      }),
    );
    setView("monthly");
  };

  const update = (patch: Partial<ScenarioConfig>) => {
    if (!config) return;
    const next = scenarioConfigSchema.safeParse({ ...config, ...patch });
    if (next.success) setConfig(next.data);
  };
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
          columnLabels: y.years.map((yr) => (result.birthYear ? `${yr} (${Number(yr) - result.birthYear})` : yr)),
          lines: y.lines.map((l) => ({ ...l, amounts: adjN(l.amounts, d) })),
          totals: {
            income: adj(y.totals.income, d), expense: adj(y.totals.expense, d), debtPayment: adj(y.totals.debtPayment, d), net: adj(y.totals.net, d),
            toInvestments: adj(y.totals.toInvestments, d), purchases: adj(y.totals.purchases, d), borrowed: adj(y.totals.borrowed, d), withdrawn: adj(y.totals.withdrawn, d),
          },
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
        totals: {
          income: adj(result.totals.income, d), expense: adj(result.totals.expense, d), debtPayment: adj(result.totals.debtPayment, d), net: adj(result.totals.net, d),
          toInvestments: adj(result.totals.toInvestments, d), purchases: adj(result.totals.purchases, d), borrowed: adj(result.totals.borrowed, d), withdrawn: adj(result.totals.withdrawn, d),
        },
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
              {data.inputs.birthYear && !(HORIZON_CHOICES as readonly number[]).includes(monthsToAge(data.inputs.startMonth, data.inputs.birthYear, 100)) && (
                <SelectItem value={String(monthsToAge(data.inputs.startMonth, data.inputs.birthYear, 100))}>To age 100</SelectItem>
              )}
              {!(HORIZON_CHOICES as readonly number[]).includes(config.horizonMonths) &&
                !(data.inputs.birthYear && config.horizonMonths === monthsToAge(data.inputs.startMonth, data.inputs.birthYear, 100)) && (
                <SelectItem value={String(config.horizonMonths)}>{horizonLabel(config.horizonMonths)}</SelectItem>
              )}
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

      <ScenarioBar
        hook={sc}
        working={config}
        dirty={dirty}
        result={result}
        onOpened={onOpened}
        compareWith={compareWith}
        onCompareWith={setCompareWith}
        extraCompare={beforePreset ? { value: "before", label: `This scenario ${beforePreset.label}` } : null}
      />

      {result.retirement && (
        <Card className="border-primary/40">
          <CardContent className="py-4 grid gap-3 sm:grid-cols-3">
            <div>
              <p className="text-xs text-muted-foreground">Retire</p>
              <p className="text-lg font-semibold">{monthLong(result.retirement.month)}{result.retirement.age != null ? `, at ${result.retirement.age}` : ""}</p>
              <p className="text-xs text-muted-foreground">Investments then: {formatCurrency(real ? result.retirement.investmentsAtRetirement / (result.deflator[Math.max(0, result.months.indexOf(result.retirement.month) - 1)] ?? 1) : result.retirement.investmentsAtRetirement, cur, { decimals: 0 })}{real ? " in today's money" : ""}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Money lasts</p>
              {result.retirement.runsOutMonth ? (
                <p className="text-lg font-semibold text-rose-600">
                  Until {result.retirement.runsOutAge != null ? `age ${result.retirement.runsOutAge}` : monthLong(result.retirement.runsOutMonth)}
                </p>
              ) : (
                <p className="text-lg font-semibold text-emerald-600">
                  Past {result.retirement.horizonEndAge != null ? `age ${result.retirement.horizonEndAge}` : monthLong(result.retirement.horizonEndMonth)}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {result.retirement.runsOutMonth ? `Runs out in ${monthLong(result.retirement.runsOutMonth)}.` : "Still money left at the end of the forecast."}
              </p>
            </div>
            <div className="text-xs text-muted-foreground self-center">
              Taxes aren&apos;t modelled: enter income and pensions as take-home amounts. Returns are an average; real markets go up and down.
              {!result.birthYear && " Add your birth year (Presets → Can I retire at…) to see ages."}
            </div>
          </CardContent>
        </Card>
      )}

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
      <Card key={editorKey}>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="text-base">Layers, events and assumptions</CardTitle>
              <CardDescription>Changes recalculate straight away. Save them as a scenario to keep them.</CardDescription>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="h-8"><Sparkles className="h-3.5 w-3.5 mr-1" /> Presets <ChevronDown className="h-3.5 w-3.5 ml-1" /></Button>} />
              <DropdownMenuContent align="end" className="min-w-64">
                <DropdownMenuGroup>
                  <DropdownMenuItem disabled={result.loans.length === 0} onClick={() => setDebtPresetOpen(true)}>
                    <div><div className="text-sm">Pay off my debt faster…</div><div className="text-xs text-muted-foreground">An extra amount each month at your loans, compared with now.</div></div>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={openRetirePreset}>
                    <div><div className="text-sm">Can I retire at…</div><div className="text-xs text-muted-foreground">Retire at an age, with pensions and investments paying the rest, to age 100.</div></div>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={applyThreeMonthPreset}>
                    <div><div className="text-sm">Next 3 months by category</div><div className="text-xs text-muted-foreground">Budget, then your recent average, then scheduled payments, by month.</div></div>
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <LayerPanel layers={config.layers} lines={data.inputs.lines} onChange={(layers) => update({ layers })} />
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
          <div className="md:col-span-2 border-t pt-4">
            <EventsPanel
              events={config.events}
              lines={data.inputs.lines}
              loans={data.inputs.loans.map((l) => ({ key: `debt:${l.accountId}`, label: l.label }))}
              onChange={(events) => update({ events })}
            />
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
                {blankIncome.length > 0 ? ` (including ${blankIncome.length} income)` : ""}. Add budgets on the <Link href="/budgets" className="underline">Budgets page</Link>, or add a &quot;Your history&quot; layer to fill them from what you actually spent.
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

      {comparison && compareSource && (
        <ComparePanel
          comparison={comparison}
          labelA={`${sc.open && sc.open.id !== "builtin" ? sc.open.name : "Baseline"}${dirty ? " (with your unsaved changes)" : ""}`}
          labelB={compareSource.label}
          currency={cur}
          note={compareSource.note}
        />
      )}
      {planActual && compareSource && (
        <PlanVsActualCard data={planActual} snapshotLabel={compareSource.label} currency={cur} />
      )}
      {compareWith && compareSource && !comparison && (
        <p className="text-sm text-destructive">That comparison can&apos;t be read.</p>
      )}

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
      <Dialog open={retirePresetOpen} onOpenChange={setRetirePresetOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Can I retire at…</DialogTitle>
            <DialogDescription>Adds a retirement to this forecast, runs it to age 100 in today&apos;s money, and compares it with not retiring.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="rp-by">Birth year</Label>
              <Input id="rp-by" type="number" value={retireForm.birthYear} onChange={(e) => setRetireForm({ ...retireForm, birthYear: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="rp-age">Retire at age</Label>
              <Input id="rp-age" type="number" value={retireForm.age} onChange={(e) => setRetireForm({ ...retireForm, age: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="rp-spend">Spending in retirement, % of now</Label>
              <Input id="rp-spend" type="number" value={retireForm.spending} onChange={(e) => setRetireForm({ ...retireForm, spending: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Paying for it from investments</Label>
              <Select value={retireForm.method} onValueChange={(v) => setRetireForm({ ...retireForm, method: v === "fixed_pct" ? "fixed_pct" : "cover_shortfall" })}>
                <SelectTrigger className="h-8 text-xs" aria-label="Paying for it from investments"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="cover_shortfall">Sell only what&apos;s needed</SelectItem>
                  <SelectItem value="fixed_pct">4% a year, growing with inflation</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="rp-pension">Pension or benefit, per month (today&apos;s money, optional)</Label>
              <Input id="rp-pension" type="number" value={retireForm.pension} onChange={(e) => setRetireForm({ ...retireForm, pension: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="rp-page">It starts at age</Label>
              <Input id="rp-page" type="number" value={retireForm.pensionAge} onChange={(e) => setRetireForm({ ...retireForm, pensionAge: e.target.value })} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Your birth year is saved (the year only) so ages can be shown. Taxes aren&apos;t modelled.</p>
          {retireError && <p className="text-sm text-destructive">{retireError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRetirePresetOpen(false)}>Cancel</Button>
            <Button onClick={applyRetirePreset}>Show me</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={debtPresetOpen} onOpenChange={setDebtPresetOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Pay off my debt faster</DialogTitle>
            <DialogDescription>Adds a debt strategy from {monthLong(result.startMonth)} and compares it with your forecast as it is now.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="dp-extra">Extra per month</Label>
              <Input id="dp-extra" type="number" min={0} step="any" value={debtExtra} onChange={(e) => setDebtExtra(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Order</Label>
              <Select value={debtMethod} onValueChange={(v) => setDebtMethod(v === "snowball" ? "snowball" : "avalanche")}>
                <SelectTrigger className="h-8 text-xs" aria-label="Order"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="avalanche">Avalanche: highest rate first (least interest)</SelectItem>
                  <SelectItem value="snowball">Snowball: smallest balance first (quick wins)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDebtPresetOpen(false)}>Cancel</Button>
            <Button onClick={applyDebtPreset}>Show me</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
