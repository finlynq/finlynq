"use client";

/**
 * /forecast — Forecast (plan/forecast-scenarios.md).
 *
 * One request loads a snapshot of your real data plus the Baseline result;
 * every change on the page (horizon, assumptions, layers, events) re-runs the
 * same pure engine in the browser, so there is no Recalculate button and
 * nothing is stored unless you save a scenario or freeze a snapshot. Lines
 * with no budget stay blank (owner decision 2026-11-25); a History layer can
 * fill them ("Fill blanks from my history", or the first-visit card).
 *
 * Layout (2026-11-25 redesign): header + scenario bar, the answer cards, then
 * the chart, notes, comparison and table on the left and "Your plan"
 * (questions, events, layers, assumptions) in a rail on the right, which
 * drops below the content on narrow screens.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  BLANK_NOTE_DISMISSED_KEY,
  blankNoteKeys,
  explainBlankLines,
  isBlankNoteDismissed,
  parseDismissedKeys,
} from "@/lib/forecast/blank-lines";
import { hasHistoryFill, isMostlyBlank, quickFillPreview, valueableLines, withHistoryFill } from "@/lib/forecast/quick-fill";
import type { ForecastInputs, ForecastResult } from "@/lib/forecast/types";
import { BalancesChart, CashFlowChart, type BalancePoint, type ChartMarker, type FlowPoint } from "./_components/forecast-charts";
import { ForecastTable, type TableModel } from "./_components/forecast-table";
import { LayerPanel } from "./_components/layer-panel";
import { CompareSelect, ScenarioBar } from "./_components/scenario-bar";
import { ComparePanel, PlanVsActualCard } from "./_components/compare-panel";
import { EVENT_LABEL, EventsPanel, newEvent } from "./_components/events-panel";
import { AnswerCards, FirstRunCard, NotesStrip, monthLong, type ForecastNote } from "./_components/forecast-overview";
import { Segmented } from "./_components/segmented";
import { StickyBar } from "./_components/sticky-bar";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { layerSchema } from "@/lib/forecast/config";
import { useForecastScenarios } from "./_components/use-forecast-scenarios";
import { CalendarDays, ChevronRight, Clock, RefreshCw, TrendingDown } from "lucide-react";

type RunResponse = { inputs: ForecastInputs; scenario: ScenarioConfig; result: ForecastResult };

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (ym: string) => `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;

const FIRST_RUN_DISMISSED_KEY = "pf-forecast-first-run-dismissed";

/** Months from `startMonth` to the December of the year the user turns `age` (capped at 50 years). */
function monthsToAge(startMonth: string, birthYear: number, age: number): number {
  const [y, m] = startMonth.split("-").map(Number);
  const end = (birthYear + age) * 12 + 11;
  return Math.max(1, Math.min(600, end - (y * 12 + (m - 1)) + 1));
}

function horizonShort(months: number) {
  return months % 12 === 0 ? `${months / 12}y` : `${months} mo`;
}

