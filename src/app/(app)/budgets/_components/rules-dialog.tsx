"use client";

/**
 * A budget line's rules (plan/budget-rules.md): list, add, edit, delete, and
 * what the next 12 months come to. Rules fill the current month and later;
 * months that have ended keep their budgets whatever is changed here.
 */
import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatCurrency, getMonthLabel } from "@/lib/currency";
import { describeIncrease, type RuleIncrease } from "@/lib/budgets/rules";
import { budgetApi, type LineRulesView, type RuleInput } from "./budget-api";
import { parseSignedAmount } from "./rule-budget-cell";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

type Draft = {
  id: number | null;
  amount: string;
  startMonth: string;
  noEnd: boolean;
  endMonth: string;
  incMode: "none" | "percent" | "amount";
  incValue: string;
  every: "month" | "year";
  stepMonth: string;
};

const emptyDraft = (start: string): Draft => ({
  id: null,
  amount: "",
  startMonth: start,
  noEnd: true,
  endMonth: start,
  incMode: "none",
  incValue: "",
  every: "year",
  stepMonth: "1",
});

export function ruleRange(startMonth: string, endMonth: string | null): string {
  return endMonth ? `${getMonthLabel(startMonth)} to ${getMonthLabel(endMonth)}` : `from ${getMonthLabel(startMonth)}, no end`;
}

