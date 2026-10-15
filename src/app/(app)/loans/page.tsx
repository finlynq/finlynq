"use client";


import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox, type ComboboxItemShape } from "@/components/ui/combobox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useDropdownOrder } from "@/components/dropdown-order-provider";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/currency";
import { useDisplayCurrency } from "@/components/currency-provider";
import { useActiveCurrencies } from "@/lib/hooks/useActiveCurrencies";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar, Legend } from "recharts";
import { Plus, Pencil, Trash2, Landmark, CreditCard, FileText, Calendar, CheckCircle2, ChevronDown, LayoutGrid, List } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { parseSaveError } from "@/lib/save-error";
import { CspSafeBar } from "@/components/csp-safe-bar";
import { isLoanCompleted } from "@/lib/loan-status";
import { LoanInterestEntries } from "./_components/interest-entries";
import { LoanScheduleEditor } from "./_components/schedule-editor";
import { LoansList, LOAN_TYPE_BADGE_COLORS } from "./_components/loans-list";
import {
  LOANS_VIEW_STORAGE_KEY,
  loanPaidPct,
  loanShownRate,
  loanTypeLabel,
  parseLoansView,
  type LoansView,
} from "@/lib/loans/list-view";

type Loan = {
  id: number; name: string; type: string; principal: number; annualRate: number;
  termMonths: number | null; startDate: string; paymentFrequency: string; extraPayment: number;
  paymentAmount: number | null; residualValue: number | null;
  monthlyPayment: number; paymentPerPeriod: number; monthlyEquivalentPayment: number;
  totalInterest: number; payoffDate: string;
  remainingBalance: number; balanceSource: "account" | "projection" | null;
  principalPaid: number; interestPaid: number; periodsRemaining: number;
  accountName: string | null;
  accountId: number | null;
  scheduleMode?: "calculated" | "manual";
  // How the interest is worked out; see INTEREST_METHODS in loan-calculator.ts.
  interestMethod?: "rate" | "flat" | "total";
  interestAmount?: number | null;
  // The comparable yearly rate on the balance owed (differs from annualRate for flat / total).
  effectiveAnnualRate?: number | null;
  // FINLYNQ-123 dual basis. Every amount above is in `currency` (the loan's
  // own). The `*Display` companions are the server's current-rate conversion
  // into `displayCurrency` and are the ONLY figures safe to sum across loans.
  currency: string;
  displayCurrency: string;
  remainingBalanceDisplay: number | null;
  monthlyEquivalentPaymentDisplay: number | null;
};
type AmortRow = { period: number; date: string; payment: number; principal: number; interest: number; balance: number; interestOverridden?: boolean };
type AccrualRow = { month: string; interest: number };
type AmortResult = { monthlyPayment: number; totalPayments: number; totalInterest: number; payoffDate: string; residualValue: number; schedule: AmortRow[]; monthlyAccrual: AccrualRow[]; scheduleMode?: "calculated" | "manual" };

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

// How a loan's interest is entered. Mirrors INTEREST_METHODS in loan-calculator.ts.
const INTEREST_METHOD_OPTIONS = [
  { value: "rate", label: "Yearly rate" },
  { value: "flat", label: "Fixed amount each payment" },
  { value: "total", label: "Total for the whole loan" },
];

// Tabs of the schedule panel, in display order. A `?tab=` deep link must name one.
const PANEL_TABS = ["chart", "table", "monthly", "entries", "whatif"];

const PERIODS_PER_YEAR: Record<string, number> = { weekly: 52, biweekly: 26, semi_monthly: 24, monthly: 12, quarterly: 4, annual: 1 };

// What-if is term-driven; for payment-driven loans (termMonths null) derive an
// equivalent term in months from the solved periods remaining.
function equivalentTermMonths(loan: Loan): number {
  if (loan.termMonths != null) return loan.termMonths;
  const perYear = PERIODS_PER_YEAR[loan.paymentFrequency] ?? 12;
  return Math.max(1, Math.round((loan.periodsRemaining / perYear) * 12));
}
type WhatIf = { extraPayment: number; monthsSaved: number; interestSaved: number; newPayoffDate: string; totalInterest: number };
type Account = { id: number; name: string; currency?: string | null; isInvestment?: boolean };

