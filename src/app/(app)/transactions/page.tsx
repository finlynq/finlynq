"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { OnboardingTips } from "@/components/onboarding-tips";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/currency";
import { Plus, ChevronLeft, ChevronRight, Trash2, Pencil, SlidersHorizontal, ChevronDown, Receipt, Search, X, Scissors, AlertTriangle } from "lucide-react";
import { SplitDialog } from "./_components/split-dialog";

type Transaction = {
  id: number;
  date: string;
  accountId: number;
  accountName: string;
  categoryId: number;
  categoryName: string;
  categoryType: string;
  currency: string;
  amount: number;
  quantity: number | null;
  portfolioHolding: string | null;
  note: string;
  payee: string;
  tags: string;
  isBusiness: number | null;
};

type Account = { id: number; name: string; currency: string };
type Category = { id: number; name: string; type: string; group: string };
type Holding = { id: number; name: string; symbol: string | null; accountName: string | null };

type SplitRow = {
  categoryId: string;
  amount: string;
  note: string;
};

const categoryColorMap: Record<string, string> = {
  income: "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  expense: "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300",
  transfer: "border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-700 dark:bg-sky-950 dark:text-sky-300",
  investment: "border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-700 dark:bg-violet-950 dark:text-violet-300",
};

function getCategoryBadgeClass(categoryType: string): string {
  const key = categoryType?.toLowerCase() ?? "";
  return categoryColorMap[key] ?? "border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300";
}

function TableSkeleton() {
  return (
    <div className="p-4 space-y-3">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <div className="h-4 w-20 rounded bg-muted animate-pulse" />
          <div className="h-4 w-24 rounded bg-muted animate-pulse" />
          <div className="h-5 w-16 rounded-full bg-muted animate-pulse" />
          <div className="h-4 w-28 rounded bg-muted animate-pulse" />
          <div className="h-4 w-32 rounded bg-muted animate-pulse flex-1" />
          <div className="h-4 w-20 rounded bg-muted animate-pulse ml-auto" />
          <div className="h-6 w-14 rounded bg-muted animate-pulse" />
        </div>
      ))}
    </div>
  );
}

