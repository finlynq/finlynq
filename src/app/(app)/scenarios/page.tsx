"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/currency";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  AreaChart, Area, Legend,
} from "recharts";
import { Home, PiggyBank, CreditCard, TrendingUp, Calculator } from "lucide-react";

// --- Types ---
type HomePurchaseResult = {
  downPayment: number; principal: number; monthlyPayment: number;
  totalInterest: number; totalPayments: number; monthlyCashFlow: number;
  monthlyPropertyTax: number; monthlyMaintenance: number;
  balanceOverTime: { year: number; balance: number; equity: number }[];
};

type ExtraSavingsResult = {
  futureValue: number; totalContributions: number; totalGrowth: number;
  projections: { year: number; contributions: number; growth: number; total: number }[];
};

type DebtPayoffResult = {
  avalanche: { strategy: string; totalInterest: number; totalMonths: number; order: { name: string; paidOffMonth: number }[] };
  snowball: { strategy: string; totalInterest: number; totalMonths: number; order: { name: string; paidOffMonth: number }[] };
  avalancheTimeline: { month: number; totalDebt: number }[];
  snowballTimeline: { month: number; totalDebt: number }[];
};

type IncomeChangeResult = {
  current: { annualIncome: number; annualTax: number; monthlyNet: number; monthlySavings: number; savingsRate: number };
  new: { annualIncome: number; annualTax: number; monthlyNet: number; monthlySavings: number; savingsRate: number };
  difference: { annualIncome: number; annualTax: number; monthlyNet: number; monthlySavings: number };
};

type Loan = {
  id: number; name: string; principal: number; annualRate: number;
  termMonths: number; remainingBalance: number; monthlyPayment: number;
};

