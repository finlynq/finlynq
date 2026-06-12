"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Combobox, type ComboboxItemShape } from "@/components/ui/combobox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorState } from "@/components/error-state";
import { PageSkeleton } from "@/components/page-skeleton";
import { OnboardingTips } from "@/components/onboarding-tips";
import { formatCurrency, getCurrentMonth, getMonthLabel } from "@/lib/currency";
import { buildTxDrillUrl } from "@/lib/transactions/drill-url";
import { parseSaveError } from "@/lib/save-error";
import { useDisplayCurrency } from "@/components/currency-provider";
import { useDropdownOrder } from "@/components/dropdown-order-provider";
import {
  Plus, ChevronLeft, ChevronRight, Trash2, PiggyBank, TrendingDown,
  Wallet, LayoutGrid, Save, FileDown, ArrowRightLeft, Clock,
  AlertTriangle, ArrowDownRight, Copy,
} from "lucide-react";

type Budget = {
  id: number;
  categoryId: number;
  categoryName: string;
  categoryGroup: string;
  month: string;
  amount: number;
  rolloverAmount?: number;
};

type Category = { id: number; name: string; type: string; group: string };

type SpendingRow = {
  categoryId: number;
  categoryName: string;
  categoryGroup: string;
  categoryType: string;
  total: number;
};

type BudgetTemplate = {
  id: number;
  name: string;
  categoryId: number;
  categoryName: string;
  categoryGroup: string;
  amount: number;
  createdAt: string;
};

type AgeOfMoney = {
  ageInDays: number;
  trend: number;
  history: { date: string; ageInDays: number }[];
};

type BudgetMode = "traditional" | "envelope";

