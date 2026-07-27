"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useDropdownOrder } from "@/components/dropdown-order-provider";
import { formatCurrency } from "@/lib/currency";
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
import { ManageGroupsDialog } from "./_components/manage-groups-dialog";
import { AccountDialog } from "./_components/account-dialog";
import {
  TrendingUp,
  TrendingDown,
  Wallet,
  ArrowUpRight,
  ArrowDownRight,
  Plus,
  Archive,
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
// value→label map for base-ui Select trigger (FINLYNQ-197).
const ACCOUNT_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  ACCOUNT_TYPES.map((t) => [t.value, t.label]),
);

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

export default function AccountsPage() {
  const { displayCurrency } = useDisplayCurrency();
  const [accounts, setAccounts] = useState<AccountBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Create account dialog — the form + save flow live in the shared
  // <AccountDialog> (FINLYNQ-206 follow-up); this page only owns open state.
  // Editing an account lives on its detail page (/accounts/[id]).
  const [dialogOpen, setDialogOpen] = useState(false);

  // Show-archived toggle (persists archived accounts in the list with a badge)
  const [showArchived, setShowArchived] = useState(false);
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
                  {/* FINLYNQ-303 — both bases per row: the account's own
                      currency is the primary figure, with the display-currency
                      equivalent beneath it when they differ. The totals below
                      remain reporting-only (a cross-currency sum has no native
                      basis). */}
                  <span className="shrink-0 mr-2 text-right">
                    <span className={`font-mono text-sm font-semibold block ${a.balance >= 0 ? color : "text-rose-600"}`}>
                      {formatCurrency(a.balance, a.currency)}
                    </span>
                    {a.convertedBalance != null &&
                      a.currency.toUpperCase() !== displayCurrency.toUpperCase() && (
                        <span className="font-mono text-[11px] text-muted-foreground block">
                          {formatCurrency(a.convertedBalance, displayCurrency)}
                        </span>
                      )}
                  </span>
                </Link>
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
    <>
      <Button
        size="sm"
        className="bg-gradient-to-r from-primary to-primary/80 hover:from-primary/90 hover:to-primary/70 shadow-sm"
        onClick={() => setDialogOpen(true)}
      >
        <Plus className="h-4 w-4 mr-1.5" /> Create Account
      </Button>
      <AccountDialog
        mode="create"
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        defaultCurrency={displayCurrency}
        existingGroups={existingGroups}
        aliasWarning={(alias, excludeId) => aliasWarning(accounts, alias, excludeId)}
        onCreated={() => loadAccounts()}
      />
    </>
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
