"use client";

/**
 * Email-import rules manager (Epic C2). Rendered in /settings/import → Email
 * Import. Lists the user's rules and opens the shared EmailRuleDialog to
 * create/edit one. CRUD over /api/email-rules: "when an email from X arrives,
 * record it into account Y (+ category Z, + field mapping), auto or review."
 */

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, Pencil } from "lucide-react";
import { safeAccountName, safeName } from "@/lib/safe-name";
import { EmailRuleDialog, type RuleDraftInit } from "./email-rule-dialog";
import type { EmailCondition } from "@/lib/email-rules/schema";

interface EmailRule {
  id: number;
  name: string;
  conditions: EmailCondition[];
  accountId: number;
  categoryId: number | null;
  /** FINLYNQ-189 — transfer destination (mutually exclusive with categoryId). */
  transferDestAccountId: number | null;
  mode: "auto" | "review";
  flipSign: boolean;
  dateSource: "parsed" | "received";
  payeeOverride: string | null;
  currency: string | null;
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

function summarizeCondition(c: EmailCondition): string {
  if (c.field === "amount") {
    if (c.op === "between") return `amount ${c.min}–${c.max}`;
    return `amount ${c.op === "gt" ? ">" : "<"} ${c.value}`;
  }
  return `${c.field} ${c.op} “${c.value}”`;
}
function summarizeConditions(conds: EmailCondition[]): string {
  if (!conds || conds.length === 0) return "(no conditions)";
  return conds.map(summarizeCondition).join(" AND ");
}

export function EmailRulesManager() {
  const [rules, setRules] = useState<EmailRule[]>([]);
  const [accounts, setAccounts] = useState<AccountOpt[]>([]);
  const [categories, setCategories] = useState<CategoryOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogInit, setDialogInit] = useState<RuleDraftInit | null>(null);

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
              Match on sender / subject / body / payee / amount (all conditions
              must match) → an account, so body emails record automatically
              (mode <span className="font-mono">auto</span>) or wait for one
              click (<span className="font-mono">review</span>). Add field
              mapping to reverse the amount sign, choose the date, or rename the
              payee.
            </p>
          </div>
          <Button size="sm" className="gap-1.5" onClick={() => setDialogInit({})}>
            <Plus className="h-4 w-4" /> Add rule
          </Button>
        </div>

        {error && (
          <div className="rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800">
            {error}
          </div>
        )}

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rules.length === 0 ? (
          <p className="text-sm text-muted-foreground">No email rules yet.</p>
        ) : (
          <div className="space-y-1.5">
            {rules.map((r) => {
              const transforms = [
                r.flipSign ? "flip sign" : null,
                r.dateSource === "received" ? "date: received" : null,
                r.payeeOverride ? `payee: ${r.payeeOverride}` : null,
                r.currency ? `currency: ${r.currency}` : null,
              ].filter(Boolean) as string[];
              return (
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
                      {summarizeConditions(r.conditions)} → {acctLabel(r.accountId)}
                      {r.transferDestAccountId != null
                        ? ` → transfer to ${acctLabel(r.transferDestAccountId)}`
                        : catLabel(r.categoryId)
                          ? ` · ${catLabel(r.categoryId)}`
                          : ""}
                      {transforms.length > 0 ? ` · ${transforms.join(" · ")}` : ""}
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
                      setDialogInit({
                        id: r.id,
                        name: r.name,
                        conditions: r.conditions,
                        accountId: r.accountId,
                        categoryId: r.categoryId,
                        transferDestAccountId: r.transferDestAccountId,
                        mode: r.mode,
                        flipSign: r.flipSign,
                        dateSource: r.dateSource,
                        payeeOverride: r.payeeOverride,
                        currency: r.currency,
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
              );
            })}
          </div>
        )}
      </CardContent>

      {dialogInit && (
        <EmailRuleDialog
          key={dialogInit.id ?? "new"}
          open
          onOpenChange={(o) => {
            if (!o) setDialogInit(null);
          }}
          accounts={accounts}
          categories={categories}
          mode="manager"
          initial={dialogInit}
          onSaved={() => void load()}
        />
      )}
    </Card>
  );
}