export default function BudgetsPage() {
  const { displayCurrency } = useDisplayCurrency();
  const [month, setMonth] = useState(getCurrentMonth());
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [spending, setSpending] = useState<SpendingRow[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [templates, setTemplates] = useState<BudgetTemplate[]>([]);
  const [ageOfMoney, setAgeOfMoney] = useState<AgeOfMoney | null>(null);
  const [mode, setMode] = useState<BudgetMode>("traditional");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [applyTemplateDialogOpen, setApplyTemplateDialogOpen] = useState(false);
  const [moveMoneyDialogOpen, setMoveMoneyDialogOpen] = useState(false);
  const [form, setForm] = useState({ categoryId: "", amount: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [templateName, setTemplateName] = useState("");
  const [moveFrom, setMoveFrom] = useState("");
  const [moveTo, setMoveTo] = useState("");
  const [moveAmount, setMoveAmount] = useState("");
  const [moveError, setMoveError] = useState("");

  // Envelope mode: track per-category available amounts (income allocated)
  const [envelopeIncome, setEnvelopeIncome] = useState(0);

  const sortCategory = useDropdownOrder("category");

  function validateForm() {
    const newErrors: Record<string, string> = {};
    if (!form.categoryId) newErrors.categoryId = "Category is required";
    if (!form.amount || parseFloat(form.amount) <= 0) newErrors.amount = "Amount must be greater than 0";
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  const isFormValid = form.categoryId !== "" && form.amount !== "" && parseFloat(form.amount) > 0;

  const loadData = useCallback(() => {
    setLoadError(false);
    fetch(`/api/budgets?month=${month}&rollover=1&currency=${encodeURIComponent(displayCurrency)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Failed to load budgets"))))
      .then((data) => setBudgets(Array.isArray(data) ? data : []))
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));

    const startDate = `${month}-01`;
    const [y, m] = month.split("-").map(Number);
    const endDate = `${month}-${new Date(y, m, 0).getDate()}`;
    fetch(`/api/dashboard?startDate=${startDate}&endDate=${endDate}&currency=${encodeURIComponent(displayCurrency)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setSpending(Array.isArray(d.spendingByCategory) ? d.spendingByCategory : []);
        // Calculate total income for the month for envelope mode
        const income = (d.incomeVsExpenses ?? [])
          .filter((row: { type: string; total: number }) => row.type === "I")
          .reduce((s: number, row: { total: number }) => s + row.total, 0);
        setEnvelopeIncome(income);
      })
      .catch(() => {});
  }, [month, displayCurrency]);

  const loadTemplates = useCallback(() => {
    fetch("/api/budget-templates")
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setTemplates(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, []);

  const loadAgeOfMoney = useCallback(() => {
    fetch("/api/age-of-money")
      .then((r) => r.json())
      .then((d) => {
        if (!d.error) setAgeOfMoney(d);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    fetch("/api/categories")
      .then((r) => (r.ok ? r.json() : []))
      .then((cats: Category[]) => setCategories(Array.isArray(cats) ? cats.filter((c) => c.type === "E") : []))
      .catch(() => {});
    loadTemplates();
    loadAgeOfMoney();
  }, [loadTemplates, loadAgeOfMoney]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validateForm()) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/budgets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryId: Number(form.categoryId),
          month,
          amount: parseFloat(form.amount),
        }),
      });
      if (!res.ok) {
        setFormError(await parseSaveError(res, "Failed to save budget"));
        return;
      }
      setDialogOpen(false);
      setForm({ categoryId: "", amount: "" });
      setErrors({});
      setFormError("");
      loadData();
    } catch {
      setFormError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (deleteId == null) return;
    setDeleting(true);
    try {
      await fetch(`/api/budgets?id=${deleteId}`, { method: "DELETE" });
      setDeleteId(null);
      loadData();
    } finally {
      setDeleting(false);
    }
  }

  // Copy the previous month's budget rows into the currently-selected month.
  // Reuses the upserting POST /api/budgets (no API change) — posts each prior
  // row's native amount + currency so values clone exactly.
  function prevMonthOf(m: string): string {
    const [y, mm] = m.split("-").map(Number);
    const d = new Date(y, mm - 2, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }

  async function handleCopyFromPrevMonth() {
    setCopyError("");
    setCopying(true);
    try {
      const prev = prevMonthOf(month);
      const res = await fetch(`/api/budgets?month=${prev}`);
      if (!res.ok) {
        setCopyError(await parseSaveError(res, "Couldn't load last month's budgets"));
        return;
      }
      const prevRows = await res.json();
      if (!Array.isArray(prevRows) || prevRows.length === 0) {
        setCopyError("No budgets in the previous month to copy.");
        return;
      }
      for (const b of prevRows as Array<{ categoryId: number; amount: number; currency?: string }>) {
        const post = await fetch("/api/budgets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            categoryId: b.categoryId,
            month,
            amount: b.amount,
            ...(b.currency ? { currency: b.currency } : {}),
          }),
        });
        if (!post.ok) {
          setCopyError(await parseSaveError(post, "Failed to copy budgets"));
          return;
        }
      }
      loadData();
    } catch {
      setCopyError("Network error. Please try again.");
    } finally {
      setCopying(false);
    }
  }

  const deletingBudget = budgets.find((b) => b.id === deleteId) ?? null;

  function changeMonth(delta: number) {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }

  // Save current budgets as a template
  async function handleSaveTemplate() {
    if (!templateName.trim() || budgets.length === 0) return;
    for (const b of budgets) {
      await fetch("/api/budget-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: templateName.trim(),
          categoryId: b.categoryId,
          amount: b.amount,
        }),
      });
    }
    setTemplateName("");
    setTemplateDialogOpen(false);
    loadTemplates();
  }

  // Apply a template to the current month
  async function handleApplyTemplate(name: string) {
    const templateItems = templates.filter((t) => t.name === name);
    for (const t of templateItems) {
      const res = await fetch("/api/budgets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryId: t.categoryId,
          month,
          amount: t.amount,
        }),
      });
      if (!res.ok) {
        // Surface the reason (e.g. 423 locked) and stop applying the rest.
        setCopyError(await parseSaveError(res, "Failed to apply template"));
        loadData();
        return;
      }
    }
    setApplyTemplateDialogOpen(false);
    loadData();
  }

  async function handleDeleteTemplate(name: string) {
    const templateItems = templates.filter((t) => t.name === name);
    for (const t of templateItems) {
      await fetch(`/api/budget-templates?id=${t.id}`, { method: "DELETE" });
    }
    loadTemplates();
  }

  // Move money between envelopes
  async function handleMoveMoney() {
    if (!moveFrom || !moveTo || !moveAmount || moveFrom === moveTo) return;
    const amt = parseFloat(moveAmount);
    if (amt <= 0) return;

    const fromBudget = budgets.find((b) => b.categoryId === Number(moveFrom));
    const toBudget = budgets.find((b) => b.categoryId === Number(moveTo));

    setMoveError("");
    try {
      if (fromBudget) {
        const fromRes = await fetch("/api/budgets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            categoryId: fromBudget.categoryId,
            month,
            amount: Math.max(0, fromBudget.amount - amt),
          }),
        });
        if (!fromRes.ok) {
          setMoveError(await parseSaveError(fromRes, "Failed to move funds"));
          return;
        }
      }

      const toRes = await fetch("/api/budgets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryId: Number(moveTo),
          month,
          amount: (toBudget?.amount ?? 0) + amt,
        }),
      });
      if (!toRes.ok) {
        setMoveError(await parseSaveError(toRes, "Failed to move funds"));
        loadData();
        return;
      }

      setMoveMoneyDialogOpen(false);
      setMoveFrom("");
      setMoveTo("");
      setMoveAmount("");
      setMoveError("");
      loadData();
    } catch {
      setMoveError("Network error. Please try again.");
    }
  }

  const spendingMap = new Map(spending.map((s) => [s.categoryId, Math.abs(s.total)]));

  // FINLYNQ-130 — drill-through: the budget [startDate, endDate] for the
  // currently-selected month (mirrors the /api/dashboard fetch range above).
  // Each category "spent" amount links into /transactions scoped to that
  // category + month.
  const budgetMonthStart = `${month}-01`;
  const [budgetMonthY, budgetMonthM] = month.split("-").map(Number);
  const budgetMonthEnd = `${month}-${String(new Date(budgetMonthY, budgetMonthM, 0).getDate()).padStart(2, "0")}`;

  const totalBudget = budgets.reduce((s, b) => s + b.amount, 0);
  const totalSpent = budgets.reduce((s, b) => s + (spendingMap.get(b.categoryId) ?? 0), 0);
  const totalRemaining = totalBudget - totalSpent;
  const totalRollover = budgets.reduce((s, b) => s + (b.rolloverAmount ?? 0), 0);

  // Envelope mode: available to budget = income - total budgeted
  const availableToBudget = envelopeIncome - totalBudget;

  // Group budgets by category group
  const groupMap = new Map<string, Budget[]>();
  budgets.forEach((b) => {
    const group = b.categoryGroup || "Other";
    groupMap.set(group, [...(groupMap.get(group) ?? []), b]);
  });

  // Unique template names
  const templateNames = [...new Set(templates.map((t) => t.name))];

  function progressColorClass(spent: number, budgetAmt: number) {
    if (budgetAmt <= 0) return "";
    const ratio = spent / budgetAmt;
    if (ratio > 1) return "[&_[data-slot=progress-indicator]]:bg-rose-500";
    if (ratio >= 0.75) return "[&_[data-slot=progress-indicator]]:bg-amber-500";
    return "[&_[data-slot=progress-indicator]]:bg-primary";
  }

  if (loading) return <PageSkeleton variant="list" rows={5} />;
  if (loadError) return <ErrorState title="Couldn't load budgets" message="We couldn't load your budgets. Please try again." onRetry={() => { setLoading(true); loadData(); }} />;

  return (
    <div className="space-y-6">
      <OnboardingTips page="budgets" />
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Budgets</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Set spending limits and track how you&apos;re doing each month.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Mode toggle */}
          <div className="inline-flex items-center rounded-lg border bg-background p-0.5 shadow-sm">
            <button
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all duration-150 flex items-center gap-1.5 ${
                mode === "traditional"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setMode("traditional")}
              title="Monthly budget limits per category"
            >
              <LayoutGrid className="h-3 w-3" />
              <span className="hidden sm:inline">Traditional</span>
            </button>
            <button
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all duration-150 flex items-center gap-1.5 ${
                mode === "envelope"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setMode("envelope")}
              title="Zero-based envelope budgeting"
            >
              <Wallet className="h-3 w-3" />
              <span className="hidden sm:inline">Envelope</span>
            </button>
          </div>

          {/* Template buttons */}
          {budgets.length > 0 && (
            <Dialog open={templateDialogOpen} onOpenChange={setTemplateDialogOpen}>
              <DialogTrigger render={<Button variant="outline" size="sm" />}>
                <Save className="h-4 w-4 mr-1" /> Save Template
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Save as Template</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div>
                    <Label>Template Name</Label>
                    <Input
                      value={templateName}
                      onChange={(e) => setTemplateName(e.target.value)}
                      placeholder="e.g. Monthly Essentials"
                    />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    This will save all {budgets.length} budget items as a reusable template.
                  </p>
                  <Button
                    className="w-full"
                    disabled={!templateName.trim()}
                    onClick={handleSaveTemplate}
                  >
                    Save Template
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          )}

          {templateNames.length > 0 && (
            <Dialog open={applyTemplateDialogOpen} onOpenChange={(open) => { setApplyTemplateDialogOpen(open); if (open) setCopyError(""); }}>
              <DialogTrigger render={<Button variant="outline" size="sm" />}>
                <FileDown className="h-4 w-4 mr-1" /> Apply Template
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Apply Budget Template</DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                  {copyError && <p className="text-sm text-destructive">{copyError}</p>}
                  {templateNames.map((name) => {
                    const items = templates.filter((t) => t.name === name);
                    const total = items.reduce((s, t) => s + t.amount, 0);
                    return (
                      <div
                        key={name}
                        className="flex items-center justify-between rounded-lg border p-3"
                      >
                        <div>
                          <p className="text-sm font-medium">{name}</p>
                          <p className="text-xs text-muted-foreground">
                            {items.length} categories &middot; {formatCurrency(total, displayCurrency)}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button size="sm" onClick={() => handleApplyTemplate(name)}>
                            Apply
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground"
                            aria-label={`Delete template ${name}`}
                            onClick={() => handleDeleteTemplate(name)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </DialogContent>
            </Dialog>
          )}

          {/* Move Money (envelope mode) */}
          {mode === "envelope" && budgets.length >= 2 && (
            <Dialog open={moveMoneyDialogOpen} onOpenChange={(open) => { setMoveMoneyDialogOpen(open); if (!open) setMoveError(""); }}>
              <DialogTrigger render={<Button variant="outline" size="sm" />}>
                <ArrowRightLeft className="h-4 w-4 mr-1" /> Move Money
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Move Money Between Envelopes</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div>
                    <Label>From</Label>
                    <Combobox
                      value={moveFrom}
                      onValueChange={(v) => setMoveFrom(v)}
                      items={sortCategory(
                        budgets.map((b): ComboboxItemShape => ({
                          value: String(b.categoryId),
                          label: `${b.categoryName} (${formatCurrency(b.amount - (spendingMap.get(b.categoryId) ?? 0), displayCurrency)} available)`,
                        })),
                        (b) => Number(b.value),
                        (a, z) => (a.label ?? "").localeCompare(z.label ?? ""),
                      )}
                      placeholder="Select category"
                      searchPlaceholder="Search categories…"
                      emptyMessage="No matches"
                      className="w-full"
                    />
                  </div>
                  <div>
                    <Label>To</Label>
                    <Combobox
                      value={moveTo}
                      onValueChange={(v) => setMoveTo(v)}
                      items={sortCategory(
                        budgets
                          .filter((b) => String(b.categoryId) !== moveFrom)
                          .map((b): ComboboxItemShape => ({ value: String(b.categoryId), label: b.categoryName })),
                        (b) => Number(b.value),
                        (a, z) => (a.label ?? "").localeCompare(z.label ?? ""),
                      )}
                      placeholder="Select category"
                      searchPlaceholder="Search categories…"
                      emptyMessage="No matches"
                      className="w-full"
                    />
                  </div>
                  <div>
                    <Label>Amount</Label>
                    <Input
                      type="number"
                      step="0.01"
                      value={moveAmount}
                      onChange={(e) => setMoveAmount(e.target.value)}
                      placeholder="50.00"
                    />
                  </div>
                  {moveError && <p className="text-sm text-destructive">{moveError}</p>}
                  <Button
                    className="w-full"
                    disabled={!moveFrom || !moveTo || !moveAmount || moveFrom === moveTo || parseFloat(moveAmount) <= 0}
                    onClick={handleMoveMoney}
                  >
                    Move Funds
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          )}

          <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) { setFormError(""); setErrors({}); } }}>
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
                  <Combobox
                    value={form.categoryId}
                    onValueChange={(v) => { setForm({ ...form, categoryId: v }); setErrors({ ...errors, categoryId: "" }); }}
                    items={sortCategory(
                      categories.map((c): ComboboxItemShape => ({ value: String(c.id), label: `${c.group} - ${c.name}` })),
                      (c) => Number(c.value),
                      (a, z) => (a.label ?? "").localeCompare(z.label ?? ""),
                    )}
                    placeholder="Select category"
                    searchPlaceholder="Search categories…"
                    emptyMessage="No categories"
                    className="w-full"
                  />
                  {errors.categoryId && <p className="text-xs text-destructive mt-1">{errors.categoryId}</p>}
                </div>
                <div>
                  <Label>Budget Amount</Label>
                  <Input type="number" step="0.01" value={form.amount} onChange={(e) => { setForm({ ...form, amount: e.target.value }); setErrors({ ...errors, amount: "" }); }} placeholder="500.00" />
                  {errors.amount && <p className="text-xs text-destructive mt-1">{errors.amount}</p>}
                </div>
                {formError && <p className="text-sm text-destructive">{formError}</p>}
                <Button type="submit" className="w-full" disabled={!isFormValid || submitting}>{submitting ? "Saving…" : "Save Budget"}</Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Month nav */}
      <div className="inline-flex items-center gap-2 rounded-xl bg-muted/50 px-2 py-1.5">
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Previous month" onClick={() => changeMonth(-1)}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <h2 className="text-sm font-semibold min-w-28 text-center">{getMonthLabel(month)}</h2>
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Next month" onClick={() => changeMonth(1)}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      {/* Summary Cards */}
      <div className={`grid grid-cols-2 gap-3 ${mode === "envelope" ? "md:grid-cols-4" : ageOfMoney ? "md:grid-cols-4" : "md:grid-cols-3"}`}>
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm text-muted-foreground">Total Budget</CardTitle>
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100 dark:bg-indigo-950/40">
                <PiggyBank className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{formatCurrency(totalBudget, displayCurrency)}</p>
            {totalRollover > 0 && (
              <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                <ArrowDownRight className="h-3 w-3" />
                {formatCurrency(totalRollover, displayCurrency)} rolled over
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm text-muted-foreground">Total Spent</CardTitle>
              <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${totalSpent > totalBudget ? "bg-rose-100 dark:bg-rose-950/40" : "bg-emerald-100 dark:bg-emerald-950/40"}`}>
                <TrendingDown className={`h-5 w-5 ${totalSpent > totalBudget ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400"}`} />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <p className={`text-2xl font-bold ${totalSpent > totalBudget ? "text-rose-600" : "text-emerald-600"}`}>
              {formatCurrency(totalSpent, displayCurrency)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm text-muted-foreground">Remaining</CardTitle>
              <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${totalRemaining >= 0 ? "bg-emerald-100 dark:bg-emerald-950/40" : "bg-rose-100 dark:bg-rose-950/40"}`}>
                <Wallet className={`h-5 w-5 ${totalRemaining >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`} />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <p className={`text-2xl font-bold ${totalRemaining >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
              {formatCurrency(totalRemaining, displayCurrency)}
            </p>
          </CardContent>
        </Card>

        {/* Age of Money / Available to Budget card */}
        {mode === "envelope" ? (
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm text-muted-foreground">Available to Budget</CardTitle>
                <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${availableToBudget >= 0 ? "bg-emerald-100 dark:bg-emerald-950/40" : "bg-rose-100 dark:bg-rose-950/40"}`}>
                  <Wallet className={`h-5 w-5 ${availableToBudget >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`} />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <p className={`text-2xl font-bold ${availableToBudget >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                {formatCurrency(availableToBudget, displayCurrency)}
              </p>
              {availableToBudget < 0 && (
                <p className="text-xs text-rose-600 mt-1 flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  Over-budgeted! Reduce or move funds.
                </p>
              )}
            </CardContent>
          </Card>
        ) : ageOfMoney ? (
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm text-muted-foreground">Age of Money</CardTitle>
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-100 dark:bg-violet-950/40">
                  <Clock className="h-5 w-5 text-violet-600 dark:text-violet-400" />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{ageOfMoney.ageInDays} days</p>
              {ageOfMoney.trend !== 0 && (
                <p className={`text-xs mt-1 ${ageOfMoney.trend > 0 ? "text-emerald-600" : "text-rose-600"}`}>
                  {ageOfMoney.trend > 0 ? "+" : ""}{ageOfMoney.trend}d vs previous period
                </p>
              )}
            </CardContent>
          </Card>
        ) : null}
      </div>

      {/* Envelope mode: zero-sum warning */}
      {mode === "envelope" && availableToBudget < 0 && budgets.length > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            You&apos;ve budgeted <strong>{formatCurrency(Math.abs(availableToBudget), displayCurrency)}</strong> more than your income.
            Move money between envelopes or reduce budget amounts to reach zero.
          </span>
        </div>
      )}

      {/* Budget items */}
      {budgets.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-14 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-100 dark:bg-indigo-950/60 mb-4">
              <LayoutGrid className="h-7 w-7 text-indigo-600 dark:text-indigo-400" />
            </div>
            <p className="text-base font-semibold mb-1">No budgets for {getMonthLabel(month)}</p>
            <p className="text-sm text-muted-foreground max-w-xs mb-5">
              Set spending limits for your categories and track how you&apos;re doing throughout the month.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button onClick={() => setDialogOpen(true)}>
                <Plus className="h-4 w-4 mr-1" />
                Add your first budget
              </Button>
              <Button variant="outline" disabled={copying} onClick={handleCopyFromPrevMonth}>
                <Copy className="h-4 w-4 mr-1" />
                {copying ? "Copying…" : `Copy from ${getMonthLabel(prevMonthOf(month))}`}
              </Button>
            </div>
            {copyError && <p className="text-sm text-destructive mt-3">{copyError}</p>}
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
                const rollover = b.rolloverAmount ?? 0;
                const effectiveBudget = mode === "traditional" && rollover > 0
                  ? b.amount - rollover
                  : b.amount;
                const rawPct = effectiveBudget > 0 ? (spent / effectiveBudget) * 100 : 0;
                const pct = Math.min(rawPct, 100);
                const over = spent > effectiveBudget;

                // Envelope mode: available = budget - spent
                const envelopeAvailable = b.amount - spent;

                return (
                  <div
                    key={b.id}
                    className="rounded-lg px-3 py-3 -mx-3 transition-colors hover:bg-muted/50"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-y-1 mb-1.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-medium truncate">{b.categoryName}</span>
                        <span className={`shrink-0 text-xs font-medium tabular-nums px-1.5 py-0.5 rounded-full ${
                          over
                            ? "bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300"
                            : rawPct >= 75
                              ? "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300"
                              : "bg-primary/10 text-primary"
                        }`}>
                          {Math.round(rawPct)}%
                        </span>
                        {rollover > 0 && (
                          <span
                            className="text-xs font-medium tabular-nums px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400 flex items-center gap-0.5"
                            title={`${formatCurrency(rollover, displayCurrency)} rolled over from last month`}
                          >
                            <Clock className="h-3 w-3" />
                            {formatCurrency(rollover, displayCurrency)}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {mode === "envelope" ? (
                          <Link
                            href={buildTxDrillUrl({ categoryId: String(b.categoryId), startDate: budgetMonthStart, endDate: budgetMonthEnd })}
                            className={`text-sm font-mono tabular-nums hover:underline ${envelopeAvailable < 0 ? "text-rose-600" : ""}`}
                            title={b.categoryName ? `View ${b.categoryName} transactions for ${getMonthLabel(month)}` : `View transactions for ${getMonthLabel(month)}`}
                          >
                            {formatCurrency(envelopeAvailable, displayCurrency)} left
                          </Link>
                        ) : (
                          <Link
                            href={buildTxDrillUrl({ categoryId: String(b.categoryId), startDate: budgetMonthStart, endDate: budgetMonthEnd })}
                            className={`text-sm font-mono tabular-nums hover:underline ${over ? "text-rose-600" : ""}`}
                            title={b.categoryName ? `View ${b.categoryName} transactions for ${getMonthLabel(month)}` : `View transactions for ${getMonthLabel(month)}`}
                          >
                            {formatCurrency(spent, displayCurrency)} / {formatCurrency(effectiveBudget, displayCurrency)}
                          </Link>
                        )}
                        <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" aria-label={`Delete budget for ${b.categoryName}`} onClick={() => setDeleteId(b.id)}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                    <Progress
                      value={pct}
                      className={`[&_[data-slot=progress-track]]:h-2.5 ${progressColorClass(spent, effectiveBudget)}`}
                    />
                  </div>
                );
              })}
            </CardContent>
          </Card>
        ))
      )}

      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={(open) => { if (!open) setDeleteId(null); }}
        title="Delete budget"
        description={<>Are you sure you want to delete the budget for <strong>{deletingBudget?.categoryName ?? "this category"}</strong>? This cannot be undone.</>}
        confirmLabel="Delete budget"
        busy={deleting}
        onConfirm={handleDelete}
      />
    </div>
  );
}