// --- Helper ---
function ResultCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-xl font-bold font-mono mt-1 ${color ?? ""}`}>{value}</p>
    </div>
  );
}

// ===== HOME PURCHASE TAB =====
function HomePurchaseTab() {
  const [form, setForm] = useState({
    purchasePrice: "500000", downPaymentPct: "20", interestRate: "5.5",
    amortizationYears: "25", propertyTaxYear: "4000", maintenanceYear: "3000",
  });
  const [result, setResult] = useState<HomePurchaseResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function calculate() {
    setLoading(true);
    const res = await fetch("/api/scenarios", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "home-purchase",
        purchasePrice: parseFloat(form.purchasePrice),
        downPaymentPct: parseFloat(form.downPaymentPct),
        interestRate: parseFloat(form.interestRate),
        amortizationYears: parseInt(form.amortizationYears),
        propertyTaxYear: parseFloat(form.propertyTaxYear),
        maintenanceYear: parseFloat(form.maintenanceYear),
      }),
    });
    setResult(await res.json());
    setLoading(false);
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Home className="h-5 w-5 text-indigo-500" /> Purchase Details
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Purchase Price ($)</Label><Input type="number" value={form.purchasePrice} onChange={(e) => setForm({ ...form, purchasePrice: e.target.value })} /></div>
            <div><Label>Down Payment (%)</Label><Input type="number" value={form.downPaymentPct} onChange={(e) => setForm({ ...form, downPaymentPct: e.target.value })} /></div>
            <div><Label>Interest Rate (%)</Label><Input type="number" step="0.1" value={form.interestRate} onChange={(e) => setForm({ ...form, interestRate: e.target.value })} /></div>
            <div><Label>Amortization (years)</Label><Input type="number" value={form.amortizationYears} onChange={(e) => setForm({ ...form, amortizationYears: e.target.value })} /></div>
            <div><Label>Property Tax / Year ($)</Label><Input type="number" value={form.propertyTaxYear} onChange={(e) => setForm({ ...form, propertyTaxYear: e.target.value })} /></div>
            <div><Label>Maintenance / Year ($)</Label><Input type="number" value={form.maintenanceYear} onChange={(e) => setForm({ ...form, maintenanceYear: e.target.value })} /></div>
          </div>
          <Button onClick={calculate} disabled={loading} className="w-full">
            <Calculator className="h-4 w-4 mr-1" /> {loading ? "Calculating..." : "Calculate"}
          </Button>
        </CardContent>
      </Card>

      <div className="space-y-4">
        {result && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <ResultCard label="Monthly Mortgage" value={formatCurrency(result.monthlyPayment, "CAD")} color="text-indigo-600" />
              <ResultCard label="Total Monthly Cost" value={formatCurrency(result.monthlyCashFlow, "CAD")} color="text-rose-600" />
              <ResultCard label="Down Payment" value={formatCurrency(result.downPayment, "CAD")} />
              <ResultCard label="Total Interest" value={formatCurrency(result.totalInterest, "CAD")} color="text-amber-600" />
            </div>
            <Card>
              <CardHeader><CardTitle className="text-sm">Mortgage Balance Over Time</CardTitle></CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={280}>
                  <LineChart data={result.balanceOverTime}>
                    <XAxis dataKey="year" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => `Yr ${v}`} />
                    <YAxis fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                    <Tooltip formatter={(v) => formatCurrency(Number(v), "CAD")} />
                    <Legend />
                    <Line type="monotone" dataKey="balance" stroke="#6366f1" strokeWidth={2} dot={false} name="Remaining Balance" />
                    <Line type="monotone" dataKey="equity" stroke="#10b981" strokeWidth={2} dot={false} name="Equity" />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
            <div className="grid grid-cols-3 gap-3">
              <ResultCard label="Monthly Property Tax" value={formatCurrency(result.monthlyPropertyTax, "CAD")} />
              <ResultCard label="Monthly Maintenance" value={formatCurrency(result.monthlyMaintenance, "CAD")} />
              <ResultCard label="Total Payments" value={formatCurrency(result.totalPayments, "CAD")} />
            </div>
          </>
        )}
        {!result && (
          <Card className="flex items-center justify-center h-64">
            <p className="text-muted-foreground">Enter purchase details and click Calculate</p>
          </Card>
        )}
      </div>
    </div>
  );
}

// ===== EXTRA SAVINGS TAB =====
function ExtraSavingsTab() {
  const [form, setForm] = useState({ monthlySavings: "500", returnRate: "7", years: "20" });
  const [result, setResult] = useState<ExtraSavingsResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function calculate() {
    setLoading(true);
    const res = await fetch("/api/scenarios", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "extra-savings",
        monthlySavings: parseFloat(form.monthlySavings),
        returnRate: parseFloat(form.returnRate),
        years: parseInt(form.years),
      }),
    });
    setResult(await res.json());
    setLoading(false);
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PiggyBank className="h-5 w-5 text-emerald-500" /> Savings Details
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div><Label>Additional Monthly Savings ($)</Label><Input type="number" value={form.monthlySavings} onChange={(e) => setForm({ ...form, monthlySavings: e.target.value })} /></div>
          <div><Label>Expected Annual Return (%)</Label><Input type="number" step="0.5" value={form.returnRate} onChange={(e) => setForm({ ...form, returnRate: e.target.value })} /></div>
          <div><Label>Time Horizon (years)</Label><Input type="number" value={form.years} onChange={(e) => setForm({ ...form, years: e.target.value })} /></div>
          <Button onClick={calculate} disabled={loading} className="w-full">
            <Calculator className="h-4 w-4 mr-1" /> {loading ? "Calculating..." : "Calculate"}
          </Button>
        </CardContent>
      </Card>

      <div className="space-y-4">
        {result && (
          <>
            <div className="grid grid-cols-3 gap-3">
              <ResultCard label="Future Value" value={formatCurrency(result.futureValue, "CAD")} color="text-emerald-600" />
              <ResultCard label="Total Contributed" value={formatCurrency(result.totalContributions, "CAD")} />
              <ResultCard label="Investment Growth" value={formatCurrency(result.totalGrowth, "CAD")} color="text-indigo-600" />
            </div>
            <Card>
              <CardHeader><CardTitle className="text-sm">Growth Over Time</CardTitle></CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                  <AreaChart data={result.projections}>
                    <XAxis dataKey="year" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => `Yr ${v}`} />
                    <YAxis fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                    <Tooltip formatter={(v) => formatCurrency(Number(v), "CAD")} />
                    <Legend />
                    <Area type="monotone" dataKey="contributions" stackId="1" stroke="#6366f1" fill="#6366f1" fillOpacity={0.3} name="Contributions" />
                    <Area type="monotone" dataKey="growth" stackId="1" stroke="#10b981" fill="#10b981" fillOpacity={0.3} name="Investment Growth" />
                  </AreaChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </>
        )}
        {!result && (
          <Card className="flex items-center justify-center h-64">
            <p className="text-muted-foreground">Enter savings details and click Calculate</p>
          </Card>
        )}
      </div>
    </div>
  );
}

// ===== DEBT PAYOFF TAB =====
function DebtPayoffTab() {
  const [loans, setLoans] = useState<Loan[]>([]);
  const [extraBudget, setExtraBudget] = useState("200");
  const [result, setResult] = useState<DebtPayoffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loansLoading, setLoansLoading] = useState(true);

  useEffect(() => {
    fetch("/api/loans")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setLoans(data);
        setLoansLoading(false);
      })
      .catch(() => setLoansLoading(false));
  }, []);

  async function calculate() {
    if (loans.length === 0) return;
    setLoading(true);
    const debts = loans.map((l) => ({
      id: l.id,
      name: l.name,
      balance: l.remainingBalance,
      rate: l.annualRate,
      minPayment: l.monthlyPayment,
    }));
    const res = await fetch("/api/scenarios", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "debt-payoff", debts, extraBudget: parseFloat(extraBudget) || 0 }),
    });
    setResult(await res.json());
    setLoading(false);
  }

  // Merge timelines for chart
  const chartData = result ? (() => {
    const maxMonth = Math.max(
      result.avalancheTimeline[result.avalancheTimeline.length - 1]?.month ?? 0,
      result.snowballTimeline[result.snowballTimeline.length - 1]?.month ?? 0,
    );
    const avMap = new Map(result.avalancheTimeline.map((r) => [r.month, r.totalDebt]));
    const snMap = new Map(result.snowballTimeline.map((r) => [r.month, r.totalDebt]));
    const step = Math.max(1, Math.floor(maxMonth / 60));
    const data: { month: number; avalanche: number; snowball: number }[] = [];
    for (let m = 0; m <= maxMonth; m += step) {
      data.push({
        month: m,
        avalanche: avMap.get(m) ?? (avMap.get(m - 1) ?? 0),
        snowball: snMap.get(m) ?? (snMap.get(m - 1) ?? 0),
      });
    }
    return data;
  })() : [];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-rose-500" /> Your Debts
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {loansLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-10 bg-muted animate-pulse rounded" />
              ))}
            </div>
          ) : loans.length === 0 ? (
            <p className="text-sm text-muted-foreground">No loans found. Add loans on the Loans page first.</p>
          ) : (
            <>
              <div className="max-h-64 overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Balance</TableHead>
                      <TableHead>Rate</TableHead>
                      <TableHead>Min Payment</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loans.map((l) => (
                      <TableRow key={l.id}>
                        <TableCell className="font-medium">{l.name}</TableCell>
                        <TableCell className="font-mono">{formatCurrency(l.remainingBalance, "CAD")}</TableCell>
                        <TableCell>{l.annualRate}%</TableCell>
                        <TableCell className="font-mono">{formatCurrency(l.monthlyPayment, "CAD")}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div>
                <Label>Extra Monthly Budget ($)</Label>
                <Input type="number" value={extraBudget} onChange={(e) => setExtraBudget(e.target.value)} />
              </div>
              <Button onClick={calculate} disabled={loading} className="w-full">
                <Calculator className="h-4 w-4 mr-1" /> {loading ? "Calculating..." : "Compare Strategies"}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      <div className="space-y-4">
        {result && (
          <>
            <div className="grid grid-cols-2 gap-4">
              <Card className="border-l-4 border-l-indigo-500">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    Avalanche <Badge variant="secondary" className="bg-indigo-100 text-indigo-700">Highest Rate First</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div><p className="text-xs text-muted-foreground">Total Interest</p><p className="font-mono font-bold text-rose-600">{formatCurrency(result.avalanche.totalInterest, "CAD")}</p></div>
                  <div><p className="text-xs text-muted-foreground">Months to Debt-Free</p><p className="font-mono font-bold">{result.avalanche.totalMonths}</p></div>
                  <div className="pt-2 border-t">
                    <p className="text-xs text-muted-foreground mb-1">Payoff Order</p>
                    {result.avalanche.order.map((o, i) => (
                      <p key={i} className="text-xs font-mono">{i + 1}. {o.name} <span className="text-muted-foreground">(month {o.paidOffMonth})</span></p>
                    ))}
                  </div>
                </CardContent>
              </Card>
              <Card className="border-l-4 border-l-amber-500">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    Snowball <Badge variant="secondary" className="bg-amber-100 text-amber-700">Lowest Balance First</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div><p className="text-xs text-muted-foreground">Total Interest</p><p className="font-mono font-bold text-rose-600">{formatCurrency(result.snowball.totalInterest, "CAD")}</p></div>
                  <div><p className="text-xs text-muted-foreground">Months to Debt-Free</p><p className="font-mono font-bold">{result.snowball.totalMonths}</p></div>
                  <div className="pt-2 border-t">
                    <p className="text-xs text-muted-foreground mb-1">Payoff Order</p>
                    {result.snowball.order.map((o, i) => (
                      <p key={i} className="text-xs font-mono">{i + 1}. {o.name} <span className="text-muted-foreground">(month {o.paidOffMonth})</span></p>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>

            {result.avalanche.totalInterest !== result.snowball.totalInterest && (
              <Card className="bg-emerald-50 border-emerald-200">
                <CardContent className="py-3">
                  <p className="text-sm text-emerald-700">
                    {result.avalanche.totalInterest < result.snowball.totalInterest
                      ? `Avalanche saves you ${formatCurrency(result.snowball.totalInterest - result.avalanche.totalInterest, "CAD")} in interest and ${result.snowball.totalMonths - result.avalanche.totalMonths} months.`
                      : `Snowball saves you ${formatCurrency(result.avalanche.totalInterest - result.snowball.totalInterest, "CAD")} in interest.`}
                  </p>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader><CardTitle className="text-sm">Total Debt Over Time</CardTitle></CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={280}>
                  <LineChart data={chartData}>
                    <XAxis dataKey="month" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => `Mo ${v}`} />
                    <YAxis fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                    <Tooltip formatter={(v) => formatCurrency(Number(v), "CAD")} />
                    <Legend />
                    <Line type="monotone" dataKey="avalanche" stroke="#6366f1" strokeWidth={2} dot={false} name="Avalanche" />
                    <Line type="monotone" dataKey="snowball" stroke="#f59e0b" strokeWidth={2} dot={false} name="Snowball" />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </>
        )}
        {!result && loans.length > 0 && (
          <Card className="flex items-center justify-center h-64">
            <p className="text-muted-foreground">Click Compare Strategies to see results</p>
          </Card>
        )}
      </div>
    </div>
  );
}

// ===== INCOME CHANGE TAB =====
function IncomeChangeTab() {
  const [form, setForm] = useState({ currentIncome: "70000", newIncome: "85000", currentSavingsRate: "20" });
  const [result, setResult] = useState<IncomeChangeResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function calculate() {
    setLoading(true);
    const res = await fetch("/api/scenarios", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "income-change",
        currentIncome: parseFloat(form.currentIncome),
        newIncome: parseFloat(form.newIncome),
        currentSavingsRate: parseFloat(form.currentSavingsRate),
      }),
    });
    setResult(await res.json());
    setLoading(false);
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-cyan-500" /> Income Details
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div><Label>Current Annual Income ($)</Label><Input type="number" value={form.currentIncome} onChange={(e) => setForm({ ...form, currentIncome: e.target.value })} /></div>
          <div><Label>New Annual Income ($)</Label><Input type="number" value={form.newIncome} onChange={(e) => setForm({ ...form, newIncome: e.target.value })} /></div>
          <div><Label>Current Savings Rate (%)</Label><Input type="number" value={form.currentSavingsRate} onChange={(e) => setForm({ ...form, currentSavingsRate: e.target.value })} /></div>
          <Button onClick={calculate} disabled={loading} className="w-full">
            <Calculator className="h-4 w-4 mr-1" /> {loading ? "Calculating..." : "Calculate Impact"}
          </Button>
        </CardContent>
      </Card>

      <div className="space-y-4">
        {result && (
          <>
            <div className="grid grid-cols-2 gap-4">
              <Card className="border-t-4 border-t-gray-300">
                <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Current</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  <div><p className="text-xs text-muted-foreground">Annual Income</p><p className="font-mono font-bold">{formatCurrency(result.current.annualIncome, "CAD")}</p></div>
                  <div><p className="text-xs text-muted-foreground">Monthly Take-Home</p><p className="font-mono">{formatCurrency(result.current.monthlyNet, "CAD")}</p></div>
                  <div><p className="text-xs text-muted-foreground">Monthly Savings</p><p className="font-mono">{formatCurrency(result.current.monthlySavings, "CAD")}</p></div>
                  <div><p className="text-xs text-muted-foreground">Savings Rate</p><p className="font-mono">{result.current.savingsRate}%</p></div>
                </CardContent>
              </Card>
              <Card className="border-t-4 border-t-emerald-500">
                <CardHeader className="pb-2"><CardTitle className="text-sm text-emerald-600">New</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  <div><p className="text-xs text-muted-foreground">Annual Income</p><p className="font-mono font-bold">{formatCurrency(result.new.annualIncome, "CAD")}</p></div>
                  <div><p className="text-xs text-muted-foreground">Monthly Take-Home</p><p className="font-mono">{formatCurrency(result.new.monthlyNet, "CAD")}</p></div>
                  <div><p className="text-xs text-muted-foreground">Monthly Savings</p><p className="font-mono">{formatCurrency(result.new.monthlySavings, "CAD")}</p></div>
                  <div><p className="text-xs text-muted-foreground">Savings Rate</p><p className="font-mono">{result.new.savingsRate}%</p></div>
                </CardContent>
              </Card>
            </div>

            <Card className="bg-cyan-50 border-cyan-200">
              <CardHeader className="pb-2"><CardTitle className="text-sm">Impact Summary</CardTitle></CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs text-muted-foreground">Extra Monthly Take-Home</p>
                    <p className="font-mono font-bold text-emerald-600">+{formatCurrency(result.difference.monthlyNet, "CAD")}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Extra Monthly Savings</p>
                    <p className="font-mono font-bold text-emerald-600">+{formatCurrency(result.difference.monthlySavings, "CAD")}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Additional Annual Tax</p>
                    <p className="font-mono font-bold text-amber-600">+{formatCurrency(result.difference.annualTax, "CAD")}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Annual Income Increase</p>
                    <p className="font-mono font-bold text-indigo-600">+{formatCurrency(result.difference.annualIncome, "CAD")}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </>
        )}
        {!result && (
          <Card className="flex items-center justify-center h-64">
            <p className="text-muted-foreground">Enter income details and click Calculate Impact</p>
          </Card>
        )}
      </div>
    </div>
  );
}

// ===== MAIN PAGE =====
export default function ScenariosPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Scenario Planner</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Model financial decisions and see their long-term impact
        </p>
      </div>

      <Tabs defaultValue="home-purchase">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="home-purchase">Home Purchase</TabsTrigger>
          <TabsTrigger value="extra-savings">Extra Savings</TabsTrigger>
          <TabsTrigger value="debt-payoff">Debt Payoff</TabsTrigger>
          <TabsTrigger value="income-change">Income Change</TabsTrigger>
        </TabsList>
        <TabsContent value="home-purchase" className="mt-6"><HomePurchaseTab /></TabsContent>
        <TabsContent value="extra-savings" className="mt-6"><ExtraSavingsTab /></TabsContent>
        <TabsContent value="debt-payoff" className="mt-6"><DebtPayoffTab /></TabsContent>
        <TabsContent value="income-change" className="mt-6"><IncomeChangeTab /></TabsContent>
      </Tabs>
    </div>
  );
}
