"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox, type ComboboxItemShape } from "@/components/ui/combobox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/currency";
import { useDisplayCurrency } from "@/components/currency-provider";
import { useDropdownOrder } from "@/components/dropdown-order-provider";
import { SUPPORTED_FIAT_CURRENCIES } from "@/lib/fx/supported-currencies";
import { Plus, Trash2, Target, CheckCircle2, TrendingUp, Calendar, Pencil, X } from "lucide-react";

type Goal = {
  id: number; name: string; type: string; targetAmount: number; currentAmount: number;
  currency: string;
  deadline: string | null;
  // Issue #130 — multi-account linking. `accountIds` is the canonical list;
  // `accounts` carries decrypted display names; `accountName` is the legacy
  // first-only string preserved for any consumer that hasn't migrated yet.
  accountIds: number[]; accounts: string[]; accountName: string | null;
  priority: number; status: string;
  progress: number; remaining: number; monthlyNeeded: number; note: string;
};
type Account = { id: number; name: string };

type FormState = {
  name: string;
  type: string;
  targetAmount: string;
  currency: string;
  deadline: string;
  accountIds: number[]; // issue #130 — multi-account
  priority: string;
  note: string;
};

const goalTypeConfig: Record<string, { label: string; badgeClass: string; borderClass: string }> = {
  savings: { label: "Savings", badgeClass: "bg-emerald-100 text-emerald-700 border-emerald-200", borderClass: "border-l-emerald-500" },
  debt_payoff: { label: "Debt Payoff", badgeClass: "bg-rose-100 text-rose-700 border-rose-200", borderClass: "border-l-rose-500" },
  investment: { label: "Investment", badgeClass: "bg-indigo-100 text-indigo-700 border-indigo-200", borderClass: "border-l-indigo-500" },
  emergency_fund: { label: "Emergency Fund", badgeClass: "bg-amber-100 text-amber-700 border-amber-200", borderClass: "border-l-amber-500" },
};

function progressColorClass(progress: number): string {
  if (progress < 33) return "[&_[data-slot=progress-indicator]]:bg-rose-500";
  if (progress <= 66) return "[&_[data-slot=progress-indicator]]:bg-amber-500";
  return "[&_[data-slot=progress-indicator]]:bg-emerald-500";
}

function progressTextClass(progress: number): string {
  if (progress < 33) return "text-rose-600";
  if (progress <= 66) return "text-amber-600";
  return "text-emerald-600";
}

function emptyForm(displayCurrency: string): FormState {
  return {
    name: "",
    type: "savings",
    targetAmount: "",
    currency: displayCurrency,
    deadline: "",
    accountIds: [],
    priority: "1",
    note: "",
  };
}

function goalToForm(g: Goal, displayCurrency: string): FormState {
  return {
    name: g.name ?? "",
    type: g.type,
    targetAmount: String(g.targetAmount),
    currency: g.currency || displayCurrency,
    deadline: g.deadline ?? "",
    accountIds: g.accountIds ?? [],
    priority: String(g.priority ?? 1),
    note: g.note ?? "",
  };
}

/**
 * <GoalEditForm> — shared Add/Edit goal form (issue #130). Mode is set by
 * `mode`: "add" routes to POST /api/goals; "edit" carries the goal id and
 * routes to PUT /api/goals. The form fully owns its state; the parent
 * triggers `onSave()` once persistence completes so it can refresh the
 * list.
 */
