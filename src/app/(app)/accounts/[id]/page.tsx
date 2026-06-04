"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/currency";
import { ArrowLeft, Wallet, Layers, Hash, Pencil, Coins, Plus, Trash2, Inbox, FileCog } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SUPPORTED_FIAT_CURRENCIES } from "@/lib/fx/supported-currencies";
import { ModePicker } from "@/components/inbox/mode-picker";
import { ImportPrefsPicker } from "@/components/inbox/import-prefs-picker";
import { isMode, type Mode } from "@/components/inbox/modes";
import { NetWorthHistoryChart } from "@/components/net-worth-history-chart";

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
const ACCOUNT_GROUPS: Record<string, string[]> = {
  A: ["Cash", "Checking", "Savings", "Investment", "Property", "Other"],
  L: ["Credit Card", "Loan", "Mortgage", "Other"],
};

export default function AccountDetailPage() {
  const { id } = useParams();
  const [account, setAccount] = useState<Account | null>(null);
  const [txns, setTxns] = useState<Transaction[]>([]);
  const [total, setTotal] = useState(0);
  const [balance, setBalance] = useState<number | null>(null);
  const [cashFlowBasis, setCashFlowBasis] = useState<number | null>(null);
  const [holdingsValue, setHoldingsValue] = useState<number | null>(null);

  // Edit dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({ name: "", type: "A", group: "", currency: "CAD", note: "" });
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");

  // Cash sleeves panel — list + create + delete.
  // Phase 2 of the portfolio-ops refactor: cash sleeves are explicit
  // `portfolio_holdings.is_cash=TRUE` rows, one per (account, currency).
  // Users provision them here before recording Buy/Sell/FX operations.
  const [sleeves, setSleeves] = useState<CashSleeve[]>([]);
  const [sleevesLoading, setSleevesLoading] = useState(false);
  const [newSleeveOpen, setNewSleeveOpen] = useState(false);
  const [newSleeveCurrency, setNewSleeveCurrency] = useState<string>("");
  const [newSleeveSaving, setNewSleeveSaving] = useState(false);
  const [newSleeveError, setNewSleeveError] = useState("");

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
    setNewSleeveCurrency(account?.currency ?? "CAD");
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

  async function handleDeleteSleeve(sleeveId: number) {
    const sleeve = sleeves.find((s) => s.id === sleeveId);
    if (!sleeve) return;
    if (
      !confirm(
        `Delete the ${sleeve.currency} cash sleeve? This is only allowed when no transactions reference it.`,
      )
    ) {
      return;
    }
    const res = await fetch(
      `/api/portfolio/holdings/cash-sleeve?id=${sleeveId}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      const data = await res.json();
      alert(data.error ?? "Failed to delete sleeve");
      return;
    }
    await refreshSleeves();
  }

  function openEdit() {
    if (!account) return;
    setEditForm({ name: account.name, type: account.type, group: account.group || "", currency: account.currency, note: "" });
    setEditError("");
    setEditOpen(true);
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    setEditSaving(true);
    setEditError("");
    try {
      const res = await fetch("/api/accounts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: Number(id), ...editForm }),
      });
      if (!res.ok) {
        const data = await res.json();
        setEditError(data.error ?? "Failed to update");
        return;
      }
      const updated = await res.json();
      setAccount(updated);
      setEditOpen(false);
    } catch {
      setEditError("Failed to update account");
    } finally {
      setEditSaving(false);
    }
  }

  useEffect(() => {
    fetch("/api/accounts")
      .then((r) => r.json())
      .then((accts) => {
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

  return (
    <div className="space-y-6">
      <Link href="/accounts" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
        <ArrowLeft className="h-4 w-4" /> Back to Accounts
      </Link>

      <div className="flex items-center justify-between">
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
            </div>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={openEdit}>
          <Pencil className="h-3.5 w-3.5 mr-1.5" /> Edit
        </Button>
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
              <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${displayBalance >= 0 ? "bg-emerald-100 text-emerald-600" : "bg-rose-100 text-rose-600"}`}>
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
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600">
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
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100 text-amber-600">
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

      {/* Reconciliation mode — Inbox v4 Phase 5 (2026-05-27).
          Persists `accounts.mode` via PATCH /api/accounts/[id]/mode.
          The /inbox lens-chip gear icon deep-links to this card. */}
      <Card id="reconciliation-mode">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Inbox className="h-4 w-4 text-sky-600" /> Reconciliation mode
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            How uploads to this account flow through the pipeline. The
            <code className="px-1 mx-0.5 rounded bg-muted text-[10px]">/inbox</code>
            chip is a per-render lens; this picker is the persisted policy.
          </p>
        </CardHeader>
        <CardContent>
          <ModePicker
            accountId={account.id}
            initialMode={isMode(account.mode) ? account.mode : "manual"}
            onSaved={(m) => setAccount({ ...account, mode: m })}
          />
        </CardContent>
      </Card>

      {/* Import field-mapping preferences (2026-06-04). The canonical home for
          resetting an account that was set to "apply automatically" back to
          "ask me first" — once 'auto', the upload preview never reappears. */}
      <Card id="import-prefs">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <FileCog className="h-4 w-4 text-violet-600" /> Import preferences
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Whether CSV / OFX / QFX uploads to this account show a field-mapping
            preview before staging, and which OFX field becomes the payee.
          </p>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>

      {/* Cash sleeves — Phase 2 portfolio-ops UI. Visible on every account so
          users can also see "no sleeves" on non-investment accounts. */}
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Coins className="h-4 w-4 text-emerald-600" /> Cash sleeves
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Per-currency cash positions inside this account. Required before
              recording buys, sells, or FX conversions in a new currency.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={openNewSleeve}>
            <Plus className="h-3.5 w-3.5 mr-1.5" /> Add sleeve
          </Button>
        </CardHeader>
        <CardContent>
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
                        onClick={() => void handleDeleteSleeve(s.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-rose-600" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

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
              <Select
                value={newSleeveCurrency}
                onValueChange={(v) => setNewSleeveCurrency(v ?? "")}
              >
                <SelectTrigger><SelectValue placeholder="Pick a currency" /></SelectTrigger>
                <SelectContent>
                  {SUPPORTED_FIAT_CURRENCIES.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
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

      {/* Edit account dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Account</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleEdit} className="space-y-4">
            <div className="space-y-1.5">
              <Label>Account Name</Label>
              <Input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} autoFocus />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Type</Label>
                <Select value={editForm.type} onValueChange={(v) => {
                  const t = v ?? "A";
                  setEditForm({ ...editForm, type: t, group: ACCOUNT_GROUPS[t]?.[0] ?? "" });
                }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ACCOUNT_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Group</Label>
                <Select value={editForm.group} onValueChange={(v) => setEditForm({ ...editForm, group: v ?? "" })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(ACCOUNT_GROUPS[editForm.type] ?? []).map((g) => <SelectItem key={g} value={g}>{g}</SelectItem>)}
                    <SelectItem value="Other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Currency</Label>
              <Select value={editForm.currency} onValueChange={(v) => setEditForm({ ...editForm, currency: v ?? "CAD" })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="CAD">CAD</SelectItem>
                  <SelectItem value="USD">USD</SelectItem>
                  <SelectItem value="EUR">EUR</SelectItem>
                  <SelectItem value="GBP">GBP</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Note <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Input value={editForm.note} onChange={(e) => setEditForm({ ...editForm, note: e.target.value })} />
            </div>
            {editError && <p className="text-sm text-destructive">{editError}</p>}
            <div className="flex gap-2 pt-1">
              <Button type="button" variant="outline" className="flex-1" onClick={() => setEditOpen(false)}>Cancel</Button>
              <Button type="submit" className="flex-1" disabled={editSaving}>{editSaving ? "Saving…" : "Save Changes"}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
