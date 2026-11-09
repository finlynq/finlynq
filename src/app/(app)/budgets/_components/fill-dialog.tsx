"use client";

/**
 * Fill budgets (plan/budget-rules.md). Two ways:
 *  - Only this month: the amount goes into one month as "use only this
 *    amount" (the line's rules are ignored that month).
 *  - This and future months: each line gets a rule from the chosen month,
 *    for a number of months or with no end, carrying the increase. The line's
 *    existing rules that overlap are ended (the preview names them).
 * The source (a month's budget or spending, an average, the same month last
 * year, a fixed amount) gives the starting amount either way.
 */
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatCurrency, getMonthLabel } from "@/lib/currency";
import { shiftMonth } from "@/lib/budgets/lines";
import { describeIncrease } from "@/lib/budgets/rules";
import type { FillAdjust, FillSource } from "@/lib/budgets/fill";
import { budgetApi, type FillRulePreview } from "./budget-api";
import { ruleRange } from "./rules-dialog";

export type FillScope =
  | { kind: "all"; label: string }
  | { kind: "keys"; keys: string[]; label: string }
  | { kind: "group"; group: string; label: string };

type SourceKey = "budget" | "spent" | "average3" | "average6" | "average12" | "same_month_last_year" | "fixed";
type IncreaseKey = "none" | "percent" | "amount";
type EveryKey = "once" | "month" | "year";
type Mode = "this_month" | "rules";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const NO_END = "none";

function toSource(key: SourceKey, fixed: string): FillSource {
  switch (key) {
    case "average3":
      return { kind: "average", months: 3 };
    case "average6":
      return { kind: "average", months: 6 };
    case "average12":
      return { kind: "average", months: 12 };
    case "fixed":
      return { kind: "fixed", amount: Number(fixed) || 0 };
    default:
      return { kind: key };
  }
}

type PreviewRow = { key: string; name: string; month: string; amount: number; previous: number | null };
type Preview = { mode: Mode; rows: PreviewRow[]; rules: FillRulePreview[]; total: number };

