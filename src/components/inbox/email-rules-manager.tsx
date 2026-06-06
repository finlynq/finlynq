"use client";

/**
 * Email-import rules manager (Epic C2). Rendered in /settings/import → Email
 * Import. CRUD over /api/email-rules: "when an email from X arrives, record it
 * into account Y (+ category Z), auto or review." Drives the DEK-bearing sweep.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2, Pencil } from "lucide-react";
import { safeAccountName, safeName } from "@/lib/safe-name";

interface EmailRule {
  id: number;
  name: string;
  matchType: "sender" | "subject";
  matchOp: "contains" | "exact" | "regex";
  matchValue: string;
  accountId: number;
  categoryId: number | null;
  mode: "auto" | "review";
  isActive: boolean;
  priority: number;
}
interface AccountOpt {
  id: number;
  name: string | null;
  alias?: string | null;
  currency: string;
  isInvestment?: boolean;
  archived?: boolean;
}
interface CategoryOpt {
  id: number;
  name: string | null;
}

type Draft = {
  id: number | null;
  name: string;
  matchType: "sender" | "subject";
  matchOp: "contains" | "exact" | "regex";
  matchValue: string;
  accountId: number | null;
  categoryId: number | null;
  mode: "auto" | "review";
};

const EMPTY_DRAFT: Draft = {
  id: null,
  name: "",
  matchType: "sender",
  matchOp: "contains",
  matchValue: "",
  accountId: null,
  categoryId: null,
  mode: "auto",
};

export function EmailRulesManager() {
  const [rules, setRules] = useState<EmailRule[]>([]);
  const [accounts, setAccounts] = useState<AccountOpt[]>([]);
  const [categories, setCategories] = useState<CategoryOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, a, c] = await Promise.all([
        fetch("/api/email-rules"),
        fetch("/api/accounts"),
        fetch("/api/categories"),
      ]);
      if (r.ok) setRules(await r.json());
      if (a.ok) setAccounts(await a.json());
      if (c.ok) setCategories(await c.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const recordableAccounts = useMemo(
    () => accounts.filter((a) => !a.archived && a.isInvestment !== true),
    [accounts],
  );
  const acctLabel = useCallback(
    (id: number) => {
      const a = accounts.find((x) => x.id === id);
      return a ? safeAccountName(a) : `Account #${id}`;
    },
    [accounts],
  );
  const catLabel = useCallback(
    (id: number | null) => {
      if (id == null) return null;
      const c = categories.find((x) => x.id === id);
      return c ? safeName(c.name, "category", c.id) : `Category #${id}`;
    },
    [categories],
  );

  const save = useCallback(async () => {
    if (!draft || !draft.name.trim() || !draft.matchValue.trim() || draft.accountId == null) {
      setError("Name, match value, and account are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: draft.name.trim(),
        matchType: draft.matchType,
        matchOp: draft.matchOp,
        matchValue: draft.matchValue.trim(),
        accountId: draft.accountId,
        categoryId: draft.categoryId,
        mode: draft.mode,
      };
      const res = await fetch(
        draft.id != null ? `/api/email-rules/${draft.id}` : "/api/email-rules",
        {
          method: draft.id != null ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? `HTTP ${res.status}`);
      }
      setDraft(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [draft, load]);

  const remove = useCallback(
    async (id: number) => {
      await fetch(`/api/email-rules/${id}`, { method: "DELETE" });
      await load();
    },
    [load],
  );

  const toggleActive = useCallback(
    async (rule: EmailRule) => {
      await fetch(`/api/email-rules/${rule.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !rule.isActive }),
      });
      await load();
    },
    [load],
  );

  return (
    <Card>
      <CardContent className="space-y-4 py-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Email rules</p>
            <p className="text-xs text-muted-foreground">
              Match a sender or subject to an account so body emails record
              automatically (mode <span className="font-mono">auto</span>) or
              wait for one click (<span className="font-mono">review</span>).
            </p>
          </div>
          {!draft && (
            <Button size="sm" className="gap-1.5" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
              <Plus className="h-4 w-4" /> Add rule
            </Button>
          )}
        </div>

        {error && (
          <div className="rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800">
            {error}
          </div>
        )}

        {draft && (
          <div className="rounded-lg border p-3 space-y-3 bg-muted/30">
            <div className="flex flex-wrap gap-2">
              <input
                className="flex-1 min-w-[160px] rounded-md border bg-background px-2 py-1.5 text-sm"
                placeholder="Rule name (e.g. Chase alerts)"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Select
                value={draft.matchType}
                onValueChange={(v) => setDraft({ ...draft, matchType: (v as Draft["matchType"]) ?? "sender" })}
              >
                <SelectTrigger className="w-[110px] h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="sender">Sender</SelectItem>
                  <SelectItem value="subject">Subject</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={draft.matchOp}
                onValueChange={(v) => setDraft({ ...draft, matchOp: (v as Draft["matchOp"]) ?? "contains" })}
              >
                <SelectTrigger className="w-[120px] h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="contains">contains</SelectItem>
                  <SelectItem value="exact">exact</SelectItem>
                  <SelectItem value="regex">regex</SelectItem>
                </SelectContent>
              </Select>
              <input
                className="flex-1 min-w-[160px] rounded-md border bg-background px-2 py-1.5 text-sm"
                placeholder="value (e.g. alerts@chase.com)"
                value={draft.matchValue}
                onChange={(e) => setDraft({ ...draft, matchValue: e.target.value })}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-xs text-muted-foreground">→</span>
              <Select
                value={draft.accountId != null ? String(draft.accountId) : ""}
                onValueChange={(v) => setDraft({ ...draft, accountId: v ? parseInt(v, 10) : null })}
              >
                {/* Explicit render — base-ui SelectValue otherwise shows the
                 *  raw value (the account id) instead of the name. */}
                <SelectTrigger className="w-[180px] h-9">
                  <SelectValue placeholder="Account">
                    {draft.accountId != null ? acctLabel(draft.accountId) : "Account"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {recordableAccounts.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {safeAccountName(a)} · {a.currency}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={draft.categoryId != null ? String(draft.categoryId) : "none"}
                onValueChange={(v) =>
                  setDraft({ ...draft, categoryId: v && v !== "none" ? parseInt(v, 10) : null })
                }
              >
                <SelectTrigger className="w-[170px] h-9">
                  <SelectValue placeholder="Category (optional)">
                    {draft.categoryId != null ? catLabel(draft.categoryId) : "No category"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No category</SelectItem>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {safeName(c.name, "category", c.id)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={draft.mode}
                onValueChange={(v) => setDraft({ ...draft, mode: (v as Draft["mode"]) ?? "auto" })}
              >
                <SelectTrigger className="w-[110px] h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">auto</SelectItem>
                  <SelectItem value="review">review</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Auto-record needs a category (income/expense sign must match). Without
              one, the rule resolves the account and waits for a click.
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void save()} disabled={saving}>
                {draft.id != null ? "Save changes" : "Add rule"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setDraft(null)} disabled={saving}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rules.length === 0 && !draft ? (
          <p className="text-sm text-muted-foreground">No email rules yet.</p>
        ) : (
          <div className="space-y-1.5">
            {rules.map((r) => (
              <div
                key={r.id}
                className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{r.name}</span>
                    <Badge variant="outline" className="text-[10px]">{r.mode}</Badge>
                    {!r.isActive && <Badge variant="outline" className="text-[10px]">off</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {r.matchType} {r.matchOp} “{r.matchValue}” → {acctLabel(r.accountId)}
                    {catLabel(r.categoryId) ? ` · ${catLabel(r.categoryId)}` : ""}
                  </div>
                </div>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => void toggleActive(r)}>
                  {r.isActive ? "Disable" : "Enable"}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={() =>
                    setDraft({
                      id: r.id,
                      name: r.name,
                      matchType: r.matchType,
                      matchOp: r.matchOp,
                      matchValue: r.matchValue,
                      accountId: r.accountId,
                      categoryId: r.categoryId,
                      mode: r.mode,
                    })
                  }
                  title="Edit"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-muted-foreground hover:text-rose-600"
                  onClick={() => void remove(r.id)}
                  title="Delete"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
