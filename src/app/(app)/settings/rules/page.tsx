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

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Zap, Plus, Trash2, AlertTriangle, Inbox,
} from "lucide-react";
import {
  RuleEditorDialog,
  type Category,
  type Account,
  type Holding,
  type RuleSeed,
} from "@/components/rules/rule-editor-dialog";
import type { Condition, Action } from "@/lib/rules/schema";
import { isAnyAmountCondition, isCatchAllRule } from "@/lib/rules/catch-all";

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
      if (isAnyAmountCondition(c)) return "any amount";
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
    case "ticker":
      return `ticker ${c.op} "${c.value}"`;
    case "security_name":
      return `security name ${c.op} "${c.value}"`;
    case "quantity":
      if (c.op === "between") return `quantity between ${c.min}-${c.max}`;
      return `quantity ${c.op} ${c.value}`;
    case "merchant_category_code":
      return `merchant category ${c.op === "starts_with" ? "starts with" : c.op === "in" ? "is one of" : "is"} ${c.value}`;
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
    case "record_investment_op": {
      const acct = fkNames?.accounts?.[String(a.investmentAccountId)] ?? `#${a.investmentAccountId}`;
      const target = a.useRowTicker
        ? "row ticker"
        : a.holdingId != null
          ? (fkNames?.holdings?.[String(a.holdingId)] ?? `#${a.holdingId}`)
          : "—";
      if (a.op === "deposit" || a.op === "withdrawal") {
        const other = a.counterpartyAccountId != null
          ? (fkNames?.accounts?.[String(a.counterpartyAccountId)] ?? `#${a.counterpartyAccountId}`)
          : "—";
        return `${a.op} (${acct} ↔ ${other})`;
      }
      return `record ${a.op} → ${target} in ${acct}`;
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
  const [loaded, setLoaded] = useState(false);
  const [addingCatchAll, setAddingCatchAll] = useState(false);
  const [catchAllNotice, setCatchAllNotice] = useState("");

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
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => { load(); }, []);

  const catchAllRule = rules.find((r) => isCatchAllRule(r)) ?? null;

  async function handleAddCatchAll() {
    if (addingCatchAll) return;
    setAddingCatchAll(true);
    setError("");
    try {
      const res = await fetch("/api/rules/catch-all", { method: "POST" });
      if (!res.ok) {
        const msg = res.status === 423
          ? "Your session is locked. Sign in again to add the rule."
          : ((await res.json().catch(() => ({})))?.error ?? "Failed to add the catch-all rule");
        setError(msg);
        return;
      }
      const body = await res.json().catch(() => ({}));
      const made = body?.data?.categoryCreated ? " and the Uncategorized category" : "";
      setCatchAllNotice(
        `Added the catch-all rule${made}. New rows no other rule matches are now recorded under Uncategorized; ` +
        "rows already waiting on Auto-pilot accounts are picked up on the next sync.",
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAddingCatchAll(false);
    }
  }

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

      {loaded && !catchAllRule && (
        <Card id="catch-all">
          <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <Inbox className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Record everything else as Uncategorized</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Adds one rule, listed last, that files every row no other rule matches under an
                {" "}&quot;Uncategorized&quot; category (made if you don&apos;t have one). On Auto-pilot
                accounts those rows then reach your transactions instead of waiting in Import.
                Edit, disable or delete it like any rule.
              </p>
            </div>
            <Button size="sm" onClick={handleAddCatchAll} disabled={addingCatchAll} className="shrink-0">
              {addingCatchAll ? "Adding…" : "Add catch-all rule"}
            </Button>
          </CardContent>
        </Card>
      )}

      {catchAllNotice && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200">
          {catchAllNotice}
          <button className="ml-2 text-xs underline" onClick={() => setCatchAllNotice("")}>dismiss</button>
        </div>
      )}

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
                    {isCatchAllRule(rule) && <Badge variant="outline" className="text-[10px]">catch-all</Badge>}
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
        <RuleEditorDialog
          rule={ruleRowToSeed(editing)}
          categories={categories}
          accounts={accounts}
          holdings={holdings}
          onClose={(saved) => {
            setShowEditor(false);
            setEditing(null);
            if (saved) load();
          }}
          onSubmit={async (payload) => {
            const url = "/api/rules";
            const method = editing ? "PUT" : "POST";
            const body = editing
              ? { id: editing.id, ...payload }
              : payload;
            try {
              const res = await fetch(url, {
                method,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
              });
              if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                return { ok: false, error: data?.error ?? "Failed to save rule" };
              }
              return { ok: true };
            } catch (e) {
              return { ok: false, error: e instanceof Error ? e.message : String(e) };
            }
          }}
        />
      )}
    </div>
  );
}

function ruleRowToSeed(rule: RuleRow | null): RuleSeed | null {
  if (!rule) return null;
  return {
    id: rule.id,
    name: rule.name,
    conditions: rule.conditions ?? { all: [] },
    actions: rule.actions ?? [],
    priority: rule.priority,
    isActive: rule.isActive,
  };
}

