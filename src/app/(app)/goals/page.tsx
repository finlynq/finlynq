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
import { useActiveCurrencies } from "@/lib/hooks/useActiveCurrencies";
import { Plus, Trash2, Target, CheckCircle2, TrendingUp, Calendar, Pencil, X, AlertTriangle } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorState } from "@/components/error-state";
import { PageSkeleton } from "@/components/page-skeleton";
import { parseSaveError } from "@/lib/save-error";
import { todayISO } from "@/lib/utils/date";

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
  // FINLYNQ-123: current-rate conversions into the display currency. The ONLY
  // figures the summary tiles may sum — per-goal amounts stay in `currency`.
  targetAmountDisplay?: number; currentAmountDisplay?: number;
  // GH #423: 'growth' goals count growth since startDate; startAmount and
  // balanceNow are the linked balance then and now (goal currency).
  progressMode?: "balance" | "growth"; startDate?: string | null;
  startAmount?: number | null; balanceNow?: number;
  // GH #462: each linked account with how much of it this goal counts.
  accountLinks?: GoalAccountLink[];
};
type GoalAccountLink = {
  accountId: number;
  accountName: string;
  allocationKind: "amount" | "percent" | null;
  allocationValue: number | null;
  allocationApplied?: boolean;
  /** What the link counts toward the goal, goal currency. */
  countedAmount: number;
  accountCurrency: string;
  accountBalance: number;
  /** Account-wide: what every active goal claims of it (account currency). */
  claims: {
    claimed: number;
    unallocated: number;
    percentClaimed: number;
    overAllocated: boolean;
    goalCount: number;
  } | null;
};
type Account = { id: number; name: string };

/** Per account, from the goals list: what the active goals claim of it. */
type AccountClaimView = NonNullable<GoalAccountLink["claims"]> & {
  accountId: number;
  accountName: string;
  accountCurrency: string;
  accountBalance: number;
};

type AllocationChoice = "whole" | "amount" | "percent";
type LinkForm = { accountId: number; kind: AllocationChoice; value: string };

type FormState = {
  name: string;
  type: string;
  targetAmount: string;
  currency: string;
  deadline: string;
  // issue #130 — multi-account; GH #462 — each link with its allocation.
  links: LinkForm[];
  priority: string;
  note: string;
  progressMode: "balance" | "growth";
  startDate: string;
};

const ALLOCATION_LABELS: Record<AllocationChoice, string> = {
  whole: "Whole account",
  amount: "Amount",
  percent: "Percent",
};

/** "C$1,500.00 of Savings", "30% of Savings", or just "Savings". */
function linkLabel(l: GoalAccountLink, goalCurrency: string): string {
  const name = l.accountName || `#${l.accountId}`;
  if (l.allocationKind === "amount" && l.allocationValue != null) {
    return `${formatCurrency(l.allocationValue, goalCurrency)} of ${name}`;
  }
  if (l.allocationKind === "percent" && l.allocationValue != null) {
    return `${Number(l.allocationValue.toFixed(2))}% of ${name}`;
  }
  return name;
}

/** One entry per account any goal links, carrying its claim summary. */
function accountClaimViews(goals: Goal[]): Map<number, AccountClaimView> {
  const out = new Map<number, AccountClaimView>();
  for (const g of goals) {
    for (const l of g.accountLinks ?? []) {
      if (!l.claims || out.has(l.accountId)) continue;
      out.set(l.accountId, {
        ...l.claims,
        accountId: l.accountId,
        accountName: l.accountName,
        accountCurrency: l.accountCurrency,
        accountBalance: l.accountBalance,
      });
    }
  }
  return out;
}

/** "Savings: goals claim $6,000.00 of $5,000.00" (or 130% of it). */
function overAllocationText(c: AccountClaimView): string {
  const name = c.accountName || `#${c.accountId}`;
  if (c.percentClaimed > 100 && c.claimed <= Math.max(c.accountBalance, 0) + 0.005) {
    return `${name}: goals claim ${Number(c.percentClaimed.toFixed(2))}% of it`;
  }
  return `${name}: goals claim ${formatCurrency(c.claimed, c.accountCurrency)} of ${formatCurrency(Math.max(c.accountBalance, 0), c.accountCurrency)}`;
}

const PROGRESS_MODE_LABELS: Record<string, string> = {
  balance: "Reach a balance",
  growth: "Grow by an amount",
};

