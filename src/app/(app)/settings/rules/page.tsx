"use client";

/**
 * /settings/rules — Transaction Rules manager (FINLYNQ-84).
 *
 * Multi-condition + multi-action rule editor. The legacy single-field rule
 * UI on /settings/categorization (matchField/matchType/matchValue +
 * assignCategoryId/assignTags/renameTo) was deleted in 2026-05-21 as part
 * of this work; rules now live exclusively here.
 *
 * Surface:
 *  - Rule list sorted by priority DESC, each card shows an
 *    auto-generated plain-English summary plus active toggle / edit / delete.
 *  - Editor dialog: name, priority, isActive, multi-condition list,
 *    multi-action list, live preview that runs `computePureActionPatch`
 *    client-side against a user-typed sample transaction input.
 *
 * Load-bearing UI rules (per CLAUDE.md / plan):
 *  - Conditions are AND-only (no OR groups in v2).
 *  - Actions are an ordered list; pure actions land via the patch, side-
 *    effect actions (`set_account`, `create_transfer`) only fire from the
 *    staging-approve path.
 *  - FK lookups (categories / accounts / holdings) are batched on load —
 *    the GET /api/rules response already includes decrypted names; we
 *    fetch the FK option lists once for the editor.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Combobox, type ComboboxItemShape } from "@/components/ui/combobox";
import { useDropdownOrder } from "@/components/dropdown-order-provider";
import {
  Zap, Plus, Trash2, AlertTriangle, ChevronUp, ChevronDown,
} from "lucide-react";
import { computePureActionPatch } from "@/lib/rules/execute";
import type { Condition, Action } from "@/lib/rules/schema";

type Category = { id: number; name: string; type: string; group: string };
type Account = { id: number; name: string };
type Holding = { id: number; name: string };

type RuleRow = {
  id: number;
  name: string;
  conditions: { all: Condition[] };
  actions: Action[];
  isActive: boolean;
  priority: number;
  createdAt: string;
  updatedAt: string | null;
  actionFKNames?: {
    categories: Record<string, string | null>;
    accounts: Record<string, string | null>;
    holdings: Record<string, string | null>;
  };
};

const CONDITION_FIELDS: Array<{ value: Condition["field"]; label: string }> = [
  { value: "payee", label: "Payee" },
  { value: "note", label: "Note" },
  { value: "tags", label: "Tags" },
  { value: "amount", label: "Amount" },
  { value: "account", label: "Account" },
  { value: "currency", label: "Currency" },
  { value: "date", label: "Date" },
];

const ACTION_KINDS: Array<{ value: Action["kind"]; label: string; sideEffect?: true }> = [
  { value: "set_category", label: "Set category" },
  { value: "set_tags", label: "Set tags" },
  { value: "rename_payee", label: "Rename payee" },
  { value: "set_entered_currency", label: "Set entered currency" },
  { value: "set_portfolio_holding", label: "Set holding" },
  { value: "set_account", label: "Move to account (approve-time only)", sideEffect: true },
  { value: "create_transfer", label: "Create transfer pair (approve-time only)", sideEffect: true },
];

function blankCondition(): Condition {
  return { field: "payee", op: "contains", value: "" } as Condition;
}

function blankAction(): Action {
  return { kind: "set_category", categoryId: 0 } as Action;
}

function summarizeConditions(group: { all: Condition[] }, fkNames?: RuleRow["actionFKNames"]): string {
  if (group.all.length === 0) return "(no conditions)";
  return group.all.map((c) => describeCondition(c, fkNames)).join(" AND ");
}

function describeCondition(c: Condition, fkNames?: RuleRow["actionFKNames"]): string {
  switch (c.field) {
    case "payee":
    case "note":
    case "tags":
      return `${c.field} ${c.op} "${c.value}"`;
    case "amount":
      if (c.op === "between") return `amount between ${c.min}-${c.max}`;
      return `amount ${c.op} ${c.value}`;
    case "account": {
      const name = fkNames?.accounts?.[String(c.accountId)] ?? `#${c.accountId}`;
      return `account ${c.op} ${name}`;
    }
    case "currency":
      return `currency ${c.op} ${c.value}`;
    case "date":
      if (c.op === "weekday") return `date weekday=${c.weekday}`;
      if (c.op === "day_of_month") return `date day=${c.day}`;
      return `date in ${c.from}…${c.to}`;
  }
}

function summarizeActions(actions: Action[], fkNames?: RuleRow["actionFKNames"]): string {
  if (actions.length === 0) return "(no actions)";
  return actions.map((a) => describeAction(a, fkNames)).join(", ");
}

function describeAction(a: Action, fkNames?: RuleRow["actionFKNames"]): string {
  switch (a.kind) {
    case "set_category": {
      const name = fkNames?.categories?.[String(a.categoryId)] ?? `#${a.categoryId}`;
      return `set category → ${name}`;
    }
    case "set_tags":
      return `set tags → "${a.tags}"`;
    case "rename_payee":
      return `rename payee → "${a.to}"`;
    case "set_account": {
      const name = fkNames?.accounts?.[String(a.accountId)] ?? `#${a.accountId}`;
      return `set account → ${name}`;
    }
    case "set_entered_currency":
      return `set entered currency → ${a.currency}`;
    case "set_portfolio_holding": {
      const name = fkNames?.holdings?.[String(a.holdingId)] ?? `#${a.holdingId}`;
      return `set holding → ${name}`;
    }
    case "create_transfer": {
      const name = fkNames?.accounts?.[String(a.destAccountId)] ?? `#${a.destAccountId}`;
      return `create transfer → ${name}`;
    }
  }
}

export default function RulesSettingsPage() {
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<RuleRow | null>(null);
  const [showEditor, setShowEditor] = useState(false);

  async function load() {
    try {
      const [rulesRes, catsRes, acctsRes, holdRes] = await Promise.all([
        fetch("/api/rules"),
        fetch("/api/categories"),
        fetch("/api/accounts"),
        fetch("/api/portfolio"),
      ]);
      if (rulesRes.ok) setRules(await rulesRes.json());
      if (catsRes.ok) setCategories(await catsRes.json());
      if (acctsRes.ok) setAccounts(await acctsRes.json());
      if (holdRes.ok) {
        const data = await holdRes.json();
        // /api/portfolio returns an array of holdings.
        setHoldings(Array.isArray(data) ? data : (data.holdings ?? []));
      }
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => { load(); }, []);

  async function handleToggle(rule: RuleRow) {
    try {
      const res = await fetch("/api/rules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: rule.id, isActive: !rule.isActive }),
      });
      if (!res.ok) {
        const d = await res.json();
        setError(d.error ?? "Failed to toggle");
        return;
      }
      load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleDelete(rule: RuleRow) {
    if (!confirm(`Delete rule "${rule.name}"?`)) return;
    try {
      await fetch(`/api/rules?id=${rule.id}`, { method: "DELETE" });
      load();
    } catch (e) {
      setError(String(e));
    }
  }

  function startEditor(rule?: RuleRow) {
    setEditing(rule ?? null);
    setShowEditor(true);
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Rules</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Auto-categorize and transform transactions with multi-condition rules.
          See <a href="/docs/transaction-rules-v2" className="underline hover:text-foreground">the docs</a> for the full action list.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-100 text-orange-600">
                <Zap className="h-5 w-5" />
              </div>
              <div>
                <CardTitle className="text-base">Transaction Rules</CardTitle>
                <CardDescription>Sorted by priority DESC. First match wins.</CardDescription>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => startEditor()}>
              <Plus className="h-4 w-4 mr-1" /> Add Rule
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {error && (
            <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-lg">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {error}
              <button className="ml-auto text-xs underline" onClick={() => setError("")}>dismiss</button>
            </div>
          )}

          {rules.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-6">No rules yet. Add a rule to auto-categorize transactions.</p>
          )}

          {rules.map((rule) => (
            <div
              key={rule.id}
              className={`rounded-lg border p-3 space-y-1 ${!rule.isActive ? "opacity-60" : ""}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm truncate">{rule.name}</span>
                    {rule.priority > 0 && <Badge variant="secondary" className="text-[10px]">P{rule.priority}</Badge>}
                    {!rule.isActive && <Badge variant="outline" className="text-[10px]">disabled</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    <strong>When:</strong> {summarizeConditions(rule.conditions ?? { all: [] }, rule.actionFKNames)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    <strong>Then:</strong> {summarizeActions(rule.actions ?? [], rule.actionFKNames)}
                  </p>
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button variant="ghost" size="sm" onClick={() => handleToggle(rule)}>
                    {rule.isActive ? "Disable" : "Enable"}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => startEditor(rule)}>
                    Edit
                  </Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => handleDelete(rule)}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {showEditor && (
        <RuleEditor
          rule={editing}
          categories={categories}
          accounts={accounts}
          holdings={holdings}
          onClose={(saved) => {
            setShowEditor(false);
            setEditing(null);
            if (saved) load();
          }}
        />
      )}
    </div>
  );
}

/** Sub-component: editor dialog. */
function RuleEditor({
  rule,
  categories,
  accounts,
  holdings,
  onClose,
}: {
  rule: RuleRow | null;
  categories: Category[];
  accounts: Account[];
  holdings: Holding[];
  onClose: (saved: boolean) => void;
}) {
  const [name, setName] = useState(rule?.name ?? "");
  const [priority, setPriority] = useState(rule?.priority ?? 0);
  const [isActive, setIsActive] = useState(rule?.isActive ?? true);
  const [conditions, setConditions] = useState<Condition[]>(rule?.conditions?.all ?? [blankCondition()]);
  const [actions, setActions] = useState<Action[]>(rule?.actions ?? [blankAction()]);
  const [error, setError] = useState("");

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
    const payload = rule
      ? { id: rule.id, name: name.trim(), conditions: { all: conditions }, actions, priority, isActive }
      : { name: name.trim(), conditions: { all: conditions }, actions, priority, isActive };
    try {
      const res = await fetch("/api/rules", {
        method: rule ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const d = await res.json();
        setError(d.error ?? "Failed to save rule");
        return;
      }
      onClose(true);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(false); }}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{rule ? "Edit rule" : "New rule"}</DialogTitle>
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
          <Button variant="ghost" onClick={() => onClose(false)}>Cancel</Button>
          <Button onClick={handleSave}>{rule ? "Update rule" : "Create rule"}</Button>
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
            (a, z) => a.label.localeCompare(z.label),
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

// Reserved for future use — DialogTrigger is currently shown via parent state.
void DialogTrigger;
