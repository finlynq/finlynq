"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox, type ComboboxItemShape } from "@/components/ui/combobox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useActiveCurrencies } from "@/lib/hooks/useActiveCurrencies";
import { useDropdownOrder } from "@/components/dropdown-order-provider";
import { ACCOUNT_GROUP_DEFAULTS } from "@/lib/accounts/groups";
import { todayISO } from "@/lib/utils/date";
import {
  loadOpeningBalance,
  saveOpeningBalance,
  type OpeningBalance,
} from "@/lib/accounts/opening-balance-client";
import { GroupField } from "./group-field";

const ACCOUNT_TYPES = [
  { value: "A", label: "Asset" },
  { value: "L", label: "Liability" },
];
const ACCOUNT_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  ACCOUNT_TYPES.map((t) => [t.value, t.label]),
);

export type AccountDialogAccount = {
  id: number;
  name: string;
  type: string;
  group: string;
  currency: string;
  note?: string | null;
  alias?: string | null;
  isInvestment?: boolean;
  archived?: boolean;
};

/** An extra (edit-only) tab — Reconciliation / Import / Cash sleeves. Rendered
 *  after Details. Hidden in create mode (no account id yet). */
export type AccountDialogTab = { value: string; label: string; content: ReactNode };

type FormState = {
  name: string;
  alias: string;
  type: string;
  group: string;
  currency: string;
  note: string;
  isInvestment: boolean;
  obAmount: string;
  obDate: string;
};

function blankForm(defaultCurrency: string): FormState {
  return {
    name: "",
    alias: "",
    type: "A",
    group: ACCOUNT_GROUP_DEFAULTS.A?.[0] ?? "",
    currency: defaultCurrency,
    note: "",
    isInvestment: false,
    obAmount: "",
    obDate: todayISO(),
  };
}

function formFromAccount(a: AccountDialogAccount): FormState {
  return {
    name: a.name,
    alias: a.alias ?? "",
    type: a.type,
    group: a.group || "",
    currency: a.currency,
    note: a.note ?? "",
    isInvestment: a.isInvestment === true,
    obAmount: "",
    obDate: todayISO(),
  };
}

export interface AccountDialogProps {
  mode: "create" | "edit";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** edit: the account being edited. */
  account?: AccountDialogAccount | null;
  /** create: default currency (the user's reporting/display currency). */
  defaultCurrency?: string;
  /** group-name suggestions for the GroupField. */
  existingGroups?: string[];
  /** edit only: extra tabs (Reconciliation / Import / Cash sleeves). */
  extraTabs?: AccountDialogTab[];
  /** edit only: which tab to open initially (deep-link support). */
  initialTab?: string;
  /** optional alias-clash warning; excludeId is the account being edited. */
  aliasWarning?: (alias: string, excludeId: number | null) => string;
  onCreated?: (account: AccountDialogAccount) => void;
  onSaved?: (account: AccountDialogAccount) => void;
  onRemoved?: (result: { archived: boolean }) => void;
}

/**
 * Shared create/edit account dialog (FINLYNQ-206 follow-up). One component for
 * BOTH the accounts-list "Create Account" flow and the account-detail "Edit
 * Account" flow — identical fields + tabs; only the title and the footer
 * buttons differ. Create shows just the Details form (the extra tabs require an
 * account id that doesn't exist yet, so they're hidden); edit shows all tabs +
 * Save + the smart Archive/Delete action.
 */
