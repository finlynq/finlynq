"use client";

import { DevModeGuard } from "@/components/dev-mode-guard";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/currency";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar, Legend } from "recharts";
import { Plus, Trash2, Landmark, CreditCard, FileText, Calendar } from "lucide-react";
import { EmptyState } from "@/components/empty-state";

type Loan = {
  id: number; name: string; type: string; principal: number; annualRate: number;
  termMonths: number; startDate: string; paymentFrequency: string; extraPayment: number;
  monthlyPayment: number; totalInterest: number; payoffDate: string;
  remainingBalance: number; principalPaid: number; interestPaid: number; periodsRemaining: number;
  accountName: string | null;
};
type AmortRow = { period: number; date: string; payment: number; principal: number; interest: number; balance: number };
type AmortResult = { monthlyPayment: number; totalPayments: number; totalInterest: number; payoffDate: string; schedule: AmortRow[] };
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
  mortgage: "bg-indigo-100 text-indigo-700",
  lease: "bg-amber-100 text-amber-700",
  loan: "bg-cyan-100 text-cyan-700",
  student_loan: "bg-violet-100 text-violet-700",
  credit_card: "bg-rose-100 text-rose-700",
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
  const [loans, setLoans] = useState<Loan[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedLoan, setSelectedLoan] = useState<Loan | null>(null);
  const [amort, setAmort] = useState<AmortResult | null>(null);
  const [whatIf, setWhatIf] = useState<WhatIf[]>([]);
  const [form, setForm] = useState({ name: "", type: "mortgage", principal: "", annualRate: "", termMonths: "", startDate: "", paymentFrequency: "monthly", extraPayment: "0", accountId: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});

  function validateForm() {
    const e: Record<string, string> = {};
    if (!form.name.trim()) e.name = "Name is required";
    if (!form.principal || parseFloat(form.principal) <= 0) e.principal = "Principal must be greater than 0";
    if (!form.annualRate || parseFloat(form.annualRate) <= 0) e.annualRate = "Rate must be greater than 0";
    if (form.annualRate && parseFloat(form.annualRate) > 100) e.annualRate = "Rate must be 100 or less";
    if (!form.termMonths || parseInt(form.termMonths) <= 0) e.termMonths = "Term must be greater than 0";
    if (!form.startDate) e.startDate = "Start date is required";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  const isFormValid = form.name.trim() !== "" && form.principal !== "" && parseFloat(form.principal) > 0 && form.annualRate !== "" && parseFloat(form.annualRate) > 0 && parseFloat(form.annualRate) <= 100 && form.termMonths !== "" && parseInt(form.termMonths) > 0 && form.startDate !== "";

  const load = useCallback(() => {
    fetch("/api/loans").then((r) => r.json()).then((data) => { setLoans(data); setLoading(false); });
  }, []);
  useEffect(() => { load(); fetch("/api/accounts").then((r) => r.json()).then(setAccounts); }, [load]);

  async function viewAmortization(loan: Loan) {
    setSelectedLoan(loan);
    const [amortRes, whatIfRes] = await Promise.all([
      fetch("/api/loans", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "amortization", principal: loan.principal, annualRate: loan.annualRate, termMonths: loan.termMonths, startDate: loan.startDate, extraPayment: loan.extraPayment, paymentFrequency: loan.paymentFrequency }) }).then((r) => r.json()),
      fetch("/api/loans", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "what-if", principal: loan.principal, annualRate: loan.annualRate, termMonths: loan.termMonths, startDate: loan.startDate, extraAmounts: [100, 200, 500, 1000] }) }).then((r) => r.json()),
    ]);
    setAmort(amortRes);
    setWhatIf(whatIfRes);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validateForm()) return;
    await fetch("/api/loans", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: form.name, type: form.type, principal: parseFloat(form.principal), annualRate: parseFloat(form.annualRate), termMonths: parseInt(form.termMonths), startDate: form.startDate, paymentFrequency: form.paymentFrequency, extraPayment: parseFloat(form.extraPayment) || 0, accountId: form.accountId ? parseInt(form.accountId) : null }) });
    setDialogOpen(false);
    setForm({ name: "", type: "mortgage", principal: "", annualRate: "", termMonths: "", startDate: "", paymentFrequency: "monthly", extraPayment: "0", accountId: "" });
    setErrors({});
    load();
  }

  async function handleDelete(id: number) {
    await fetch(`/api/loans?id=${id}`, { method: "DELETE" });
    load();
  }

  const totalDebt = loans.reduce((s, l) => s + l.remainingBalance, 0);
  const totalMonthly = loans.reduce((s, l) => s + l.monthlyPayment, 0);

  if (loading) return <LoansSkeleton />;

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
                  <Label>Principal ($)</Label>
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
                  <Input type="number" value={form.termMonths} onChange={(e) => { setForm({ ...form, termMonths: e.target.value }); setErrors({ ...errors, termMonths: "" }); }} />
                  {errors.termMonths && <p className="text-xs text-destructive mt-1">{errors.termMonths}</p>}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Start Date</Label>
                  <Input type="date" value={form.startDate} onChange={(e) => { setForm({ ...form, startDate: e.target.value }); setErrors({ ...errors, startDate: "" }); }} />
                  {errors.startDate && <p className="text-xs text-destructive mt-1">{errors.startDate}</p>}
                </div>
                <div><Label>Extra Payment/mo</Label><Input type="number" step="0.01" value={form.extraPayment} onChange={(e) => setForm({ ...form, extraPayment: e.target.value })} /></div>
              </div>
              <div><Label>Linked Account</Label>
                <Select value={form.accountId} onValueChange={(v) => setForm({ ...form, accountId: v ?? "" })}>
                  <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                  <SelectContent>{accounts.map((a) => <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <Button type="submit" className="w-full" disabled={!isFormValid}>Add Loan</Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-rose-100">
                <Landmark className="h-5 w-5 text-rose-600" />
              </div>
              <CardTitle className="text-sm text-muted-foreground">Total Debt</CardTitle>
            </div>
          </CardHeader>
          <CardContent><p className="text-2xl font-bold text-rose-600">{formatCurrency(totalDebt, "CAD")}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100">
                <Calendar className="h-5 w-5 text-amber-600" />
              </div>
              <CardTitle className="text-sm text-muted-foreground">Monthly Payments</CardTitle>
            </div>
          </CardHeader>
          <CardContent><p className="text-2xl font-bold">{formatCurrency(totalMonthly, "CAD")}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100">
                <FileText className="h-5 w-5 text-indigo-600" />
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
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => handleDelete(loan.id)}><Trash2 className="h-4 w-4" /></Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-4">
                <div><p className="text-xs text-muted-foreground">Remaining</p><p className="font-mono font-bold text-rose-600">{formatCurrency(loan.remainingBalance, "CAD")}</p></div>
                <div><p className="text-xs text-muted-foreground">Monthly</p><p className="font-mono">{formatCurrency(loan.monthlyPayment, "CAD")}</p></div>
                <div><p className="text-xs text-muted-foreground">Rate</p><p className="font-mono">{loan.annualRate}%</p></div>
                <div><p className="text-xs text-muted-foreground">Total Interest</p><p className="font-mono">{formatCurrency(loan.totalInterest, "CAD")}</p></div>
                <div><p className="text-xs text-muted-foreground">Payoff</p><p className="font-mono">{loan.payoffDate}</p></div>
              </div>
              <div className="space-y-1">
                <div className="flex justify-between text-xs"><span>Principal paid: {formatCurrency(loan.principalPaid, "CAD")}</span><span>{Math.round(paidPct)}%</span></div>
                <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-rose-200">
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-all"
                    style={{ width: `${paidPct}%` }}
                  />
                </div>
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
              <TabsList><TabsTrigger value="chart">Chart</TabsTrigger><TabsTrigger value="table">Table</TabsTrigger><TabsTrigger value="whatif">What-If</TabsTrigger></TabsList>
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
                        <TableRow key={r.period}><TableCell>{r.period}</TableCell><TableCell>{r.date}</TableCell><TableCell>{formatCurrency(r.payment, "CAD")}</TableCell><TableCell className="text-emerald-600">{formatCurrency(r.principal, "CAD")}</TableCell><TableCell className="text-rose-600">{formatCurrency(r.interest, "CAD")}</TableCell><TableCell className="font-mono">{formatCurrency(r.balance, "CAD")}</TableCell></TableRow>
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
                      <TableRow key={w.extraPayment}><TableCell className="font-mono">{formatCurrency(w.extraPayment, "CAD")}</TableCell><TableCell className="text-emerald-600 font-bold">{w.monthsSaved} months</TableCell><TableCell className="text-emerald-600 font-bold">{formatCurrency(w.interestSaved, "CAD")}</TableCell><TableCell>{w.newPayoffDate}</TableCell></TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function LoansPage() { return <DevModeGuard><LoansPageContent /></DevModeGuard>; }
