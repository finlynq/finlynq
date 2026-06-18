"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox, type ComboboxItemShape } from "@/components/ui/combobox";
import { useDropdownOrder } from "@/components/dropdown-order-provider";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/currency";
import { todayISO } from "@/lib/utils/date";
import { useDisplayCurrency } from "@/components/currency-provider";
import { OnboardingTips } from "@/components/onboarding-tips";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import {
  ACCOUNT_GROUP_DEFAULTS,
  orderGroups,
  parseGroupOrder,
  type AccountGroupOrder,
  type AccountGroupType,
} from "@/lib/accounts/groups";
import { GroupField } from "./_components/group-field";
import { ManageGroupsDialog } from "./_components/manage-groups-dialog";
import {
  TrendingUp,
  TrendingDown,
  Wallet,
  ArrowUpRight,
  ArrowDownRight,
  Plus,
  Pencil,
  Archive,
  ArchiveRestore,
  Trash2,
  FolderCog,
} from "lucide-react";

type AccountBalance = {
  accountId: number;
  accountName: string;
  accountType: string;
  accountGroup: string;
  currency: string;
  balance: number;
  convertedBalance?: number;
  archived?: boolean;
  isInvestment?: boolean;
  alias?: string | null;
};

const ACCOUNT_TYPES = [
  { value: "A", label: "Asset" },
  { value: "L", label: "Liability" },
];

// FINLYNQ-179: the default group suggestions now live in the shared
// src/lib/accounts/groups.ts (single source of truth, also used by the
// settings route + management dialog). The group field is free-text — these
// are seed suggestions, NOT an allow-list.
const ACCOUNT_GROUPS: Record<string, string[]> = ACCOUNT_GROUP_DEFAULTS;

function aliasWarning(list: AccountBalance[], alias: string, excludeId: number | null): string {
  const a = alias.trim().toLowerCase();
  if (!a) return "";
  const clash = list.find((acc) => {
    if (acc.accountId === excludeId) return false;
    const otherAlias = (acc.alias ?? "").trim().toLowerCase();
    const otherName = acc.accountName.trim().toLowerCase();
    return otherAlias === a || otherName === a;
  });
  return clash
    ? `Another account ("${clash.accountName}") already uses this name or alias — matches may be ambiguous.`
    : "";
}

function SummarySkeleton() {
  return (
    <div className="space-y-6">
      <div>
        <div className="h-8 w-40 bg-muted animate-pulse rounded-lg" />
        <div className="h-4 w-64 bg-muted animate-pulse rounded-lg mt-2" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardHeader className="pb-2">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-muted animate-pulse" />
                <div className="h-4 w-24 bg-muted animate-pulse rounded" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="h-7 w-32 bg-muted animate-pulse rounded mt-1" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="space-y-4">
            <div className="h-6 w-28 bg-muted animate-pulse rounded" />
            <Card>
              <CardHeader className="pb-2">
                <div className="h-4 w-20 bg-muted animate-pulse rounded" />
              </CardHeader>
              <CardContent className="space-y-3">
                {Array.from({ length: 3 }).map((_, j) => (
                  <div key={j} className="flex items-center justify-between py-2.5 px-3">
                    <div className="flex items-center gap-3">
                      <div className="h-8 w-8 rounded-lg bg-muted animate-pulse" />
                      <div className="h-4 w-32 bg-muted animate-pulse rounded" />
                    </div>
                    <div className="h-4 w-20 bg-muted animate-pulse rounded" />
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        ))}
      </div>
    </div>
  );
}

const emptyForm = {
  name: "",
  type: "A",
  group: "Checking",
  currency: "CAD",
  initialBalance: "0",
  note: "",
  alias: "",
};

