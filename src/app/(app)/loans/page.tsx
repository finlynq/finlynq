"use client";

import { DevModeGuard } from "@/components/dev-mode-guard";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox, type ComboboxItemShape } from "@/components/ui/combobox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useDropdownOrder } from "@/components/dropdown-order-provider";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/currency";
import { useDisplayCurrency } from "@/components/currency-provider";
import { SUPPORTED_FIAT_CURRENCIES } from "@/lib/fx/supported-currencies";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar, Legend } from "recharts";
import { Plus, Trash2, Landmark, CreditCard, FileText, Calendar } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CspSafeBar } from "@/components/csp-safe-bar";

type Loan = {
  id: number; name: string; type: string; principal: number; annualRate: number;
  termMonths: number | null; startDate: string; paymentFrequency: string; extraPayment: number;
  paymentAmount: number | null; residualValue: number | null;
  monthlyPayment: number; paymentPerPeriod: number; monthlyEquivalentPayment: number;
  totalInterest: number; payoffDate: string;
  remainingBalance: number; balanceSource: "account" | "projection" | null;
  principalPaid: number; interestPaid: number; periodsRemaining: number;
  accountName: string | null;
};
type AmortRow = { period: number; date: string; payment: number; principal: number; interest: number; balance: number };
type AccrualRow = { month: string; interest: number };
type AmortResult = { monthlyPayment: number; totalPayments: number; totalInterest: number; payoffDate: string; residualValue: number; schedule: AmortRow[]; monthlyAccrual: AccrualRow[] };

const FREQUENCY_OPTIONS = [
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Biweekly" },
  { value: "semi_monthly", label: "Semi-monthly" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "annual", label: "Annual" },
] as const;

const FREQUENCY_LABELS: Record<string, string> = Object.fromEntries(
  FREQUENCY_OPTIONS.map((f) => [f.value, f.label])
);

const PERIODS_PER_YEAR: Record<string, number> = { weekly: 52, biweekly: 26, semi_monthly: 24, monthly: 12, quarterly: 4, annual: 1 };

// What-if is term-driven; for payment-driven loans (termMonths null) derive an
// equivalent term in months from the solved periods remaining.
function equivalentTermMonths(loan: Loan): number {
  if (loan.termMonths != null) return loan.termMonths;
  const perYear = PERIODS_PER_YEAR[loan.paymentFrequency] ?? 12;
  return Math.max(1, Math.round((loan.periodsRemaining / perYear) * 12));
}
type WhatIf = { extraPayment: number; monthsSaved: number; interestSaved: number; newPayoffDate: string; totalInterest: number };
type Account = { id: number; name: string };

const LOAN_TYPE_COLORS: Record<string, string> = {
  mortgage: "border-l-indigo-500",
  lease: "border-l-amber-500",
  loan: "border-l-cyan-500",
  student_loan: "border-l-violet-500",
  credit_card: "border-l-rose-500",
};

const LOAN_TYPE_BADGE_COLORS: Record<string, string> = {
  mortgage: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300",
  lease: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
  loan: "bg-cyan-100 text-cyan-700 dark:bg-cyan-950/50 dark:text-cyan-300",
  student_loan: "bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300",
  credit_card: "bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300",
};

