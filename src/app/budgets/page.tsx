"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { formatCurrency, getCurrentMonth, getMonthLabel } from "@/lib/currency";
import { Plus, ChevronLeft, ChevronRight, Trash2, PiggyBank, TrendingDown, Wallet, LayoutGrid } from "lucide-react";

type Budget = {
  id: number;
  categoryId: number;
  categoryName: string;
  categoryGroup: string;
  month: string;
  amount: number;
};

type Category = { id: number; name: string; type: string; group: string };

type SpendingRow = {
  categoryId: number;
  categoryName: string;
  categoryGroup: string;
  categoryType: string;
  total: number;
};

export default function BudgetsPage() {
  const [month, setMonth] = useState(getCurrentMonth());
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [spending, setSpending] = useState<SpendingRow[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({ categoryId: "", amount: "" });

  const loadData = useCallback(() => {
    fetch(`/api/budgets?month=${month}`)
      .then((r) => r.json())
      .then(setBudgets);

    const startDate = `${month}-01`;
    const [y, m] = month.split("-").map(Number);
    const endDate = `${month}-${new Date(y, m, 0).getDate()}`;
    fetch(`/api/dashboard?startDate=${startDate}&endDate=${endDate}`)
      .then((r) => r.json())
      .then((d) => setSpending(d.spendingByCategory));
  }, [month]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    fetch("/api/categories")
      .then((r) => r.json())
      .then((cats: Category[]) => setCategories(cats.filter((c) => c.type === "E")));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await fetch("/api/budgets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        categoryId: Number(form.categoryId),
        month,
        amount: parseFloat(form.amount),
      }),
    });
    setDialogOpen(false);
    setForm({ categoryId: "", amount: "" });
    loadData();
  }

  async function handleDelete(id: number) {
    await fetch(`/api/budgets?id=${id}`, { method: "DELETE" });
    loadData();
  }

  function changeMonth(delta: number) {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }

  const spendingMap = new Map(spending.map((s) => [s.categoryId, Math.abs(s.total)]));

  const totalBudget = budgets.reduce((s, b) => s + b.amount, 0);
  const totalSpent = budgets.reduce((s, b) => s + (spendingMap.get(b.categoryId) ?? 0), 0);
  const totalRemaining = totalBudget - totalSpent;

  // Group budgets by category group
  const groupMap = new Map<string, Budget[]>();
  budgets.forEach((b) => {
    const group = b.categoryGroup || "Other";
    groupMap.set(group, [...(groupMap.get(group) ?? []), b]);
  });

  function progressColorClass(spent: number, budgetAmt: number) {
    if (budgetAmt <= 0) return "";
    const ratio = spent / budgetAmt;
    if (ratio > 1) return "[&_[data-slot=progress-indicator]]:bg-rose-500";
    if (ratio >= 0.75) return "[&_[data-slot=progress-indicator]]:bg-amber-500";
    return "[&_[data-slot=progress-indicator]]:bg-indigo-500";
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Budgets</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Set spending limits and track how you're doing each month.
          </p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger render={<Button />}>
            <Plus className="h-4 w-4 mr-1" /> Add Budget
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Set Budget for {getMonthLabel(month)}</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
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
              <div>
                <Label>Budget Amount</Label>
                <Input type="number" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="500.00" required />
              </div>
              <Button type="submit" className="w-full">Save Budget</Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Month nav */}
      <div className="inline-flex items-center gap-2 rounded-xl bg-muted/50 px-2 py-1.5">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => changeMonth(-1)}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <h2 className="text-sm font-semibold min-w-28 text-center">{getMonthLabel(month)}</h2>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => changeMonth(1)}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm text-muted-foreground">Total Budget</CardTitle>
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100">
                <PiggyBank className="h-5 w-5 text-indigo-600" />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{formatCurrency(totalBudget, "CAD")}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm text-muted-foreground">Total Spent</CardTitle>
              <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${totalSpent > totalBudget ? "bg-rose-100" : "bg-emerald-100"}`}>
                <TrendingDown className={`h-5 w-5 ${totalSpent > totalBudget ? "text-rose-600" : "text-emerald-600"}`} />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <p className={`text-2xl font-bold ${totalSpent > totalBudget ? "text-rose-600" : "text-emerald-600"}`}>
              {formatCurrency(totalSpent, "CAD")}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm text-muted-foreground">Remaining</CardTitle>
              <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${totalRemaining >= 0 ? "bg-emerald-100" : "bg-rose-100"}`}>
                <Wallet className={`h-5 w-5 ${totalRemaining >= 0 ? "text-emerald-600" : "text-rose-600"}`} />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <p className={`text-2xl font-bold ${totalRemaining >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
              {formatCurrency(totalRemaining, "CAD")}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Budget items */}
      {budgets.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted mb-4">
              <LayoutGrid className="h-7 w-7 text-muted-foreground" />
            </div>
            <p className="text-base font-medium mb-1">No budgets for {getMonthLabel(month)}</p>
            <p className="text-sm text-muted-foreground max-w-xs">
              Click &ldquo;Add Budget&rdquo; above to set a spending limit for a category and start tracking your progress.
            </p>
          </CardContent>
        </Card>
      ) : (
        Array.from(groupMap.entries()).map(([group, items]) => (
          <Card key={group}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">{group}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {items.map((b) => {
                const spent = spendingMap.get(b.categoryId) ?? 0;
                const rawPct = b.amount > 0 ? (spent / b.amount) * 100 : 0;
                const pct = Math.min(rawPct, 100);
                const over = spent > b.amount;

                return (
                  <div
                    key={b.id}
                    className="rounded-lg px-3 py-3 -mx-3 transition-colors hover:bg-muted/50"
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{b.categoryName}</span>
                        <span className={`text-xs font-medium tabular-nums px-1.5 py-0.5 rounded-full ${
                          over
                            ? "bg-rose-100 text-rose-700"
                            : rawPct >= 75
                              ? "bg-amber-100 text-amber-700"
                              : "bg-indigo-100 text-indigo-700"
                        }`}>
                          {Math.round(rawPct)}%
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`text-sm font-mono ${over ? "text-rose-600" : ""}`}>
                          {formatCurrency(spent, "CAD")} / {formatCurrency(b.amount, "CAD")}
                        </span>
                        <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" onClick={() => handleDelete(b.id)}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                    <Progress
                      value={pct}
                      className={`[&_[data-slot=progress-track]]:h-2.5 ${progressColorClass(spent, b.amount)}`}
                    />
                  </div>
                );
              })}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
