"use client";

/**
 * Shared email-import rule editor dialog (2026-06-16; multi-condition 2026-06-17).
 *
 * Two modes:
 *   - "manager"   — create/edit a rule from /settings/import (POST/PUT
 *                   /api/email-rules). No email context.
 *   - "fromEmail" — "Create rule from this email" on the Email tab. Pre-filled
 *                   from the landed email; shows a live "will record" preview
 *                   computed with the pure applyEmailTransform; on save creates
 *                   the rule AND records THIS email through the same mapping.
 *
 * A rule is an AND group of conditions over sender/subject/body/payee (text) +
 * amount (numeric). State is seeded once via useState initializers — the parent
 * mounts this with a `key` (rule id / email id) so each open gets a fresh form.
 */

import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2 } from "lucide-react";
import { applyEmailTransform } from "@/lib/email-import/apply-transform";
import { formatCurrency } from "@/lib/currency";
import { safeAccountName, safeName } from "@/lib/safe-name";
import {
  EMAIL_CONDITION_FIELDS,
  defaultEmailConditionForField,
  type EmailCondition,
  type EmailConditionField,
} from "@/lib/email-rules/schema";

export interface RuleDraftInit {
  id?: number | null;
  name?: string;
  conditions?: EmailCondition[];
  accountId?: number | null;
  categoryId?: number | null;
  mode?: "auto" | "review";
  flipSign?: boolean;
  dateSource?: "parsed" | "received";
  payeeOverride?: string | null;
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

export interface FromEmailCtx {
  emailId: string;
  candidate: { date: string; amount: number; currency: string; payee: string } | null;
  receivedAt: string; // ISO
}

const PLACEHOLDER: Record<EmailConditionField, string> = {
  sender: "alerts@chase.com",
  subject: "transaction alert",
  body: "withdrawal",
  payee: "STARBUCKS",
  amount: "",
};

function toNum(s: string): number {
  if (s.trim() === "") return 0;
  const n = Number(s);
  return Number.isNaN(n) ? 0 : n;
}

/** One condition row — field/op/value selects; field-change swaps the whole row
 *  to a fresh typed default (mirrors the transaction-rules editor). */
function EmailConditionRow({
  cond,
  onChange,
  onRemove,
  canRemove,
}: {
  cond: EmailCondition;
  onChange: (next: EmailCondition) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Select
        value={cond.field}
        onValueChange={(v) => onChange(defaultEmailConditionForField((v as EmailConditionField) ?? "sender"))}
      >
        <SelectTrigger className="w-[110px] h-9"><SelectValue /></SelectTrigger>
        <SelectContent>
          {EMAIL_CONDITION_FIELDS.map((f) => (
            <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {cond.field === "amount" ? (
        <>
          <Select
            value={cond.op}
            onValueChange={(v) => {
              const op = (v as "gt" | "lt" | "between") ?? "lt";
              onChange(
                op === "between"
                  ? { field: "amount", op: "between", min: 0, max: 0 }
                  : { field: "amount", op, value: 0 },
              );
            }}
          >
            <SelectTrigger className="w-[130px] h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="gt">greater than</SelectItem>
              <SelectItem value="lt">less than</SelectItem>
              <SelectItem value="between">between</SelectItem>
            </SelectContent>
          </Select>
          {cond.op === "between" ? (
            <>
              <input
                type="number"
                step="0.01"
                className="h-9 w-[90px] rounded-md border bg-background px-2 text-sm"
                value={String(cond.min)}
                placeholder="min"
                onChange={(e) => onChange({ field: "amount", op: "between", min: toNum(e.target.value), max: cond.max })}
              />
              <span className="text-xs text-muted-foreground">–</span>
              <input
                type="number"
                step="0.01"
                className="h-9 w-[90px] rounded-md border bg-background px-2 text-sm"
                value={String(cond.max)}
                placeholder="max"
                onChange={(e) => onChange({ field: "amount", op: "between", min: cond.min, max: toNum(e.target.value) })}
              />
            </>
          ) : (
            <input
              type="number"
              step="0.01"
              className="h-9 w-[120px] rounded-md border bg-background px-2 text-sm"
              value={String(cond.value)}
              placeholder="amount"
              onChange={(e) => onChange({ field: "amount", op: cond.op, value: toNum(e.target.value) })}
            />
          )}
          <span className="text-xs text-muted-foreground">(by magnitude)</span>
        </>
      ) : (
        <>
          <Select
            value={cond.op}
            onValueChange={(v) => onChange({ ...cond, op: (v as "contains" | "exact" | "regex") ?? "contains" })}
          >
            <SelectTrigger className="w-[120px] h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="contains">contains</SelectItem>
              <SelectItem value="exact">exact</SelectItem>
              <SelectItem value="regex">regex</SelectItem>
            </SelectContent>
          </Select>
          <input
            className="h-9 flex-1 min-w-[140px] rounded-md border bg-background px-2 text-sm"
            placeholder={PLACEHOLDER[cond.field]}
            value={cond.value}
            onChange={(e) => onChange({ ...cond, value: e.target.value })}
          />
        </>
      )}

      {canRemove && (
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8 text-muted-foreground hover:text-rose-600"
          onClick={onRemove}
          title="Remove condition"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

export function EmailRuleDialog({
  open,
  onOpenChange,
  accounts,
  categories,
  initial,
  mode,
  fromEmail,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: AccountOpt[];
  categories: CategoryOpt[];
  initial?: RuleDraftInit;
  mode: "manager" | "fromEmail";
  fromEmail?: FromEmailCtx;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [conditions, setConditions] = useState<EmailCondition[]>(
    initial?.conditions && initial.conditions.length > 0
      ? initial.conditions
      : [defaultEmailConditionForField("sender")],
  );
  const [accountId, setAccountId] = useState<number | null>(initial?.accountId ?? null);
  const [categoryId, setCategoryId] = useState<number | null>(initial?.categoryId ?? null);
  const [ruleMode, setRuleMode] = useState<"auto" | "review">(initial?.mode ?? "auto");
  const [flipSign, setFlipSign] = useState(initial?.flipSign ?? false);
  const [dateSource, setDateSource] = useState<"parsed" | "received">(initial?.dateSource ?? "parsed");
  const [payeeOverride, setPayeeOverride] = useState(initial?.payeeOverride ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isEdit = initial?.id != null;
  const recordableAccounts = useMemo(
    () => accounts.filter((a) => !a.archived && a.isInvestment !== true),
    [accounts],
  );
  const acctLabel = (id: number | null) => {
    if (id == null) return "Account";
    const a = accounts.find((x) => x.id === id);
    return a ? `${safeAccountName(a)} · ${a.currency}` : `Account #${id}`;
  };
  const catLabel = (id: number | null) => {
    if (id == null) return "No category";
    const c = categories.find((x) => x.id === id);
    return c ? safeName(c.name, "category", c.id) : `Category #${id}`;
  };

  const updateCondition = (i: number, next: EmailCondition) =>
    setConditions((cs) => cs.map((c, j) => (j === i ? next : c)));
  const addCondition = () =>
    setConditions((cs) => [...cs, defaultEmailConditionForField("body")]);
  const removeCondition = (i: number) =>
    setConditions((cs) => cs.filter((_, j) => j !== i));

  // Live "will record" preview (fromEmail mode) — the pure transform applied to
  // the parsed candidate, so flip / date-source / rename are visible pre-save.
  const preview = useMemo(() => {
    if (mode !== "fromEmail" || !fromEmail?.candidate) return null;
    const c = fromEmail.candidate;
    const eff = applyEmailTransform(
      { date: c.date, amount: c.amount, payee: c.payee },
      { flipSign, dateSource, payeeOverride: payeeOverride.trim() || null },
      fromEmail.receivedAt ? fromEmail.receivedAt.slice(0, 10) : null,
    );
    return { ...eff, currency: c.currency };
  }, [mode, fromEmail, flipSign, dateSource, payeeOverride]);

  const save = async () => {
    if (!name.trim() || accountId == null) {
      setError("Name and account are required.");
      return;
    }
    if (conditions.length === 0) {
      setError("Add at least one condition.");
      return;
    }
    for (const c of conditions) {
      if (c.field !== "amount" && !c.value.trim()) {
        setError("Every text condition needs a value.");
        return;
      }
    }
    if (mode === "fromEmail" && categoryId == null) {
      setError("Pick a category — recording this email now needs one.");
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const all = conditions.map((c) =>
        c.field === "amount" ? c : { ...c, value: c.value.trim() },
      );
      const payload = {
        name: name.trim(),
        conditions: { all },
        accountId,
        categoryId,
        mode: ruleMode,
        flipSign,
        dateSource,
        payeeOverride: payeeOverride.trim() || null,
      };
      const res = await fetch(isEdit ? `/api/email-rules/${initial!.id}` : "/api/email-rules", {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? `HTTP ${res.status}`);
      }

      // From-email: also record THIS email now through the same mapping.
      if (mode === "fromEmail" && fromEmail) {
        const rec = await fetch(`/api/import/email-inbox/${fromEmail.emailId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "record",
            accountId,
            categoryId,
            flipSign,
            dateSource,
            payeeOverride: payeeOverride.trim() || undefined,
          }),
        });
        if (!rec.ok) {
          const b = await rec.json().catch(() => ({}));
          const reason = b.code ?? b.error ?? `HTTP ${rec.status}`;
          setNotice(
            reason === "sign_category_mismatch"
              ? "Rule created — but this email didn't record: the amount sign doesn't match the category. Adjust the flip/category and use Record on the row."
              : `Rule created — but this email didn't record (${reason}).`,
          );
          onSaved();
          setSaving(false);
          return;
        }
        const body = await rec.json().catch(() => ({}));
        if (body.action === "duplicate_skipped") {
          setNotice("Rule created. This email matched an existing transaction, so it was skipped as a duplicate.");
          onSaved();
          setSaving(false);
          return;
        }
      }

      onSaved();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {mode === "fromEmail"
              ? "Create rule from this email"
              : isEdit
                ? "Edit email rule"
                : "New email rule"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {error && (
            <div className="rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
              {error}
            </div>
          )}
          {notice && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              {notice}
            </div>
          )}

          {/* Name */}
          <input
            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
            placeholder="Rule name (e.g. Chase alerts)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />

          {/* Conditions (AND) */}
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">When ALL of these match</label>
            {conditions.map((cond, i) => (
              <EmailConditionRow
                key={i}
                cond={cond}
                onChange={(next) => updateCondition(i, next)}
                onRemove={() => removeCondition(i)}
                canRemove={conditions.length > 1}
              />
            ))}
            <Button size="sm" variant="outline" className="gap-1.5" onClick={addCondition}>
              <Plus className="h-3.5 w-3.5" /> Add condition
            </Button>
          </div>

          {/* Target */}
          <div>
            <label className="text-xs text-muted-foreground">…record it into</label>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
              <Select
                value={accountId != null ? String(accountId) : ""}
                onValueChange={(v) => setAccountId(v ? parseInt(v, 10) : null)}
              >
                <SelectTrigger className="w-[190px] h-9">
                  <SelectValue placeholder="Account">{acctLabel(accountId)}</SelectValue>
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
                value={categoryId != null ? String(categoryId) : "none"}
                onValueChange={(v) => setCategoryId(v && v !== "none" ? parseInt(v, 10) : null)}
              >
                <SelectTrigger className="w-[180px] h-9">
                  <SelectValue placeholder="Category">{catLabel(categoryId)}</SelectValue>
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
              <Select value={ruleMode} onValueChange={(v) => setRuleMode((v as "auto" | "review") ?? "auto")}>
                <SelectTrigger className="w-[110px] h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">auto</SelectItem>
                  <SelectItem value="review">review</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Mapping / transforms */}
          <div className="rounded-lg border p-3 space-y-2.5 bg-muted/30">
            <p className="text-xs font-medium">Field mapping</p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border"
                checked={flipSign}
                onChange={(e) => setFlipSign(e.target.checked)}
              />
              Reverse amount sign
              <span className="text-xs text-muted-foreground">(for alerts that report expenses as positive)</span>
            </label>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label className="text-xs text-muted-foreground w-20">Use date</label>
              <Select value={dateSource} onValueChange={(v) => setDateSource((v as "parsed" | "received") ?? "parsed")}>
                <SelectTrigger className="w-[200px] h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="parsed">from the email body</SelectItem>
                  <SelectItem value="received">the email&apos;s received date</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label className="text-xs text-muted-foreground w-20">Payee</label>
              <input
                className="flex-1 min-w-[160px] rounded-md border bg-background px-2 py-1.5 text-sm"
                placeholder="(optional) always use this payee"
                value={payeeOverride}
                onChange={(e) => setPayeeOverride(e.target.value)}
              />
            </div>
          </div>

          {/* Live preview (fromEmail) */}
          {preview && (
            <div className="rounded-md border border-emerald-200 bg-emerald-50/60 p-2.5 text-sm dark:border-emerald-900 dark:bg-emerald-950/30">
              <span className="text-xs text-muted-foreground">Will record: </span>
              <span className="font-medium">{formatCurrency(preview.amount, preview.currency)}</span>
              <span className="mx-1.5 text-muted-foreground">·</span>
              <span>{preview.payee}</span>
              <span className="mx-1.5 text-muted-foreground">·</span>
              <span>{preview.date}</span>
            </div>
          )}

          <p className="text-[11px] text-muted-foreground">
            Auto-record needs a category (the income/expense sign must match). Without one, the rule resolves
            the account and waits for a click.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {mode === "fromEmail" ? "Create rule & record" : isEdit ? "Save changes" : "Add rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
