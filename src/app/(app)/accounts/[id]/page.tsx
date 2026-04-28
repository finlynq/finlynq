"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/currency";
import { ArrowLeft, Wallet, Layers, Hash, Pencil } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

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
            {account.name.charAt(0)}
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