const LOAN_TYPE_COLORS: Record<string, string> = {
  mortgage: "border-l-indigo-500",
  lease: "border-l-amber-500",
  loan: "border-l-cyan-500",
  student_loan: "border-l-violet-500",
  credit_card: "border-l-rose-500",
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
  // ONE dialog serves create and edit. `editingLoan` is the only mode switch,
  // so any field added to the form below is automatically editable too — the
  // whole reason this isn't a second copy of the layout.
  const [editingLoan, setEditingLoan] = useState<Loan | null>(null);
  const [saving, setSaving] = useState(false);
  // A currency change on an existing loan RE-DENOMINATES it (reinterprets the
  // stored numbers); it does not convert them. Held here pending confirmation.
  const [pendingRedenominate, setPendingRedenominate] = useState<{ from: string; to: string } | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [selectedLoan, setSelectedLoan] = useState<Loan | null>(null);
  const [amort, setAmort] = useState<AmortResult | null>(null);
  const [whatIf, setWhatIf] = useState<WhatIf[]>([]);
  const [form, setForm] = useState({ name: "", type: "mortgage", principal: "", currency: displayCurrency, annualRate: "", termMonths: "", startDate: "", paymentAmount: "", paymentFrequency: "monthly", extraPayment: "0", residualValue: "", accountId: "", interestMethod: "rate", interestAmount: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Built-in fiat UNION the user's active currencies (#291).
  const currencyOptions = useActiveCurrencies(form.currency);

  function validateForm() {
    const e: Record<string, string> = {};
    if (!form.name.trim()) e.name = "Name is required";
    if (!form.principal || parseFloat(form.principal) <= 0) e.principal = "Principal must be greater than 0";
    if (form.interestMethod === "rate") {
      if (!form.annualRate || parseFloat(form.annualRate) < 0) e.annualRate = "Rate must be 0 or more";
      if (form.annualRate && parseFloat(form.annualRate) > 100) e.annualRate = "Rate must be 100 or less";
    } else if (form.interestAmount === "" || !(parseFloat(form.interestAmount) >= 0)) {
      e.annualRate = "Enter the interest amount (0 or more)";
    }
    // FINLYNQ-136: term OR payment — payment-driven loans solve for the term.
    if (!form.termMonths && !form.paymentAmount) e.termMonths = "Enter a term or a payment amount";
    if (form.termMonths && parseInt(form.termMonths) <= 0) e.termMonths = "Term must be greater than 0";
    if (form.paymentAmount && parseFloat(form.paymentAmount) <= 0) e.paymentAmount = "Payment must be greater than 0";
    if (form.residualValue && form.principal && parseFloat(form.residualValue) >= parseFloat(form.principal)) e.residualValue = "Residual must be less than principal";
    if (!form.startDate) e.startDate = "Start date is required";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  const isFormValid = form.name.trim() !== "" && form.principal !== "" && parseFloat(form.principal) > 0 && (form.interestMethod === "rate" ? form.annualRate !== "" && parseFloat(form.annualRate) >= 0 && parseFloat(form.annualRate) <= 100 : form.interestAmount !== "" && parseFloat(form.interestAmount) >= 0) && (form.termMonths !== "" ? parseInt(form.termMonths) > 0 : form.paymentAmount !== "" && parseFloat(form.paymentAmount) > 0) && form.startDate !== "";

  const BLANK_FORM = {
    name: "", type: "mortgage", principal: "", currency: displayCurrency, annualRate: "",
    termMonths: "", startDate: "", paymentAmount: "", paymentFrequency: "monthly",
    extraPayment: "0", residualValue: "", accountId: "",
    interestMethod: "rate", interestAmount: "",
  };

  function openCreate() {
    setEditingLoan(null);
    setErrors({});
    setForm({ ...BLANK_FORM, currency: displayCurrency });
    setDialogOpen(true);
  }

  function openEdit(loan: Loan) {
    setEditingLoan(loan);
    setErrors({});
    // Seed from the loan's NATIVE fields — never the converted companions, or
    // saving would silently rewrite the principal in the display currency.
    setForm({
      name: loan.name ?? "",
      type: loan.type,
      principal: String(loan.principal),
      currency: loan.currency,
      annualRate: String(loan.annualRate),
      interestMethod: loan.interestMethod ?? "rate",
      interestAmount: loan.interestAmount == null ? "" : String(loan.interestAmount),
      termMonths: loan.termMonths == null ? "" : String(loan.termMonths),
      startDate: loan.startDate,
      paymentAmount: loan.paymentAmount == null ? "" : String(loan.paymentAmount),
      paymentFrequency: loan.paymentFrequency,
      extraPayment: String(loan.extraPayment ?? 0),
      residualValue: loan.residualValue == null ? "" : String(loan.residualValue),
      accountId: loan.accountId == null ? "" : String(loan.accountId),
    });
    setDialogOpen(true);
  }

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

  // Cards or the compact list (in-app feedback 2026-10-15: 17 loans, about
  // three cards to a screen). Remembered per browser. Reading storage in the
  // initializer is safe here: the page shows its skeleton until the loans load,
  // so the server render and the first client render are the same either way.
  const [view, setView] = useState<LoansView>(() => {
    if (typeof window === "undefined") return "cards";
    try {
      return parseLoansView(window.localStorage.getItem(LOANS_VIEW_STORAGE_KEY));
    } catch {
      return "cards"; // storage blocked
    }
  });
  function changeView(next: LoansView) {
    setView(next);
    try {
      window.localStorage.setItem(LOANS_VIEW_STORAGE_KEY, next);
    } catch {
      // Storage blocked: the choice lasts until the page is left.
    }
  }

  // Schedule panel tab. Controlled so a deep link can open a specific one.
  const [panelTab, setPanelTab] = useState("chart");
  // `/loans?loan=<id>&tab=<tab>` opens that loan's schedule panel on that tab
  // (the dashboard's loan-interest card links here). Read once, after the
  // loans have loaded; later clicks own the panel from then on.
  const deepLinkDone = useRef(false);
  // Set by the deep link; the panel is scrolled to once it has rendered.
  const scrollToPanel = useRef(false);
  useEffect(() => {
    if (!scrollToPanel.current || !amort) return;
    scrollToPanel.current = false;
    document.getElementById("loan-schedule")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [amort]);
  useEffect(() => {
    if (deepLinkDone.current || loans.length === 0) return;
    deepLinkDone.current = true;
    const params = new URLSearchParams(window.location.search);
    const target = loans.find((l) => String(l.id) === params.get("loan"));
    // A loan the server could not schedule has no panel to open.
    if (!target || target.remainingBalance == null) return;
    const tab = params.get("tab");
    if (tab && PANEL_TABS.includes(tab)) setPanelTab(tab);
    scrollToPanel.current = true;
    void viewAmortization(target);
    // viewAmortization is recreated every render; this runs once by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loans]);

  async function viewAmortization(loan: Loan) {
    setSelectedLoan(loan);
    const [amortRes, whatIfRes] = await Promise.all([
      fetch("/api/loans", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "amortization", loanId: loan.id, principal: loan.principal, annualRate: loan.annualRate, termMonths: loan.termMonths, startDate: loan.startDate, paymentAmount: loan.paymentAmount, extraPayment: loan.extraPayment, paymentFrequency: loan.paymentFrequency, residualValue: loan.residualValue }) }).then((r) => r.json()),
      fetch("/api/loans", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "what-if", principal: loan.principal, annualRate: loan.annualRate, termMonths: equivalentTermMonths(loan), startDate: loan.startDate, extraAmounts: [100, 200, 500, 1000] }) }).then((r) => r.json()),
    ]);
    setAmort(amortRes);
    setWhatIf(Array.isArray(whatIfRes) ? whatIfRes : []);
  }

  // The panel renders below every loan, so with a long list it opened off
  // screen and the click looked like it did nothing. Scroll to it.
  function openSchedule(loan: Loan) {
    scrollToPanel.current = true;
    void viewAmortization(loan);
  }

  // ONE payload shape for both verbs, so a field added to the form reaches
  // create and edit together rather than silently working in only one.
  function buildPayload() {
    return {
      name: form.name,
      type: form.type,
      principal: parseFloat(form.principal),
      currency: form.currency || displayCurrency,
      // For a fixed-amount or total-interest loan the rate is not what
      // produces the interest; keep whatever was typed, or 0.
      annualRate: form.interestMethod === "rate" ? parseFloat(form.annualRate) : parseFloat(form.annualRate) || 0,
      interestMethod: form.interestMethod,
      interestAmount: form.interestMethod === "rate" ? null : parseFloat(form.interestAmount),
      termMonths: form.termMonths ? parseInt(form.termMonths) : null,
      startDate: form.startDate,
      paymentAmount: form.paymentAmount ? parseFloat(form.paymentAmount) : null,
      paymentFrequency: form.paymentFrequency,
      extraPayment: parseFloat(form.extraPayment) || 0,
      residualValue: form.type === "lease" && form.residualValue ? parseFloat(form.residualValue) : null,
      accountId: form.accountId ? parseInt(form.accountId) : null,
    };
  }

  async function doSave() {
    // `saving` gates re-entry — /api/loans has no idempotency key, so a
    // double-submit would book the loan twice.
    if (saving) return;
    setSaving(true);
    setPendingRedenominate(null);
    const editing = editingLoan;
    try {
      const res = await fetch("/api/loans", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing ? { id: editing.id, ...buildPayload() } : buildPayload()),
      });
      if (!res.ok) {
        // e.g. payment below the period interest, or 423 with no DEK. Keep the
        // dialog OPEN and the input intact.
        const message = await parseSaveError(res, editing ? "Failed to save loan" : "Failed to create loan");
        setErrors((prev) => ({ ...prev, form: message }));
        return;
      }
      setDialogOpen(false);
      setEditingLoan(null);
      setForm({ ...BLANK_FORM, currency: displayCurrency });
      setErrors({});
      load();
    } catch {
      // A thrown fetch (offline, DNS, aborted) would otherwise leave the
      // dialog sitting there looking like nothing happened.
      setErrors((prev) => ({ ...prev, form: "Couldn't reach the server. Check your connection and try again." }));
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving || !validateForm()) return;
    const from = editingLoan?.currency;
    const to = form.currency || displayCurrency;
    // Changing the currency of an EXISTING loan reinterprets its stored
    // numbers rather than converting them — confirm before that lands.
    if (editingLoan && from && from !== to) {
      setPendingRedenominate({ from, to });
      return;
    }
    await doSave();
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

  // FINLYNQ-123: totals sum the server's converted figures, NOT the native
  // ones. Adding a ₽8,116,000 balance to a USD book and labelling the result
  // "$" is an ~80x overstatement. `*Display` is null only for a row the server
  // couldn't schedule (dataIntegrity), which contributes nothing either way.
  const totalDebt = loans.reduce((s, l) => s + (l.remainingBalanceDisplay ?? 0), 0);
  // Paid-off loans sit in a collapsed "Completed" accordion and pay nothing.
  const activeLoans = loans.filter((l) => !isLoanCompleted(l));
  const completedLoans = loans.filter(isLoanCompleted);
  // Monthly-equivalent so weekly/quarterly/annual loans sum comparably.
  const totalMonthly = activeLoans.reduce((s, l) => s + (l.monthlyEquivalentPaymentDisplay ?? 0), 0);
  // Whether any loan is booked in something other than the display currency —
  // drives the "converted at today's rate" caveat on the two total tiles.
  const hasForeignLoan = loans.some((l) => l.currency && l.currency !== displayCurrency);

  const renderLoan = (loan: Loan) => {
        const paidPct = loanPaidPct(loan);
        const shownRate = loanShownRate(loan);
        const borderClass = LOAN_TYPE_COLORS[loan.type] || "border-l-gray-400";
        const badgeClass = LOAN_TYPE_BADGE_COLORS[loan.type] || "";
        return (
          <Card key={loan.id} className={`border-l-4 ${borderClass}`}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CardTitle>{loan.name}</CardTitle>
                  <Badge variant="secondary" className={badgeClass}>{loanTypeLabel(loan.type)}</Badge>
                  {loan.scheduleMode === "manual" && <Badge variant="outline" className="text-xs">Manual schedule</Badge>}
                  {loan.currency !== displayCurrency && (
                    <Badge variant="outline" className="font-mono text-xs">{loan.currency}</Badge>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => openSchedule(loan)}>View Schedule</Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Edit loan ${loan.name}`} onClick={() => openEdit(loan)}><Pencil className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" aria-label={`Delete loan ${loan.name}`} onClick={() => setDeleteId(loan.id)}><Trash2 className="h-4 w-4" /></Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-4">
                <div>
                  <p className="text-xs text-muted-foreground">
                    Remaining
                    {loan.balanceSource === "account" && loan.accountId != null && (
                      <Link href={`/accounts/${loan.accountId}`} className="ml-1 text-emerald-600 hover:underline" title={`Live balance from ${loan.accountName ?? "the linked account"}. Open the account.`}>
                        · from account
                      </Link>
                    )}
                  </p>
                  <p className="font-mono font-bold text-rose-600">{formatCurrency(loan.remainingBalance, loan.currency)}</p>
                  {loan.currency !== displayCurrency && loan.remainingBalanceDisplay != null && (
                    <p className="text-xs text-muted-foreground font-mono">≈ {formatCurrency(loan.remainingBalanceDisplay, displayCurrency)}</p>
                  )}
                </div>
                <div><p className="text-xs text-muted-foreground">{FREQUENCY_LABELS[loan.paymentFrequency] ?? "Payment"}</p><p className="font-mono">{formatCurrency(loan.paymentPerPeriod ?? loan.monthlyPayment, loan.currency)}</p></div>
                <div>
                  <p className="text-xs text-muted-foreground">{shownRate.effective ? "Effective rate" : "Rate"}</p>
                  <p className="font-mono" title={shownRate.effective ? "The yearly rate, on the balance still owed, that this loan works out to" : undefined}>
                    {shownRate.rate}%
                  </p>
                </div>
                <div><p className="text-xs text-muted-foreground">Total Interest</p><p className="font-mono">{formatCurrency(loan.totalInterest, loan.currency)}</p></div>
                <div>
                  <p className="text-xs text-muted-foreground">{loan.type === "lease" ? "Term end" : "Payoff"}</p>
                  <p className="font-mono">{loan.payoffDate}</p>
                  {loan.type === "lease" && loan.residualValue != null && loan.residualValue > 0 && (
                    <p className="text-xs text-muted-foreground">residual {formatCurrency(loan.residualValue, loan.currency)}</p>
                  )}
                </div>
              </div>
              <div className="space-y-1">
                <div className="flex justify-between text-xs"><span>Principal paid: {formatCurrency(loan.principalPaid, loan.currency)}</span><span>{Math.round(paidPct)}%</span></div>
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
  };

  if (loading) return <LoansSkeleton />;
  if (loadError) return <ErrorState title="Couldn't load loans" message="We couldn't load your loans. Please try again." onRetry={() => { setLoading(true); load(); }} />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Loans & Debt</h1>
          <p className="text-sm text-muted-foreground mt-1">Track balances, amortization schedules, and payoff strategies</p>
        </div>
        {/* Opening is routed through openCreate/openEdit rather than a
            DialogTrigger, so the form is seeded before the dialog paints.
            `displayCurrency` starts at the USD default and only resolves once
            /api/auth/session lands, so seeding at open (not at useState) is
            what stops a RUB user being shown USD preselected — the form SENDS
            that value, persisting the wrong currency rather than displaying it. */}
        <Button id="add-loan-btn" onClick={openCreate}><Plus className="h-4 w-4 mr-1" /> Add Loan</Button>
        <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) setEditingLoan(null); }}>
          <DialogContent>
            <DialogHeader><DialogTitle>{editingLoan ? "Edit Loan" : "Add Loan"}</DialogTitle></DialogHeader>
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
                      {currencyOptions.map(c => (<SelectItem key={c} value={c}>{c}</SelectItem>))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Principal</Label>
                  <Input type="number" step="0.01" value={form.principal} onChange={(e) => { setForm({ ...form, principal: e.target.value }); setErrors({ ...errors, principal: "" }); }} />
                  {errors.principal && <p className="text-xs text-destructive mt-1">{errors.principal}</p>}
                </div>
                <div>
                  <Label>Interest</Label>
                  <Select value={form.interestMethod} onValueChange={(v) => { setForm({ ...form, interestMethod: v ?? "rate" }); setErrors({ ...errors, annualRate: "" }); }}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    {/* Wider than its narrow trigger, so the longer labels are not clipped. */}
                    <SelectContent className="min-w-60">
                      {INTEREST_METHOD_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  {form.interestMethod === "rate" ? (
                    <>
                      <Label>Annual Rate (%)</Label>
                      <Input type="number" step="0.01" value={form.annualRate} onChange={(e) => { setForm({ ...form, annualRate: e.target.value }); setErrors({ ...errors, annualRate: "" }); }} />
                    </>
                  ) : (
                    <>
                      <Label>{form.interestMethod === "flat" ? "Interest each payment" : "Total interest"}</Label>
                      <Input type="number" step="0.01" min="0" value={form.interestAmount} onChange={(e) => { setForm({ ...form, interestAmount: e.target.value }); setErrors({ ...errors, annualRate: "" }); }} />
                    </>
                  )}
                  {errors.annualRate && <p className="text-xs text-destructive mt-1">{errors.annualRate}</p>}
                </div>
                {form.interestMethod !== "rate" && (
                  <p className="col-span-2 text-xs text-muted-foreground">
                    {form.interestMethod === "flat"
                      ? "Every payment carries this same interest, the way such loans are advertised. Interest really accrues on what is still owed, so the loan card also shows the yearly rate this works out to."
                      : "The whole loan's interest, spread the standard way: the payment stays level, with more interest in the early payments and less in the later ones."}
                  </p>
                )}
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
                  // Mirror the server's precedence (explicit > linked account >
                  // display currency): picking an account moves the currency
                  // with it, so the form can't imply one and store another.
                  onValueChange={(v) => {
                    const acct = accounts.find((a) => String(a.id) === v);
                    setForm((f) => ({ ...f, accountId: v, currency: acct?.currency || f.currency }));
                  }}
                  items={sortAccount(
                    accounts
                      // Interest is booked on the linked account and its balance becomes the
                      // loan's, which an investment account can't do (the server refuses it too).
                      // A loan already on one keeps it listed so the form still shows it.
                      .filter((a) => a.isInvestment !== true || a.id === editingLoan?.accountId)
                      .map((a): ComboboxItemShape => ({ value: String(a.id), label: a.name })),
                    (a) => Number(a.value),
                    (a, z) => (a.label ?? "").localeCompare(z.label ?? ""),
                  )}
                  placeholder="None"
                  searchPlaceholder="Search accounts…"
                  emptyMessage="No matches"
                  className="w-full"
                />
              </div>
              {editingLoan && form.currency !== editingLoan.currency && (
                <p className="text-xs text-amber-600 dark:text-amber-500">
                  Changing the currency re-labels the amounts above as {form.currency}. It does not convert them.
                </p>
              )}
              {errors.form && <p className="text-xs text-destructive">{errors.form}</p>}
              <Button type="submit" className="w-full" disabled={!isFormValid || saving}>
                {saving ? "Saving…" : editingLoan ? "Save changes" : "Add Loan"}
              </Button>
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
          <CardContent>
            <p className="text-2xl font-bold text-rose-600">{formatCurrency(totalDebt, displayCurrency)}</p>
            {hasForeignLoan && <p className="text-xs text-muted-foreground mt-1">converted at today&apos;s rates</p>}
          </CardContent>
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
          <CardContent>
            <p className="text-2xl font-bold">{formatCurrency(totalMonthly, displayCurrency)}</p>
            {hasForeignLoan && <p className="text-xs text-muted-foreground mt-1">converted at today&apos;s rates</p>}
          </CardContent>
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
          <CardContent><p className="text-2xl font-bold">{activeLoans.length}</p></CardContent>
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

      {loans.length > 0 && (
        <div className="flex justify-end">
          <Tabs value={view} onValueChange={(v) => changeView(v === "list" ? "list" : "cards")}>
            <TabsList aria-label="How loans are shown">
              <TabsTrigger value="cards" className="px-3"><LayoutGrid className="h-4 w-4" /> Cards</TabsTrigger>
              <TabsTrigger value="list" className="px-3"><List className="h-4 w-4" /> List</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      )}

      {/* Active loans: cards, or one row each */}
      {view === "list"
        ? activeLoans.length > 0 && (
            <div className="rounded-xl border bg-card">
              <LoansList
                loans={activeLoans}
                displayCurrency={displayCurrency}
                selectedId={selectedLoan?.id ?? null}
                onSchedule={openSchedule}
                onEdit={openEdit}
                onDelete={(l) => setDeleteId(l.id)}
              />
            </div>
          )
        : activeLoans.map(renderLoan)}

      {/* Paid-off loans: collapsed by default */}
      {completedLoans.length > 0 && (
        <details className="group rounded-xl border bg-card text-card-foreground">
          <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="flex-1">
              <span className="block text-sm font-medium">Completed ({completedLoans.length})</span>
              <span className="block text-xs text-muted-foreground">Paid-off loans</span>
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
          </summary>
          {view === "list" ? (
            <div className="border-t">
              <LoansList
                loans={completedLoans}
                displayCurrency={displayCurrency}
                selectedId={selectedLoan?.id ?? null}
                onSchedule={openSchedule}
                onEdit={openEdit}
                onDelete={(l) => setDeleteId(l.id)}
              />
            </div>
          ) : (
            <div className="space-y-6 px-4 pb-4">{completedLoans.map(renderLoan)}</div>
          )}
        </details>
      )}

      {/* Amortization detail modal */}
      {selectedLoan && amort && (
        <Card id="loan-schedule">
          {/* Every figure in this panel comes from the schedule the server
              computed in the loan's OWN currency — never the display one. */}
          <CardHeader><CardTitle>Amortization: {selectedLoan.name} <span className="text-sm font-normal text-muted-foreground font-mono">({selectedLoan.currency})</span></CardTitle></CardHeader>
          <CardContent>
            <Tabs value={panelTab} onValueChange={(v) => setPanelTab(String(v ?? "chart"))}>
              <TabsList><TabsTrigger value="chart">Chart</TabsTrigger><TabsTrigger value="table">Table</TabsTrigger><TabsTrigger value="monthly">Monthly Interest</TabsTrigger><TabsTrigger value="entries">Interest entries</TabsTrigger><TabsTrigger value="whatif">What-If</TabsTrigger></TabsList>
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
                <LoanScheduleEditor
                  loan={selectedLoan}
                  schedule={amort.schedule}
                  mode={amort.scheduleMode ?? "calculated"}
                  // Rebuild this panel from the saved schedule, and the cards above it.
                  onChanged={() => { void viewAmortization(selectedLoan); void load(); }}
                />
              </TabsContent>
              <TabsContent value="monthly">
                <p className="text-sm text-muted-foreground mb-4">Interest accrued per calendar month — the reportable figure, day-weighted when payments straddle month boundaries.</p>
                <div className="max-h-96 overflow-auto">
                  <Table>
                    <TableHeader><TableRow><TableHead>Month</TableHead><TableHead>Interest Accrued</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {(amort.monthlyAccrual ?? []).map((m) => (
                        <TableRow key={m.month}><TableCell className="font-mono">{m.month}</TableCell><TableCell className="text-rose-600 font-mono">{formatCurrency(m.interest, selectedLoan.currency)}</TableCell></TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>
              <TabsContent value="entries">
                <LoanInterestEntries
                  loan={selectedLoan}
                  schedule={amort.schedule}
                  // No rate is suggested unless the rate is what produces the interest.
                  rateDriven={amort.scheduleMode !== "manual" && (selectedLoan.interestMethod ?? "rate") === "rate"}
                  onPosted={load}
                  // Rebuild this panel's schedule at the new rate, and the cards above it.
                  onRateChanged={(annualRate) => { void viewAmortization({ ...selectedLoan, annualRate }); void load(); }}
                />
              </TabsContent>
              <TabsContent value="whatif">
                <p className="text-sm text-muted-foreground mb-4">What if you added extra monthly payments? Amounts are in {selectedLoan.currency}.</p>
                <Table>
                  <TableHeader><TableRow><TableHead>Extra/Month</TableHead><TableHead>Months Saved</TableHead><TableHead>Interest Saved</TableHead><TableHead>New Payoff</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {whatIf.map((w) => (
                      <TableRow key={w.extraPayment}><TableCell className="font-mono">{formatCurrency(w.extraPayment, selectedLoan.currency)}</TableCell><TableCell className="text-emerald-600 font-bold">{w.monthsSaved} months</TableCell><TableCell className="text-emerald-600 font-bold">{formatCurrency(w.interestSaved, selectedLoan.currency)}</TableCell><TableCell>{w.newPayoffDate}</TableCell></TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      )}

      {/* Re-denomination is not a conversion: the stored numbers stay put and
          only their currency label changes. That is the right primitive for
          repairing a loan booked in the wrong currency, but it silently
          restates the debt if the user expected a conversion. */}
      <ConfirmDialog
        open={pendingRedenominate !== null}
        onOpenChange={(open) => { if (!open) setPendingRedenominate(null); }}
        title="Change loan currency?"
        description={
          <>
            This re-labels the loan from <strong>{pendingRedenominate?.from}</strong> to{" "}
            <strong>{pendingRedenominate?.to}</strong>. The amounts are <strong>not</strong> converted —
            a principal of {form.principal || "0"} stays {form.principal || "0"}, now read as{" "}
            {pendingRedenominate?.to}.
          </>
        }
        confirmLabel="Change currency"
        busy={saving}
        onConfirm={doSave}
      />

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

export default function LoansPage() { return <LoansPageContent />; }