export function AccountDialog({
  mode,
  open,
  onOpenChange,
  account,
  defaultCurrency = "USD",
  existingGroups = [],
  extraTabs,
  initialTab = "details",
  aliasWarning,
  onCreated,
  onSaved,
  onRemoved,
}: AccountDialogProps) {
  const [form, setForm] = useState<FormState>(() => blankForm(defaultCurrency));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [obOriginal, setObOriginal] = useState<OpeningBalance | null>(null);
  const [tab, setTab] = useState(initialTab);
  // Archive/delete confirmation.
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  // Once a create POST has succeeded, remember the id so a retry (e.g. after an
  // opening-balance hiccup) doesn't create a SECOND account.
  const createdIdRef = useRef<number | null>(null);

  const currencyOptions = useActiveCurrencies(form.currency);
  const sortCurrency = useDropdownOrder("currency");

  const isEdit = mode === "edit";
  const showTabs = isEdit && !!extraTabs && extraTabs.length > 0;
  const archived = account?.archived === true;

  // Seed the form whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    createdIdRef.current = null;
    setErrors({});
    setSaveError("");
    setTab(initialTab);
    if (isEdit && account) {
      setForm(formFromAccount(account));
      setObOriginal(null);
      // Opening balance lives in a backing transaction; load it for cash
      // accounts only (hidden for investment accounts).
      if (account.isInvestment !== true) {
        void loadOpeningBalance(account.id).then((ob) => {
          setObOriginal(ob);
          setForm((f) => ({
            ...f,
            obAmount: ob ? String(ob.amount) : "",
            obDate: ob ? ob.date : todayISO(),
          }));
        });
      }
    } else {
      setForm(blankForm(defaultCurrency));
      setObOriginal(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function setType(t: string) {
    // Mirror the legacy create behavior: changing type seeds the default group.
    const defaultGroup = ACCOUNT_GROUP_DEFAULTS[t as "A" | "L"]?.[0] ?? "";
    setForm((f) => ({ ...f, type: t, group: defaultGroup }));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = "Name is required";
    if (!isEdit && !form.type) errs.type = "Type is required";
    if (!isEdit && !form.group.trim()) errs.group = "Group is required";
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSaving(true);
    setSaveError("");
    try {
      const payload = {
        name: form.name.trim(),
        type: form.type,
        group: form.group.trim(),
        currency: form.currency,
        note: form.note.trim(),
        alias: form.alias.trim() || (isEdit ? null : undefined),
        isInvestment: form.isInvestment,
      };

      let accountId: number;
      let saved: AccountDialogAccount;

      if (isEdit && account) {
        accountId = account.id;
        const res = await fetch("/api/accounts", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: account.id, ...payload }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          setSaveError(d.error ?? "Failed to update account");
          return;
        }
        saved = await res.json();
      } else if (createdIdRef.current != null) {
        // Account was already created on a prior submit that failed at the
        // opening-balance step — don't create a duplicate, just retry the OB.
        accountId = createdIdRef.current;
        saved = { ...payload, id: accountId, alias: payload.alias ?? null };
      } else {
        const res = await fetch("/api/accounts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          setSaveError(d.error ?? "Failed to create account");
          return;
        }
        saved = await res.json();
        accountId = saved.id;
        createdIdRef.current = accountId;
      }

      // Persist the opening balance (cash accounts only; no-op when unchanged).
      const obRes = await saveOpeningBalance(
        accountId,
        form.isInvestment,
        { amount: form.obAmount, date: form.obDate },
        obOriginal,
      );
      if (!obRes.ok) {
        setSaveError(
          isEdit
            ? obRes.error
            : `Account created, but the opening balance failed: ${obRes.error}`,
        );
        // Edit: the account update committed; surface to the parent so the page
        // refreshes, but keep the dialog open with the error.
        if (isEdit) onSaved?.(saved);
        return;
      }

      if (isEdit) onSaved?.(saved);
      else onCreated?.(saved);
      onOpenChange(false);
    } catch {
      setSaveError(isEdit ? "Failed to update account" : "Failed to create account");
    } finally {
      setSaving(false);
    }
  }

  async function handleArchiveOrDelete() {
    if (!account) return;
    setRemoving(true);
    setSaveError("");
    try {
      // Try a hard delete first; if the account is still referenced (FK 409),
      // archive it instead (hidden from lists, history kept).
      const del = await fetch(`/api/accounts?id=${account.id}`, { method: "DELETE" });
      if (del.ok) {
        setRemoveOpen(false);
        onRemoved?.({ archived: false });
        onOpenChange(false);
        return;
      }
      if (del.status === 409) {
        const arch = await fetch("/api/accounts", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: account.id, archived: true }),
        });
        if (!arch.ok) {
          const d = await arch.json().catch(() => ({}));
          setSaveError(d.error ?? "Failed to archive account");
          return;
        }
        setRemoveOpen(false);
        onRemoved?.({ archived: true });
        onOpenChange(false);
        return;
      }
      const d = await del.json().catch(() => ({}));
      setSaveError(d.error ?? "Failed to remove account");
    } catch {
      setSaveError("Failed to remove account");
    } finally {
      setRemoving(false);
    }
  }

  async function handleUnarchive() {
    if (!account) return;
    setRemoving(true);
    setSaveError("");
    try {
      const res = await fetch("/api/accounts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: account.id, archived: false }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setSaveError(d.error ?? "Failed to unarchive account");
        return;
      }
      const saved = await res.json();
      onSaved?.(saved);
      onOpenChange(false);
    } catch {
      setSaveError("Failed to unarchive account");
    } finally {
      setRemoving(false);
    }
  }

  const aliasMsg = aliasWarning?.(form.alias, account?.id ?? null) ?? "";

  // ── Details form (identical in create + edit) ───────────────────────────
  const detailsForm = (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="space-y-1.5">
        <Label>Account Name</Label>
        <Input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="e.g. TD Chequing"
          autoFocus
        />
        {errors.name && <p className="text-xs text-destructive">{errors.name}</p>}
      </div>

      <div className="space-y-1.5">
        <Label>Alias <span className="text-muted-foreground text-xs">(optional)</span></Label>
        <Input
          value={form.alias}
          onChange={(e) => setForm({ ...form, alias: e.target.value })}
          placeholder="e.g. 1234 or Visa4242"
          maxLength={64}
        />
        <p className="text-xs text-muted-foreground">
          Short nickname used when matching transactions — e.g. last 4 digits of a card, or a receipt label.
        </p>
        {aliasMsg && <p className="text-xs text-amber-600">{aliasMsg}</p>}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Type</Label>
          <Select items={ACCOUNT_TYPE_LABELS} value={form.type} onValueChange={(v) => setType(v ?? "A")}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {ACCOUNT_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
            </SelectContent>
          </Select>
          {errors.type && <p className="text-xs text-destructive">{errors.type}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="account-dialog-group">Group</Label>
          <GroupField
            inputId="account-dialog-group"
            type={form.type}
            value={form.group}
            existingGroups={existingGroups}
            onChange={(v) => setForm({ ...form, group: v })}
          />
          {errors.group && <p className="text-xs text-destructive">{errors.group}</p>}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Currency</Label>
        <Combobox
          value={form.currency}
          onValueChange={(v) => setForm({ ...form, currency: v || defaultCurrency })}
          items={sortCurrency(
            currencyOptions.map((c): ComboboxItemShape => ({ value: c, label: c })),
            (c) => c.value,
            (a, z) => a.label.localeCompare(z.label),
          )}
          placeholder={defaultCurrency}
          searchPlaceholder="Search…"
          emptyMessage="No matches"
          className="w-full"
        />
      </div>

      <div className="space-y-1.5">
        <Label>Note <span className="text-muted-foreground text-xs">(optional)</span></Label>
        <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="e.g. Joint account" />
      </div>

      {/* Opening balance (FINLYNQ-206) — cash accounts only. Backed by ONE
          kind='opening_balance' transaction; clearing zeroes it (never
          deletes). Hidden when "Investment account" is checked. */}
      {!form.isInvestment && (
        <div className="space-y-2 rounded-lg border border-border/60 p-3">
          <Label>Opening balance <span className="text-muted-foreground text-xs">(optional)</span></Label>
          <p className="text-xs text-muted-foreground">
            A single starting-balance entry for this account. Set the date to when the account opened so
            Balance Over Time and Net Worth history start from the right point. Clearing the amount zeroes
            the entry — it is not deleted.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="account-dialog-ob-amount">Amount</Label>
              <Input
                id="account-dialog-ob-amount"
                type="number"
                step="0.01"
                value={form.obAmount}
                onChange={(e) => setForm({ ...form, obAmount: e.target.value })}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="account-dialog-ob-date">Date</Label>
              <Input
                id="account-dialog-ob-date"
                type="date"
                value={form.obDate}
                onChange={(e) => setForm({ ...form, obDate: e.target.value })}
              />
            </div>
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="account-dialog-isInvestment"
            checked={form.isInvestment}
            onChange={(e) => setForm({ ...form, isInvestment: e.target.checked })}
            className="h-4 w-4 rounded border-input"
          />
          <Label htmlFor="account-dialog-isInvestment" className="cursor-pointer">Investment account</Label>
        </div>
        <p className="text-xs text-muted-foreground">
          When enabled, every transaction in this account must reference a portfolio holding (a security or
          the auto-created &quot;Cash&quot; sleeve). Turning this on now will reassign any unattributed
          transactions to this account&apos;s Cash holding.
        </p>
      </div>

      {saveError && <p className="text-sm text-destructive">{saveError}</p>}

      <div className="flex gap-2 pt-1">
        <Button type="button" variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" className="flex-1" disabled={saving || removing}>
          {saving ? (isEdit ? "Saving…" : "Creating…") : isEdit ? "Save Changes" : "Create Account"}
        </Button>
      </div>

      {/* Account actions (edit only) — one smart Archive/Delete, or Unarchive
          for an archived account. */}
      {isEdit && account && (
        <div className="mt-2 pt-4 border-t space-y-2">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Account actions</p>
          {archived ? (
            <div className="flex gap-2">
              <Button type="button" variant="outline" className="flex-1" disabled={removing} onClick={handleUnarchive}>
                Unarchive
              </Button>
              <Button type="button" variant="destructive" className="flex-1" disabled={removing} onClick={() => setRemoveOpen(true)}>
                Delete
              </Button>
            </div>
          ) : (
            <Button type="button" variant="destructive" className="w-full" disabled={removing} onClick={() => setRemoveOpen(true)}>
              Archive or delete account
            </Button>
          )}
          <p className="text-xs text-muted-foreground">
            If the account still has transactions or linked records it is archived (hidden from lists and
            pickers, history kept). If it is empty it is permanently deleted.
          </p>
        </div>
      )}
    </form>
  );

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className={showTabs ? "sm:max-w-xl" : undefined}>
          <DialogHeader>
            <DialogTitle>{isEdit ? "Edit Account" : "Create Account"}</DialogTitle>
            {/* Bank feeds live in Settings, so people looking for "connect my
                bank" here couldn't find them (in-app feedback 2026-09-15). */}
            {!isEdit && (
              <DialogDescription>
                Want transactions to arrive automatically?{" "}
                <Link
                  href="/settings/bank-feeds"
                  className="text-primary underline-offset-4 hover:underline"
                  onClick={() => onOpenChange(false)}
                >
                  Connect your bank
                </Link>{" "}
                instead.
              </DialogDescription>
            )}
          </DialogHeader>

          {showTabs ? (
            <Tabs value={tab} onValueChange={(v) => setTab(v ?? "details")}>
              <TabsList className="w-full">
                <TabsTrigger value="details">Details</TabsTrigger>
                {extraTabs!.map((t) => (
                  <TabsTrigger key={t.value} value={t.value}>{t.label}</TabsTrigger>
                ))}
              </TabsList>
              <TabsContent value="details" className="pt-4">
                {detailsForm}
              </TabsContent>
              {extraTabs!.map((t) => (
                <TabsContent key={t.value} value={t.value} className="pt-4 space-y-3">
                  {t.content}
                </TabsContent>
              ))}
            </Tabs>
          ) : (
            detailsForm
          )}
        </DialogContent>
      </Dialog>

      {/* Smart Archive/Delete confirmation. */}
      <ConfirmDialog
        open={removeOpen}
        onOpenChange={(o) => { if (!o) setRemoveOpen(false); }}
        title="Remove account"
        description={
          <>
            Remove <b>{account?.name}</b>? If it still has any transactions or linked records it will be
            <b> archived</b> (hidden from lists and pickers, but its history is kept). If it is completely
            empty it will be <b>permanently deleted</b> — this cannot be undone.
          </>
        }
        confirmLabel="Continue"
        busy={removing}
        onConfirm={handleArchiveOrDelete}
      />
    </>
  );
}