const goalTypeConfig: Record<string, { label: string; badgeClass: string; borderClass: string }> = {
  savings: { label: "Savings", badgeClass: "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-900/60", borderClass: "border-l-emerald-500" },
  debt_payoff: { label: "Debt Payoff", badgeClass: "bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-950/50 dark:text-rose-300 dark:border-rose-900/60", borderClass: "border-l-rose-500" },
  investment: { label: "Investment", badgeClass: "bg-indigo-100 text-indigo-700 border-indigo-200 dark:bg-indigo-950/50 dark:text-indigo-300 dark:border-indigo-900/60", borderClass: "border-l-indigo-500" },
  emergency_fund: { label: "Emergency Fund", badgeClass: "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-900/60", borderClass: "border-l-amber-500" },
};

// value→label maps for base-ui Select triggers (FINLYNQ-197).
const GOAL_TYPE_LABELS: Record<string, string> = {
  savings: "Savings",
  debt_payoff: "Debt Payoff",
  investment: "Investment",
  emergency_fund: "Emergency Fund",
};
const GOAL_PRIORITY_LABELS: Record<string, string> = {
  "1": "High",
  "2": "Medium",
  "3": "Low",
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
    links: [],
    priority: "1",
    note: "",
    progressMode: "balance",
    startDate: todayISO(),
  };
}

