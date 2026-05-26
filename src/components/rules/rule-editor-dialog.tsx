"use client";

/**
 * Shared transaction-rule editor dialog (FINLYNQ-90).
 *
 * Extracted from `/settings/rules/page.tsx` so two call-sites can share the
 * exact same editor surface:
 *
 *   1. `/settings/rules` — full CRUD over the user's rule list. Submits
 *      to `POST/PUT /api/rules`.
 *   2. `/import/pending` UnresolvedCategoriesBanner — per-row "Create
 *      rule" button on the reconciliation banner. Submits to
 *      `POST /api/import/staged/[id]/create-rule` (legacy + v2 both
 *      accepted by that endpoint; this editor emits v2).
 *
 * Design rule (load-bearing):
 *
 *   The editor NEVER bakes in a URL. The caller's `onSubmit` callback owns
 *   the fetch and returns `{ ok, error? }`. On `{ ok: false }` the editor
 *   renders the error inline (via the existing AlertTriangle banner) and
 *   stays open. Without this, the two call-sites cannot share the form.
 *
 * Reuses (do NOT re-copy):
 *
 *   - `Condition`, `Action`, `ConditionGroup` from `@/lib/rules/schema`
 *   - `computePureActionPatch` from `@/lib/rules/execute` (live-preview panel)
 *   - shadcn primitives (Dialog / Select / Input / Button / Label / Combobox)
 *   - `useDropdownOrder("category")` from `@/components/dropdown-order-provider`
 *     (FINLYNQ-89 — category Combobox sorted by user's saved order)
 *
 * Phase-3 callers (banner) seed the editor with a payee/contains condition +
 * a pre-filled rule name. The editor does NOT pre-filter side-effect actions
 * (`set_account`, `create_transfer`) — the server is the authority on what
 * gets accepted, and the editor surfaces any refusal inline. This matches
 * the CLAUDE.md "Auto-categorize rules" gotcha decision (server-side gate,
 * UI shows the full surface).
 */

import { useMemo, useState } from "react";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Combobox, type ComboboxItemShape } from "@/components/ui/combobox";
import { useDropdownOrder } from "@/components/dropdown-order-provider";
import {
  Plus, Trash2, AlertTriangle, ChevronUp, ChevronDown,
} from "lucide-react";
import { computePureActionPatch } from "@/lib/rules/execute";
import type { Condition, Action, ConditionGroup } from "@/lib/rules/schema";

export type Category = { id: number; name: string; type: string; group: string };
export type Account = { id: number; name: string };
export type Holding = { id: number; name: string };

export type RuleSeed = {
  id?: number;
  name: string;
  conditions: ConditionGroup;
  actions: Action[];
  priority: number;
  isActive: boolean;
};

export type RuleEditorPayload = {
  name: string;
  conditions: ConditionGroup;
  actions: Action[];
  priority: number;
  isActive: boolean;
};

export type SubmitResult = { ok: true } | { ok: false; error: string };

export interface RuleEditorDialogProps {
  /** When set, the editor opens in edit-mode and uses the seed's id on submit. */
  rule?: RuleSeed | null;
  /** Seeds for fresh dialogs (banner call-site uses these). Ignored when `rule` is set. */
  initialName?: string;
  initialConditions?: Condition[];
  initialActions?: Action[];
  initialPriority?: number;
  initialIsActive?: boolean;
  categories: Category[];
  accounts: Account[];
  holdings: Holding[];
  onClose: (saved: boolean) => void;
  onSubmit: (payload: RuleEditorPayload) => Promise<SubmitResult>;
  /** Defaults to "Create rule" / "Update rule" based on whether `rule` is set. */
  submitLabel?: string;
  /** Defaults to "New rule" / "Edit rule" based on whether `rule` is set. */
  title?: string;
}

export const CONDITION_FIELDS: Array<{ value: Condition["field"]; label: string }> = [
  { value: "payee", label: "Payee" },
  { value: "note", label: "Note" },
  { value: "tags", label: "Tags" },
  { value: "amount", label: "Amount" },
  { value: "account", label: "Account" },
  { value: "currency", label: "Currency" },
  { value: "date", label: "Date" },
];