export function FillDialog({
  open,
  onOpenChange,
  month,
  currency,
  scope,
  section,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  month: string;
  currency: string;
  scope: FillScope;
  section: "spending" | "income";
  onDone: (message: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("rules");
  const [source, setSource] = useState<SourceKey>("average3");
  const [fixed, setFixed] = useState("");
  const [start, setStart] = useState(month);
  const [count, setCount] = useState(NO_END);
  const [increase, setIncrease] = useState<IncreaseKey>("none");
  const [incValue, setIncValue] = useState("");
  const [every, setEvery] = useState<EveryKey>("year");
  const [stepMonth, setStepMonth] = useState("1");
  const [skipBudgeted, setSkipBudgeted] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setStart(month);
      setPreview(null);
      setError("");
    }
  }, [open, month]);

  const noEnd = count === NO_END;
  const months = useMemo(() => {
    if (mode === "this_month" || noEnd) return [start];
    const n = Math.max(1, Math.min(36, Math.round(Number(count) || 1)));
    return Array.from({ length: n }, (_, i) => shiftMonth(start, i));
  }, [mode, start, count, noEnd]);

  const adjust: FillAdjust | null =
    mode === "this_month" || increase === "none" || !Number(incValue)
      ? null
      : { mode: increase, value: Number(incValue), every, ...(every === "year" ? { stepMonth: Number(stepMonth) } : {}) };

  const request = (previewOnly: boolean) => ({
    months,
    source: toSource(source, fixed),
    adjust,
    overwrite: mode === "this_month" ? !skipBudgeted : false,
    scope: scope.kind === "all" ? { kind: "all" as const } : scope.kind === "keys" ? { kind: "keys" as const, keys: scope.keys } : { kind: "group" as const, group: scope.group },
    section,
    preview: previewOnly,
    mode,
    noEnd: mode === "rules" ? noEnd : undefined,
  });

  // Any change to the inputs drops a stale preview.
  useEffect(() => setPreview(null), [mode, source, fixed, start, count, increase, incValue, every, stepMonth, skipBudgeted]);

  async function runPreview() {
    if (source === "fixed" && !(Number(fixed) >= 0 && fixed.trim() !== "")) {
      setError("Enter the amount to use");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await budgetApi.fill(request(true));
      setPreview({ mode, rows: res.rows, rules: res.rules ?? [], total: res.total });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't preview");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      const res = await budgetApi.fill(request(false));
      const n = mode === "rules" ? (res.rules ?? []).length : res.rows.length;
      onDone(
        n === 0
          ? "Nothing to fill."
          : mode === "rules"
            ? `Added ${n} rule${n === 1 ? "" : "s"}.`
            : `Saved ${n} budget${n === 1 ? "" : "s"} for ${getMonthLabel(start)}.`,
      );
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  const baseLabel = getMonthLabel(shiftMonth(start, -1));
  const fmt = (n: number) => formatCurrency(n, currency);
  const itemCount = preview ? (preview.mode === "rules" ? preview.rules.length : preview.rows.length) : 0;
  const replacing = preview?.mode === "rules" ? preview.rules.reduce((s, r) => s + r.replaces.length, 0) : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Fill budgets: {scope.label}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="grid grid-cols-2 gap-1 rounded-lg border p-1" role="radiogroup" aria-label="What to fill">
            {(
              [
                ["this_month", "Only this month"],
                ["rules", "This and future months"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={mode === key}
                onClick={() => setMode(key)}
                className={`rounded-md px-2 py-1.5 text-sm transition-colors ${mode === key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">
            {mode === "this_month"
              ? "Puts the amount into one month only. A line's rules are ignored for that month."
              : "Adds a rule to each line from the month you pick. The line's rules that overlap it are ended; months that have ended keep their budgets."}
          </p>

          <div>
            <Label>Use</Label>
            <Select value={source} onValueChange={(v) => setSource((v ?? "average3") as SourceKey)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="budget">{baseLabel}&apos;s budget</SelectItem>
                <SelectItem value="spent">{baseLabel}&apos;s {section === "income" ? "income" : "spending"}</SelectItem>
                <SelectItem value="average3">Average of the last 3 months</SelectItem>
                <SelectItem value="average6">Average of the last 6 months</SelectItem>
                <SelectItem value="average12">Average of the last 12 months</SelectItem>
                <SelectItem value="same_month_last_year">The same month last year</SelectItem>
                <SelectItem value="fixed">A fixed amount</SelectItem>
              </SelectContent>
            </Select>
            {source === "fixed" && (
              <Input className="mt-2" inputMode="decimal" placeholder="500" value={fixed} onChange={(e) => setFixed(e.target.value)} />
            )}
          </div>

          <div>
            <Label>{mode === "this_month" ? "Month" : "From"}</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input type="month" value={start} onChange={(e) => e.target.value && setStart(e.target.value)} className="w-48" />
              {mode === "rules" && (
                <Select value={count} onValueChange={(v) => setCount(v ?? NO_END)}>
                  <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_END}>No end</SelectItem>
                    {[...new Set([1, 2, 3, 6, 12, 18, 24, ...(noEnd ? [] : [Number(count)])])].sort((a, b) => a - b).map((n) => (
                      <SelectItem key={n} value={String(n)}>{n === 1 ? "for 1 month" : `for ${n} months`}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {mode === "rules" && (
                <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => setCount(String(13 - Number(start.slice(5, 7))))}>
                  Through December
                </button>
              )}
            </div>
            {mode === "rules" && (
              <p className="mt-1 text-xs text-muted-foreground">{ruleRange(start, noEnd ? null : months[months.length - 1])}</p>
            )}
          </div>

          {mode === "rules" ? (
            <div>
              <Label>Increase</Label>
              <div className="flex flex-wrap gap-2">
                <Select value={increase} onValueChange={(v) => setIncrease((v ?? "none") as IncreaseKey)}>
                  <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No change</SelectItem>
                    <SelectItem value="percent">By a percent</SelectItem>
                    <SelectItem value="amount">By an amount</SelectItem>
                  </SelectContent>
                </Select>
                {increase !== "none" && (
                  <>
                    <Input
                      className="w-24"
                      inputMode="decimal"
                      placeholder={increase === "percent" ? "3" : "25"}
                      value={incValue}
                      onChange={(e) => setIncValue(e.target.value)}
                      aria-label={increase === "percent" ? "Percent" : "Amount"}
                    />
                    <Select value={every} onValueChange={(v) => setEvery((v ?? "year") as EveryKey)}>
                      <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="once">once, from the start</SelectItem>
                        <SelectItem value="month">every month</SelectItem>
                        <SelectItem value="year">every year</SelectItem>
                      </SelectContent>
                    </Select>
                    {every === "year" && (
                      <Select value={stepMonth} onValueChange={(v) => setStepMonth(v ?? "1")}>
                        <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {MONTH_NAMES.map((n, i) => (
                            <SelectItem key={n} value={String(i + 1)}>in {n}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Increases are counted from the start month (never in it). Use a negative number to lower.
              </p>
            </div>
          ) : (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={skipBudgeted} onChange={(e) => setSkipBudgeted(e.target.checked)} />
              Skip lines that already have a budget that month
            </label>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          {preview && itemCount === 0 && (
            <p className="rounded-md border p-3 text-muted-foreground">
              {preview.mode === "this_month" && skipBudgeted
                ? "Nothing to fill: every line already has a budget that month, or the source has no amount. Untick “Skip lines…” to replace them."
                : "Nothing to fill: the source has no amount for these lines."}
            </p>
          )}

          {preview?.mode === "this_month" && itemCount > 0 && (
            <div className="max-h-64 overflow-auto rounded-md border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1 text-left font-medium">Line</th>
                    <th className="px-2 py-1 text-right font-medium">Now</th>
                    <th className="px-2 py-1 text-right font-medium">{getMonthLabel(start)}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, 300).map((r) => (
                    <tr key={r.key} className="border-t">
                      <td className="px-2 py-1">{r.name}</td>
                      <td className="px-2 py-1 text-right font-mono">{r.previous == null ? "—" : fmt(r.previous)}</td>
                      <td className="px-2 py-1 text-right font-mono">{fmt(r.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {preview?.mode === "rules" && itemCount > 0 && (
            <>
              {replacing > 0 && (
                <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    {replacing} existing rule{replacing === 1 ? " is" : "s are"} ended or removed (listed below). Months that have ended keep their
                    budgets; amounts you typed stay.
                  </span>
                </div>
              )}
              <div className="max-h-72 space-y-1.5 overflow-auto rounded-md border p-2">
                {preview.rules.slice(0, 200).map((r) => (
                  <div key={r.key} className="rounded border-b pb-1.5 last:border-b-0 last:pb-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-medium">{r.name}</span>
                      <span className="font-mono text-xs">{fmt(r.amount)} a month</span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {ruleRange(r.startMonth, r.endMonth)}
                      {r.increase && ` · ${describeIncrease(r.increase, fmt)}`}
                    </div>
                    {r.increase && r.months.length > 1 && (
                      <div className="text-[11px] text-muted-foreground">
                        {r.months
                          .filter((m, i) => i === 0 || m.amount !== r.months[i - 1].amount)
                          .slice(0, 4)
                          .map((m) => `${getMonthLabel(m.month)}: ${fmt(m.amount)}`)
                          .join(" · ")}
                      </div>
                    )}
                    {r.replaces.map((x) => (
                      <div key={x.id} className="text-[11px] text-amber-700 dark:text-amber-300">
                        {x.action === "end" ? "Ends" : "Removes"} {formatCurrency(x.amount, currency)} a month, {ruleRange(x.startMonth, x.endMonth)}
                        {x.action === "end" && x.newEndMonth ? ` (now to ${getMonthLabel(x.newEndMonth)})` : ""}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}

          {preview && itemCount > 0 && (
            <p className="text-xs text-muted-foreground">
              {preview.mode === "rules"
                ? `${itemCount} rule${itemCount === 1 ? "" : "s"}, ${fmt(preview.total)} in ${getMonthLabel(start)}.`
                : `${itemCount} budget${itemCount === 1 ? "" : "s"}, ${fmt(preview.total)} in total.`}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            {preview && itemCount > 0 ? (
              <Button onClick={save} disabled={busy}>
                {busy
                  ? "Saving…"
                  : preview.mode === "rules"
                    ? `Add ${itemCount} rule${itemCount === 1 ? "" : "s"}`
                    : `Save ${itemCount} budget${itemCount === 1 ? "" : "s"}`}
              </Button>
            ) : (
              <Button onClick={runPreview} disabled={busy}>
                {busy ? "Working…" : "Preview"}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