export default function AccountsPage() {
  const { displayCurrency } = useDisplayCurrency();
  const [accounts, setAccounts] = useState<AccountBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Create account dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  // Edit account dialog
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editAccountId, setEditAccountId] = useState<number | null>(null);
  const [editAccountArchived, setEditAccountArchived] = useState(false);
  const [editForm, setEditForm] = useState({ name: "", type: "A", group: "", currency: "CAD", note: "", alias: "", isInvestment: false });
  const [editFormErrors, setEditFormErrors] = useState<Record<string, string>>({});
  const [editSaving, setEditSaving] = useState(false);
  const [editSaveError, setEditSaveError] = useState("");
  const [archiving, setArchiving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Show-archived toggle (persists archived accounts in the list with a badge)
  const [showArchived, setShowArchived] = useState(false);

  const sortCurrency = useDropdownOrder("currency");
  // FINLYNQ-148: the Settings → Dropdown Ordering "account" list is the user's
  // configured account sort order. The /accounts list must honour it (it was
  // ignoring the setting and rendering in raw API order). Pinned accounts lead
  // in the saved order; the rest fall back to a null-safe name sort (account
  // names are decrypted display values — defend against null per the safeName
  // invariant).
  const sortAccountOrder = useDropdownOrder("account");

  // FINLYNQ-179: user-customizable account groups. The saved per-type display
  // order is a settings key/value (no migration); the management surface
  // (rename / reorder / merge-into-Other) lives behind the "Manage groups"
  // button.
  const [groupOrder, setGroupOrder] = useState<AccountGroupOrder>({ A: [], L: [] });
  const [manageGroupsOpen, setManageGroupsOpen] = useState(false);

  function loadGroupOrder() {
    fetch("/api/settings/account-group-order")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.order) setGroupOrder(parseGroupOrder(JSON.stringify(d.order)));
      })
      .catch(() => {});
  }

  useEffect(() => { loadGroupOrder(); }, []);

  function loadAccounts(includeArchived = showArchived) {
    setLoading(true);
    setError(false);
    const params = new URLSearchParams();
    if (includeArchived) params.set("includeArchived", "1");
    params.set("currency", displayCurrency);
    const url = `/api/dashboard?${params.toString()}`;
    fetch(url)
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((d) => {
        setAccounts(d.balances ?? []);
        setLoading(false);
      })
      .catch(() => { setError(true); setLoading(false); });
  }

  useEffect(() => { loadAccounts(showArchived);   }, [showArchived, displayCurrency]);

  function resetForm() {
    setForm(emptyForm);
    setFormErrors({});
    setSaveError("");
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = "Name is required";
    if (!form.type) errs.type = "Type is required";
    if (!form.group.trim()) errs.group = "Group is required";
    setFormErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSaving(true);
    setSaveError("");
    try {
      const res = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          type: form.type,
          group: form.group.trim(),
          currency: form.currency,
          note: form.note.trim(),
          alias: form.alias.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        setSaveError(data.error ?? "Failed to create account");
        setSaving(false);
        return;
      }

      // If initial balance is non-zero, create an opening balance transaction
      const initialBalance = parseFloat(form.initialBalance);
      if (!isNaN(initialBalance) && initialBalance !== 0) {
        const account = await res.json();
        await fetch("/api/transactions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            date: todayISO(),
            accountId: account.id,
            categoryId: 1,
            currency: form.currency,
            amount: initialBalance,
            payee: "Opening Balance",
            note: "Initial account balance",
          }),
        });
      }

      setDialogOpen(false);
      resetForm();
      loadAccounts();
    } catch {
      setSaveError("Failed to create account");
    } finally {
      setSaving(false);
    }
  }

  function openEditDialog(a: AccountBalance) {
    setEditAccountId(a.accountId);
    setEditAccountArchived(Boolean(a.archived));
    setEditForm({ name: a.accountName, type: a.accountType, group: a.accountGroup || "", currency: a.currency, note: "", alias: a.alias ?? "", isInvestment: Boolean(a.isInvestment) });
    setEditFormErrors({});
    setEditSaveError("");
    setConfirmDelete(false);
    setEditDialogOpen(true);
  }

  async function handleToggleArchive() {
    if (editAccountId == null) return;
    setArchiving(true);
    setEditSaveError("");
    try {
      const res = await fetch("/api/accounts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editAccountId, archived: !editAccountArchived }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setEditSaveError(data.error ?? "Failed to update account");
        return;
      }
      setEditDialogOpen(false);
      loadAccounts(showArchived);
    } catch {
      setEditSaveError("Failed to update account");
    } finally {
      setArchiving(false);
    }
  }

  async function handleDelete() {
    if (editAccountId == null) return;
    setDeleting(true);
    setEditSaveError("");
    try {
      const res = await fetch(`/api/accounts?id=${editAccountId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setEditSaveError(data.error ?? "Failed to delete account");
        setConfirmDelete(false);
        return;
      }
      setEditDialogOpen(false);
      loadAccounts(showArchived);
    } catch {
      setEditSaveError("Failed to delete account");
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!editForm.name.trim()) errs.name = "Name is required";
    setEditFormErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setEditSaving(true);
    setEditSaveError("");
    try {
      const res = await fetch("/api/accounts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editAccountId, name: editForm.name.trim(), type: editForm.type, group: editForm.group.trim(), currency: editForm.currency, note: editForm.note.trim(), alias: editForm.alias.trim() || null, isInvestment: editForm.isInvestment }),
      });
      if (!res.ok) {
        const data = await res.json();
        setEditSaveError(data.error ?? "Failed to update account");
        setEditSaving(false);
        return;
      }
      setEditDialogOpen(false);
      loadAccounts();
    } catch {
      setEditSaveError("Failed to update account");
    } finally {
      setEditSaving(false);
    }
  }

  const assets = accounts.filter((a) => a.accountType === "A");
  const liabilities = accounts.filter((a) => a.accountType === "L");
  // Totals always exclude archived, even when the toggle surfaces them in the list.
  const activeAssets = assets.filter((a) => !a.archived);
  const activeLiabilities = liabilities.filter((a) => !a.archived);

  // FINLYNQ-179: the set of group names currently in use, for combobox
  // suggestions (any type) and the management dialog (scoped per type).
  const existingGroups = Array.from(
    new Set(accounts.map((a) => (a.accountGroup || "").trim()).filter(Boolean)),
  );
  const groupsByType: Record<AccountGroupType, string[]> = {
    A: Array.from(new Set(assets.map((a) => a.accountGroup || "Other"))),
    L: Array.from(new Set(liabilities.map((a) => a.accountGroup || "Other"))),
  };

  const groups = (list: AccountBalance[]) => {
    const map = new Map<string, AccountBalance[]>();
    list.forEach((a) => {
      const group = a.accountGroup || "Other";
      map.set(group, [...(map.get(group) ?? []), a]);
    });
    // FINLYNQ-179: order the GROUP SECTIONS by the user's saved per-type order
    // (settings key/value), with "Other" always last and the rest alphabetical.
    const type: AccountGroupType = list[0]?.accountType === "L" ? "L" : "A";
    const orderedGroupNames = orderGroups(
      Array.from(map.keys()),
      groupOrder[type] ?? [],
    );
    // Within each group, honour the user's configured account order (Settings →
    // Dropdown Ordering). Pinned accounts lead in saved order; the rest fall
    // back to a null-safe name sort.
    return orderedGroupNames.map(
      (group) =>
        [
          group,
          sortAccountOrder(
            map.get(group) ?? [],
            (a) => a.accountId,
            (a, b) => (a.accountName ?? "").localeCompare(b.accountName ?? ""),
          ),
        ] as const,
    );
  };

  const renderSection = (
    title: string,
    list: AccountBalance[],
    color: string,
    SectionIcon: typeof TrendingUp,
    avatarClasses: string,
  ) => (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <SectionIcon className={`h-5 w-5 ${color}`} />
        <h2 className="text-xl font-semibold">{title}</h2>
      </div>
      {groups(list).map(([group, accts]) => (
        <Card key={group} size="sm">
          <CardHeader>
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {group}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {accts.map((a) => (
              <div key={a.accountId} className={`flex items-center gap-1 rounded-lg hover:bg-muted/50 transition-colors group ${a.archived ? "opacity-60" : ""}`}>
                <Link
                  href={`/accounts/${a.accountId}`}
                  className="flex items-center justify-between flex-1 py-1.5 px-3 gap-2 min-w-0"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div
                      className={`h-7 w-7 shrink-0 rounded-lg flex items-center justify-center text-xs font-bold ${avatarClasses}`}
                    >
                      {(a.accountName ?? "?").charAt(0).toUpperCase()}
                    </div>
                    <div className="flex items-center gap-2 min-w-0">
                      <p className="font-medium text-sm truncate">
                        {a.accountName}
                        {a.alias && <span className="ml-1.5 text-xs text-muted-foreground font-normal">({a.alias})</span>}
                      </p>
                      <Badge variant="outline" className="text-[10px] shrink-0">{a.currency}</Badge>
                      {a.archived && <Badge variant="secondary" className="text-[10px] shrink-0">Archived</Badge>}
                    </div>
                  </div>
                  <span className={`font-mono text-sm font-semibold shrink-0 ${a.balance >= 0 ? color : "text-rose-600"}`}>
                    {formatCurrency(a.balance, a.currency)}
                  </span>
                </Link>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity mr-1"
                  onClick={(e) => { e.preventDefault(); openEditDialog(a); }}
                  title="Edit account"
                  aria-label="Edit account"
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );

  // Totals are aggregations across all currencies — sum the API-provided
  // convertedBalance (in displayCurrency) when present, fall back to raw balance.
  const totalAssetsConverted = activeAssets.reduce((s, a) => s + (a.convertedBalance ?? a.balance), 0);
  const totalLiabilitiesConverted = activeLiabilities.reduce((s, a) => s + (a.convertedBalance ?? a.balance), 0);

  const createAccountDialog = (
    <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
      <DialogTrigger render={<Button size="sm" className="bg-gradient-to-r from-primary to-primary/80 hover:from-primary/90 hover:to-primary/70 shadow-sm" />}>
        <Plus className="h-4 w-4 mr-1.5" /> Create Account
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Account</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Account Name</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. TD Chequing"
              autoFocus
            />
            {formErrors.name && <p className="text-xs text-destructive">{formErrors.name}</p>}
          </div>

          <div className="space-y-1.5">
            <Label>Alias <span className="text-muted-foreground text-xs">(optional)</span></Label>
            <Input
              value={form.alias}
              onChange={(e) => setForm({ ...form, alias: e.target.value })}
              placeholder="e.g. 1234 or Visa4242"
              maxLength={64}
            />
            <p className="text-xs text-muted-foreground">Short nickname used when matching transactions — e.g. last 4 digits of a card, or a receipt label.</p>
            {aliasWarning(accounts, form.alias, null) && (
              <p className="text-xs text-amber-600">{aliasWarning(accounts, form.alias, null)}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select
                value={form.type}
                onValueChange={(v) => {
                  const t = v ?? "A";
                  const defaultGroup = ACCOUNT_GROUPS[t]?.[0] ?? "";
                  setForm({ ...form, type: t, group: defaultGroup });
                }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ACCOUNT_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {formErrors.type && <p className="text-xs text-destructive">{formErrors.type}</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="create-account-group">Group</Label>
              <GroupField
                inputId="create-account-group"
                type={form.type}
                value={form.group}
                existingGroups={existingGroups}
                onChange={(v) => setForm({ ...form, group: v })}
              />
              {formErrors.group && <p className="text-xs text-destructive">{formErrors.group}</p>}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Currency</Label>
              <Combobox
                value={form.currency}
                onValueChange={(v) => setForm({ ...form, currency: v || "CAD" })}
                items={sortCurrency(
                  ["CAD", "USD", "EUR", "GBP"].map((c): ComboboxItemShape => ({ value: c, label: c })),
                  (c) => c.value,
                  (a, z) => a.label.localeCompare(z.label),
                )}
                placeholder="CAD"
                searchPlaceholder="Search…"
                emptyMessage="No matches"
                className="w-full"
              />
            </div>

            <div className="space-y-1.5">
              <Label>Initial Balance</Label>
              <Input
                type="number"
                step="0.01"
                value={form.initialBalance}
                onChange={(e) => setForm({ ...form, initialBalance: e.target.value })}
                placeholder="0.00"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Note <span className="text-muted-foreground text-xs">(optional)</span></Label>
            <Input
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              placeholder="e.g. Joint account"
            />
          </div>

          {saveError && <p className="text-sm text-destructive">{saveError}</p>}

          <div className="flex gap-2 pt-1">
            <Button type="button" variant="outline" className="flex-1" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" className="flex-1" disabled={saving}>
              {saving ? "Creating…" : "Create Account"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );

  if (loading) return <SummarySkeleton />;

  if (error) {
    return <ErrorState title="Couldn't load accounts" message="We had trouble loading your account data." onRetry={loadAccounts} />;
  }

  if (accounts.length === 0) {
    return (
      <div className="space-y-4">
        <OnboardingTips page="accounts" />
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Accounts</h1>
            <p className="text-sm text-muted-foreground mt-1">Overview of your assets, liabilities, and net worth</p>
          </div>
          {createAccountDialog}
        </div>
        <EmptyState
          icon={Wallet}
          title="No accounts yet"
          description="Create your first account or import bank data to start tracking your net worth."
          action={{ label: "Import data", href: "/import" }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <OnboardingTips page="accounts" />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Accounts</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Overview of your assets, liabilities, and net worth
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setManageGroupsOpen(true)}
            title="Rename, reorder, or merge account groups"
          >
            <FolderCog className="h-4 w-4 mr-1.5" />
            Manage groups
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowArchived((v) => !v)}
            title={showArchived ? "Hide archived accounts" : "Show archived accounts"}
          >
            <Archive className="h-4 w-4 mr-1.5" />
            {showArchived ? "Hide archived" : "Show archived"}
          </Button>
          {createAccountDialog}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {[
          { label: "Total Assets", value: totalAssetsConverted, Icon: TrendingUp, color: "emerald" },
          { label: "Total Liabilities", value: totalLiabilitiesConverted, Icon: TrendingDown, color: "rose" },
        ].map(({ label, value, Icon, color }) => (
          <Card key={label}>
            <CardContent className="pt-3 pb-3">
              <div className={`flex h-7 w-7 items-center justify-center rounded-lg mb-1.5 ${color === "emerald" ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-400" : "bg-rose-100 text-rose-600 dark:bg-rose-950/60 dark:text-rose-400"}`}>
                <Icon className="h-4 w-4" />
              </div>
              <p className="text-xs text-muted-foreground truncate">{label}</p>
              <p className={`text-lg font-bold mt-0 ${color === "emerald" ? "text-emerald-600" : "text-rose-600"}`}>
                {formatCurrency(value, displayCurrency)}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {renderSection("Assets", assets, "text-emerald-600", ArrowUpRight, "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300")}
        {renderSection("Liabilities", liabilities, "text-rose-600", ArrowDownRight, "bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300")}
      </div>

      {/* Edit account dialog */}
      <Dialog open={editDialogOpen} onOpenChange={(open) => { setEditDialogOpen(open); if (!open) { setEditAccountId(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Account</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleEdit} className="space-y-4">
            <div className="space-y-1.5">
              <Label>Account Name</Label>
              <Input
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                autoFocus
              />
              {editFormErrors.name && <p className="text-xs text-destructive">{editFormErrors.name}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Alias <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Input
                value={editForm.alias}
                onChange={(e) => setEditForm({ ...editForm, alias: e.target.value })}
                placeholder="e.g. 1234 or Visa4242"
                maxLength={64}
              />
              <p className="text-xs text-muted-foreground">Short nickname used when matching transactions — e.g. last 4 digits of a card, or a receipt label.</p>
              {aliasWarning(accounts, editForm.alias, editAccountId) && (
                <p className="text-xs text-amber-600">{aliasWarning(accounts, editForm.alias, editAccountId)}</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Type</Label>
                <Select value={editForm.type} onValueChange={(v) => {
                  const t = v ?? "A";
                  const defaultGroup = ACCOUNT_GROUPS[t]?.[0] ?? "";
                  setEditForm({ ...editForm, type: t, group: defaultGroup });
                }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ACCOUNT_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-account-group">Group</Label>
                <GroupField
                  inputId="edit-account-group"
                  type={editForm.type}
                  value={editForm.group}
                  existingGroups={existingGroups}
                  onChange={(v) => setEditForm({ ...editForm, group: v })}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Currency</Label>
              <Combobox
                value={editForm.currency}
                onValueChange={(v) => setEditForm({ ...editForm, currency: v || "CAD" })}
                items={sortCurrency(
                  ["CAD", "USD", "EUR", "GBP"].map((c): ComboboxItemShape => ({ value: c, label: c })),
                  (c) => c.value,
                  (a, z) => a.label.localeCompare(z.label),
                )}
                placeholder="CAD"
                searchPlaceholder="Search…"
                emptyMessage="No matches"
                className="w-full"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Note <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Input value={editForm.note} onChange={(e) => setEditForm({ ...editForm, note: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="isInvestment"
                  checked={editForm.isInvestment}
                  onChange={(e) => setEditForm({ ...editForm, isInvestment: e.target.checked })}
                  className="h-4 w-4 rounded border-input"
                />
                <Label htmlFor="isInvestment" className="cursor-pointer">Investment account</Label>
              </div>
              <p className="text-xs text-muted-foreground">
                When enabled, every transaction in this account must reference a portfolio holding (a security or the auto-created &quot;Cash&quot; sleeve). Turning this on now will reassign any unattributed transactions to this account&apos;s Cash holding.
              </p>
            </div>
            {editSaveError && <p className="text-sm text-destructive">{editSaveError}</p>}
            <div className="flex gap-2 pt-1">
              <Button type="button" variant="outline" className="flex-1" onClick={() => setEditDialogOpen(false)}>Cancel</Button>
              <Button type="submit" className="flex-1" disabled={editSaving || archiving || deleting}>{editSaving ? "Saving…" : "Save Changes"}</Button>
            </div>
          </form>
          <div className="mt-4 pt-4 border-t space-y-2">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Account actions</p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={handleToggleArchive}
                disabled={archiving || editSaving || deleting}
                title={editAccountArchived
                  ? "Unarchive — show this account in balances and pickers again"
                  : "Archive — hide from balances and pickers but keep history"}
              >
                {editAccountArchived ? (
                  <><ArchiveRestore className="h-4 w-4 mr-1.5" />{archiving ? "Unarchiving…" : "Unarchive"}</>
                ) : (
                  <><Archive className="h-4 w-4 mr-1.5" />{archiving ? "Archiving…" : "Archive"}</>
                )}
              </Button>
              {confirmDelete ? (
                <Button
                  type="button"
                  variant="destructive"
                  className="flex-1"
                  onClick={handleDelete}
                  disabled={deleting || archiving || editSaving}
                >
                  <Trash2 className="h-4 w-4 mr-1.5" />{deleting ? "Deleting…" : "Confirm delete"}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1 text-destructive hover:text-destructive"
                  onClick={() => setConfirmDelete(true)}
                  disabled={deleting || archiving || editSaving}
                  title="Permanently delete — only allowed if no transactions reference this account"
                >
                  <Trash2 className="h-4 w-4 mr-1.5" />Delete
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Archive hides the account from balances and pickers but keeps its history. Delete is permanent and only works when no transactions reference the account.
            </p>
          </div>
        </DialogContent>
      </Dialog>

      {/* FINLYNQ-179 — rename / reorder / merge-into-Other account groups */}
      <ManageGroupsDialog
        open={manageGroupsOpen}
        onOpenChange={setManageGroupsOpen}
        groupsByType={groupsByType}
        onChanged={() => {
          loadAccounts();
          loadGroupOrder();
        }}
      />
    </div>
  );
}
