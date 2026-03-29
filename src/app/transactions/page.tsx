"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/currency";
import { Plus, ChevronLeft, ChevronRight, Trash2, Pencil, SlidersHorizontal, ChevronDown } from "lucide-react";

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
  splitPerson: string | null;
  splitRatio: number | null;
};

type Account = { id: number; name: string; currency: string };
type Category = { id: number; name: string; type: string; group: string };

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

export default function TransactionsPage() {
  const [txns, setTxns] = useState<Transaction[]>([]);
  const [total, setTotal] = useState(0);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({
    startDate: "",
    endDate: "",
    accountId: "",
    categoryId: "",
    search: "",
  });
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
    splitPerson: "",
    splitRatio: "",
    isBusiness: false,
    quantity: "",
    portfolioHoldingId: "",
  });

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

  useEffect(() => {
    loadTxns();
  }, [loadTxns]);

  useEffect(() => {
    fetch("/api/accounts").then((r) => r.ok ? r.json() : []).then(setAccounts);
    fetch("/api/categories").then((r) => r.ok ? r.json() : []).then(setCategories);
  }, []);

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
    if (form.splitPerson) body.splitPerson = form.splitPerson;
    if (form.splitRatio) body.splitRatio = parseFloat(form.splitRatio);
    if (form.quantity) body.quantity = parseFloat(form.quantity);
    if (form.portfolioHoldingId) body.portfolioHolding = form.portfolioHoldingId;

    await fetch("/api/transactions", {
      method: editId ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    setDialogOpen(false);
    setEditId(null);
    resetForm();
    loadTxns();
  }

  function resetForm() {
    setForm({ date: new Date().toISOString().split("T")[0], accountId: "", categoryId: "", currency: "CAD", amount: "", payee: "", note: "", tags: "", splitPerson: "", splitRatio: "", isBusiness: false, quantity: "", portfolioHoldingId: "" });
    setShowAdvanced(false);
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
      splitPerson: t.splitPerson || "",
      splitRatio: t.splitRatio != null ? String(t.splitRatio) : "",
      isBusiness: t.isBusiness === 1,
      quantity: t.quantity != null ? String(t.quantity) : "",
      portfolioHoldingId: t.portfolioHolding || "",
    });
    // Show advanced section if any advanced fields have values
    if (t.splitPerson || t.splitRatio != null || t.isBusiness === 1 || t.quantity != null || t.portfolioHolding) {
      setShowAdvanced(true);
    }
    setDialogOpen(true);
  }

  async function handleDelete(id: number) {
    await fetch(`/api/transactions?id=${id}`, { method: "DELETE" });
    loadTxns();
  }

  const totalPages = Math.ceil(total / limit);

  // Compute visible page numbers for pagination
  function getPageNumbers(): (number | "ellipsis")[] {
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, i) => i);
    }
    const pages: (number | "ellipsis")[] = [0];
    if (page > 2) pages.push("ellipsis");
    for (let i = Math.max(1, page - 1); i <= Math.min(totalPages - 2, page + 1); i++) {
      pages.push(i);
    }
    if (page < totalPages - 3) pages.push("ellipsis");
    pages.push(totalPages - 1);
    return pages;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Transactions</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Manage and track all your financial transactions</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) { setEditId(null); resetForm(); } }}>
          <DialogTrigger render={<Button className="bg-gradient-to-r from-primary to-primary/80 hover:from-primary/90 hover:to-primary/70 shadow-sm" />}>
            <Plus className="h-4 w-4 mr-2" /> Add Transaction
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editId ? "Edit Transaction" : "New Transaction"}</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-5">
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
                    <SelectTrigger><SelectValue placeholder="Select account" /></SelectTrigger>
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
                    <SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger>
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

              {/* Advanced fields toggle */}
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
                      <Label>Split Person</Label>
                      <Input value={form.splitPerson} onChange={(e) => setForm({ ...form, splitPerson: e.target.value })} placeholder="e.g. John" />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Split Ratio</Label>
                      <Input type="number" step="0.01" min="0" max="1" value={form.splitRatio} onChange={(e) => setForm({ ...form, splitRatio: e.target.value })} placeholder="0.5 = 50%" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label>Quantity</Label>
                      <Input type="number" step="0.0001" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} placeholder="e.g. 10" />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Portfolio Holding</Label>
                      <Input value={form.portfolioHoldingId} onChange={(e) => setForm({ ...form, portfolioHoldingId: e.target.value })} placeholder="Holding name/ID" />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="isBusiness"
                      checked={form.isBusiness}
                      onChange={(e) => setForm({ ...form, isBusiness: e.target.checked })}
                      className="h-4 w-4 rounded border-input"
                    />
                    <Label htmlFor="isBusiness" className="cursor-pointer">Business expense</Label>
                  </div>
                </div>
              )}

              <Button type="submit" className="w-full">{editId ? "Update" : "Create"} Transaction</Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Filters */}
      <Card className="bg-muted/30 border-dashed">
        <CardContent className="pt-4">
          <div className="flex items-center gap-2 mb-3">
            <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium text-muted-foreground">Filters</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Input type="date" placeholder="Start date" value={filters.startDate} onChange={(e) => { setFilters({ ...filters, startDate: e.target.value }); setPage(0); }} />
            <Input type="date" placeholder="End date" value={filters.endDate} onChange={(e) => { setFilters({ ...filters, endDate: e.target.value }); setPage(0); }} />
            <Select value={filters.accountId} onValueChange={(v) => { setFilters({ ...filters, accountId: !v || v === "all" ? "" : v }); setPage(0); }}>
              <SelectTrigger><SelectValue placeholder="All accounts" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All accounts</SelectItem>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filters.categoryId} onValueChange={(v) => { setFilters({ ...filters, categoryId: !v || v === "all" ? "" : v }); setPage(0); }}>
              <SelectTrigger><SelectValue placeholder="All categories" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input placeholder="Search payee, note, tags..." value={filters.search} onChange={(e) => { setFilters({ ...filters, search: e.target.value }); setPage(0); }} />
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <TableSkeleton />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Payee</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="w-20"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {txns.map((t) => (
                  <TableRow key={t.id} className="hover:bg-muted/30">
                    <TableCell className="text-sm">{formatDate(t.date)}</TableCell>
                    <TableCell className="text-sm">{t.accountName}</TableCell>
                    <TableCell className="text-sm">
                      {t.categoryName ? (
                        <Badge variant="outline" className={`text-xs ${getCategoryBadgeClass(t.categoryType)}`}>{t.categoryName}</Badge>
                      ) : "-"}
                    </TableCell>
                    <TableCell className="text-sm">{t.payee || "-"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-40 truncate">{t.note || "-"}</TableCell>
                    <TableCell className={`text-right font-mono text-sm font-semibold ${t.amount >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                      {formatCurrency(t.amount, t.currency)}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => startEdit(t)}>
                          <Pencil className="h-3 w-3" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => handleDelete(t.id)}>
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
          Showing {page * limit + 1}-{Math.min((page + 1) * limit, total)} of {total}
        </p>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          {getPageNumbers().map((p, idx) =>
            p === "ellipsis" ? (
              <span key={`ellipsis-${idx}`} className="px-2 text-sm text-muted-foreground">...</span>
            ) : (
              <Button
                key={p}
                variant={page === p ? "default" : "outline"}
                size="sm"
                className="h-8 w-8 p-0 text-sm"
                onClick={() => setPage(p)}
              >
                {p + 1}
              </Button>
            )
          )}
          <Button variant="outline" size="sm" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