// Split indicator — shows a small badge if the transaction has splits
function SplitBadge({ transactionId }: { transactionId: number }) {
  const [hasSplits, setHasSplits] = useState<boolean | null>(null);

  useEffect(() => {
    fetch(`/api/transactions/splits?transactionId=${transactionId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d: unknown[]) => setHasSplits(d.length > 0))
      .catch(() => setHasSplits(false));
  }, [transactionId]);

  if (!hasSplits) return null;
  return (
    <Badge variant="outline" className="text-[10px] border-violet-300 bg-violet-50 text-violet-700 ml-1">
      split
    </Badge>
  );
}

const emptySplitRow = (): SplitRow => ({ categoryId: "", amount: "", note: "" });

export default function TransactionsPage() {
  const [txns, setTxns] = useState<Transaction[]>([]);
  const [total, setTotal] = useState(0);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [searchInput, setSearchInput] = useState("");
  const [filters, setFilters] = useState({
    startDate: "",
    endDate: "",
    accountId: "",
    categoryId: "",
    search: "",
  });
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Add/edit dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [form, setForm] = useState({
    date: new Date().toISOString().split("T")[0],
    accountId: "",
    categoryId: "",
    currency: "CAD",
    amount: "",
    payee: "",
    note: "",
    tags: "",
    isBusiness: false,
    quantity: "",
    portfolioHoldingId: "",
  });

  // Inline split rows in the add/edit form (Task 6)
  const [showSplits, setShowSplits] = useState(false);
  const [splitRows, setSplitRows] = useState<SplitRow[]>([emptySplitRow(), emptySplitRow()]);

  // Delete confirmation
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [deleteConfirmPayee, setDeleteConfirmPayee] = useState("");
  const [deleting, setDeleting] = useState(false);

  // Split dialog (for existing transactions)
  const [splitDialogOpen, setSplitDialogOpen] = useState(false);
  const [splitTxn, setSplitTxn] = useState<Transaction | null>(null);

  // Bulk selection
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkAction, setBulkAction] = useState("");
  const [bulkCategoryId, setBulkCategoryId] = useState("");
  const [bulkAccountId, setBulkAccountId] = useState("");
  const [bulkDate, setBulkDate] = useState("");
  const [bulkNote, setBulkNote] = useState("");
  const [bulkPayee, setBulkPayee] = useState("");
  const [bulkTags, setBulkTags] = useState("");
  const [bulkProcessing, setBulkProcessing] = useState(false);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);

  const limit = 50;

  const loadTxns = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (filters.startDate) params.set("startDate", filters.startDate);
    if (filters.endDate) params.set("endDate", filters.endDate);
    if (filters.accountId) params.set("accountId", filters.accountId);
    if (filters.categoryId) params.set("categoryId", filters.categoryId);
    if (filters.search) params.set("search", filters.search);
    params.set("limit", String(limit));
    params.set("offset", String(page * limit));

    fetch(`/api/transactions?${params}`)
      .then((r) => r.json())
      .then((d) => {
        setTxns(d.data ?? []);
        setTotal(d.total ?? 0);
      })
      .finally(() => setLoading(false));
  }, [filters, page]);

  useEffect(() => { loadTxns(); }, [loadTxns]);

  useEffect(() => {
    fetch("/api/accounts").then((r) => r.ok ? r.json() : []).then(setAccounts);
    fetch("/api/categories").then((r) => r.ok ? r.json() : []).then(setCategories);
    fetch("/api/portfolio").then((r) => r.ok ? r.json() : []).then(setHoldings);
  }, []);

  function handleSearchChange(value: string) {
    setSearchInput(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setFilters((f) => ({ ...f, search: value }));
      setPage(0);
    }, 350);
  }

  function clearFilters() {
    setSearchInput("");
    setFilters({ startDate: "", endDate: "", accountId: "", categoryId: "", search: "" });
    setPage(0);
  }

  function resetForm() {
    setForm({ date: new Date().toISOString().split("T")[0], accountId: "", categoryId: "", currency: "CAD", amount: "", payee: "", note: "", tags: "", isBusiness: false, quantity: "", portfolioHoldingId: "" });
    setShowAdvanced(false);
    setShowSplits(false);
    setSplitRows([emptySplitRow(), emptySplitRow()]);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = {
      ...(editId ? { id: editId } : {}),
      date: form.date,
      accountId: Number(form.accountId),
      categoryId: Number(form.categoryId),
      currency: form.currency,
      amount: parseFloat(form.amount),
      payee: form.payee,
      note: form.note,
      tags: form.tags,
      isBusiness: form.isBusiness ? 1 : 0,
    };
    if (form.quantity) body.quantity = parseFloat(form.quantity);
    if (form.portfolioHoldingId) body.portfolioHolding = form.portfolioHoldingId;

    const res = await fetch("/api/transactions", {
      method: editId ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    // If splits are enabled and we have 2+ valid rows, save them
    if (showSplits && splitRows.filter((r) => r.amount).length >= 2) {
      let txnId = editId;
      if (!txnId && res.ok) {
        const created = await res.json();
        txnId = created.id;
      }
      if (txnId) {
        const sign = parseFloat(form.amount) < 0 ? -1 : 1;
        await fetch("/api/transactions/splits", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transactionId: txnId,
            splits: splitRows
              .filter((r) => r.amount)
              .map((r) => ({
                categoryId: r.categoryId ? parseInt(r.categoryId) : null,
                amount: sign * Math.abs(parseFloat(r.amount) || 0),
                note: r.note,
              })),
          }),
        });
      }
    }

    setDialogOpen(false);
    setEditId(null);
    resetForm();
    loadTxns();
  }

  function startEdit(t: Transaction) {
    setEditId(t.id);
    setForm({
      date: t.date,
      accountId: String(t.accountId),
      categoryId: String(t.categoryId),
      currency: t.currency,
      amount: String(t.amount),
      payee: t.payee || "",
      note: t.note || "",
      tags: t.tags || "",
      isBusiness: t.isBusiness === 1,
      quantity: t.quantity != null ? String(t.quantity) : "",
      portfolioHoldingId: t.portfolioHolding || "",
    });
    if (t.isBusiness === 1 || t.quantity != null || t.portfolioHolding) {
      setShowAdvanced(true);
    }
    setDialogOpen(true);
  }

  function confirmDelete(t: Transaction) {
    setDeleteConfirmId(t.id);
    setDeleteConfirmPayee(t.payee || `Transaction #${t.id}`);
  }

  async function handleDelete() {
    if (!deleteConfirmId) return;
    setDeleting(true);
    await fetch(`/api/transactions?id=${deleteConfirmId}`, { method: "DELETE" });
    setDeleteConfirmId(null);
    setDeleting(false);
    loadTxns();
  }

  function openSplitDialog(t: Transaction) {
    setSplitTxn(t);
    setSplitDialogOpen(true);
  }

  // Bulk selection helpers
  const allSelected = txns.length > 0 && txns.every((t) => selected.has(t.id));
  const someSelected = selected.size > 0;

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(txns.map((t) => t.id)));
    }
  }

  function toggleOne(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  }

  function resetBulkFields() {
    setBulkCategoryId("");
    setBulkAccountId("");
    setBulkDate("");
    setBulkNote("");
    setBulkPayee("");
    setBulkTags("");
  }

  async function executeBulkAction() {
    if (!someSelected) return;
    const ids = Array.from(selected);

    if (bulkAction === "delete") {
      setBulkDeleteConfirm(true);
      return;
    }

    setBulkProcessing(true);
    const body: Record<string, unknown> = { action: bulkAction, ids };
    if (bulkAction === "update_category") body.categoryId = Number(bulkCategoryId);
    if (bulkAction === "update_account") body.accountId = Number(bulkAccountId);
    if (bulkAction === "update_date") body.date = bulkDate;
    if (bulkAction === "update_note") body.note = bulkNote;
    if (bulkAction === "update_payee") body.payee = bulkPayee;
    if (bulkAction === "update_tags") body.tags = bulkTags;

    await fetch("/api/transactions/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    setSelected(new Set());
    setBulkAction("");
    resetBulkFields();
    setBulkProcessing(false);
    loadTxns();
  }

  async function confirmBulkDelete() {
    setBulkProcessing(true);
    await fetch("/api/transactions/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", ids: Array.from(selected) }),
    });
    setSelected(new Set());
    setBulkAction("");
    setBulkDeleteConfirm(false);
    setBulkProcessing(false);
    loadTxns();
  }

  const isBulkApplyDisabled =
    bulkProcessing ||
    !bulkAction ||
    (bulkAction === "update_category" && !bulkCategoryId) ||
    (bulkAction === "update_account" && !bulkAccountId) ||
    (bulkAction === "update_date" && !bulkDate) ||
    (bulkAction === "update_note" && bulkNote === "" && bulkAction === "update_note") ||
    (bulkAction === "update_payee" && bulkPayee === "" && bulkAction === "update_payee");

  const totalPages = Math.ceil(total / limit);

  function getPageNumbers(): (number | "ellipsis")[] {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i);
    const pages: (number | "ellipsis")[] = [0];
    if (page > 2) pages.push("ellipsis");
    for (let i = Math.max(1, page - 1); i <= Math.min(totalPages - 2, page + 1); i++) {
      pages.push(i);
    }
    if (page < totalPages - 3) pages.push("ellipsis");
    pages.push(totalPages - 1);
    return pages;
  }

  // Split allocated total for inline split editor
  const splitAllocated = splitRows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
  const splitRemaining = Math.abs(parseFloat(form.amount) || 0) - splitAllocated;
  const splitBalanced = Math.abs(splitRemaining) < 0.01;

  return (
    <div className="space-y-6">
      <OnboardingTips page="transactions" />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Transactions</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Manage and track all your financial transactions</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) { setEditId(null); resetForm(); } }}>
          <DialogTrigger render={<Button className="bg-gradient-to-r from-primary to-primary/80 hover:from-primary/90 hover:to-primary/70 shadow-sm" />}>
            <Plus className="h-4 w-4 mr-2" /> Add Transaction
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{editId ? "Edit Transaction" : "New Transaction"}</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Date</Label>
                  <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required />
                </div>
                <div className="space-y-1.5">
                  <Label>Amount</Label>
                  <Input type="number" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="-50.00" required />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Account</Label>
                  <Select value={form.accountId} onValueChange={(v) => {
                    const val = v ?? "";
                    const acct = accounts.find((a) => String(a.id) === val);
                    setForm({ ...form, accountId: val, currency: acct?.currency ?? "CAD" });
                  }}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select account">
                        {(v) => {
                          const val = v == null ? "" : String(v);
                          if (!val) return "Select account";
                          return accounts.find((a) => String(a.id) === val)?.name ?? val;
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {accounts.map((a) => (
                        <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Category</Label>
                  <Select value={form.categoryId} onValueChange={(v) => setForm({ ...form, categoryId: v ?? "" })}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select category">
                        {(v) => {
                          const val = v == null ? "" : String(v);
                          if (!val) return "Select category";
                          const c = categories.find((c) => String(c.id) === val);
                          return c ? `${c.group} - ${c.name}` : val;
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {categories.map((c) => (
                        <SelectItem key={c.id} value={String(c.id)}>{c.group} - {c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Payee</Label>
                  <Input value={form.payee} onChange={(e) => setForm({ ...form, payee: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label>Currency</Label>
                  <Select value={form.currency} onValueChange={(v) => setForm({ ...form, currency: v ?? "CAD" })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="CAD">CAD</SelectItem>
                      <SelectItem value="USD">USD</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Note</Label>
                <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>Tags (comma-separated)</Label>
                <Input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
              </div>

              {/* Inline split editor (Task 6) */}
              <button
                type="button"
                className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors w-full"
                onClick={() => setShowSplits(!showSplits)}
              >
                <Scissors className={`h-4 w-4 transition-transform ${showSplits ? "text-violet-500" : ""}`} />
                {showSplits ? "Hide splits" : "Split this transaction"}
              </button>

              {showSplits && (
                <div className="space-y-2 border rounded-lg p-3 bg-muted/20">
                  <div className="text-xs text-muted-foreground font-medium">Split rows (must sum to total amount)</div>
                  {splitRows.map((row, i) => (
                    <div key={i} className="flex gap-1.5 items-center">
                      <Select value={row.categoryId} onValueChange={(v) => {
                        const next = [...splitRows];
                        next[i] = { ...next[i], categoryId: v ?? "" };
                        setSplitRows(next);
                      }}>
                        <SelectTrigger className="h-7 text-xs flex-1"><SelectValue placeholder="Category" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="">No category</SelectItem>
                          {categories.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        className="h-7 text-xs w-24 font-mono"
                        placeholder="0.00"
                        value={row.amount}
                        onChange={(e) => {
                          const next = [...splitRows];
                          next[i] = { ...next[i], amount: e.target.value };
                          setSplitRows(next);
                        }}
                      />
                      <Input
                        className="h-7 text-xs w-24"
                        placeholder="Note"
                        value={row.note}
                        onChange={(e) => {
                          const next = [...splitRows];
                          next[i] = { ...next[i], note: e.target.value };
                          setSplitRows(next);
                        }}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0 text-muted-foreground"
                        onClick={() => setSplitRows(splitRows.filter((_, j) => j !== i))}
                        disabled={splitRows.length <= 2}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full h-7 text-xs"
                    onClick={() => setSplitRows([...splitRows, emptySplitRow()])}
                  >
                    <Plus className="h-3 w-3 mr-1" /> Add row
                  </Button>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Allocated: <span className="font-mono">{formatCurrency(splitAllocated, form.currency)}</span></span>
                    {splitBalanced ? (
                      <Badge variant="outline" className="text-[10px] border-emerald-300 text-emerald-600 bg-emerald-50">Balanced</Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] border-rose-300 text-rose-600 bg-rose-50">
                        {splitRemaining > 0 ? `${formatCurrency(splitRemaining, form.currency)} left` : `${formatCurrency(Math.abs(splitRemaining), form.currency)} over`}
                      </Badge>
                    )}
                  </div>
                </div>
              )}

              <button
                type="button"
                className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors w-full"
                onClick={() => setShowAdvanced(!showAdvanced)}
              >
                <ChevronDown className={`h-4 w-4 transition-transform ${showAdvanced ? "rotate-180" : ""}`} />
                Advanced Options
              </button>

              {showAdvanced && (
                <div className="space-y-4 border rounded-lg p-4 bg-muted/20">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label>Quantity</Label>
                      <Input type="number" step="0.0001" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} placeholder="e.g. 10" />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Portfolio Holding</Label>
                      <Select
                        value={form.portfolioHoldingId || "__none__"}
                        onValueChange={(v) => setForm({ ...form, portfolioHoldingId: v === "__none__" ? "" : (v ?? "") })}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select holding">
                            {(v) => {
                              const val = v == null ? "" : String(v);
                              if (!val || val === "__none__") return "None";
                              const h = holdings.find((h) => h.name === val);
                              if (!h) return val;
                              return h.symbol ? `${h.name} (${h.symbol})` : h.name;
                            }}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">None</SelectItem>
                          {holdings.map((h) => (
                            <SelectItem key={h.id} value={h.name}>
                              {h.symbol ? `${h.name} (${h.symbol})` : h.name}
                              {h.accountName ? ` — ${h.accountName}` : ""}
                            </SelectItem>
                          ))}
                          {form.portfolioHoldingId &&
                            !holdings.some((h) => h.name === form.portfolioHoldingId) && (
                              <SelectItem value={form.portfolioHoldingId}>{form.portfolioHoldingId}</SelectItem>
                            )}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input type="checkbox" id="isBusiness" checked={form.isBusiness} onChange={(e) => setForm({ ...form, isBusiness: e.target.checked })} className="h-4 w-4 rounded border-input" />
                    <Label htmlFor="isBusiness" className="cursor-pointer">Business expense</Label>
                  </div>
                </div>
              )}

              <div className="flex gap-2">
                {editId && (
                  <Button type="button" variant="outline" className="text-destructive border-destructive/30" onClick={() => {
                    const t = txns.find((t) => t.id === editId);
                    if (t) { confirmDelete(t); setDialogOpen(false); }
                  }}>
                    <Trash2 className="h-4 w-4 mr-1.5" /> Delete
                  </Button>
                )}
                <Button type="submit" className="flex-1">{editId ? "Update" : "Create"} Transaction</Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Search + Filters */}
      <Card className="bg-muted/30 border-dashed">
        <CardContent className="pt-4 space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              className="pl-9 pr-8"
              placeholder="Search payee, note, or tags…"
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
            />
            {searchInput && (
              <button onClick={() => { setSearchInput(""); setFilters({ ...filters, search: "" }); setPage(0); }} className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-muted transition-colors">
                <X className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <Input type="date" className="w-36 h-8 text-xs" value={filters.startDate} onChange={(e) => { setFilters({ ...filters, startDate: e.target.value }); setPage(0); }} />
            <span className="text-xs text-muted-foreground">to</span>
            <Input type="date" className="w-36 h-8 text-xs" value={filters.endDate} onChange={(e) => { setFilters({ ...filters, endDate: e.target.value }); setPage(0); }} />
            <Select value={filters.accountId} onValueChange={(v) => { setFilters({ ...filters, accountId: !v || v === "all" ? "" : v }); setPage(0); }}>
              <SelectTrigger className="w-40 h-8 text-xs"><SelectValue placeholder="All accounts" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All accounts</SelectItem>
                {accounts.map((a) => <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={filters.categoryId} onValueChange={(v) => { setFilters({ ...filters, categoryId: !v || v === "all" ? "" : v }); setPage(0); }}>
              <SelectTrigger className="w-44 h-8 text-xs"><SelectValue placeholder="All categories" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {categories.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {(filters.startDate || filters.endDate || filters.accountId || filters.categoryId || filters.search) && (
              <button onClick={clearFilters} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors ml-1">
                <X className="h-3 w-3" /> Clear all
              </button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Bulk action bar */}
      {someSelected && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-primary/5 border border-primary/20 rounded-lg text-sm">
          <span className="font-medium text-primary">{selected.size} selected</span>
          <div className="flex items-center gap-2 flex-1 flex-wrap">
            <Select value={bulkAction} onValueChange={(v) => { setBulkAction(v ?? ""); resetBulkFields(); }}>
              <SelectTrigger className="w-44 h-7 text-xs"><SelectValue placeholder="Choose action…" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="update_category">Change category</SelectItem>
                <SelectItem value="update_account">Change account</SelectItem>
                <SelectItem value="update_date">Change date</SelectItem>
                <SelectItem value="update_payee">Change payee</SelectItem>
                <SelectItem value="update_note">Change note</SelectItem>
                <SelectItem value="update_tags">Change tags</SelectItem>
                <SelectItem value="delete">Delete selected</SelectItem>
              </SelectContent>
            </Select>
            {bulkAction === "update_category" && (
              <Select value={bulkCategoryId} onValueChange={(v) => setBulkCategoryId(v ?? "")}>
                <SelectTrigger className="w-44 h-7 text-xs"><SelectValue placeholder="Select category" /></SelectTrigger>
                <SelectContent>
                  {categories.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.group} — {c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            {bulkAction === "update_account" && (
              <Select value={bulkAccountId} onValueChange={(v) => setBulkAccountId(v ?? "")}>
                <SelectTrigger className="w-44 h-7 text-xs"><SelectValue placeholder="Select account" /></SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            {bulkAction === "update_date" && (
              <Input type="date" className="h-7 text-xs w-36" value={bulkDate} onChange={(e) => setBulkDate(e.target.value)} />
            )}
            {bulkAction === "update_payee" && (
              <Input className="h-7 text-xs w-44" placeholder="New payee" value={bulkPayee} onChange={(e) => setBulkPayee(e.target.value)} />
            )}
            {bulkAction === "update_note" && (
              <Input className="h-7 text-xs w-44" placeholder="New note" value={bulkNote} onChange={(e) => setBulkNote(e.target.value)} />
            )}
            {bulkAction === "update_tags" && (
              <Input className="h-7 text-xs w-44" placeholder="New tags" value={bulkTags} onChange={(e) => setBulkTags(e.target.value)} />
            )}
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={executeBulkAction}
              disabled={isBulkApplyDisabled}
              variant={bulkAction === "delete" ? "destructive" : "default"}
            >
              {bulkProcessing ? "Processing…" : "Apply"}
            </Button>
          </div>
          <button onClick={() => setSelected(new Set())} className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <TableSkeleton />
          ) : txns.length === 0 ? (
            <EmptyState
              icon={Receipt}
              title="No transactions yet"
              description="Add your first transaction or import bank statements to get started."
              action={{ label: "Import data", href: "/import" }}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      className="h-4 w-4 rounded border-input cursor-pointer"
                      title="Select all"
                    />
                  </TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Payee</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="w-24"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {txns.map((t) => (
                  <TableRow key={t.id} className={`hover:bg-muted/30 ${selected.has(t.id) ? "bg-primary/5" : ""}`}>
                    <TableCell>
                      <input
                        type="checkbox"
                        checked={selected.has(t.id)}
                        onChange={() => toggleOne(t.id)}
                        className="h-4 w-4 rounded border-input cursor-pointer"
                      />
                    </TableCell>
                    <TableCell className="text-sm">{formatDate(t.date)}</TableCell>
                    <TableCell className="text-sm">{t.accountName}</TableCell>
                    <TableCell className="text-sm">
                      {t.categoryName ? (
                        <span className="flex items-center gap-1">
                          <Badge variant="outline" className={`text-xs ${getCategoryBadgeClass(t.categoryType)}`}>{t.categoryName}</Badge>
                          <SplitBadge transactionId={t.id} />
                        </span>
                      ) : (
                        <SplitBadge transactionId={t.id} />
                      )}
                    </TableCell>
                    <TableCell className="text-sm">{t.payee || "-"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-40 truncate">{t.note || "-"}</TableCell>
                    <TableCell className={`text-right font-mono text-sm font-semibold ${t.amount >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                      {formatCurrency(t.amount, t.currency)}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-0.5">
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => startEdit(t)} title="Edit">
                          <Pencil className="h-3 w-3" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-violet-500" onClick={() => openSplitDialog(t)} title="Split">
                          <Scissors className="h-3 w-3" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => confirmDelete(t)} title="Delete">
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Showing {page * limit + 1}–{Math.min((page + 1) * limit, total)} of {total}
        </p>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          {getPageNumbers().map((p, idx) =>
            p === "ellipsis" ? (
              <span key={`ellipsis-${idx}`} className="px-2 text-sm text-muted-foreground">...</span>
            ) : (
              <Button key={p} variant={page === p ? "default" : "outline"} size="sm" className="h-8 w-8 p-0 text-sm" onClick={() => setPage(p)}>
                {p + 1}
              </Button>
            )
          )}
          <Button variant="outline" size="sm" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Single delete confirmation dialog */}
      <Dialog open={deleteConfirmId !== null} onOpenChange={(open) => { if (!open) setDeleteConfirmId(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-4 w-4" />
              Delete Transaction
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete <strong>{deleteConfirmPayee}</strong>? This cannot be undone.
          </p>
          <div className="flex gap-2 mt-2">
            <Button variant="outline" className="flex-1" onClick={() => setDeleteConfirmId(null)}>Cancel</Button>
            <Button variant="destructive" className="flex-1" disabled={deleting} onClick={handleDelete}>
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Bulk delete confirmation dialog */}
      <Dialog open={bulkDeleteConfirm} onOpenChange={(open) => { if (!open) setBulkDeleteConfirm(false); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-4 w-4" />
              Delete {selected.size} Transactions
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will permanently delete <strong>{selected.size} transaction{selected.size !== 1 ? "s" : ""}</strong>. This cannot be undone.
          </p>
          <div className="flex gap-2 mt-2">
            <Button variant="outline" className="flex-1" onClick={() => setBulkDeleteConfirm(false)}>Cancel</Button>
            <Button variant="destructive" className="flex-1" disabled={bulkProcessing} onClick={confirmBulkDelete}>
              {bulkProcessing ? "Deleting…" : `Delete ${selected.size}`}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Split dialog (for existing transactions) */}
      {splitTxn && (
        <SplitDialog
          open={splitDialogOpen}
          onOpenChange={(open) => { setSplitDialogOpen(open); if (!open) setSplitTxn(null); }}
          transactionId={splitTxn.id}
          totalAmount={splitTxn.amount}
          currency={splitTxn.currency}
          categories={categories}
          accounts={accounts}
          onSaved={loadTxns}
        />
      )}
    </div>
  );
}