export function RulesDialog({
  target,
  month,
  onClose,
  onChanged,
}: {
  target: { key: string; name: string } | null;
  month: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [view, setView] = useState<LineRulesView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toDelete, setToDelete] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!target) return;
    try {
      setView(await budgetApi.rules(target.key, month));
      setLoadError("");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load the rules");
    }
  }, [target, month]);

  useEffect(() => {
    setView(null);
    setDraft(null);
    setError("");
    void load();
  }, [load]);

  const cur = view?.currency ?? "USD";
  const fmt = (n: number) => formatCurrency(n, cur);

  function edit(r: LineRulesView["rules"][number]) {
    setError("");
    setDraft({
      id: r.id,
      amount: String(r.amount),
      startMonth: r.startMonth,
      noEnd: r.endMonth == null,
      endMonth: r.endMonth ?? r.startMonth,
      incMode: r.increase ? r.increase.mode : "none",
      incValue: r.increase ? String(r.increase.value) : "",
      every: r.increase?.every ?? "year",
      stepMonth: String(r.increase?.stepMonth ?? 1),
    });
  }

  async function save() {
    if (!draft || !target) return;
    const amount = parseSignedAmount(draft.amount);
    if (amount == null || Number.isNaN(amount) || amount < 0) {
      setError("Enter an amount of 0 or more");
      return;
    }
    const incValue = parseSignedAmount(draft.incValue);
    if (draft.incMode !== "none" && (incValue == null || Number.isNaN(incValue))) {
      setError("Enter the increase");
      return;
    }
    if (!draft.noEnd && draft.endMonth < draft.startMonth) {
      setError("The end month is before the start month");
      return;
    }
    const increase: RuleIncrease | null =
      draft.incMode === "none" || !incValue
        ? null
        : { mode: draft.incMode, value: incValue, every: draft.every, ...(draft.every === "year" ? { stepMonth: Number(draft.stepMonth) } : {}) };
    const input: RuleInput = { amount, startMonth: draft.startMonth, endMonth: draft.noEnd ? null : draft.endMonth, increase };
    setBusy(true);
    setError("");
    try {
      if (draft.id == null) await budgetApi.createRule(target.key, input);
      else await budgetApi.updateRule(draft.id, input);
      setDraft(null);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the rule");
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (toDelete == null) return;
    setBusy(true);
    try {
      await budgetApi.deleteRule(toDelete);
      setToDelete(null);
      if (draft?.id === toDelete) setDraft(null);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete the rule");
      setToDelete(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
    <Dialog open={target != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Rules: {target?.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <p className="text-xs text-muted-foreground">
            Each month&apos;s budget is the rules active that month plus anything you type on top. Rules fill this month and later; months
            that have ended keep their budgets, whatever you change here.
          </p>
          {loadError && <p className="text-destructive">{loadError}</p>}
          {!view && !loadError && <p className="text-muted-foreground">Loading…</p>}

          {view && (
            <>
              <div className="space-y-1.5">
                {view.rules.length === 0 && !draft && <p className="text-muted-foreground">No rules yet.</p>}
                {view.rules.map((r) => (
                  <div key={r.id} className="flex items-start justify-between gap-2 rounded-md border px-3 py-2">
                    <div className="min-w-0">
                      <div className="font-medium">
                        {formatCurrency(r.amount, r.currency)} a month
                        {r.increase && <span className="font-normal text-muted-foreground"> · {describeIncrease(r.increase, fmt)}</span>}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {ruleRange(r.startMonth, r.endMonth)}
                        {r.fromMonthAmount != null && ` · ${getMonthLabel(view.from)}: ${fmt(r.fromMonthAmount)}`}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Edit rule" onClick={() => edit(r)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Delete rule" onClick={() => setToDelete(r.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>

              {draft ? (
                <div className="space-y-3 rounded-md border bg-muted/30 p-3">
                  <div className="font-medium">{draft.id == null ? "New rule" : "Edit rule"}</div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div>
                      <Label>Amount a month</Label>
                      <Input inputMode="decimal" placeholder="100" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} />
                    </div>
                    <div>
                      <Label>From</Label>
                      <Input type="month" value={draft.startMonth} onChange={(e) => e.target.value && setDraft({ ...draft, startMonth: e.target.value })} className="min-w-0" />
                    </div>
                    <div>
                      <Label>To</Label>
                      {draft.noEnd ? (
                        <div className="flex h-8 items-center text-muted-foreground">No end</div>
                      ) : (
                        <Input type="month" value={draft.endMonth} onChange={(e) => e.target.value && setDraft({ ...draft, endMonth: e.target.value })} className="min-w-0" />
                      )}
                      <label className="mt-1 flex items-center gap-1.5 text-xs">
                        <input type="checkbox" checked={draft.noEnd} onChange={(e) => setDraft({ ...draft, noEnd: e.target.checked })} />
                        No end
                      </label>
                    </div>
                  </div>
                  <div>
                    <Label>Increase</Label>
                    <div className="flex flex-wrap gap-2">
                      <Select value={draft.incMode} onValueChange={(v) => setDraft({ ...draft, incMode: (v ?? "none") as Draft["incMode"] })}>
                        <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No increase</SelectItem>
                          <SelectItem value="percent">By a percent</SelectItem>
                          <SelectItem value="amount">By an amount</SelectItem>
                        </SelectContent>
                      </Select>
                      {draft.incMode !== "none" && (
                        <>
                          <Input
                            className="w-24"
                            inputMode="decimal"
                            placeholder={draft.incMode === "percent" ? "3" : "25"}
                            aria-label={draft.incMode === "percent" ? "Percent" : "Amount"}
                            value={draft.incValue}
                            onChange={(e) => setDraft({ ...draft, incValue: e.target.value })}
                          />
                          <Select value={draft.every} onValueChange={(v) => setDraft({ ...draft, every: (v ?? "year") as Draft["every"] })}>
                            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="month">every month</SelectItem>
                              <SelectItem value="year">every year</SelectItem>
                            </SelectContent>
                          </Select>
                          {draft.every === "year" && (
                            <Select value={draft.stepMonth} onValueChange={(v) => setDraft({ ...draft, stepMonth: v ?? "1" })}>
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
                      Counted from the rule&apos;s start month, never in the start month itself. Negative lowers.
                    </p>
                  </div>
                  {error && <p className="text-xs text-destructive">{error}</p>}
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => setDraft(null)} disabled={busy}>Cancel</Button>
                    <Button size="sm" onClick={save} disabled={busy}>{busy ? "Saving…" : draft.id == null ? "Add rule" : "Save rule"}</Button>
                  </div>
                </div>
              ) : (
                <Button variant="outline" size="sm" onClick={() => { setError(""); setDraft(emptyDraft(view.from)); }}>
                  <Plus className="mr-1 h-4 w-4" /> Add a rule
                </Button>
              )}

              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">Next 12 months</div>
                <div className="max-h-64 overflow-auto rounded-md border">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-muted text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1 text-left font-medium">Month</th>
                        <th className="px-2 py-1 text-right font-medium">Rules</th>
                        <th className="px-2 py-1 text-right font-medium">Typed</th>
                        <th className="px-2 py-1 text-right font-medium">Budget</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.months.map((m) => (
                        <tr key={m.month} className="border-t">
                          <td className="px-2 py-1">{getMonthLabel(m.month)}</td>
                          <td className={`px-2 py-1 text-right font-mono ${m.override ? "text-muted-foreground line-through" : ""}`}>{m.fromRules ? fmt(m.fromRules) : "—"}</td>
                          <td className="px-2 py-1 text-right font-mono">
                            {m.override ? "only this" : m.adjustment ? `${m.adjustment > 0 ? "+" : ""}${fmt(m.adjustment)}` : "—"}
                          </td>
                          <td className={`px-2 py-1 text-right font-mono font-medium ${m.total != null && m.total < 0 ? "text-rose-600 dark:text-rose-400" : ""}`}>
                            {m.total == null ? "—" : fmt(m.total)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
      <ConfirmDialog
        open={toDelete != null}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Delete this rule?"
        description="This month and later stop getting its amount. Months that have ended keep their budgets."
        confirmLabel="Delete rule"
        busy={busy}
        onConfirm={confirmDelete}
      />
    </>
  );
}