function LoansSkeleton() {
  return (
    <div className="space-y-6">
      <div>
        <div className="h-8 w-48 bg-muted animate-pulse rounded-lg" />
        <div className="h-4 w-72 bg-muted animate-pulse rounded-lg mt-2" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
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
      {Array.from({ length: 2 }).map((_, i) => (
        <Card key={i}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="h-6 w-36 bg-muted animate-pulse rounded" />
                <div className="h-5 w-16 bg-muted animate-pulse rounded-full" />
              </div>
              <div className="flex gap-2">
                <div className="h-8 w-24 bg-muted animate-pulse rounded" />
                <div className="h-8 w-8 bg-muted animate-pulse rounded" />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-4">
              {Array.from({ length: 5 }).map((_, j) => (
                <div key={j}>
                  <div className="h-3 w-16 bg-muted animate-pulse rounded mb-1" />
                  <div className="h-5 w-24 bg-muted animate-pulse rounded" />
                </div>
              ))}
            </div>
            <div className="space-y-1">
              <div className="flex justify-between">
                <div className="h-3 w-32 bg-muted animate-pulse rounded" />
                <div className="h-3 w-8 bg-muted animate-pulse rounded" />
              </div>
              <div className="h-2.5 w-full bg-muted animate-pulse rounded-full" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function LoansPageContent() {
  const { displayCurrency } = useDisplayCurrency();
  const [loans, setLoans] = useState<Loan[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [selectedLoan, setSelectedLoan] = useState<Loan | null>(null);
  const [amort, setAmort] = useState<AmortResult | null>(null);
  const [whatIf, setWhatIf] = useState<WhatIf[]>([]);
  const [form, setForm] = useState({ name: "", type: "mortgage", principal: "", currency: displayCurrency, annualRate: "", termMonths: "", startDate: "", paymentAmount: "", paymentFrequency: "monthly", extraPayment: "0", residualValue: "", accountId: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});

  function validateForm() {
    const e: Record<string, string> = {};
    if (!form.name.trim()) e.name = "Name is required";
    if (!form.principal || parseFloat(form.principal) <= 0) e.principal = "Principal must be greater than 0";
    if (!form.annualRate || parseFloat(form.annualRate) < 0) e.annualRate = "Rate must be 0 or more";
    if (form.annualRate && parseFloat(form.annualRate) > 100) e.annualRate = "Rate must be 100 or less";
    // FINLYNQ-136: term OR payment — payment-driven loans solve for the term.
    if (!form.termMonths && !form.paymentAmount) e.termMonths = "Enter a term or a payment amount";
    if (form.termMonths && parseInt(form.termMonths) <= 0) e.termMonths = "Term must be greater than 0";
    if (form.paymentAmount && parseFloat(form.paymentAmount) <= 0) e.paymentAmount = "Payment must be greater than 0";
    if (form.residualValue && form.principal && parseFloat(form.residualValue) >= parseFloat(form.principal)) e.residualValue = "Residual must be less than principal";
    if (!form.startDate) e.startDate = "Start date is required";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  const isFormValid = form.name.trim() !== "" && form.principal !== "" && parseFloat(form.principal) > 0 && form.annualRate !== "" && parseFloat(form.annualRate) >= 0 && parseFloat(form.annualRate) <= 100 && (form.termMonths !== "" ? parseInt(form.termMonths) > 0 : form.paymentAmount !== "" && parseFloat(form.paymentAmount) > 0) && form.startDate !== "";

  const load = useCallback(() => {
    setLoadError(false);
    fetch("/api/loans")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Failed to load loans"))))
      .then((data) => { setLoans(Array.isArray(data) ? data : []); })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    load();
    fetch("/api/accounts")
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setAccounts(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, [load]);

  const sortAccount = useDropdownOrder("account");

  async function viewAmortization(loan: Loan) {
    setSelectedLoan(loan);
    const [amortRes, whatIfRes] = await Promise.all([
      fetch("/api/loans", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "amortization", principal: loan.principal, annualRate: loan.annualRate, termMonths: loan.termMonths, startDate: loan.startDate, paymentAmount: loan.paymentAmount, extraPayment: loan.extraPayment, paymentFrequency: loan.paymentFrequency, residualValue: loan.residualValue }) }).then((r) => r.json()),
      fetch("/api/loans", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "what-if", principal: loan.principal, annualRate: loan.annualRate, termMonths: equivalentTermMonths(loan), startDate: loan.startDate, extraAmounts: [100, 200, 500, 1000] }) }).then((r) => r.json()),
    ]);
    setAmort(amortRes);
    setWhatIf(Array.isArray(whatIfRes) ? whatIfRes : []);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validateForm()) return;
    const res = await fetch("/api/loans", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: form.name, type: form.type, principal: parseFloat(form.principal), currency: form.currency || displayCurrency, annualRate: parseFloat(form.annualRate), termMonths: form.termMonths ? parseInt(form.termMonths) : null, startDate: form.startDate, paymentAmount: form.paymentAmount ? parseFloat(form.paymentAmount) : null, paymentFrequency: form.paymentFrequency, extraPayment: parseFloat(form.extraPayment) || 0, residualValue: form.type === "lease" && form.residualValue ? parseFloat(form.residualValue) : null, accountId: form.accountId ? parseInt(form.accountId) : null }) });
    if (!res.ok) {
      // e.g. payment below the period interest — surface the server's message.
      const body = await res.json().catch(() => null);
      setErrors({ ...errors, form: body?.error ?? "Failed to create loan" });
      return;
    }
    setDialogOpen(false);
    setForm({ name: "", type: "mortgage", principal: "", currency: displayCurrency, annualRate: "", termMonths: "", startDate: "", paymentAmount: "", paymentFrequency: "monthly", extraPayment: "0", residualValue: "", accountId: "" });
    setErrors({});
    load();
  }

  async function handleDelete() {
    if (deleteId == null) return;
    setDeleting(true);
    try {
      await fetch(`/api/loans?id=${deleteId}`, { method: "DELETE" });
      setDeleteId(null);
      load();
    } finally {
      setDeleting(false);
    }
  }

  const deletingLoan = loans.find((l) => l.id === deleteId) ?? null;

  const totalDebt = loans.reduce((s, l) => s + (l.remainingBalance ?? 0), 0);
  // Monthly-equivalent so weekly/quarterly/annual loans sum comparably.
  const totalMonthly = loans.reduce((s, l) => s + (l.monthlyEquivalentPayment ?? l.monthlyPayment ?? 0), 0);

  if (loading) return <LoansSkeleton />;
  if (loadError) return <ErrorState title="Couldn't load loans" message="We couldn't load your loans. Please try again." onRetry={() => { setLoading(true); load(); }} />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Loans & Debt</h1>
          <p className="text-sm text-muted-foreground mt-1">Track balances, amortization schedules, and payoff strategies</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger render={<Button id="add-loan-btn" />}><Plus className="h-4 w-4 mr-1" /> Add Loan</DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Add Loan</DialogTitle></DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Name</Label>
                  <Input value={form.name} onChange={(e) => { setForm({ ...form, name: e.target.value }); setErrors({ ...errors, name: "" }); }} />
                  {errors.name && <p className="text-xs text-destructive mt-1">{errors.name}</p>}
                </div>
                <div><Label>Type</Label>
                  <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v ?? "mortgage" })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mortgage">Mortgage</SelectItem>
                      <SelectItem value="lease">Lease</SelectItem>
                      <SelectItem value="loan">Loan</SelectItem>
                      <SelectItem value="student_loan">Student Loan</SelectItem>
                      <SelectItem value="credit_card">Credit Card</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label>Currency</Label>
                  <Select value={form.currency} onValueChange={(v) => setForm({ ...form, currency: v ?? displayCurrency })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {SUPPORTED_FIAT_CURRENCIES.map(c => (<SelectItem key={c} value={c}>{c}</SelectItem>))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Principal</Label>
                  <Input type="number" step="0.01" value={form.principal} onChange={(e) => { setForm({ ...form, principal: e.target.value }); setErrors({ ...errors, principal: "" }); }} />
                  {errors.principal && <p className="text-xs text-destructive mt-1">{errors.principal}</p>}
                </div>
                <div>
                  <Label>Annual Rate (%)</Label>
                  <Input type="number" step="0.01" value={form.annualRate} onChange={(e) => { setForm({ ...form, annualRate: e.target.value }); setErrors({ ...errors, annualRate: "" }); }} />
                  {errors.annualRate && <p className="text-xs text-destructive mt-1">{errors.annualRate}</p>}
                </div>
                <div>
                  <Label>Term (months)</Label>
                  <Input type="number" placeholder="From payment" value={form.termMonths} onChange={(e) => { setForm({ ...form, termMonths: e.target.value }); setErrors({ ...errors, termMonths: "" }); }} />
                  {errors.termMonths && <p className="text-xs text-destructive mt-1">{errors.termMonths}</p>}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label>Payment</Label>
                  <Input type="number" step="0.01" placeholder="From term" value={form.paymentAmount} onChange={(e) => { setForm({ ...form, paymentAmount: e.target.value }); setErrors({ ...errors, paymentAmount: "", termMonths: "" }); }} />
                  {errors.paymentAmount && <p className="text-xs text-destructive mt-1">{errors.paymentAmount}</p>}
                </div>
                <div><Label>Frequency</Label>
                  <Select value={form.paymentFrequency} onValueChange={(v) => setForm({ ...form, paymentFrequency: v ?? "monthly" })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {FREQUENCY_OPTIONS.map((f) => (<SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>))}
                    </SelectContent>
                  </Select>
                </div>
                <div><Label>Extra/Payment</Label><Input type="number" step="0.01" value={form.extraPayment} onChange={(e) => setForm({ ...form, extraPayment: e.target.value })} /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Start Date</Label>
                  <Input type="date" value={form.startDate} onChange={(e) => { setForm({ ...form, startDate: e.target.value }); setErrors({ ...errors, startDate: "" }); }} />
                  {errors.startDate && <p className="text-xs text-destructive mt-1">{errors.startDate}</p>}
                </div>
                {form.type === "lease" && (
                  <div>
                    <Label>Residual / Buyout</Label>
                    <Input type="number" step="0.01" placeholder="Balance at term end" value={form.residualValue} onChange={(e) => { setForm({ ...form, residualValue: e.target.value }); setErrors({ ...errors, residualValue: "" }); }} />
                    {errors.residualValue && <p className="text-xs text-destructive mt-1">{errors.residualValue}</p>}
                  </div>
                )}
              </div>
              <div><Label>Linked Account</Label>
                <Combobox
                  value={form.accountId}
                  onValueChange={(v) => setForm({ ...form, accountId: v })}
                  items={sortAccount(
                    accounts.map((a): ComboboxItemShape => ({ value: String(a.id), label: a.name })),
                    (a) => Number(a.value),
                    (a, z) => (a.label ?? "").localeCompare(z.label ?? ""),
                  )}
                  placeholder="None"
                  searchPlaceholder="Search accounts…"
                  emptyMessage="No matches"
                  className="w-full"
                />
              </div>
              {errors.form && <p className="text-xs text-destructive">{errors.form}</p>}
              <Button type="submit" className="w-full" disabled={!isFormValid}>Add Loan</Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-rose-100 dark:bg-rose-950/40">
                <Landmark className="h-5 w-5 text-rose-600 dark:text-rose-400" />
              </div>
              <CardTitle className="text-sm text-muted-foreground">Total Debt</CardTitle>
            </div>
          </CardHeader>
          <CardContent><p className="text-2xl font-bold text-rose-600">{formatCurrency(totalDebt, displayCurrency)}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100 dark:bg-amber-950/40">
                <Calendar className="h-5 w-5 text-amber-600 dark:text-amber-400" />
              </div>
              <CardTitle className="text-sm text-muted-foreground">Monthly Payments</CardTitle>
            </div>
          </CardHeader>
          <CardContent><p className="text-2xl font-bold">{formatCurrency(totalMonthly, displayCurrency)}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100 dark:bg-indigo-950/40">
                <FileText className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
              </div>
              <CardTitle className="text-sm text-muted-foreground">Active Loans</CardTitle>
            </div>
          </CardHeader>
          <CardContent><p className="text-2xl font-bold">{loans.length}</p></CardContent>
        </Card>
      </div>

      {/* Empty state */}
      {loans.length === 0 && (
        <EmptyState
          icon={Landmark}
          title="No loans tracked yet"
          description="Add a mortgage, car loan, student loan, or any other debt to see amortization schedules and payoff projections."
          action={{ label: "Add your first loan", onClick: () => document.getElementById("add-loan-btn")?.click() }}
        />
      )}

      {/* Loan cards */}
      {loans.map((loan) => {
        const paidPct = loan.principal > 0 ? ((loan.principal - loan.remainingBalance) / loan.principal) * 100 : 0;
        const borderClass = LOAN_TYPE_COLORS[loan.type] || "border-l-gray-400";
        const badgeClass = LOAN_TYPE_BADGE_COLORS[loan.type] || "";
        return (
          <Card key={loan.id} className={`border-l-4 ${borderClass}`}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CardTitle>{loan.name}</CardTitle>
                  <Badge variant="secondary" className={badgeClass}>{loan.type}</Badge>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => viewAmortization(loan)}>View Schedule</Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" aria-label={`Delete loan ${loan.name}`} onClick={() => setDeleteId(loan.id)}><Trash2 className="h-4 w-4" /></Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-4">
                <div>
                  <p className="text-xs text-muted-foreground">Remaining{loan.balanceSource === "account" && <span className="ml-1 text-emerald-600" title={`Live balance from ${loan.accountName ?? "linked account"}`}>· from account</span>}</p>
                  <p className="font-mono font-bold text-rose-600">{formatCurrency(loan.remainingBalance, displayCurrency)}</p>
                </div>
                <div><p className="text-xs text-muted-foreground">{FREQUENCY_LABELS[loan.paymentFrequency] ?? "Payment"}</p><p className="font-mono">{formatCurrency(loan.paymentPerPeriod ?? loan.monthlyPayment, displayCurrency)}</p></div>
                <div><p className="text-xs text-muted-foreground">Rate</p><p className="font-mono">{loan.annualRate}%</p></div>
                <div><p className="text-xs text-muted-foreground">Total Interest</p><p className="font-mono">{formatCurrency(loan.totalInterest, displayCurrency)}</p></div>
                <div>
                  <p className="text-xs text-muted-foreground">{loan.type === "lease" ? "Term end" : "Payoff"}</p>
                  <p className="font-mono">{loan.payoffDate}</p>
                  {loan.type === "lease" && loan.residualValue != null && loan.residualValue > 0 && (
                    <p className="text-xs text-muted-foreground">residual {formatCurrency(loan.residualValue, displayCurrency)}</p>
                  )}
                </div>
              </div>
              <div className="space-y-1">
                <div className="flex justify-between text-xs"><span>Principal paid: {formatCurrency(loan.principalPaid, displayCurrency)}</span><span>{Math.round(paidPct)}%</span></div>
                <CspSafeBar
                  percent={paidPct}
                  className="bg-rose-200"
                  fillClassName="bg-emerald-500"
                  ariaLabel={`Loan ${loan.name} paid`}
                />
              </div>
            </CardContent>
          </Card>
        );
      })}

      {/* Amortization detail modal */}
      {selectedLoan && amort && (
        <Card>
          <CardHeader><CardTitle>Amortization: {selectedLoan.name}</CardTitle></CardHeader>
          <CardContent>
            <Tabs defaultValue="chart">
              <TabsList><TabsTrigger value="chart">Chart</TabsTrigger><TabsTrigger value="table">Table</TabsTrigger><TabsTrigger value="monthly">Monthly Interest</TabsTrigger><TabsTrigger value="whatif">What-If</TabsTrigger></TabsList>
              <TabsContent value="chart">
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={amort.schedule.filter((_, i) => i % Math.max(1, Math.floor(amort.schedule.length / 60)) === 0)}>
                    <XAxis dataKey="date" fontSize={10} tickLine={false} axisLine={false} /><YAxis fontSize={10} tickLine={false} axisLine={false} /><Tooltip /><Legend />
                    <Bar dataKey="principal" fill="#10b981" name="Principal" stackId="a" radius={[2, 2, 0, 0]} />
                    <Bar dataKey="interest" fill="#f43f5e" name="Interest" stackId="a" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
                <ResponsiveContainer width="100%" height={200} className="mt-4">
                  <LineChart data={amort.schedule.filter((_, i) => i % Math.max(1, Math.floor(amort.schedule.length / 60)) === 0)}>
                    <XAxis dataKey="date" fontSize={10} tickLine={false} axisLine={false} /><YAxis fontSize={10} tickLine={false} axisLine={false} /><Tooltip />
                    <Line type="monotone" dataKey="balance" stroke="#6366f1" strokeWidth={2} dot={false} name="Balance" />
                  </LineChart>
                </ResponsiveContainer>
              </TabsContent>
              <TabsContent value="table">
                <div className="max-h-96 overflow-auto">
                  <Table>
                    <TableHeader><TableRow><TableHead>#</TableHead><TableHead>Date</TableHead><TableHead>Payment</TableHead><TableHead>Principal</TableHead><TableHead>Interest</TableHead><TableHead>Balance</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {amort.schedule.map((r) => (
                        <TableRow key={r.period}><TableCell>{r.period}</TableCell><TableCell>{r.date}</TableCell><TableCell>{formatCurrency(r.payment, displayCurrency)}</TableCell><TableCell className="text-emerald-600">{formatCurrency(r.principal, displayCurrency)}</TableCell><TableCell className="text-rose-600">{formatCurrency(r.interest, displayCurrency)}</TableCell><TableCell className="font-mono">{formatCurrency(r.balance, displayCurrency)}</TableCell></TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>
              <TabsContent value="monthly">
                <p className="text-sm text-muted-foreground mb-4">Interest accrued per calendar month — the reportable figure, day-weighted when payments straddle month boundaries.</p>
                <div className="max-h-96 overflow-auto">
                  <Table>
                    <TableHeader><TableRow><TableHead>Month</TableHead><TableHead>Interest Accrued</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {(amort.monthlyAccrual ?? []).map((m) => (
                        <TableRow key={m.month}><TableCell className="font-mono">{m.month}</TableCell><TableCell className="text-rose-600 font-mono">{formatCurrency(m.interest, displayCurrency)}</TableCell></TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>
              <TabsContent value="whatif">
                <p className="text-sm text-muted-foreground mb-4">What if you added extra monthly payments?</p>
                <Table>
                  <TableHeader><TableRow><TableHead>Extra/Month</TableHead><TableHead>Months Saved</TableHead><TableHead>Interest Saved</TableHead><TableHead>New Payoff</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {whatIf.map((w) => (
                      <TableRow key={w.extraPayment}><TableCell className="font-mono">{formatCurrency(w.extraPayment, displayCurrency)}</TableCell><TableCell className="text-emerald-600 font-bold">{w.monthsSaved} months</TableCell><TableCell className="text-emerald-600 font-bold">{formatCurrency(w.interestSaved, displayCurrency)}</TableCell><TableCell>{w.newPayoffDate}</TableCell></TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={(open) => { if (!open) setDeleteId(null); }}
        title="Delete loan"
        description={<>Are you sure you want to delete <strong>{deletingLoan?.name ?? "this loan"}</strong>? This cannot be undone.</>}
        confirmLabel="Delete loan"
        busy={deleting}
        onConfirm={handleDelete}
      />
    </div>
  );
}

export default function LoansPage() { return <DevModeGuard><LoansPageContent /></DevModeGuard>; }