export default function ForecastPage() {
  const [data, setData] = useState<RunResponse | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<ScenarioConfig | null>(null);
  const [view, setView] = useState<"monthly" | "yearly">("yearly");
  const [real, setReal] = useState(false);
  const [chart, setChart] = useState<"balances" | "flows">("balances");
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
  // The first-visit card stays hidden once dismissed (this browser only).
  const [firstRunDismissed, setFirstRunDismissed] = useState(true);
  useEffect(() => {
    try {
      setFirstRunDismissed(localStorage.getItem(FIRST_RUN_DISMISSED_KEY) === "1");
    } catch {
      setFirstRunDismissed(false);
    }
  }, []);
  // Blank lines the user dismissed from the notes strip (GH #469, this browser only).
  const [dismissedBlankKeys, setDismissedBlankKeys] = useState<string[]>([]);
  useEffect(() => {
    try {
      setDismissedBlankKeys(parseDismissedKeys(localStorage.getItem(BLANK_NOTE_DISMISSED_KEY)));
    } catch {
      /* storage blocked: nothing dismissed */
    }
  }, []);
  const saveDismissedBlankKeys = (keys: string[]) => {
    setDismissedBlankKeys(keys);
    try {
      if (keys.length) localStorage.setItem(BLANK_NOTE_DISMISSED_KEY, JSON.stringify(keys));
      else localStorage.removeItem(BLANK_NOTE_DISMISSED_KEY);
    } catch {
      /* private window: for this visit only */
    }
  };
  const dismissFirstRun = () => {
    setFirstRunDismissed(true);
    try {
      localStorage.setItem(FIRST_RUN_DISMISSED_KEY, "1");
    } catch {
      /* private window: hidden for this visit only */
    }
  };

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

  const otherResult = useMemo(() => {
    if (!compareSource || !data) return null;
    return compareSource.result ?? (compareSource.config ? runForecast(data.inputs, compareSource.config) : null);
  }, [compareSource, data]);

  const comparison = useMemo(
    () => (otherResult && result ? compareResults(result, otherResult) : null),
    [otherResult, result],
  );

  const planActual = useMemo(() => {
    if (!compareWith.startsWith("snapshot:") || !compareSource?.result || !data) return null;
    return planVsActual(compareSource.result, data.inputs);
  }, [compareWith, compareSource, data]);

  // First visit: most lines blank → offer to fill them from history, with a preview.
  const mostlyBlank = !!(data && config && result && isMostlyBlank(data.inputs, config, result));
  const fillPreview = useMemo(() => {
    if (!mostlyBlank || !data || !config || !result) return null;
    return quickFillPreview(result, runForecast(data.inputs, withHistoryFill(config)));
  }, [mostlyBlank, data, config, result]);

  const fillFromHistory = () => {
    if (!config) return;
    setConfig(withHistoryFill(config));
    setEditorKey((k) => k + 1);
  };

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
    setEditorKey((k) => k + 1);
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
      // The compared scenario's yearly net worth, matched by year.
      const other = otherResult ? yearlyView(otherResult) : null;
      const otherNW = new Map<string, number>();
      if (other) {
        const onw = adj(other.balances.netWorth, other.deflator);
        other.years.forEach((yr, i) => otherNW.set(yr, onw[i]));
      }
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
          compare: otherNW.get(yr) ?? null,
        })),
        flows: y.years.map((yr, i) => ({
          label: yr, income: adj(y.totals.income, d)[i], spending: adj(y.totals.expense, d)[i], debt: adj(y.totals.debtPayment, d)[i],
        })),
      };
    }
    const d = result.deflator;
    const b = result.balances;
    const otherNW = new Map<string, number>();
    if (otherResult) {
      const onw = adj(otherResult.balances.netWorth, otherResult.deflator);
      otherResult.months.forEach((m, i) => otherNW.set(m, onw[i]));
    }
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
        compare: otherNW.get(m) ?? null,
      })),
      flows: result.months.map((m, i) => ({
        label: monthLabel(m), income: adj(result.totals.income, d)[i], spending: adj(result.totals.expense, d)[i], debt: adj(result.totals.debtPayment, d)[i],
      })),
    };
  }, [result, otherResult, view, real]);

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
  const age100 = data.inputs.birthYear ? monthsToAge(data.inputs.startMonth, data.inputs.birthYear, 100) : null;
  const horizonOptions: Array<{ value: string; label: string }> = [
    ...HORIZON_CHOICES.filter((h) => h <= data.inputs.maxHorizonMonths).map((h) => ({ value: String(h), label: horizonShort(h) })),
    ...(age100 && !(HORIZON_CHOICES as readonly number[]).includes(age100) ? [{ value: String(age100), label: "To age 100" }] : []),
  ];
  if (!horizonOptions.some((o) => o.value === String(config.horizonMonths))) {
    horizonOptions.push({ value: String(config.horizonMonths), label: horizonShort(config.horizonMonths) });
  }

  // The compared scenario's net worth in the same final month.
  const compareEnd = (() => {
    if (!otherResult || !compareSource) return null;
    const i = otherResult.months.indexOf(result.months[last]);
    if (i < 0) return null;
    const v = real ? otherResult.balances.netWorth[i] / otherResult.deflator[i] : otherResult.balances.netWorth[i];
    return { label: compareSource.label, endNetWorth: v };
  })();

  const markers: ChartMarker[] = config.events
    .filter((e) => e.enabled && e.month >= result.startMonth && e.month <= result.months[last])
    .map((e) => ({ date: `${e.month}-01`, text: e.label || EVENT_LABEL[e.kind] }));

  const blankShown = config.layers.some((l) => l.kind === "budget" && l.enabled) ? result.blankLines : [];
  const blankDismissed = isBlankNoteDismissed(blankShown, dismissedBlankKeys);
  const notes: ForecastNote[] = [
    ...result.warnings.map((w) => ({ tone: "warn" as const, text: w.message })),
    ...data.inputs.leftOut.map((l) => ({ tone: "info" as const, text: <><span className="font-medium">{l.label}</span>: {l.reason}</> })),
    ...(blankDismissed
      ? [
          {
            tone: "info" as const,
            text: (
              <>
                {blankShown.length} blank {blankShown.length === 1 ? "line is" : "lines are"} hidden from this note.{" "}
                <button type="button" className="underline underline-offset-2" onClick={() => saveDismissedBlankKeys([])}>
                  Show
                </button>
              </>
            ),
          },
        ]
      : []),
  ];

  const compareSelect = (
    <CompareSelect
      hook={sc}
      value={compareWith}
      onChange={setCompareWith}
      extra={beforePreset ? { value: "before", label: `This scenario ${beforePreset.label}` } : null}
    />
  );

  const presetBtn = "flex w-full items-center gap-2.5 rounded-lg border bg-muted/30 px-3 py-2.5 text-left text-sm transition-colors hover:border-primary/60 hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight">Forecast</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          From {monthLong(result.startMonth)}, starting from today&apos;s balances, your budgets and loan schedules. Data as of{" "}
          {new Date(data.inputs.inputsAsOf).toLocaleString()}.
        </p>
      </div>

      {/* Scenario, horizon and money: one toolbar that stays at the top while scrolling. */}
      <StickyBar className="rounded-lg border bg-card p-2.5">
        <ScenarioBar
          hook={sc}
          working={config}
          dirty={dirty}
          result={result}
          onOpened={onOpened}
          compareWith={compareWith}
          onCompareWith={setCompareWith}
          trailing={
            <>
              <Segmented
                label="How far ahead"
                size="sm"
                value={String(config.horizonMonths)}
                options={horizonOptions}
                onChange={(v) => update({ horizonMonths: Number(v) })}
              />
              <Segmented
                label="Show amounts in"
                size="sm"
                value={real ? "real" : "nominal"}
                options={[{ value: "nominal", label: "Future $" }, { value: "real", label: "Today's $" }]}
                onChange={(v) => setReal(v === "real")}
              />
              <Button variant="outline" size="icon" className="h-8 w-8" onClick={load} disabled={loading} aria-label="Refresh data" title="Refresh data">
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              </Button>
            </>
          }
        />
      </StickyBar>

      {mostlyBlank && !firstRunDismissed && (
        <FirstRunCard
          startMonth={result.startMonth}
          blankCount={result.blankLines.length}
          lineCount={valueableLines(data.inputs).length}
          preview={fillPreview}
          currency={cur}
          onUseHistory={fillFromHistory}
          onDismiss={dismissFirstRun}
        />
      )}

      <AnswerCards result={result} real={real} compare={compareEnd} onTryRetire={openRetirePreset} />

      <div className="flex flex-wrap items-start gap-5">
        {/* Content */}
        <div className="min-w-0 flex-[999_1_600px] space-y-5">
          <Card>
            <CardHeader className="pb-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Segmented
                    label="Chart"
                    value={chart}
                    options={[{ value: "balances", label: "Balances" }, { value: "flows", label: "Cash flow" }]}
                    onChange={setChart}
                  />
                  {/* Same setting as the table's switch: chart and table always show the same periods. */}
                  <Segmented
                    label="Chart period"
                    size="sm"
                    value={view}
                    options={[{ value: "yearly", label: "Years" }, { value: "monthly", label: "Months" }]}
                    onChange={(v) => setView(v)}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {chart === "balances"
                    ? `Net worth, investments, cash and loans owed${real ? ", in today's money" : ""}${compareSource ? `, with ${compareSource.label} dotted` : ""}`
                    : `Income, spending and debt payments ${view === "yearly" ? "per year" : "per month"}`}
                </p>
              </div>
            </CardHeader>
            <CardContent>
              {chart === "balances" ? (
                <BalancesChart points={model.balances} currency={cur} markers={markers} compareLabel={compareSource?.label} />
              ) : (
                <CashFlowChart points={model.flows} currency={cur} />
              )}
            </CardContent>
          </Card>

          <NotesStrip
            blank={blankDismissed ? [] : blankShown}
            explain={explainBlankLines(result.blankLines, data.inputs, config)}
            canFillFromHistory={!hasHistoryFill(config)}
            onFillFromHistory={fillFromHistory}
            onDismissBlank={() => saveDismissedBlankKeys(blankNoteKeys([...blankShown, ...dismissedBlankKeys.map((key) => ({ key }))]))}
            notes={notes}
          />

          {comparison && compareSource ? (
            <ComparePanel
              comparison={comparison}
              labelA={`${sc.open && sc.open.id !== "builtin" ? sc.open.name : "Baseline"}${dirty ? " (with your unsaved changes)" : ""}`}
              labelB={compareSource.label}
              currency={cur}
              note={compareSource.note}
              control={compareSelect}
            />
          ) : (
            <Card>
              <CardContent className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-[200px] flex-1">
                  <p className="text-sm font-semibold">Compare</p>
                  <p className="text-xs text-muted-foreground">See this forecast next to a saved scenario or a frozen snapshot. The difference shows here.</p>
                </div>
                {compareSelect}
              </CardContent>
            </Card>
          )}
          {planActual && compareSource && (
            <PlanVsActualCard data={planActual} snapshotLabel={compareSource.label} currency={cur} />
          )}
          {compareWith && compareSource && !comparison && (
            <p className="text-sm text-destructive">That comparison can&apos;t be read.</p>
          )}

          <section className="space-y-2">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold">{view === "yearly" ? "Year by year" : "Month by month"}</h2>
                <p className="text-xs text-muted-foreground">
                  {view === "monthly" ? "Click an income or spending amount to see how it was worked out." : "Switch to months to see how an amount was worked out."}
                </p>
              </div>
              <Segmented
                label="Table period"
                size="sm"
                value={view}
                options={[{ value: "yearly", label: "Years" }, { value: "monthly", label: "Months" }]}
                onChange={(v) => setView(v)}
              />
            </div>
            <ForecastTable
              model={model.table}
              currency={cur}
              selected={view === "monthly" ? selected : null}
              onSelect={view === "monthly" ? (key, column) => setSelected({ key, column }) : null}
            />
          </section>

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

          <p className="text-xs text-muted-foreground">
            Loan payments come from each loan&apos;s schedule; their interest is inside the payment, not a separate expense. Card balances are assumed paid in full each month. Taxes are not modelled: enter income and pensions as take-home amounts. Investment returns are an average; real markets go up and down.
            {result.retirement && !result.birthYear && " Add your birth year (Can I retire at…) to see ages."}
          </p>
        </div>

        {/* Your plan */}
        <aside aria-label="Your plan" className="min-w-0 flex-[1_1_360px] lg:max-w-[420px]">
          <Card key={editorKey}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Your plan</CardTitle>
              <p className="text-xs text-muted-foreground">Every change updates the forecast right away. Save it as a scenario to keep it.</p>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Start from a question</p>
                <button type="button" className={presetBtn} disabled={result.loans.length === 0} onClick={() => setDebtPresetOpen(true)}>
                  <TrendingDown className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                  <span className="flex-1">Pay off my debt faster</span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                </button>
                <button type="button" className={presetBtn} onClick={openRetirePreset}>
                  <Clock className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                  <span className="flex-1">Can I retire at…?</span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                </button>
                <button type="button" className={presetBtn} onClick={applyThreeMonthPreset}>
                  <CalendarDays className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                  <span className="flex-1">Next 3 months by category</span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                </button>
              </div>

              <div className="border-t pt-4">
                <EventsPanel
                  events={config.events}
                  lines={data.inputs.lines}
                  loans={data.inputs.loans.map((l) => ({ key: `debt:${l.accountId}`, label: l.label }))}
                  onChange={(events) => update({ events })}
                />
              </div>

              <div className="border-t pt-4">
                <LayerPanel layers={config.layers} lines={data.inputs.lines} onChange={(layers) => update({ layers })} />
              </div>

              <div className="border-t pt-4 space-y-3">
                <h3 className="text-sm font-semibold">Assumptions</h3>
                <div className="grid grid-cols-2 items-end gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs" htmlFor="fc-infl">Inflation, % a year</Label>
                    <Input id="fc-infl" type="number" step="0.1" className="h-8" defaultValue={config.assumptions.inflationPct} onBlur={(e) => setAssumption("inflationPct", e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs" htmlFor="fc-ret">Investment return, % a year</Label>
                    <Input id="fc-ret" type="number" step="0.1" className="h-8" defaultValue={config.assumptions.investmentReturnPct} onBlur={(e) => setAssumption("investmentReturnPct", e.target.value)} />
                  </div>
                </div>
                <div className="space-y-1">
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
        </aside>
      </div>

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
