"use client";

import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatCurrency, getMonthLabel } from "@/lib/currency";
import { shiftMonth } from "@/lib/budgets/lines";
import type { FillAdjust, FillSource } from "@/lib/budgets/fill";
import { budgetApi } from "./budget-api";

export type FillScope =
  | { kind: "all"; label: string }
  | { kind: "keys"; keys: string[]; label: string }
  | { kind: "group"; group: string; label: string };

type SourceKey = "budget" | "spent" | "average3" | "average6" | "average12" | "same_month_last_year" | "fixed";
type IncreaseKey = "none" | "percent" | "amount";
type EveryKey = "once" | "month" | "year";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

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
  onDone: (saved: number) => void;
}) {
  const [source, setSource] = useState<SourceKey>("average3");
  const [fixed, setFixed] = useState("");
  const [start, setStart] = useState(month);
  const [count, setCount] = useState("1");
  const [increase, setIncrease] = useState<IncreaseKey>("none");
  const [incValue, setIncValue] = useState("");
  const [every, setEvery] = useState<EveryKey>("once");
  const [stepMonth, setStepMonth] = useState("1");
  const [overwrite, setOverwrite] = useState(false);
  const [preview, setPreview] = useState<{ rows: PreviewRow[]; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setStart(month);
      setPreview(null);
      setError("");
    }
  }, [open, month]);

  const months = useMemo(() => {
    const n = Math.max(1, Math.min(36, Math.round(Number(count) || 1)));
    return Array.from({ length: n }, (_, i) => shiftMonth(start, i));
  }, [start, count]);

  const adjust: FillAdjust | null =
    increase === "none" || !Number(incValue)
      ? null
      : { mode: increase, value: Number(incValue), every, ...(every === "year" ? { stepMonth: Number(stepMonth) } : {}) };

  const request = (previewOnly: boolean) => ({
    months,
    source: toSource(source, fixed),
    adjust,
    overwrite,
    scope: scope.kind === "all" ? { kind: "all" as const } : scope.kind === "keys" ? { kind: "keys" as const, keys: scope.keys } : { kind: "group" as const, group: scope.group },
    section,
    preview: previewOnly,
  });

  // Any change to the inputs drops a stale preview.
  useEffect(() => setPreview(null), [source, fixed, start, count, increase, incValue, every, stepMonth, overwrite]);

  async function runPreview() {
    if (source === "fixed" && !(Number(fixed) >= 0 && fixed.trim() !== "")) {
      setError("Enter the amount to use");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await budgetApi.fill(request(true));
      setPreview({ rows: res.rows, total: res.total });
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
      onDone(res.rows.length);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  const baseLabel = getMonthLabel(shiftMonth(months[0], -1));
  const rangeLabel = months.length === 1 ? getMonthLabel(months[0]) : `${getMonthLabel(months[0])} to ${getMonthLabel(months[months.length - 1])}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Fill budgets: {scope.label}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="grid gap-3 sm:grid-cols-2">
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
              <Label>Months</Label>
              <div className="flex gap-2">
                <Input type="month" value={start} onChange={(e) => e.target.value && setStart(e.target.value)} className="flex-1" />
                <Select value={count} onValueChange={(v) => setCount(v ?? "1")}>
                  <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {[...new Set([1, 2, 3, 6, 12, 18, 24, Number(count)])].sort((a, b) => a - b).map((n) => (
                      <SelectItem key={n} value={String(n)}>{n === 1 ? "1 month" : `${n} months`}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <button
                type="button"
                className="mt-1 text-xs text-primary hover:underline"
                onClick={() => setCount(String(13 - Number(start.slice(5, 7))))}
              >
                Through December
              </button>
              <p className="text-xs text-muted-foreground">{rangeLabel}</p>
            </div>
          </div>

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
                  <Select value={every} onValueChange={(v) => setEvery((v ?? "once") as EveryKey)}>
                    <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="once">once</SelectItem>
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
              Use a negative number to lower. &quot;Every month&quot; compounds; &quot;every year&quot; steps up each time that month comes round.
            </p>
          </div>

          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2">
              <input type="radio" checked={!overwrite} onChange={() => setOverwrite(false)} />
              Only months without a budget
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={overwrite} onChange={() => setOverwrite(true)} />
              Replace existing budgets
            </label>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          {preview && (
            <div className="max-h-64 overflow-auto rounded-md border">
              {preview.rows.length === 0 ? (
                <p className="p-3 text-muted-foreground">Nothing to fill: every line already has a budget, or the source has no amount.</p>
              ) : (
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1 text-left font-medium">Line</th>
                      <th className="px-2 py-1 text-left font-medium">Month</th>
                      <th className="px-2 py-1 text-right font-medium">Now</th>
                      <th className="px-2 py-1 text-right font-medium">New</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.slice(0, 300).map((r) => (
                      <tr key={`${r.key}-${r.month}`} className="border-t">
                        <td className="px-2 py-1">{r.name}</td>
                        <td className="px-2 py-1">{getMonthLabel(r.month)}</td>
                        <td className="px-2 py-1 text-right font-mono">{r.previous == null ? "—" : formatCurrency(r.previous, currency)}</td>
                        <td className="px-2 py-1 text-right font-mono">{formatCurrency(r.amount, currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
          {preview && preview.rows.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {preview.rows.length} budget{preview.rows.length === 1 ? "" : "s"}, {formatCurrency(preview.total, currency)} in total.
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            {preview && preview.rows.length > 0 ? (
              <Button onClick={save} disabled={busy}>
                {busy ? "Saving…" : `Save ${preview.rows.length} budget${preview.rows.length === 1 ? "" : "s"}`}
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
