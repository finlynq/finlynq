"use client";

/**
 * MaterializeDialog — opened from the /reconcile BankPane when the user
 * clicks "Create" on a bank-only row. Lets them pick a category + account
 * before the materialize POST, defaulting to whatever the
 * transaction_rules engine suggested for the bank row's payee.
 *
 * Why the dialog (V1.1): the v1 flow POSTed materialize with no category,
 * producing uncategorized transactions that the user had to fix in the
 * Transactions table afterwards. CLAUDE.md note: the staging-approve
 * path already gates on resolved categories (FINLYNQ-57) — the reconcile
 * surface needs an equivalent step. Reusing the rule-engine suggestion
 * keeps the friction low for the common case (payee matches a rule)
 * while still requiring an explicit confirmation.
 *
 * Cancel closes without side effects. Create posts to
 * /api/reconcile/materialize and signals success to the caller via
 * onCreated so the page can refresh.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatCurrency } from "@/lib/currency";

export interface MaterializeBankPreview {
  bankTransactionId: string;
  date: string;
  amount: number;
  currency: string;
  payee: string | null;
  /** Bank row's account — default for the override picker. */
  accountId: number;
  /** Rule-engine pick. null when no rule matched OR the matched rule
   *  carries no `set_category` action. */
  suggestedCategoryId: number | null;
}

export interface CategoryOption {
  id: number;
  name: string;
  type: string;
}

export interface AccountOption {
  id: number;
  name: string;
  currency: string;
}

export function MaterializeDialog({
  open,
  onOpenChange,
  bank,
  categories,
  accounts,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bank: MaterializeBankPreview | null;
  categories: CategoryOption[];
  accounts: AccountOption[];
  onCreated: () => void;
}) {
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset selection whenever the dialog opens for a new bank row.
  useEffect(() => {
    if (open && bank) {
      setCategoryId(bank.suggestedCategoryId);
      setAccountId(bank.accountId);
      setError(null);
      setBusy(false);
    }
  }, [open, bank]);

  const suggestedCategory = useMemo(() => {
    if (!bank?.suggestedCategoryId) return null;
    return (
      categories.find((c) => c.id === bank.suggestedCategoryId) ?? null
    );
  }, [bank, categories]);

  const onSubmit = async () => {
    if (!bank) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/reconcile/materialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bankTransactionId: bank.bankTransactionId,
          categoryId: categoryId ?? undefined,
          accountId: accountId ?? undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      onCreated();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create transaction from bank row</DialogTitle>
          <DialogDescription>
            A new transaction will be linked to this bank-ledger row.
            User edits on existing transactions are never overwritten.
          </DialogDescription>
        </DialogHeader>

        {bank && (
          <div className="space-y-4">
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Date
                  </div>
                  <div className="font-mono text-xs">{bank.date}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Amount
                  </div>
                  <div className="font-mono text-xs">
                    {formatCurrency(bank.amount, bank.currency)}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Payee
                  </div>
                  <div className="text-xs truncate">
                    {bank.payee || (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">Category</label>
              <Select
                value={categoryId != null ? String(categoryId) : "__none__"}
                onValueChange={(v) => {
                  if (v === "__none__") setCategoryId(null);
                  else {
                    const n = parseInt(v ?? "", 10);
                    if (Number.isFinite(n)) setCategoryId(n);
                  }
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">
                    Uncategorized
                  </SelectItem>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.name} {c.type ? `· ${c.type}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {suggestedCategory && (
                <p className="text-xs text-muted-foreground">
                  Suggested by a transaction rule: <span className="font-medium">{suggestedCategory.name}</span>
                </p>
              )}
              {!suggestedCategory && categoryId == null && (
                <p className="text-xs text-amber-700">
                  No category set — the transaction will land uncategorized.
                </p>
              )}
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">Account</label>
              <Select
                value={accountId != null ? String(accountId) : ""}
                onValueChange={(v) => {
                  const n = parseInt(v ?? "", 10);
                  if (Number.isFinite(n)) setAccountId(n);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select an account" />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.name} · {a.currency}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {accountId != null && accountId !== bank.accountId && (
                <p className="text-xs text-muted-foreground">
                  This will create the transaction in a different account
                  than the bank-ledger row. The lineage link stays intact.
                </p>
              )}
            </div>

            {error && (
              <div className="rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800">
                {error}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button disabled={busy || !bank || accountId == null} onClick={onSubmit}>
            {busy ? "Creating…" : "Create transaction"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