function GoalEditForm({
  mode,
  goalId,
  initial,
  accounts,
  onSave,
  onCancel,
  displayCurrency,
}: {
  mode: "add" | "edit";
  goalId?: number;
  initial: FormState;
  accounts: Account[];
  onSave: () => void;
  onCancel: () => void;
  displayCurrency: string;
}) {
  const [form, setForm] = useState<FormState>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const sortAccount = useDropdownOrder("account");

  function validateForm() {
    const e: Record<string, string> = {};
    if (!form.name.trim()) e.name = "Name is required";
    if (!form.targetAmount || parseFloat(form.targetAmount) <= 0) e.targetAmount = "Target amount must be greater than 0";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  const isFormValid = form.name.trim() !== "" && form.targetAmount !== "" && parseFloat(form.targetAmount) > 0;

  // Account chip selector — pick from the unselected pool, remove via the X
  // on each chip. Single-select Combobox is reused as the picker; the
  // selected ids drive the chip row.
  const selectedSet = new Set(form.accountIds);
  const availableAccounts = accounts.filter((a) => !selectedSet.has(a.id));

  function addAccount(idStr: string) {
    if (!idStr) return;
    const id = parseInt(idStr);
    if (Number.isNaN(id)) return;
    if (selectedSet.has(id)) return;
    setForm({ ...form, accountIds: [...form.accountIds, id] });
  }

  function removeAccount(id: number) {
    setForm({ ...form, accountIds: form.accountIds.filter((x) => x !== id) });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validateForm()) return;
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name,
        type: form.type,
        targetAmount: parseFloat(form.targetAmount),
        currency: form.currency || displayCurrency,
        deadline: form.deadline || null,
        accountIds: form.accountIds,
        priority: parseInt(form.priority),
        note: form.note,
      };
      if (mode === "edit" && goalId != null) {
        payload.id = goalId;
        await fetch("/api/goals", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } else {
        await fetch("/api/goals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }
      onSave();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <Label>Goal Name</Label>
        <Input value={form.name} onChange={(e) => { setForm({ ...form, name: e.target.value }); setErrors({ ...errors, name: "" }); }} placeholder="e.g. Emergency Fund" />
        {errors.name && <p className="text-xs text-destructive mt-1">{errors.name}</p>}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Type</Label>
          <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v ?? "savings" })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="savings">Savings</SelectItem>
              <SelectItem value="debt_payoff">Debt Payoff</SelectItem>
              <SelectItem value="investment">Investment</SelectItem>
              <SelectItem value="emergency_fund">Emergency Fund</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Currency</Label>
          <Select value={form.currency} onValueChange={(v) => setForm({ ...form, currency: v ?? displayCurrency })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {SUPPORTED_FIAT_CURRENCIES.map((c) => (
                <SelectItem key={c} value={c}>{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div>
        <Label>Target Amount</Label>
        <Input type="number" step="0.01" value={form.targetAmount} onChange={(e) => { setForm({ ...form, targetAmount: e.target.value }); setErrors({ ...errors, targetAmount: "" }); }} />
        {errors.targetAmount && <p className="text-xs text-destructive mt-1">{errors.targetAmount}</p>}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Deadline</Label>
          <Input type="date" value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} />
        </div>
        <div>
          <Label>Priority</Label>
          <Select value={form.priority} onValueChange={(v) => setForm({ ...form, priority: v ?? "1" })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="1">High</SelectItem>
              <SelectItem value="2">Medium</SelectItem>
              <SelectItem value="3">Low</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div>
        <Label>Linked Accounts</Label>
        {form.accountIds.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {form.accountIds.map((id) => {
              const a = accounts.find((x) => x.id === id);
              return (
                <span key={id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-muted text-xs font-medium border border-border/60">
                  {a?.name ?? `#${id}`}
                  <button
                    type="button"
                    aria-label={`Remove ${a?.name ?? `#${id}`}`}
                    onClick={() => removeAccount(id)}
                    className="hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              );
            })}
          </div>
        )}
        <Combobox
          value=""
          onValueChange={(v) => addAccount(v ?? "")}
          items={sortAccount(
            availableAccounts.map((a): ComboboxItemShape => ({ value: String(a.id), label: a.name })),
            (a) => Number(a.value),
            (a, z) => a.label.localeCompare(z.label),
          )}
          placeholder={form.accountIds.length === 0 ? "Add an account…" : "Add another…"}
          searchPlaceholder="Search accounts…"
          emptyMessage="No matches"
          className="w-full"
        />
        <p className="text-xs text-muted-foreground mt-1">
          Goal progress sums transactions across every linked account. Leave empty for manual tracking.
        </p>
      </div>
      <div>
        <Label>Note</Label>
        <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
      </div>
      <div className="flex gap-2">
        {mode === "edit" && (
          <Button type="button" variant="outline" className="flex-1" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        )}
        <Button type="submit" className="flex-1" disabled={!isFormValid || submitting}>
          {submitting ? "Saving…" : mode === "edit" ? "Save Changes" : "Create Goal"}
        </Button>
      </div>
    </form>
  );
}

export default function GoalsPage() {
  const { displayCurrency } = useDisplayCurrency();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [editGoal, setEditGoal] = useState<Goal | null>(null);
  const [seedForm, setSeedForm] = useState<FormState>(emptyForm(displayCurrency));

  const load = useCallback(() => { fetch("/api/goals").then((r) => r.json()).then(setGoals); }, []);
  useEffect(() => { load(); fetch("/api/accounts").then((r) => r.json()).then(setAccounts); }, [load]);

  async function toggleStatus(goal: Goal) {
    await fetch("/api/goals", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: goal.id, status: goal.status === "active" ? "completed" : "active" }) });
    load();
  }

  async function handleDelete(id: number) {
    await fetch(`/api/goals?id=${id}`, { method: "DELETE" });
    load();
  }

  const active = goals.filter((g) => g.status === "active");
  const completed = goals.filter((g) => g.status === "completed");
  const totalTarget = active.reduce((s, g) => s + g.targetAmount, 0);
  const totalCurrent = active.reduce((s, g) => s + g.currentAmount, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Financial Goals</h1>
          <p className="text-sm text-muted-foreground mt-1">Track your savings targets and measure progress over time</p>
        </div>
        <Dialog open={addOpen} onOpenChange={(o) => { setAddOpen(o); if (!o) setSeedForm(emptyForm(displayCurrency)); }}>
          <DialogTrigger render={<Button />}><Plus className="h-4 w-4 mr-1" /> Add Goal</DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>New Financial Goal</DialogTitle></DialogHeader>
            <GoalEditForm
              mode="add"
              initial={seedForm}
              accounts={accounts}
              displayCurrency={displayCurrency}
              onSave={() => { setAddOpen(false); setSeedForm(emptyForm(displayCurrency)); load(); }}
              onCancel={() => { setAddOpen(false); setSeedForm(emptyForm(displayCurrency)); }}
            />
          </DialogContent>
        </Dialog>
      </div>

      {/* Edit dialog — issue #130 */}
      <Dialog open={editGoal !== null} onOpenChange={(o) => { if (!o) setEditGoal(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit Goal</DialogTitle></DialogHeader>
          {editGoal && (
            <GoalEditForm
              mode="edit"
              goalId={editGoal.id}
              initial={goalToForm(editGoal, displayCurrency)}
              accounts={accounts}
              displayCurrency={displayCurrency}
              onSave={() => { setEditGoal(null); load(); }}
              onCancel={() => setEditGoal(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Summary cards — only show when there are goals */}
      {goals.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardContent className="flex items-center gap-4 pt-6">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100">
                <Target className="h-5 w-5 text-indigo-600" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Total Target</p>
                <p className="text-2xl font-bold">{formatCurrency(totalTarget, displayCurrency)}</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-4 pt-6">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100">
                <TrendingUp className="h-5 w-5 text-emerald-600" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Current Progress</p>
                <p className="text-2xl font-bold text-emerald-600">{formatCurrency(totalCurrent, displayCurrency)}</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-4 pt-6">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-100">
                <CheckCircle2 className="h-5 w-5 text-violet-600" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Completed</p>
                <p className="text-2xl font-bold">{completed.length} <span className="text-base font-normal text-muted-foreground">/ {goals.length}</span></p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Empty state — no goals at all */}
      {goals.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="py-16 flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-100 dark:bg-indigo-950/60 mb-4">
              <Target className="h-8 w-8 text-indigo-600 dark:text-indigo-400" />
            </div>
            <h3 className="text-lg font-semibold mb-2">Set your first financial goal</h3>
            <p className="text-sm text-muted-foreground max-w-sm mb-6">
              Goals help you stay focused and measure real progress. Start with an emergency fund, debt payoff target, or a savings milestone.
            </p>
            <div className="flex flex-wrap gap-2 justify-center">
              {[
                { label: "Emergency Fund", type: "emergency_fund" },
                { label: "Pay off debt", type: "debt_payoff" },
                { label: "Save for vacation", type: "savings" },
                { label: "Build investments", type: "investment" },
              ].map(({ label, type }) => (
                <button
                  key={label}
                  onClick={() => { setSeedForm({ ...emptyForm(displayCurrency), name: label, type }); setAddOpen(true); }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border border-border/60 bg-muted/40 hover:bg-muted transition-colors"
                >
                  <Plus className="h-3 w-3" />{label}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty state — has completed goals but no active */}
      {goals.length > 0 && active.length === 0 && (
        <Card>
          <CardContent className="py-10 flex flex-col items-center text-center">
            <CheckCircle2 className="h-10 w-10 text-emerald-500 mb-3" />
            <h3 className="text-base font-semibold mb-1">All goals completed!</h3>
            <p className="text-sm text-muted-foreground">Add a new goal to keep building momentum.</p>
          </CardContent>
        </Card>
      )}

      {/* Active goals */}
      {active.map((g) => {
        const config = goalTypeConfig[g.type] ?? goalTypeConfig.savings;
        return (
          <Card key={g.id} className={`border-l-4 ${config.borderClass}`}>
            <CardContent className="pt-6">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Target className="h-5 w-5 text-primary" />
                  <div>
                    <h3 className="font-semibold">{g.name}</h3>
                    <div className="flex flex-wrap gap-2 mt-1">
                      <Badge className={config.badgeClass}>{config.label}</Badge>
                      {/* Issue #130 — render every linked account as its own chip. */}
                      {(g.accounts ?? []).filter((n) => n).map((name, i) => (
                        <Badge key={`${g.accountIds[i] ?? i}`} variant="secondary">{name}</Badge>
                      ))}
                      {g.deadline && (
                        <Badge variant="outline" className="gap-1">
                          <Calendar className="h-3 w-3" />
                          {g.deadline}
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setEditGoal(g)} title="Edit">
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => toggleStatus(g)} title="Mark complete">
                    <CheckCircle2 className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => handleDelete(g.id)} title="Delete">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>{formatCurrency(g.currentAmount, displayCurrency)} of {formatCurrency(g.targetAmount, displayCurrency)}</span>
                  <span className={`font-bold ${progressTextClass(g.progress)}`}>{g.progress}%</span>
                </div>
                <Progress value={g.progress} className={`h-3 ${progressColorClass(g.progress)}`} />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Remaining: <span className="font-medium text-foreground">{formatCurrency(g.remaining, displayCurrency)}</span></span>
                  {g.monthlyNeeded > 0 && (
                    <span className="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 ring-1 ring-inset ring-indigo-200">
                      {formatCurrency(g.monthlyNeeded, displayCurrency)}/mo needed
                    </span>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}

      {/* Completed goals */}
      {completed.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-muted-foreground flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-emerald-500" />
            Completed Goals
          </h2>
          {completed.map((g) => (
            <Card key={g.id} className="border-l-4 border-l-emerald-400 bg-emerald-50/30">
              <CardContent className="py-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />
                  <div>
                    <span className="line-through text-muted-foreground">{g.name}</span>
                    <Badge className="ml-2 bg-emerald-100 text-emerald-700 border-emerald-200">{formatCurrency(g.targetAmount, displayCurrency)}</Badge>
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditGoal(g)} title="Edit">
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => toggleStatus(g)} title="Reactivate">
                    <Target className="h-3 w-3" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => handleDelete(g.id)}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
