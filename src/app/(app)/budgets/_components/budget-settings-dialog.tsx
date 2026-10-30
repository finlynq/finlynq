"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BUDGET_ROLE_LABELS, type BudgetRole } from "@/lib/budgets/lines";
import type { BudgetMonth } from "@/lib/budgets/month";
import { budgetApi } from "./budget-api";

const ROLE_HELP: Record<BudgetRole, string> = {
  categories: "Purchases and income count in their categories.",
  debt_payment: "Payments into it are one debt-payment line; its interest is part of that line.",
  excluded: "Nothing on it counts in the budget.",
};

function AccountRow({ account, onChanged }: { account: BudgetMonth["accounts"][number]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [payment, setPayment] = useState(account.paymentAmount == null ? "" : String(account.paymentAmount));
  const value = account.storedRole ?? "auto";

  async function save(body: { role?: BudgetRole | null; paymentAmount?: number | null }) {
    setBusy(true);
    setError("");
    try {
      await budgetApi.settings({ target: { accountId: account.id }, ...body });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t py-2 first:border-t-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{account.name}</p>
          <p className="text-xs text-muted-foreground">
            {account.type === "L" ? "Liability" : "Asset"} · {account.currency}
            {account.linkedLoans.length > 0 && ` · loan: ${account.linkedLoans.map((l) => l.name).join(", ")}`}
          </p>
        </div>
        <Select
          value={value}
          onValueChange={(v) => void save({ role: !v || v === "auto" ? null : (v as BudgetRole) })}
          disabled={busy}
        >
          <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Automatic ({BUDGET_ROLE_LABELS[account.automaticRole].toLowerCase()})</SelectItem>
            <SelectItem value="categories">{BUDGET_ROLE_LABELS.categories}</SelectItem>
            <SelectItem value="debt_payment">{BUDGET_ROLE_LABELS.debt_payment}</SelectItem>
            <SelectItem value="excluded">{BUDGET_ROLE_LABELS.excluded}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{ROLE_HELP[account.role]}</p>
      {account.role === "debt_payment" && account.linkedLoans.length === 0 && (
        <div className="mt-2 flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Planned payment per month ({account.currency})</span>
          <Input
            className="h-7 w-28"
            inputMode="decimal"
            value={payment}
            onChange={(e) => setPayment(e.target.value)}
            onBlur={() => {
              const n = payment.trim() === "" ? null : Number(payment);
              if (n != null && (!Number.isFinite(n) || n < 0)) {
                setError("Enter 0 or more");
                return;
              }
              if (n !== account.paymentAmount) void save({ paymentAmount: n });
            }}
          />
        </div>
      )}
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}

export function BudgetSettingsDialog({
  open,
  onOpenChange,
  data,
  month,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: BudgetMonth;
  month: string;
  onChanged: () => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState("");
  const accounts = data.accounts.filter((a) => showArchived || !a.archived);
  const groupsOut = [...new Set(data.excluded.filter((e) => e.by === "group").map((e) => e.group))];

  async function bringBack(body: Parameters<typeof budgetApi.settings>[0]) {
    setError("");
    try {
      await budgetApi.settings(body);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>What counts in the budget</DialogTitle>
        </DialogHeader>
        <div className="space-y-5 text-sm">
          <section>
            <div className="flex items-center justify-between">
              <h3 className="font-medium">Accounts</h3>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
                Show archived
              </label>
            </div>
            <p className="text-xs text-muted-foreground">
              Loans you repay on a schedule (mortgage, car loan, lease, student loan) count as debt payments automatically.
              Credit cards count by their purchases; paying the card is a transfer and counts nowhere.
            </p>
            <div className="mt-2 max-h-80 overflow-auto rounded-md border px-3">
              {accounts.map((a) => (
                <AccountRow key={a.id} account={a} onChanged={onChanged} />
              ))}
            </div>
          </section>

          <section>
            <h3 className="font-medium">Left out of the budget</h3>
            {data.excluded.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nothing. Use a line&apos;s menu to leave it out.</p>
            ) : (
              <div className="mt-2 space-y-1">
                {groupsOut.map((g) => (
                  <div key={`g-${g}`} className="flex items-center justify-between rounded-md border px-3 py-1.5">
                    <span>{g || "Other"} <span className="text-xs text-muted-foreground">(whole group)</span></span>
                    <Button size="sm" variant="outline" onClick={() => void bringBack({ target: { group: g }, month, excluded: false })}>
                      Bring back
                    </Button>
                  </div>
                ))}
                {data.excluded
                  .filter((e) => e.by === "category")
                  .map((e) => (
                    <div key={e.key} className="flex items-center justify-between rounded-md border px-3 py-1.5">
                      <span>
                        {e.name} <span className="text-xs text-muted-foreground">{e.type === "I" ? "income" : e.group || "Other"}</span>
                      </span>
                      <Button size="sm" variant="outline" onClick={() => void bringBack({ target: { categoryId: e.categoryId }, month, excluded: false })}>
                        Bring back
                      </Button>
                    </div>
                  ))}
              </div>
            )}
          </section>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