function goalToForm(g: Goal, displayCurrency: string): FormState {
  return {
    name: g.name ?? "",
    type: g.type,
    targetAmount: String(g.targetAmount),
    currency: g.currency || displayCurrency,
    deadline: g.deadline ?? "",
    links: (g.accountIds ?? []).map((accountId): LinkForm => {
      const l = (g.accountLinks ?? []).find((x) => x.accountId === accountId);
      return l?.allocationKind && l.allocationValue != null
        ? { accountId, kind: l.allocationKind, value: String(l.allocationValue) }
        : { accountId, kind: "whole", value: "" };
    }),
    priority: String(g.priority ?? 1),
    note: g.note ?? "",
    progressMode: g.progressMode === "growth" ? "growth" : "balance",
    startDate: g.startDate ?? todayISO(),
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
  claims,
}: {
  mode: "add" | "edit";
  goalId?: number;
  initial: FormState;
  accounts: Account[];
  onSave: () => void;
  onCancel: () => void;
  displayCurrency: string;
  /** GH #462: what the active goals already claim of each account. */
  claims: Map<number, AccountClaimView>;
}) {
  const [form, setForm] = useState<FormState>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const sortAccount = useDropdownOrder("account");
  // Built-in fiat UNION the user's active currencies (#291).
  const currencyOptions = useActiveCurrencies(form.currency);

  function validateForm() {
    const e: Record<string, string> = {};
    if (!form.name.trim()) e.name = "Name is required";
    if (!form.targetAmount || parseFloat(form.targetAmount) <= 0) e.targetAmount = "Target amount must be greater than 0";
    if (form.progressMode === "growth") {
      if (!form.startDate) e.startDate = "Pick the date to count growth from";
      else if (form.startDate > todayISO()) e.startDate = "The start date can't be in the future";
      if (form.links.length === 0) e.accounts = "Link at least one account to measure its growth";
    }
    // GH #462: same rules as the server (lib/goals/allocation.ts).
    for (const l of form.links) {
      if (l.kind === "whole") continue;
      const v = parseFloat(l.value);
      if (!Number.isFinite(v) || v <= 0) {
        e[`link-${l.accountId}`] = l.kind === "percent" ? "Enter a percentage above 0" : "Enter an amount above 0";
      } else if (l.kind === "percent" && v > 100) {
        e[`link-${l.accountId}`] = "A percentage can't be more than 100";
      }
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  const isFormValid = form.name.trim() !== "" && form.targetAmount !== "" && parseFloat(form.targetAmount) > 0;

  // Account chip selector — pick from the unselected pool, remove via the X
  // on each chip. Single-select Combobox is reused as the picker; the
  // selected ids drive the chip row.
  const selectedSet = new Set(form.links.map((l) => l.accountId));
  const availableAccounts = accounts.filter((a) => !selectedSet.has(a.id));

  function addAccount(idStr: string) {
    if (!idStr) return;
    const id = parseInt(idStr);
    if (Number.isNaN(id)) return;
    if (selectedSet.has(id)) return;
    setForm({ ...form, links: [...form.links, { accountId: id, kind: "whole", value: "" }] });
  }

  function removeAccount(id: number) {
    setForm({ ...form, links: form.links.filter((l) => l.accountId !== id) });
    setErrors({ ...errors, [`link-${id}`]: "" });
  }

  function updateLink(id: number, patch: Partial<LinkForm>) {
    setForm({ ...form, links: form.links.map((l) => (l.accountId === id ? { ...l, ...patch } : l)) });
    setErrors({ ...errors, [`link-${id}`]: "" });
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
        // GH #462: links with allocations (the server's accountLinks wins
        // over accountIds; whole-account links send no kind).
        accountLinks: form.links.map((l) =>
          l.kind === "whole"
            ? { accountId: l.accountId, allocationKind: null, allocationValue: null }
            : { accountId: l.accountId, allocationKind: l.kind, allocationValue: parseFloat(l.value) },
        ),
        priority: parseInt(form.priority),
        note: form.note,
        progressMode: form.progressMode,
        startDate: form.progressMode === "growth" ? form.startDate : null,
      };
      let res: Response;
      if (mode === "edit" && goalId != null) {
        payload.id = goalId;
        res = await fetch("/api/goals", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } else {
        res = await fetch("/api/goals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }
      if (!res.ok) {
        // Keep the dialog open with input intact; surface the reason.
        setErrors({ ...errors, form: await parseSaveError(res, "Failed to save goal") });
        return;
      }
      setErrors({ ...errors, form: "" });
      onSave();
    } catch {
      setErrors({ ...errors, form: "Network error. Please try again." });
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
          <Select items={GOAL_TYPE_LABELS} value={form.type} onValueChange={(v) => setForm({ ...form, type: v ?? "savings" })}>
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
              {currencyOptions.map((c) => (
                <SelectItem key={c} value={c}>{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div>
        <Label>Progress</Label>
        <Select
          items={PROGRESS_MODE_LABELS}
          value={form.progressMode}
          onValueChange={(v) => { setForm({ ...form, progressMode: v === "growth" ? "growth" : "balance" }); setErrors({ ...errors, startDate: "", accounts: "" }); }}
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="balance">Reach a balance</SelectItem>
            <SelectItem value="growth">Grow by an amount</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground mt-1">
          {form.progressMode === "growth"
            ? "Counts only how much the linked accounts grow from the start date, so money already in them, or saved there for other goals, isn't counted."
            : "Counts the linked accounts' whole balance."}
        </p>
      </div>
      <div className={form.progressMode === "growth" ? "grid grid-cols-2 gap-3" : ""}>
        <div>
          <Label>{form.progressMode === "growth" ? "Grow by" : "Target Amount"}</Label>
          <Input type="number" step="0.01" value={form.targetAmount} onChange={(e) => { setForm({ ...form, targetAmount: e.target.value }); setErrors({ ...errors, targetAmount: "" }); }} />
          {errors.targetAmount && <p className="text-xs text-destructive mt-1">{errors.targetAmount}</p>}
        </div>
        {form.progressMode === "growth" && (
          <div>
            <Label>Start date</Label>
            <Input type="date" max={todayISO()} value={form.startDate} onChange={(e) => { setForm({ ...form, startDate: e.target.value }); setErrors({ ...errors, startDate: "" }); }} />
            {errors.startDate && <p className="text-xs text-destructive mt-1">{errors.startDate}</p>}
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Deadline</Label>
          <Input type="date" value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} />
        </div>
        <div>
          <Label>Priority</Label>
          <Select items={GOAL_PRIORITY_LABELS} value={form.priority} onValueChange={(v) => setForm({ ...form, priority: v ?? "1" })}>
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
        {form.links.length > 0 && (
          <div className="space-y-2 mb-2">
            {form.links.map((l) => {
              const a = accounts.find((x) => x.id === l.accountId);
              const name = a?.name ?? `#${l.accountId}`;
              const c = claims.get(l.accountId);
              const err = errors[`link-${l.accountId}`];
              return (
                <div key={l.accountId} className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium truncate">{name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${name}`}
                      onClick={() => removeAccount(l.accountId)}
                      className="text-muted-foreground hover:text-destructive shrink-0"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <span className="text-xs text-muted-foreground shrink-0">Counts</span>
                    <Select
                      items={ALLOCATION_LABELS}
                      value={l.kind}
                      onValueChange={(v) => {
                        const kind: AllocationChoice = v === "amount" || v === "percent" ? v : "whole";
                        updateLink(l.accountId, { kind, value: kind === l.kind ? l.value : "" });
                      }}
                    >
                      <SelectTrigger className="h-8 w-[9.5rem]" aria-label={`How much of ${name} this goal counts`}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="whole">Whole account</SelectItem>
                        <SelectItem value="amount">Amount</SelectItem>
                        <SelectItem value="percent">Percent</SelectItem>
                      </SelectContent>
                    </Select>
                    {l.kind !== "whole" && (
                      <div className="flex items-center gap-1 min-w-0 flex-1">
                        <Input
                          type="number"
                          step={l.kind === "percent" ? "1" : "0.01"}
                          min="0"
                          max={l.kind === "percent" ? "100" : undefined}
                          className="h-8 min-w-0"
                          aria-label={l.kind === "percent" ? `Percent of ${name}` : `Amount of ${name}`}
                          value={l.value}
                          onChange={(e) => updateLink(l.accountId, { value: e.target.value })}
                        />
                        <span className="text-xs text-muted-foreground shrink-0">
                          {l.kind === "percent" ? "%" : form.currency || displayCurrency}
                        </span>
                      </div>
                    )}
                  </div>
                  {err && <p className="text-xs text-destructive mt-1">{err}</p>}
                  {c && (
                    <p className={`text-xs mt-1 ${c.overAllocated ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}>
                      {c.overAllocated
                        ? `${overAllocationText(c)} (${c.goalCount} goal${c.goalCount === 1 ? "" : "s"})`
                        : `Balance ${formatCurrency(c.accountBalance, c.accountCurrency)} · not counted by any goal: ${formatCurrency(Math.max(c.unallocated, 0), c.accountCurrency)}`}
                    </p>
                  )}
                </div>
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
            (a, z) => (a.label ?? "").localeCompare(z.label ?? ""),
          )}
          placeholder={form.links.length === 0 ? "Add an account…" : "Add another…"}
          searchPlaceholder="Search accounts…"
          emptyMessage="No matches"
          className="w-full"
        />
        {errors.accounts && <p className="text-xs text-destructive mt-1">{errors.accounts}</p>}
        <p className="text-xs text-muted-foreground mt-1">
          {form.progressMode === "growth"
            ? "Growth is measured across every linked account, from their balance the day before the start date."
            : "Goal progress sums transactions across every linked account. Leave empty for manual tracking."}
          {form.links.length > 0 && " When goals share an account, count an amount or a percent of it so its money isn't counted twice."}
        </p>
      </div>
      <div>
        <Label>Note</Label>
        <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
      </div>
      {errors.form && <p className="text-sm text-destructive">{errors.form}</p>}
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
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editGoal, setEditGoal] = useState<Goal | null>(null);
  const [seedForm, setSeedForm] = useState<FormState>(emptyForm(displayCurrency));
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Completing a goal asks first (GH #470): the checkmark sits next to Edit.
  const [completeId, setCompleteId] = useState<number | null>(null);
  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState("");

  const load = useCallback(() => {
    setLoadError(false);
    fetch("/api/goals")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Failed to load goals"))))
      .then((data) => setGoals(Array.isArray(data) ? data : []))
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    load();
    fetch("/api/accounts")
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setAccounts(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, [load]);

  async function toggleStatus(goal: Goal) {
    const res = await fetch("/api/goals", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: goal.id, status: goal.status === "active" ? "completed" : "active" }) });
    load();
    return res;
  }

  async function handleComplete() {
    const goal = goals.find((g) => g.id === completeId);
    if (!goal) return;
    setCompleting(true);
    setCompleteError("");
    try {
      const res = await toggleStatus(goal);
      if (!res.ok) {
        setCompleteError(await parseSaveError(res, "Could not mark the goal complete."));
        return;
      }
      setCompleteId(null);
    } catch {
      setCompleteError("Could not reach the server. Try again.");
    } finally {
      setCompleting(false);
    }
  }

  async function handleDelete() {
    if (deleteId == null) return;
    setDeleting(true);
    try {
      await fetch(`/api/goals?id=${deleteId}`, { method: "DELETE" });
      setDeleteId(null);
      load();
    } finally {
      setDeleting(false);
    }
  }

  const deletingGoal = goals.find((g) => g.id === deleteId) ?? null;
  const completingGoal = goals.find((g) => g.id === completeId) ?? null;

  const active = goals.filter((g) => g.status === "active");
  const completed = goals.filter((g) => g.status === "completed");
  // Each goal is measured in its OWN currency; the tiles total the server's
  // display-currency conversions so a ¥ goal and a $ goal don't sum as one.
  const totalTarget = active.reduce((s, g) => s + (g.targetAmountDisplay ?? g.targetAmount), 0);
  const totalCurrent = active.reduce((s, g) => s + (g.currentAmountDisplay ?? g.currentAmount), 0);
  const hasForeignGoal = active.some((g) => g.currency && g.currency !== displayCurrency);
  // GH #462: per account, what the active goals claim of it; warn when more
  // than it holds (a warning only: a balance can drop below the claims).
  const claims = accountClaimViews(goals);
  const overAllocated = [...claims.values()].filter((c) => c.overAllocated);

  if (loading) return <PageSkeleton variant="cards" rows={3} />;
  if (loadError) return <ErrorState title="Couldn't load goals" message="We couldn't load your goals. Please try again." onRetry={() => { setLoading(true); load(); }} />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Financial Goals</h1>
          <p className="text-sm text-muted-foreground mt-1">Track your savings targets and measure progress over time</p>
        </div>
        <Dialog open={addOpen} onOpenChange={(o) => { setAddOpen(o); if (!o) setSeedForm(emptyForm(displayCurrency)); }}>
          <DialogTrigger render={<Button />}><Plus className="h-4 w-4 mr-1" /> Add Goal</DialogTrigger>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader><DialogTitle>New Financial Goal</DialogTitle></DialogHeader>
            <GoalEditForm
              mode="add"
              initial={seedForm}
              accounts={accounts}
              displayCurrency={displayCurrency}
              claims={claims}
              onSave={() => { setAddOpen(false); setSeedForm(emptyForm(displayCurrency)); load(); }}
              onCancel={() => { setAddOpen(false); setSeedForm(emptyForm(displayCurrency)); }}
            />
          </DialogContent>
        </Dialog>
      </div>

      {/* Edit dialog — issue #130 */}
      <Dialog open={editGoal !== null} onOpenChange={(o) => { if (!o) setEditGoal(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>Edit Goal</DialogTitle></DialogHeader>
          {editGoal && (
            <GoalEditForm
              mode="edit"
              goalId={editGoal.id}
              initial={goalToForm(editGoal, displayCurrency)}
              accounts={accounts}
              displayCurrency={displayCurrency}
              claims={claims}
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
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100 dark:bg-indigo-950/40">
                <Target className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Total Target</p>
                <p className="text-2xl font-bold">{formatCurrency(totalTarget, displayCurrency)}</p>
                {hasForeignGoal && <p className="text-xs text-muted-foreground mt-1">converted at today&apos;s rates</p>}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-4 pt-6">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100 dark:bg-emerald-950/40">
                <TrendingUp className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Current Progress</p>
                <p className="text-2xl font-bold text-emerald-600">{formatCurrency(totalCurrent, displayCurrency)}</p>
                {hasForeignGoal && <p className="text-xs text-muted-foreground mt-1">converted at today&apos;s rates</p>}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-4 pt-6">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-100 dark:bg-violet-950/40">
                <CheckCircle2 className="h-5 w-5 text-violet-600 dark:text-violet-400" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Completed</p>
                <p className="text-2xl font-bold">{completed.length} <span className="text-base font-normal text-muted-foreground">/ {goals.length}</span></p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* GH #462: over-allocated accounts */}
      {overAllocated.length > 0 && (
        <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p className="font-medium">Some accounts are counted by goals for more than they hold</p>
              <ul className="space-y-0.5">
                {overAllocated.map((c) => (
                  <li key={c.accountId}>{overAllocationText(c)}</li>
                ))}
              </ul>
              <p className="text-xs opacity-80">
                Edit a goal and set how much of the account it counts (an amount or a percent) so the money isn&apos;t counted twice.
              </p>
            </div>
          </div>
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
                      {g.progressMode === "growth" && g.startDate && (
                        <Badge variant="outline" className="gap-1">
                          <TrendingUp className="h-3 w-3" />
                          Growth since {g.startDate}
                        </Badge>
                      )}
                      {g.currency && g.currency !== displayCurrency && (
                        <Badge variant="outline" className="font-mono text-xs">{g.currency}</Badge>
                      )}
                      {/* Issue #130 — every linked account as its own chip; GH #462 — with its allocation. */}
                      {g.accountLinks
                        ? g.accountLinks.map((l) => (
                            <Badge
                              key={l.accountId}
                              variant="secondary"
                              className={l.claims?.overAllocated ? "ring-1 ring-amber-400 dark:ring-amber-700" : undefined}
                              title={l.claims?.overAllocated ? "Goals count more of this account than it holds" : undefined}
                            >
                              {linkLabel(l, g.currency || displayCurrency)}
                            </Badge>
                          ))
                        : (g.accounts ?? []).filter((n) => n).map((name, i) => (
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
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setEditGoal(g)} title="Edit" aria-label={`Edit goal ${g.name}`}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => { setCompleteError(""); setCompleteId(g.id); }} title="Mark complete" aria-label={`Mark goal ${g.name} complete`}>
                    <CheckCircle2 className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => setDeleteId(g.id)} title="Delete" aria-label={`Delete goal ${g.name}`}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>
                    {g.progressMode === "growth" ? "Grew " : ""}
                    {formatCurrency(g.currentAmount, g.currency || displayCurrency)} of {formatCurrency(g.targetAmount, g.currency || displayCurrency)}
                  </span>
                  <span className={`font-bold ${progressTextClass(g.progress)}`}>{g.progress}%</span>
                </div>
                <Progress value={g.progress} className={`h-3 ${progressColorClass(g.progress)}`} />
                {g.progressMode === "growth" && g.startAmount != null && (
                  <p className="text-xs text-muted-foreground">
                    Linked balance {formatCurrency(g.startAmount, g.currency || displayCurrency)} at the start, {formatCurrency(g.balanceNow ?? 0, g.currency || displayCurrency)} now
                  </p>
                )}
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Remaining: <span className="font-medium text-foreground">{formatCurrency(g.remaining, g.currency || displayCurrency)}</span></span>
                  {g.monthlyNeeded > 0 && (
                    <span className="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 ring-1 ring-inset ring-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-300 dark:ring-indigo-900/60">
                      {formatCurrency(g.monthlyNeeded, g.currency || displayCurrency)}/mo needed
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
            <Card key={g.id} className="border-l-4 border-l-emerald-400 bg-emerald-50/30 dark:bg-emerald-950/20">
              <CardContent className="py-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <div>
                    <span className="line-through text-muted-foreground">{g.name}</span>
                    <Badge className="ml-2 bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-900/60">{formatCurrency(g.targetAmount, g.currency || displayCurrency)}</Badge>
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditGoal(g)} title="Edit" aria-label={`Edit goal ${g.name}`}>
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => toggleStatus(g)} title="Reactivate" aria-label={`Reactivate goal ${g.name}`}>
                    <Target className="h-3 w-3" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => setDeleteId(g.id)} title="Delete" aria-label={`Delete goal ${g.name}`}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={(open) => { if (!open) setDeleteId(null); }}
        title="Delete goal"
        description={<>Are you sure you want to delete <strong>{deletingGoal?.name ?? "this goal"}</strong>? This cannot be undone.</>}
        confirmLabel="Delete goal"
        busy={deleting}
        onConfirm={handleDelete}
      />

      <ConfirmDialog
        open={completeId !== null}
        onOpenChange={(open) => { if (!open) { setCompleteId(null); setCompleteError(""); } }}
        tone="default"
        title="Mark goal complete"
        description={
          completingGoal ? (
            <div className="space-y-2">
              <p>
                Mark <strong>{completingGoal.name}</strong> as complete? It moves to Completed goals, and you can reactivate it any time.
              </p>
              {completingGoal.progress < 100 && (
                <p className="text-amber-700 dark:text-amber-400">
                  It&apos;s at {completingGoal.progress}% ({formatCurrency(completingGoal.currentAmount, completingGoal.currency || displayCurrency)} of{" "}
                  {formatCurrency(completingGoal.targetAmount, completingGoal.currency || displayCurrency)}), short of its target.
                </p>
              )}
              {completeError && <p className="text-destructive">{completeError}</p>}
            </div>
          ) : null
        }
        confirmLabel="Complete goal"
        busy={completing}
        busyLabel="Saving…"
        onConfirm={handleComplete}
      />
    </div>
  );
}
