"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/currency";
import { todayISO } from "@/lib/utils/date";
import {
  ArrowLeft,
  Wallet,
  Layers,
  Hash,
  Pencil,
  Coins,
  Plus,
  Trash2,
  Inbox,
  FileCog,
  Receipt,
  TrendingUp,
  ChevronDown,
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox, type ComboboxItemShape } from "@/components/ui/combobox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useActiveCurrencies } from "@/lib/hooks/useActiveCurrencies";
import { GroupField } from "../_components/group-field";
import { ModePicker } from "@/components/inbox/mode-picker";
import { ImportPrefsPicker } from "@/components/inbox/import-prefs-picker";
import { isMode, type Mode } from "@/components/inbox/modes";
import { NetWorthHistoryChart } from "@/components/net-worth-history-chart";
import {
  TransactionDialog,
  type DialogAccount,
  type DialogCategory,
  type DialogHolding,
} from "@/components/transactions/transaction-dialog";

type Transaction = {
  id: number;
  date: string;
  accountName: string;
  categoryName: string;
  categoryType: string;
  currency: string;
  amount: number;
  payee: string;
  note: string;
};

type Account = {
  id: number;
  type: string;
  group: string;
  name: string;
  currency: string;
  isInvestment?: boolean;
  mode?: Mode;
  /** Statement-upload field-mapping prefs (2026-06-04). */
  csvMappingMode?: "confirm" | "auto";
  ofxPayeeSource?: "name" | "memo";
};

type CashSleeve = {
  id: number;
  currency: string;
  name: string | null;
  /** Total tx count referencing this sleeve — server-side from /api/portfolio's currentShares is a sum, not a count, so we derive client-side from a separate fetch. */
  txCount?: number;
};

type AccountBalance = {
  accountId: number;
  balance: number;
  cashFlowBasis?: number;
  holdingsValue?: number;
  holdingsCostBasis?: number;
};

const ACCOUNT_TYPES = [{ value: "A", label: "Asset" }, { value: "L", label: "Liability" }];
const ACCOUNT_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  ACCOUNT_TYPES.map((t) => [t.value, t.label]),
);

/** Edit-dialog tab ids. `#reconciliation-mode` / `#import-prefs` deep-links
 *  map onto the reconciliation / import tabs (FINLYNQ-227). */
type EditTab = "details" | "reconciliation" | "import" | "sleeves";

/** All 8 portfolio ops for the investment-account quick-actions menu. The op
 *  keys match the `/portfolio/new?op=<key>` route (hyphenated, NOT underscore). */
const INVESTMENT_OPS: { op: string; label: string }[] = [
  { op: "buy", label: "Buy" },
  { op: "sell", label: "Sell" },
  { op: "swap", label: "Swap" },
  { op: "transfer", label: "In-kind transfer" },
  { op: "deposit", label: "Deposit" },
  { op: "withdrawal", label: "Withdrawal" },
  { op: "income-expense", label: "Income / expense" },
  { op: "fx-conversion", label: "FX conversion" },
];