export const ACTION_KINDS: Array<{ value: Action["kind"]; label: string; sideEffect?: true }> = [
  { value: "set_category", label: "Set category" },
  { value: "set_tags", label: "Set tags" },
  { value: "rename_payee", label: "Rename payee" },
  { value: "set_entered_currency", label: "Set entered currency" },
  { value: "set_portfolio_holding", label: "Set holding" },
  { value: "set_account", label: "Move to account (approve-time only)", sideEffect: true },
  { value: "create_transfer", label: "Create transfer pair (approve-time only)", sideEffect: true },
];

export function blankCondition(): Condition {
  return { field: "payee", op: "contains", value: "" } as Condition;
}

export function blankAction(): Action {
  return { kind: "set_category", categoryId: 0 } as Action;
}

export function RuleEditorDialog({
  rule,
  initialName,
  initialConditions,
  initialActions,
  initialPriority,
  initialIsActive,
  categories,
  accounts,
  holdings,
  onClose,
  onSubmit,
  submitLabel,
  title,
}: RuleEditorDialogProps) {
  const [name, setName] = useState(rule?.name ?? initialName ?? "");
  const [priority, setPriority] = useState(rule?.priority ?? initialPriority ?? 0);
  const [isActive, setIsActive] = useState(rule?.isActive ?? initialIsActive ?? true);
  const [conditions, setConditions] = useState<Condition[]>(
    rule?.conditions?.all ?? initialConditions ?? [blankCondition()],
  );
  const [actions, setActions] = useState<Action[]>(
    rule?.actions ?? initialActions ?? [blankAction()],
  );
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Live preview state.
  const [samplePayee, setSamplePayee] = useState("Whole Foods");
  const [sampleAmount, setSampleAmount] = useState(100);
  const livePatch = useMemo(() => {
    return computePureActionPatch(actions);
  }, [actions]);

  function updateCondition(i: number, patch: Partial<Condition>) {
    const next = [...conditions];
    next[i] = { ...next[i], ...patch } as Condition;
    setConditions(next);
  }
  function moveAction(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= actions.length) return;
    const next = [...actions];
    [next[i], next[j]] = [next[j], next[i]];
    setActions(next);
  }
  function updateAction(i: number, patch: Partial<Action>) {
    const next = [...actions];
    next[i] = { ...next[i], ...patch } as Action;
    setActions(next);
  }

  async function handleSave() {
    setError("");
    if (!name.trim()) { setError("Name is required"); return; }
    if (conditions.length === 0) { setError("At least one condition is required"); return; }
    if (actions.length === 0) { setError("At least one action is required"); return; }
    setSubmitting(true);
    try {
      const result = await onSubmit({
        name: name.trim(),
        conditions: { all: conditions },
        actions,
        priority,
        isActive,
      });
      if (!result.ok) {
        setError(result.error ?? "Failed to save rule");
        return;
      }
      onClose(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const computedTitle = title ?? (rule ? "Edit rule" : "New rule");
  const computedSubmitLabel = submitLabel ?? (rule ? "Update rule" : "Create rule");

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(false); }}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{computedTitle}</DialogTitle>
        </DialogHeader>

        {error && (
          <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-lg">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Rule name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Grocery stores" />
            </div>
            <div>
              <Label>Priority</Label>
              <Input type="number" value={priority} onChange={(e) => setPriority(parseInt(e.target.value) || 0)} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="rule-active" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            <Label htmlFor="rule-active">Active</Label>
          </div>

          {/* Conditions */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Conditions (AND — all must match)</Label>
              <Button size="sm" variant="outline" onClick={() => setConditions([...conditions, blankCondition()])}>
                <Plus className="h-3 w-3 mr-1" /> Add condition
              </Button>
            </div>
            {conditions.map((cond, i) => (
              <ConditionRow
                key={i}
                cond={cond}
                accounts={accounts}
                onChange={(patch) => updateCondition(i, patch)}
                onRemove={() => setConditions(conditions.filter((_, j) => j !== i))}
              />
            ))}
          </div>

          {/* Actions */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Actions (applied in order)</Label>
              <Button size="sm" variant="outline" onClick={() => setActions([...actions, blankAction()])}>
                <Plus className="h-3 w-3 mr-1" /> Add action
              </Button>
            </div>
            {actions.map((act, i) => (
              <ActionRow
                key={i}
                action={act}
                categories={categories}
                accounts={accounts}
                holdings={holdings}
                onChange={(patch) => updateAction(i, patch)}
                onRemove={() => setActions(actions.filter((_, j) => j !== i))}
                onMoveUp={i > 0 ? () => moveAction(i, -1) : undefined}
                onMoveDown={i < actions.length - 1 ? () => moveAction(i, 1) : undefined}
              />
            ))}
          </div>

          {/* Live preview */}
          <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Live preview (pure actions only)</Label>
            <div className="grid grid-cols-2 gap-2">
              <Input value={samplePayee} onChange={(e) => setSamplePayee(e.target.value)} placeholder="Sample payee" />
              <Input type="number" value={sampleAmount} onChange={(e) => setSampleAmount(parseFloat(e.target.value) || 0)} placeholder="Sample amount" />
            </div>
            <div className="text-xs space-y-0.5 text-muted-foreground">
              <p>Sample: <span className="font-mono">{samplePayee || "(empty)"}</span> @ ${sampleAmount}</p>
              <p>Action patch: <span className="font-mono">{JSON.stringify(livePatch)}</span></p>
              <p className="italic">Side-effect actions (set_account, create_transfer) only fire from the staging-approve path; they don&apos;t appear in the patch.</p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onClose(false)} disabled={submitting}>Cancel</Button>
          <Button onClick={handleSave} disabled={submitting}>
            {submitting ? "Saving…" : computedSubmitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConditionRow({
  cond,
  accounts,
  onChange,
  onRemove,
}: {
  cond: Condition;
  accounts: Account[];
  onChange: (patch: Partial<Condition>) => void;
  onRemove: () => void;
}) {
  function setField(field: Condition["field"]) {
    // When switching field, blank to a safe default for the new shape.
    if (field === "payee" || field === "note" || field === "tags") {
      onChange({ field, op: "contains", value: "" } as unknown as Partial<Condition>);
    } else if (field === "amount") {
      onChange({ field, op: "gt", value: 0 } as unknown as Partial<Condition>);
    } else if (field === "account") {
      onChange({ field, op: "is", accountId: accounts[0]?.id ?? 0 } as unknown as Partial<Condition>);
    } else if (field === "currency") {
      onChange({ field, op: "is", value: "CAD" } as unknown as Partial<Condition>);
    } else if (field === "date") {
      onChange({ field, op: "weekday", weekday: 1 } as unknown as Partial<Condition>);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Select value={cond.field} onValueChange={(v) => setField((v ?? "payee") as Condition["field"])}>
        <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
        <SelectContent>
          {CONDITION_FIELDS.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
        </SelectContent>
      </Select>

      {/* Operator + value vary per field. */}
      {(cond.field === "payee" || cond.field === "note" || cond.field === "tags") && (
        <>
          <Select value={cond.op} onValueChange={(v) => onChange({ op: (v ?? "contains") as "contains" | "exact" | "regex" } as Partial<Condition>)}>
            <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="contains">contains</SelectItem>
              <SelectItem value="exact">exact</SelectItem>
              <SelectItem value="regex">regex</SelectItem>
            </SelectContent>
          </Select>
          <Input value={(cond as { value: string }).value ?? ""} onChange={(e) => onChange({ value: e.target.value } as Partial<Condition>)} className="flex-1" />
        </>
      )}

      {cond.field === "amount" && cond.op !== "between" && (
        <>
          <Select value={cond.op} onValueChange={(v) => onChange({ op: (v ?? "gt") as "gt" | "lt" | "eq" | "between" } as Partial<Condition>)}>
            <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="gt">&gt;</SelectItem>
              <SelectItem value="lt">&lt;</SelectItem>
              <SelectItem value="eq">=</SelectItem>
              <SelectItem value="between">between</SelectItem>
            </SelectContent>
          </Select>
          <Input type="number" value={(cond as { value: number }).value} onChange={(e) => onChange({ value: parseFloat(e.target.value) || 0 } as Partial<Condition>)} className="flex-1" />
        </>
      )}
      {cond.field === "amount" && cond.op === "between" && (
        <>
          <Select value="between" onValueChange={(v) => onChange({ op: (v ?? "between") as "gt" | "lt" | "eq" | "between" } as Partial<Condition>)}>
            <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="gt">&gt;</SelectItem>
              <SelectItem value="lt">&lt;</SelectItem>
              <SelectItem value="eq">=</SelectItem>
              <SelectItem value="between">between</SelectItem>
            </SelectContent>
          </Select>
          <Input type="number" value={(cond as { min: number }).min ?? 0} onChange={(e) => onChange({ min: parseFloat(e.target.value) || 0 } as Partial<Condition>)} className="w-24" placeholder="min" />
          <Input type="number" value={(cond as { max: number }).max ?? 0} onChange={(e) => onChange({ max: parseFloat(e.target.value) || 0 } as Partial<Condition>)} className="w-24" placeholder="max" />
        </>
      )}

      {cond.field === "account" && (
        <>
          <Select value={cond.op} onValueChange={(v) => onChange({ op: (v ?? "is") as "is" | "is_not" } as Partial<Condition>)}>
            <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="is">is</SelectItem>
              <SelectItem value="is_not">is not</SelectItem>
            </SelectContent>
          </Select>
          <Combobox
            value={String((cond as { accountId: number }).accountId)}
            onValueChange={(v) => onChange({ accountId: parseInt(v ?? "0") } as Partial<Condition>)}
            items={accounts.map((a): ComboboxItemShape => ({ value: String(a.id), label: a.name }))}
            placeholder="Select account"
            searchPlaceholder="Search accounts…"
            emptyMessage="No matches"
            className="flex-1"
          />
        </>
      )}

      {cond.field === "currency" && (
        <>
          <Select value={cond.op} onValueChange={(v) => onChange({ op: (v ?? "is") as "is" | "is_not" } as Partial<Condition>)}>
            <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="is">is</SelectItem>
              <SelectItem value="is_not">is not</SelectItem>
            </SelectContent>
          </Select>
          <Input value={(cond as { value: string }).value ?? ""} onChange={(e) => onChange({ value: e.target.value.toUpperCase() } as Partial<Condition>)} placeholder="USD" className="w-24" />
        </>
      )}

      {cond.field === "date" && cond.op === "weekday" && (
        <>
          <Select value="weekday" onValueChange={(v) => onChange({ op: (v ?? "weekday") as "weekday" | "day_of_month" | "between" } as Partial<Condition>)}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="weekday">weekday is</SelectItem>
              <SelectItem value="day_of_month">day of month</SelectItem>
              <SelectItem value="between">between</SelectItem>
            </SelectContent>
          </Select>
          <Input type="number" min={0} max={6} value={(cond as { weekday: number }).weekday} onChange={(e) => onChange({ weekday: parseInt(e.target.value) || 0 } as Partial<Condition>)} className="w-20" />
          <span className="text-xs text-muted-foreground">0=Sun…6=Sat (UTC)</span>
        </>
      )}
      {cond.field === "date" && cond.op === "day_of_month" && (
        <>
          <Select value="day_of_month" onValueChange={(v) => onChange({ op: (v ?? "day_of_month") as "weekday" | "day_of_month" | "between" } as Partial<Condition>)}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="weekday">weekday is</SelectItem>
              <SelectItem value="day_of_month">day of month</SelectItem>
              <SelectItem value="between">between</SelectItem>
            </SelectContent>
          </Select>
          <Input type="number" min={1} max={31} value={(cond as { day: number }).day} onChange={(e) => onChange({ day: parseInt(e.target.value) || 1 } as Partial<Condition>)} className="w-20" />
        </>
      )}
      {cond.field === "date" && cond.op === "between" && (
        <>
          <Select value="between" onValueChange={(v) => onChange({ op: (v ?? "between") as "weekday" | "day_of_month" | "between" } as Partial<Condition>)}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="weekday">weekday is</SelectItem>
              <SelectItem value="day_of_month">day of month</SelectItem>
              <SelectItem value="between">between</SelectItem>
            </SelectContent>
          </Select>
          <Input type="date" value={(cond as { from: string }).from} onChange={(e) => onChange({ from: e.target.value } as Partial<Condition>)} className="w-36" />
          <Input type="date" value={(cond as { to: string }).to} onChange={(e) => onChange({ to: e.target.value } as Partial<Condition>)} className="w-36" />
        </>
      )}

      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={onRemove}>
        <Trash2 className="h-3 w-3" />
      </Button>
    </div>
  );
}

function ActionRow({
  action,
  categories,
  accounts,
  holdings,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  action: Action;
  categories: Category[];
  accounts: Account[];
  holdings: Holding[];
  onChange: (patch: Partial<Action>) => void;
  onRemove: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const sortCategory = useDropdownOrder("category");

  function setKind(kind: Action["kind"]) {
    if (kind === "set_category") onChange({ kind, categoryId: categories[0]?.id ?? 0 } as unknown as Partial<Action>);
    else if (kind === "set_tags") onChange({ kind, tags: "" } as unknown as Partial<Action>);
    else if (kind === "rename_payee") onChange({ kind, to: "" } as unknown as Partial<Action>);
    else if (kind === "set_account") onChange({ kind, accountId: accounts[0]?.id ?? 0 } as unknown as Partial<Action>);
    else if (kind === "set_entered_currency") onChange({ kind, currency: "USD" } as unknown as Partial<Action>);
    else if (kind === "set_portfolio_holding") onChange({ kind, holdingId: holdings[0]?.id ?? 0 } as unknown as Partial<Action>);
    else if (kind === "create_transfer") onChange({ kind, destAccountId: accounts[0]?.id ?? 0 } as unknown as Partial<Action>);
  }

  const isSideEffect = action.kind === "set_account" || action.kind === "create_transfer";

  return (
    <div className={`flex items-center gap-2 ${isSideEffect ? "border-l-2 border-amber-500/50 pl-2" : ""}`}>
      <Select value={action.kind} onValueChange={(v) => setKind((v ?? "set_category") as Action["kind"])}>
        <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
        <SelectContent>
          {ACTION_KINDS.map((k) => <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>)}
        </SelectContent>
      </Select>

      {action.kind === "set_category" && (
        <Combobox
          value={String(action.categoryId)}
          onValueChange={(v) => onChange({ categoryId: parseInt(v ?? "0") } as Partial<Action>)}
          items={sortCategory(
            categories.map((c): ComboboxItemShape => ({ value: String(c.id), label: `${c.group} — ${c.name}` })),
            (c) => Number(c.value),
            (a, z) => (a.label ?? "").localeCompare(z.label ?? ""),
          )}
          placeholder="Select category"
          searchPlaceholder="Search categories…"
          emptyMessage="No matches"
          className="flex-1"
        />
      )}
      {action.kind === "set_tags" && (
        <Input value={action.tags} onChange={(e) => onChange({ tags: e.target.value } as Partial<Action>)} placeholder="tag1, tag2" className="flex-1" />
      )}
      {action.kind === "rename_payee" && (
        <Input value={action.to} onChange={(e) => onChange({ to: e.target.value } as Partial<Action>)} placeholder="Clean payee" className="flex-1" />
      )}
      {action.kind === "set_account" && (
        <Combobox
          value={String(action.accountId)}
          onValueChange={(v) => onChange({ accountId: parseInt(v ?? "0") } as Partial<Action>)}
          items={accounts.map((a): ComboboxItemShape => ({ value: String(a.id), label: a.name }))}
          placeholder="Select account"
          searchPlaceholder="Search accounts…"
          emptyMessage="No matches"
          className="flex-1"
        />
      )}
      {action.kind === "set_entered_currency" && (
        <Input value={action.currency} onChange={(e) => onChange({ currency: e.target.value.toUpperCase() } as Partial<Action>)} placeholder="USD" className="w-24" />
      )}
      {action.kind === "set_portfolio_holding" && (
        <Combobox
          value={String(action.holdingId)}
          onValueChange={(v) => onChange({ holdingId: parseInt(v ?? "0") } as Partial<Action>)}
          items={holdings.map((h): ComboboxItemShape => ({ value: String(h.id), label: h.name }))}
          placeholder="Select holding"
          searchPlaceholder="Search holdings…"
          emptyMessage="No matches"
          className="flex-1"
        />
      )}
      {action.kind === "create_transfer" && (
        <Combobox
          value={String(action.destAccountId)}
          onValueChange={(v) => onChange({ destAccountId: parseInt(v ?? "0") } as Partial<Action>)}
          items={accounts.map((a): ComboboxItemShape => ({ value: String(a.id), label: a.name }))}
          placeholder="Select destination account"
          searchPlaceholder="Search accounts…"
          emptyMessage="No matches"
          className="flex-1"
        />
      )}

      <div className="flex">
        {onMoveUp && (
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onMoveUp}>
            <ChevronUp className="h-3 w-3" />
          </Button>
        )}
        {onMoveDown && (
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onMoveDown}>
            <ChevronDown className="h-3 w-3" />
          </Button>
        )}
      </div>
      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={onRemove}>
        <Trash2 className="h-3 w-3" />
      </Button>
    </div>
  );
}