export default function AccountDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const [account, setAccount] = useState<Account | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [txns, setTxns] = useState<Transaction[]>([]);
  const [total, setTotal] = useState(0);
  const [balance, setBalance] = useState<number | null>(null);
  const [cashFlowBasis, setCashFlowBasis] = useState<number | null>(null);
  const [holdingsValue, setHoldingsValue] = useState<number | null>(null);

  // Edit dialog (Details / Reconciliation / Import / Cash sleeves tabs).
  const [editOpen, setEditOpen] = useState(false);
  const [editTab, setEditTab] = useState<EditTab>("details");
  const [editForm, setEditForm] = useState({ name: "", type: "A", group: "", currency: "USD", note: "", openingBalanceAmount: "", openingBalanceDate: "" });
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");
  // FINLYNQ-206 — the opening balance currently backing this (cash) account,
  // loaded from its single kind='opening_balance' transaction. null = none yet.
  // Used to detect a real change before issuing the opening-balance PUT.
  const [obOriginal, setObOriginal] = useState<{ amount: number; date: string } | null>(null);
  // Keep the form's current currency present in the dropdown even if it was
  // later deselected under Settings → Currencies you use (#291).
  const editCurrencyOptions = useActiveCurrencies(editForm.currency);

  // Generic "New transaction" dialog (normal accounts only) — embeds the shared
  // TransactionDialog seeded with this account pre-selected (FINLYNQ-227).
  const [txDialogOpen, setTxDialogOpen] = useState(false);
  const [dialogCategories, setDialogCategories] = useState<DialogCategory[]>([]);
  const [dialogHoldings, setDialogHoldings] = useState<DialogHolding[]>([]);

  // Cash sleeves panel — list + create + delete, surfaced inside the Edit
  // dialog (FINLYNQ-227). Cash sleeves are explicit `portfolio_holdings.is_cash`
  // rows, one per (account, currency); users provision them before recording
  // Buy/Sell/FX operations.
  const [sleeves, setSleeves] = useState<CashSleeve[]>([]);
  const [sleevesLoading, setSleevesLoading] = useState(false);
  const [newSleeveOpen, setNewSleeveOpen] = useState(false);
  const [newSleeveCurrency, setNewSleeveCurrency] = useState<string>("");
  const [newSleeveSaving, setNewSleeveSaving] = useState(false);
  const [newSleeveError, setNewSleeveError] = useState("");
  const sleeveCurrencyOptions = useActiveCurrencies(newSleeveCurrency);
  // Sleeve-delete confirm (shared ConfirmDialog, replaces window.confirm).
  const [deleteSleeveId, setDeleteSleeveId] = useState<number | null>(null);
  const [deletingSleeve, setDeletingSleeve] = useState(false);
  const [deleteSleeveError, setDeleteSleeveError] = useState("");

  // Group suggestions: the user's existing group names across all accounts.
  const existingGroups = useMemo(
    () =>
      Array.from(
        new Set(accounts.map((a) => (a.group || "").trim()).filter(Boolean)),
      ),
    [accounts],
  );

  async function refreshSleeves() {
    if (!id) return;
    setSleevesLoading(true);
    try {
      const res = await fetch("/api/portfolio");
      if (!res.ok) return;
      const all: Array<{
        id: number;
        accountId: number | null;
        currency: string;
        isCash: boolean;
        name: string | null;
      }> = await res.json();
      const mine = all.filter(
        (h) => h.accountId === Number(id) && h.isCash === true,
      );
      // Pull tx count per sleeve for the "Delete" gating.
      const withCounts = await Promise.all(
        mine.map(async (h) => {
          const r = await fetch(
            `/api/transactions?portfolioHoldingId=${h.id}&limit=1`,
          );
          const j = await r.json();
          return {
            id: h.id,
            currency: h.currency,
            name: h.name,
            txCount: Number(j.total ?? 0),
          };
        }),
      );
      setSleeves(withCounts);
    } finally {
      setSleevesLoading(false);
    }
  }

  useEffect(() => {
    void refreshSleeves();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function openNewSleeve() {
    setNewSleeveCurrency(account?.currency ?? "USD");
    setNewSleeveError("");
    setNewSleeveOpen(true);
  }

  async function handleCreateSleeve(e: React.FormEvent) {
    e.preventDefault();
    setNewSleeveSaving(true);
    setNewSleeveError("");
    try {
      const res = await fetch("/api/portfolio/holdings/cash-sleeve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: Number(id),
          currency: newSleeveCurrency,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        setNewSleeveError(data.error ?? "Failed to create sleeve");
        return;
      }
      setNewSleeveOpen(false);
      await refreshSleeves();
    } catch {
      setNewSleeveError("Failed to create sleeve");
    } finally {
      setNewSleeveSaving(false);
    }
  }

  const sleeveToDelete = sleeves.find((s) => s.id === deleteSleeveId) ?? null;

  async function confirmDeleteSleeve() {
    if (deleteSleeveId == null) return;
    setDeletingSleeve(true);
    setDeleteSleeveError("");
    const res = await fetch(
      `/api/portfolio/holdings/cash-sleeve?id=${deleteSleeveId}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setDeleteSleeveError(data.error ?? "Failed to delete sleeve");
      setDeletingSleeve(false);
      return;
    }
    setDeletingSleeve(false);
    setDeleteSleeveId(null);
    await refreshSleeves();
  }

  // Re-fetch the computed balance + recent transactions (the opening balance
  // feeds both). Mirrors the initial load effect.
  function refreshBalanceAndTxns() {
    fetch("/api/dashboard")
      .then((r) => r.json())
      .then((d) => {
        const b = d.balances?.find((x: AccountBalance) => x.accountId === Number(id));
        setBalance(b?.balance ?? 0);
        setCashFlowBasis(b?.cashFlowBasis ?? null);
        setHoldingsValue(b?.holdingsValue ?? null);
      })
      .catch(() => {});
    fetch(`/api/transactions?accountId=${id}&limit=200`)
      .then((r) => r.json())
      .then((d) => {
        setTxns(d.data);
        setTotal(d.total);
      })
      .catch(() => {});
  }

  function openEdit(tab: EditTab = "details") {
    if (!account) return;
    setEditForm({ name: account.name, type: account.type, group: account.group || "", currency: account.currency, note: "", openingBalanceAmount: "", openingBalanceDate: "" });
    setObOriginal(null);
    setEditError("");
    setEditTab(tab);
    setEditOpen(true);
    // FINLYNQ-206 — seed the opening-balance field from its backing
    // transaction (cash accounts only; the field is hidden for investment).
    if (account.isInvestment !== true) {
      fetch(`/api/accounts/${account.id}/opening-balance`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          const ob: { amount: number; date: string } | null = j?.data ?? null;
          setObOriginal(ob ? { amount: ob.amount, date: ob.date } : null);
          setEditForm((f) => ({
            ...f,
            openingBalanceAmount: ob ? String(ob.amount) : "",
            openingBalanceDate: ob ? ob.date : todayISO(),
          }));
        })
        .catch(() => {});
    }
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    const isInvestmentAccount = account?.isInvestment === true;

    // Opening balance (cash accounts only). Validate before any write so a
    // bad value doesn't half-save.
    const amtStr = editForm.openingBalanceAmount.trim();
    const newAmount: number | null = amtStr === "" ? null : Number(amtStr);
    if (!isInvestmentAccount && amtStr !== "" && !Number.isFinite(newAmount as number)) {
      setEditError("Opening balance must be a number");
      return;
    }
    const newDate = editForm.openingBalanceDate || todayISO();

    setEditSaving(true);
    setEditError("");
    try {
      // `editForm` carries the opening-balance fields too; strip them from the
      // account PUT (the /api/accounts route doesn't know them).
      const { openingBalanceAmount: _a, openingBalanceDate: _d, ...accountFields } = editForm;
      void _a; void _d;
      const res = await fetch("/api/accounts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: Number(id), ...accountFields }),
      });
      if (!res.ok) {
        const data = await res.json();
        setEditError(data.error ?? "Failed to update");
        return;
      }
      const updated = await res.json();
      setAccount(updated);

      // Persist the opening balance only when it actually changed. A
      // null amount with no existing row is a no-op (no row created).
      const prevAmount = obOriginal?.amount ?? null;
      const obChanged =
        newAmount !== prevAmount ||
        (obOriginal != null && newDate !== obOriginal.date);
      if (
        !isInvestmentAccount &&
        obChanged &&
        !(newAmount == null && obOriginal == null)
      ) {
        const obRes = await fetch(`/api/accounts/${id}/opening-balance`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amount: newAmount, date: newDate }),
        });
        if (!obRes.ok) {
          const d = await obRes.json().catch(() => ({}));
          setEditError(d.error ?? "Account saved, but the opening balance failed to update");
          refreshBalanceAndTxns();
          return;
        }
      }

      setEditOpen(false);
      refreshBalanceAndTxns();
    } catch {
      setEditError("Failed to update account");
    } finally {
      setEditSaving(false);
    }
  }

  // Lazily fetch categories + holdings the first time the user opens the
  // generic transaction dialog (normal accounts only).
  function openTxDialog() {
    setTxDialogOpen(true);
    if (dialogCategories.length === 0) {
      fetch("/api/categories")
        .then((r) => (r.ok ? r.json() : []))
        .then((c) => setDialogCategories(Array.isArray(c) ? c : []))
        .catch(() => {});
    }
    if (dialogHoldings.length === 0) {
      fetch("/api/portfolio")
        .then((r) => (r.ok ? r.json() : []))
        .then((h) => setDialogHoldings(Array.isArray(h) ? h : []))
        .catch(() => {});
    }
  }

  useEffect(() => {
    fetch("/api/accounts")
      .then((r) => r.json())
      .then((accts: Account[]) => {
        setAccounts(Array.isArray(accts) ? accts : []);
        const found = accts.find((a: Account) => a.id === Number(id));
        setAccount(found ?? null);
      });

    // Fetch the computed balance from the dashboard API. For investment
    // accounts, balance = market value of holdings; cashFlowBasis is the
    // transaction sum surfaced separately.
    fetch("/api/dashboard")
      .then((r) => r.json())
      .then((d) => {
        const acctBalance = d.balances?.find((b: AccountBalance) => b.accountId === Number(id));
        setBalance(acctBalance?.balance ?? 0);
        setCashFlowBasis(acctBalance?.cashFlowBasis ?? null);
        setHoldingsValue(acctBalance?.holdingsValue ?? null);
      });

    fetch(`/api/transactions?accountId=${id}&limit=200`)
      .then((r) => r.json())
      .then((d) => {
        setTxns(d.data);
        setTotal(d.total);
      });
  }, [id]);

  // Deep-link preservation (FINLYNQ-227): `/accounts/[id]#reconciliation-mode`
  // (from the /inbox lens-chip gear) and `#import-prefs` now open the Edit
  // dialog on the matching tab instead of scrolling to a (removed) card. Runs
  // once the account has loaded so openEdit has data to seed the form.
  useEffect(() => {
    if (!account) return;
    if (typeof window === "undefined") return;
    const hash = window.location.hash;
    if (hash === "#reconciliation-mode") openEdit("reconciliation");
    else if (hash === "#import-prefs") openEdit("import");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  if (!account) return (
    <div className="space-y-6">
      <div className="h-4 w-32 bg-muted animate-pulse rounded" />
      <div className="h-8 w-64 bg-muted animate-pulse rounded-lg" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => <div key={i} className="h-24 bg-muted animate-pulse rounded-xl" />)}
      </div>
    </div>
  );

  const displayBalance = balance ?? 0;
  const isInvestment = account.isInvestment === true;

  // Build a `/portfolio/new?op=<key>&account=<id>[&accountField=…]` href for an
  // op launched from THIS account. The accountField tells Deposit/Withdrawal
  // which of their two account sides this account fills.
  function opHref(op: string): string {
    const params = new URLSearchParams({ op, account: String(account!.id) });
    if (isInvestment) {
      // Investment account: it is the brokerage side. For Deposit that's the
      // DEST; for everything else (incl. Withdrawal source) it's the default.
      if (op === "deposit") params.set("accountField", "dest");
    } else {
      // Normal account: it is the cash side. Deposit source is the default;
      // Withdrawal dest needs the override.
      if (op === "withdrawal") params.set("accountField", "dest");
    }
    return `/portfolio/new?${params.toString()}`;
  }

  // Normal accounts can only deposit to / withdraw from a brokerage.
  const normalInvestmentOps = INVESTMENT_OPS.filter(
    (o) => o.op === "deposit" || o.op === "withdrawal",
  );

  const dialogAccount: DialogAccount = {
    id: account.id,
    name: account.name,
    currency: account.currency,
    type: account.type,
    isInvestment: account.isInvestment,
  };

  return (
    <div className="space-y-6">
      <Link href="/accounts" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
        <ArrowLeft className="h-4 w-4" /> Back to Accounts
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className={`h-10 w-10 rounded-xl flex items-center justify-center text-sm font-bold ${account.type === "A" ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
            {(account.name ?? "?").charAt(0)}
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{account.name}</h1>
            <div className="flex gap-2 mt-0.5">
              <Badge variant="outline" className="text-[10px]">{account.currency}</Badge>
              <Badge variant={account.type === "A" ? "default" : "destructive"} className="text-[10px]">
                {account.type === "A" ? "Asset" : "Liability"}
              </Badge>
              {isInvestment && (
                <Badge variant="secondary" className="text-[10px]">Investment</Badge>
              )}
            </div>
          </div>
        </div>

        {/* Quick-actions (FINLYNQ-227). Normal accounts: New transaction +
            Deposit/Withdrawal. Investment accounts: all 8 portfolio ops, no
            generic New transaction (per the investment-hidden-from-generic
            -dialog invariant). */}
        <div className="flex items-center gap-1.5">
          {!isInvestment && (
            <Button size="sm" onClick={openTxDialog}>
              <Receipt className="h-3.5 w-3.5 mr-1.5" /> New transaction
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="outline" size="sm">
                  <TrendingUp className="h-3.5 w-3.5 mr-1.5" /> Investment transaction
                  <ChevronDown className="h-3.5 w-3.5 ml-1.5" />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="min-w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel>
                  {isInvestment ? "Portfolio operations" : "Brokerage cash move"}
                </DropdownMenuLabel>
                {(isInvestment ? INVESTMENT_OPS : normalInvestmentOps).map((o) => (
                  <DropdownMenuItem
                    key={o.op}
                    onClick={() => router.push(opHref(o.op))}
                  >
                    {o.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" size="sm" onClick={() => openEdit("details")}>
            <Pencil className="h-3.5 w-3.5 mr-1.5" /> Edit
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  {holdingsValue && holdingsValue > 0 ? "Market value" : "Balance"}
                </p>
                <p className={`text-2xl font-bold tracking-tight mt-1 ${displayBalance >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                  {formatCurrency(displayBalance, account.currency)}
                </p>
                {holdingsValue && holdingsValue > 0 && cashFlowBasis !== null ? (
                  <p className="text-xs text-muted-foreground mt-2">
                    Cash flow:{" "}
                    <span className="font-medium text-foreground">
                      {formatCurrency(cashFlowBasis, account.currency)}
                    </span>
                  </p>
                ) : null}
              </div>
              <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${displayBalance >= 0 ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-400" : "bg-rose-100 text-rose-600 dark:bg-rose-950/60 dark:text-rose-400"}`}>
                <Wallet className="h-5 w-5" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-medium text-muted-foreground">Group</p>
                <p className="text-lg font-semibold mt-1">{account.group || "None"}</p>
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400">
                <Layers className="h-5 w-5" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-medium text-muted-foreground">Transactions</p>
                <p className="text-lg font-semibold mt-1">{total}</p>
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100 text-amber-600 dark:bg-amber-950/60 dark:text-amber-400">
                <Hash className="h-5 w-5" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Balance Over Time — accurate daily series (cash live from
          transactions, investments from stored snapshots).
          plan/net-worth-over-time.md Part A. */}
      <NetWorthHistoryChart accountId={account.id} title="Balance Over Time" />

      {/* Reconciliation mode, Import preferences, and Cash sleeves moved into
          the Edit dialog (FINLYNQ-227) — they declutter the main page and are
          reachable via the Edit button (or the #reconciliation-mode /
          #import-prefs deep-links, which open the dialog to the right tab). */}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Recent Transactions</CardTitle>
          <p className="text-xs text-muted-foreground">Last {txns.length} transactions</p>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Date</TableHead>
                <TableHead className="text-xs">Category</TableHead>
                <TableHead className="text-xs">Payee</TableHead>
                <TableHead className="text-xs">Note</TableHead>
                <TableHead className="text-xs text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {txns.map((t) => (
                <TableRow key={t.id} className="hover:bg-muted/30">
                  <TableCell className="text-sm">{formatDate(t.date)}</TableCell>
                  <TableCell className="text-sm">{t.categoryName ?? "-"}</TableCell>
                  <TableCell className="text-sm">{t.payee || "-"}</TableCell>
                  <TableCell className="text-sm text-muted-foreground max-w-40 truncate">{t.note || "-"}</TableCell>
                  <TableCell className={`text-right font-mono text-sm font-semibold ${t.amount >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                    {formatCurrency(t.amount, t.currency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Generic transaction dialog — normal accounts only, seeded with THIS
          account pre-selected (FINLYNQ-227). */}
      <TransactionDialog
        open={txDialogOpen}
        onOpenChange={setTxDialogOpen}
        accounts={[dialogAccount]}
        categories={dialogCategories}
        holdings={dialogHoldings}
        initialState={{
          kind: "transaction-prefill",
          values: { accountId: String(account.id), currency: account.currency },
        }}
        onSaved={() => {
          setTxDialogOpen(false);
          fetch(`/api/transactions?accountId=${id}&limit=200`)
            .then((r) => r.json())
            .then((d) => {
              setTxns(d.data);
              setTotal(d.total);
            })
            .catch(() => {});
        }}
      />

      {/* Create cash sleeve dialog */}
      <Dialog open={newSleeveOpen} onOpenChange={setNewSleeveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add cash sleeve</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreateSleeve} className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Creates a per-currency cash position inside <b>{account.name}</b>.
              Only one sleeve per currency is allowed.
            </p>
            <div className="space-y-1.5">
              <Label>Currency</Label>
              <Combobox
                value={newSleeveCurrency}
                onValueChange={(v) => setNewSleeveCurrency(v || "")}
                items={sleeveCurrencyOptions.map(
                  (c): ComboboxItemShape => ({ value: c, label: c }),
                )}
                placeholder="Pick a currency"
                searchPlaceholder="Search…"
                emptyMessage="No matches"
                className="w-full"
              />
            </div>
            {newSleeveError && (
              <p className="text-sm text-destructive">{newSleeveError}</p>
            )}
            <div className="flex gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={() => setNewSleeveOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="flex-1"
                disabled={newSleeveSaving || !newSleeveCurrency}
              >
                {newSleeveSaving ? "Creating…" : "Create sleeve"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Cash-sleeve delete confirmation (shared ConfirmDialog). */}
      <ConfirmDialog
        open={deleteSleeveId != null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteSleeveId(null);
            setDeleteSleeveError("");
          }
        }}
        title="Delete cash sleeve"
        description={
          <>
            Delete the {sleeveToDelete?.currency} cash sleeve? This is only
            allowed when no transactions reference it.
            {deleteSleeveError && (
              <span className="mt-2 block text-destructive">{deleteSleeveError}</span>
            )}
          </>
        }
        confirmLabel="Delete sleeve"
        busy={deletingSleeve}
        onConfirm={() => void confirmDeleteSleeve()}
      />

      {/* Edit account dialog — Details / Reconciliation / Import / Cash sleeves
          tabs (FINLYNQ-227). Widened with sm:max-w-* (never bare max-w-*) per
          FINLYNQ-144; keeps the base phone gutter + internal scroll. */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Edit Account</DialogTitle>
          </DialogHeader>
          <Tabs
            value={editTab}
            onValueChange={(v) => setEditTab((v as EditTab) ?? "details")}
          >
            <TabsList className="w-full">
              <TabsTrigger value="details">Details</TabsTrigger>
              <TabsTrigger value="reconciliation">Reconciliation</TabsTrigger>
              <TabsTrigger value="import">Import</TabsTrigger>
              <TabsTrigger value="sleeves">Cash sleeves</TabsTrigger>
            </TabsList>

            {/* Details */}
            <TabsContent value="details" className="pt-4">
              <form onSubmit={handleEdit} className="space-y-4">
                <div className="space-y-1.5">
                  <Label>Account Name</Label>
                  <Input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} autoFocus />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>Type</Label>
                    <Select
                      items={ACCOUNT_TYPE_LABELS}
                      value={editForm.type}
                      onValueChange={(v) => setEditForm({ ...editForm, type: v ?? "A" })}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {ACCOUNT_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="edit-detail-group">Group</Label>
                    <GroupField
                      inputId="edit-detail-group"
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
                    onValueChange={(v) => setEditForm({ ...editForm, currency: v || "USD" })}
                    items={editCurrencyOptions.map(
                      (c): ComboboxItemShape => ({ value: c, label: c }),
                    )}
                    placeholder="USD"
                    searchPlaceholder="Search…"
                    emptyMessage="No matches"
                    className="w-full"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Note <span className="text-muted-foreground text-xs">(optional)</span></Label>
                  <Input value={editForm.note} onChange={(e) => setEditForm({ ...editForm, note: e.target.value })} />
                </div>

                {/* Opening balance (FINLYNQ-206) — cash accounts only. Backed
                    by ONE kind='opening_balance' transaction; clearing zeroes
                    it (never deletes). Hidden for investment accounts (their
                    balance comes from holdings; out of v1 scope). */}
                {!isInvestment && (
                  <div className="space-y-2 rounded-lg border border-border/60 p-3">
                    <Label>Opening balance <span className="text-muted-foreground text-xs">(optional)</span></Label>
                    <p className="text-xs text-muted-foreground">
                      A single starting-balance entry for this account. Set the
                      date to when the account opened so Balance Over Time and
                      Net Worth history start from the right point. Clearing the
                      amount zeroes the entry — it is not deleted.
                    </p>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label htmlFor="ob-amount">Amount</Label>
                        <Input
                          id="ob-amount"
                          type="number"
                          step="0.01"
                          value={editForm.openingBalanceAmount}
                          onChange={(e) => setEditForm({ ...editForm, openingBalanceAmount: e.target.value })}
                          placeholder="0.00"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="ob-date">Date</Label>
                        <Input
                          id="ob-date"
                          type="date"
                          value={editForm.openingBalanceDate}
                          onChange={(e) => setEditForm({ ...editForm, openingBalanceDate: e.target.value })}
                        />
                      </div>
                    </div>
                  </div>
                )}

                {editError && <p className="text-sm text-destructive">{editError}</p>}
                <div className="flex gap-2 pt-1">
                  <Button type="button" variant="outline" className="flex-1" onClick={() => setEditOpen(false)}>Cancel</Button>
                  <Button type="submit" className="flex-1" disabled={editSaving}>{editSaving ? "Saving…" : "Save Changes"}</Button>
                </div>
              </form>
            </TabsContent>

            {/* Reconciliation mode — Inbox v4 Phase 5. Persists `accounts.mode`
                via PATCH /api/accounts/[id]/mode. The /inbox lens-chip gear
                deep-links here via #reconciliation-mode. */}
            <TabsContent value="reconciliation" className="pt-4 space-y-3">
              <div className="flex items-center gap-2">
                <Inbox className="h-4 w-4 text-sky-600" />
                <h3 className="text-sm font-medium">Reconciliation mode</h3>
              </div>
              <p className="text-xs text-muted-foreground">
                How uploads to this account flow through the pipeline. The{" "}
                <code className="px-1 mx-0.5 rounded bg-muted text-[10px]">/inbox</code>{" "}
                chip is a per-render lens; this picker is the persisted policy.
              </p>
              <ModePicker
                accountId={account.id}
                initialMode={isMode(account.mode) ? account.mode : "manual"}
                onSaved={(m) => setAccount({ ...account, mode: m })}
              />
            </TabsContent>

            {/* Import field-mapping preferences (2026-06-04). The canonical home
                for resetting an account from "apply automatically" back to
                "ask me first". Deep-linked via #import-prefs. */}
            <TabsContent value="import" className="pt-4 space-y-3">
              <div className="flex items-center gap-2">
                <FileCog className="h-4 w-4 text-violet-600" />
                <h3 className="text-sm font-medium">Import preferences</h3>
              </div>
              <p className="text-xs text-muted-foreground">
                Whether CSV / OFX / QFX uploads to this account show a
                field-mapping preview before staging, and which OFX field becomes
                the payee.
              </p>
              <ImportPrefsPicker
                accountId={account.id}
                initialCsvMappingMode={
                  account.csvMappingMode === "auto" ? "auto" : "confirm"
                }
                initialOfxPayeeSource={
                  account.ofxPayeeSource === "memo" ? "memo" : "name"
                }
                onSaved={(prefs) =>
                  setAccount({
                    ...account,
                    csvMappingMode: prefs.csvMappingMode,
                    ofxPayeeSource: prefs.ofxPayeeSource,
                  })
                }
              />
            </TabsContent>

            {/* Cash sleeves — list + add + delete-when-no-tx. */}
            <TabsContent value="sleeves" className="pt-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <Coins className="h-4 w-4 text-emerald-600" />
                    <h3 className="text-sm font-medium">Cash sleeves</h3>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Per-currency cash positions inside this account. Required
                    before recording buys, sells, or FX conversions in a new
                    currency.
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={openNewSleeve}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" /> Add sleeve
                </Button>
              </div>
              {sleevesLoading && sleeves.length === 0 ? (
                <div className="h-12 bg-muted animate-pulse rounded-md" />
              ) : sleeves.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No cash sleeves yet. Add one to start recording trades.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Currency</TableHead>
                      <TableHead className="text-xs">Name</TableHead>
                      <TableHead className="text-xs text-right">Transactions</TableHead>
                      <TableHead className="text-xs text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sleeves.map((s) => (
                      <TableRow key={s.id} className="hover:bg-muted/30">
                        <TableCell>
                          <Badge variant="outline" className="text-[10px] font-mono">
                            {s.currency}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm">{s.name ?? `Cash ${s.currency}`}</TableCell>
                        <TableCell className="text-right text-sm tabular-nums">
                          {s.txCount ?? 0}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={(s.txCount ?? 0) > 0}
                            title={
                              (s.txCount ?? 0) > 0
                                ? "Sleeve has transactions — delete or reassign them first"
                                : "Delete sleeve"
                            }
                            onClick={() => {
                              setDeleteSleeveError("");
                              setDeleteSleeveId(s.id);
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-rose-600" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
    </div>
  );
}
