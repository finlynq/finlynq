"use client";

import { DevModeGuard } from "@/components/dev-mode-guard";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCurrency } from "@/lib/currency";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  ReferenceLine, Legend,
} from "recharts";
import { Flame, Target, TrendingUp, Calendar, Wallet, Dice5 } from "lucide-react";
import { CHART_COLORS } from "@/lib/chart-colors";

type FireResult = {
  fireNumber: number;
  yearsToFire: number;
  fireAge: number;
  fireDate: string;
  coastFireNumber: number;
  coastFireAge: number;
  currentInvestments: number;
  monthlySavings: number;
  projections: { age: number; year: number; netWorth: number; fireNumber: number }[];
  sensitivityTable: { returnRate: number; savings: number; yearsToFire: number }[];
};

type MonteCarloResult = {
  percentilePaths: {
    p10: number[];
    p25: number[];
    p50: number[];
    p75: number[];
    p90: number[];
  };
  successProbability: number;
  fireNumber: number;
  years: number[];
  finalValues: {
    p10: number;
    p25: number;
    p50: number;
    p75: number;
    p90: number;
  };
};

function ResultCard({ label, value, icon, color }: { label: string; value: string; icon: React.ReactNode; color?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-3">
          <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${color ?? "bg-gray-100"}`}>
            {icon}
          </div>
          <CardTitle className="text-sm text-muted-foreground">{label}</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-bold font-mono">{value}</p>
      </CardContent>
    </Card>
  );
}

function FirePageContent() {
  const [form, setForm] = useState({
    currentAge: "30",
    targetRetirementAge: "65",
    currentInvestments: "50000",
    monthlySavings: "1500",
    annualReturn: "7",
    inflation: "2",
    annualExpenses: "48000",
    withdrawalRate: "4",
  });
  const [result, setResult] = useState<FireResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [dashboardLoaded, setDashboardLoaded] = useState(false);

  // Monte Carlo state
  const [mcVolatility, setMcVolatility] = useState("15");
  const [mcYears, setMcYears] = useState("30");
  const [mcResult, setMcResult] = useState<MonteCarloResult | null>(null);
  const [mcLoading, setMcLoading] = useState(false);

  // Try to pull defaults from dashboard
  useEffect(() => {
    async function loadDefaults() {
      try {
        const res = await fetch("/api/dashboard");
        if (!res.ok) return;
        const data = await res.json();

        // Sum investment account balances
        const investmentBalance = (data.balances ?? [])
          .filter((b: { accountType: string }) => b.accountType === "I")
          .reduce((s: number, b: { balance: number }) => s + b.balance, 0);

        // Get recent income/expenses
        const incomeExpenses = data.incomeVsExpenses ?? [];
        const recentMonths = incomeExpenses.slice(-6);
        let avgMonthlyIncome = 0;
        let avgMonthlyExpenses = 0;
        const incomeMonths = recentMonths.filter((r: { type: string }) => r.type === "I");
        const expenseMonths = recentMonths.filter((r: { type: string }) => r.type === "E");
        if (incomeMonths.length > 0) {
          avgMonthlyIncome = incomeMonths.reduce((s: number, r: { total: number }) => s + Math.abs(r.total), 0) / incomeMonths.length;
        }
        if (expenseMonths.length > 0) {
          avgMonthlyExpenses = expenseMonths.reduce((s: number, r: { total: number }) => s + Math.abs(r.total), 0) / expenseMonths.length;
        }

        const monthlySavings = avgMonthlyIncome - avgMonthlyExpenses;

        setForm((prev) => ({
          ...prev,
          currentInvestments: investmentBalance > 0 ? String(Math.round(investmentBalance)) : prev.currentInvestments,
          monthlySavings: monthlySavings > 0 ? String(Math.round(monthlySavings)) : prev.monthlySavings,
          annualExpenses: avgMonthlyExpenses > 0 ? String(Math.round(avgMonthlyExpenses * 12)) : prev.annualExpenses,
        }));
        setDashboardLoaded(true);
      } catch {
        // Silently fail — use defaults
      }
    }
    loadDefaults();
  }, []);

  async function calculate() {
    setLoading(true);
    const res = await fetch("/api/fire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentAge: parseInt(form.currentAge),
        targetRetirementAge: parseInt(form.targetRetirementAge),
        currentInvestments: parseFloat(form.currentInvestments),
        monthlySavings: parseFloat(form.monthlySavings),
        annualReturn: parseFloat(form.annualReturn),
        inflation: parseFloat(form.inflation),
        annualExpenses: parseFloat(form.annualExpenses),
        withdrawalRate: parseFloat(form.withdrawalRate),
      }),
    });
    setResult(await res.json());
    setLoading(false);
  }

  async function runMonteCarlo() {
    setMcLoading(true);
    try {
      const res = await fetch("/api/fire/monte-carlo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentInvestments: parseFloat(form.currentInvestments),
          monthlySavings: parseFloat(form.monthlySavings),
          annualReturn: parseFloat(form.annualReturn),
          annualVolatility: parseFloat(mcVolatility),
          inflation: parseFloat(form.inflation),
          yearsToSimulate: parseInt(mcYears),
          withdrawalRate: parseFloat(form.withdrawalRate),
          annualExpenses: parseFloat(form.annualExpenses),
        }),
      });
      setMcResult(await res.json());
    } catch {
      // Silently fail
    }
    setMcLoading(false);
  }

  // Group sensitivity table
  const returnRates = [5, 6, 7, 8, 9];
  const savingsAdj = result
    ? [...new Set(result.sensitivityTable.map((s) => s.savings))].sort((a, b) => a - b)
    : [];

  // Build Monte Carlo fan chart data
  const mcChartData = mcResult
    ? mcResult.years.map((year, i) => ({
        year,
        p10: mcResult.percentilePaths.p10[i],
        p25: mcResult.percentilePaths.p25[i],
        p50: mcResult.percentilePaths.p50[i],
        p75: mcResult.percentilePaths.p75[i],
        p90: mcResult.percentilePaths.p90[i],
      }))
    : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Flame className="h-6 w-6 text-orange-500" /> FIRE Calculator
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Calculate your Financial Independence, Retire Early number and timeline
        </p>
        {dashboardLoaded && (
          <p className="text-xs text-emerald-600 mt-1">Some values pre-filled from your dashboard data.</p>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Inputs */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-base">Your Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Current Age</Label>
                <Input type="number" value={form.currentAge} onChange={(e) => setForm({ ...form, currentAge: e.target.value })} />
              </div>
              <div>
                <Label>Target Retirement Age</Label>
                <Input type="number" value={form.targetRetirementAge} onChange={(e) => setForm({ ...form, targetRetirementAge: e.target.value })} />
              </div>
            </div>
            <div>
              <Label>Current Investments ($)</Label>
              <Input type="number" value={form.currentInvestments} onChange={(e) => setForm({ ...form, currentInvestments: e.target.value })} />
            </div>
            <div>
              <Label>Monthly Savings ($)</Label>
              <Input type="number" value={form.monthlySavings} onChange={(e) => setForm({ ...form, monthlySavings: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Annual Return (%)</Label>
                <Input type="number" step="0.5" value={form.annualReturn} onChange={(e) => setForm({ ...form, annualReturn: e.target.value })} />
              </div>
              <div>
                <Label>Inflation (%)</Label>
                <Input type="number" step="0.5" value={form.inflation} onChange={(e) => setForm({ ...form, inflation: e.target.value })} />
              </div>
            </div>
            <div>
              <Label>Annual Expenses in Retirement ($)</Label>
              <Input type="number" value={form.annualExpenses} onChange={(e) => setForm({ ...form, annualExpenses: e.target.value })} />
            </div>
            <div>
              <Label>Safe Withdrawal Rate (%)</Label>
              <Input type="number" step="0.25" value={form.withdrawalRate} onChange={(e) => setForm({ ...form, withdrawalRate: e.target.value })} />
            </div>
            <Button onClick={calculate} disabled={loading} className="w-full">
              <Flame className="h-4 w-4 mr-1" /> {loading ? "Calculating..." : "Calculate FIRE"}
            </Button>
          </CardContent>
        </Card>

        {/* Results */}
        <div className="lg:col-span-2 space-y-4">
          {result && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <ResultCard
                  label="FIRE Number"
                  value={formatCurrency(result.fireNumber, "CAD")}
                  icon={<Target className="h-5 w-5 text-orange-600" />}
                  color="bg-orange-100"
                />
                <ResultCard
                  label="Years to FIRE"
                  value={`${result.yearsToFire} years`}
                  icon={<Calendar className="h-5 w-5 text-indigo-600" />}
                  color="bg-indigo-100"
                />
                <ResultCard
                  label="FIRE Age"
                  value={`Age ${result.fireAge}`}
                  icon={<Flame className="h-5 w-5 text-rose-600" />}
                  color="bg-rose-100"
                />
                <ResultCard
                  label="Projected FIRE Date"
                  value={result.fireDate}
                  icon={<Calendar className="h-5 w-5 text-cyan-600" />}
                  color="bg-cyan-100"
                />
                <ResultCard
                  label="Coast FIRE Number"
                  value={formatCurrency(result.coastFireNumber, "CAD")}
                  icon={<Wallet className="h-5 w-5 text-emerald-600" />}
                  color="bg-emerald-100"
                />
                <ResultCard
                  label="Coast FIRE Age"
                  value={`Age ${result.coastFireAge}`}
                  icon={<TrendingUp className="h-5 w-5 text-violet-600" />}
                  color="bg-violet-100"
                />
              </div>

              {/* Coast FIRE explanation */}
              <Card className="bg-emerald-50 border-emerald-200">
                <CardContent className="py-3">
                  <p className="text-sm text-emerald-700">
                    <strong>Coast FIRE:</strong> If you already have {formatCurrency(result.coastFireNumber, "CAD")} invested,
                    you could stop saving entirely and still reach your FIRE number by age {parseInt(form.targetRetirementAge)} through investment growth alone.
                    At your current savings rate, you will reach Coast FIRE at age {result.coastFireAge}.
                  </p>
                </CardContent>
              </Card>

              {/* Net Worth Projection Chart */}
              <Card>
                <CardHeader><CardTitle className="text-sm">Projected Net Worth vs FIRE Number</CardTitle></CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={350}>
                    <AreaChart data={result.projections}>
                      <XAxis dataKey="age" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}`} />
                      <YAxis fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                      <Tooltip
                        formatter={(v) => formatCurrency(Number(v), "CAD")}
                        labelFormatter={(label) => `Age ${label}`}
                      />
                      <Legend />
                      <ReferenceLine
                        y={result.fireNumber}
                        stroke="#f97316"
                        strokeWidth={2}
                        strokeDasharray="8 4"
                        label={{ value: `FIRE: ${formatCurrency(result.fireNumber, "CAD")}`, position: "insideTopRight", fill: "#f97316", fontSize: 12 }}
                      />
                      {result.fireAge <= parseInt(form.targetRetirementAge) + 10 && (
                        <ReferenceLine
                          x={result.fireAge}
                          stroke="#10b981"
                          strokeWidth={1}
                          strokeDasharray="4 4"
                          label={{ value: `FIRE Age ${result.fireAge}`, position: "top", fill: "#10b981", fontSize: 11 }}
                        />
                      )}
                      <Area
                        type="monotone"
                        dataKey="netWorth"
                        stroke="#6366f1"
                        fill="#6366f1"
                        fillOpacity={0.15}
                        strokeWidth={2}
                        name="Projected Net Worth"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              {/* Monte Carlo Analysis */}
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Dice5 className="h-5 w-5 text-violet-500" />
                      <CardTitle className="text-sm">Monte Carlo Analysis</CardTitle>
                    </div>
                    {mcResult && (
                      <Badge
                        variant="outline"
                        className={`text-sm font-mono ${
                          mcResult.successProbability >= 80
                            ? "bg-emerald-50 text-emerald-700 border-emerald-300"
                            : mcResult.successProbability >= 50
                            ? "bg-amber-50 text-amber-700 border-amber-300"
                            : "bg-rose-50 text-rose-700 border-rose-300"
                        }`}
                      >
                        {mcResult.successProbability}% success
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    1,000 simulations with random market returns to stress-test your plan
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Monte Carlo parameters */}
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs">Volatility (%)</Label>
                      <Input
                        type="number"
                        step="1"
                        min="5"
                        max="40"
                        value={mcVolatility}
                        onChange={(e) => setMcVolatility(e.target.value)}
                        className="w-24 h-8 text-sm"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Years to Simulate</Label>
                      <Input
                        type="number"
                        step="5"
                        min="10"
                        max="60"
                        value={mcYears}
                        onChange={(e) => setMcYears(e.target.value)}
                        className="w-24 h-8 text-sm"
                      />
                    </div>
                    <Button
                      onClick={runMonteCarlo}
                      disabled={mcLoading}
                      variant="outline"
                      size="sm"
                      className="h-8"
                    >
                      <Dice5 className="h-3.5 w-3.5 mr-1" />
                      {mcLoading ? "Running..." : "Run Simulation"}
                    </Button>
                  </div>

                  {mcResult && (
                    <>
                      {/* Fan chart with percentile bands */}
                      <ResponsiveContainer width="100%" height={320}>
                        <AreaChart data={mcChartData}>
                          <XAxis
                            dataKey="year"
                            fontSize={10}
                            tickLine={false}
                            axisLine={false}
                            tickFormatter={(v) => `Yr ${v}`}
                          />
                          <YAxis
                            fontSize={10}
                            tickLine={false}
                            axisLine={false}
                            tickFormatter={(v) => {
                              if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
                              return `$${(v / 1000).toFixed(0)}k`;
                            }}
                          />
                          <Tooltip
                            formatter={(v) => formatCurrency(Number(v), "CAD")}
                            labelFormatter={(label) => `Year ${label}`}
                          />
                          <Legend />
                          <ReferenceLine
                            y={mcResult.fireNumber}
                            stroke="#f97316"
                            strokeWidth={2}
                            strokeDasharray="8 4"
                            label={{ value: "FIRE Target", position: "insideTopRight", fill: "#f97316", fontSize: 11 }}
                          />
                          {/* p10-p90 band (lightest) */}
                          <Area
                            type="monotone"
                            dataKey="p90"
                            stroke="none"
                            fill="#6366f1"
                            fillOpacity={0.08}
                            name="90th Percentile"
                            stackId="band"
                          />
                          <Area
                            type="monotone"
                            dataKey="p10"
                            stroke="none"
                            fill="transparent"
                            name="10th Percentile"
                          />
                          {/* p25-p75 band (medium) */}
                          <Area
                            type="monotone"
                            dataKey="p75"
                            stroke="none"
                            fill="#6366f1"
                            fillOpacity={0.15}
                            name="75th Percentile"
                          />
                          <Area
                            type="monotone"
                            dataKey="p25"
                            stroke="none"
                            fill="#6366f1"
                            fillOpacity={0.08}
                            name="25th Percentile"
                          />
                          {/* Median line */}
                          <Area
                            type="monotone"
                            dataKey="p50"
                            stroke="#6366f1"
                            strokeWidth={2.5}
                            fill="#6366f1"
                            fillOpacity={0.05}
                            name="Median (50th)"
                          />
                        </AreaChart>
                      </ResponsiveContainer>

                      {/* Final value percentiles */}
                      <div className="grid grid-cols-5 gap-2 text-center">
                        {([
                          { label: "Worst Case (P10)", value: mcResult.finalValues.p10, color: "text-rose-600" },
                          { label: "P25", value: mcResult.finalValues.p25, color: "text-amber-600" },
                          { label: "Median (P50)", value: mcResult.finalValues.p50, color: "text-indigo-600" },
                          { label: "P75", value: mcResult.finalValues.p75, color: "text-emerald-600" },
                          { label: "Best Case (P90)", value: mcResult.finalValues.p90, color: "text-emerald-700" },
                        ]).map((item) => (
                          <div key={item.label} className="space-y-1">
                            <p className="text-xs text-muted-foreground">{item.label}</p>
                            <p className={`text-sm font-mono font-bold ${item.color}`}>
                              {item.value >= 1_000_000
                                ? `$${(item.value / 1_000_000).toFixed(1)}M`
                                : formatCurrency(item.value, "CAD")}
                            </p>
                          </div>
                        ))}
                      </div>
                    </>
                  )}

                  {!mcResult && !mcLoading && (
                    <div className="text-center py-8 text-muted-foreground">
                      <Dice5 className="h-8 w-8 mx-auto mb-2 opacity-30" />
                      <p className="text-sm">Click &quot;Run Simulation&quot; to see probabilistic outcomes</p>
                      <p className="text-xs mt-1">Uses 1,000 random market scenarios based on your parameters</p>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Sensitivity Table */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Sensitivity Analysis: Years to FIRE</CardTitle>
                  <p className="text-xs text-muted-foreground">How different return rates and savings amounts affect your timeline</p>
                </CardHeader>
                <CardContent>
                  <div className="overflow-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="font-bold">Return Rate</TableHead>
                          {savingsAdj.map((s) => (
                            <TableHead key={s} className="text-center font-mono text-xs">
                              {formatCurrency(s, "CAD")}/mo
                            </TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {returnRates.map((rr) => (
                          <TableRow key={rr}>
                            <TableCell className="font-bold">{rr}%</TableCell>
                            {savingsAdj.map((s) => {
                              const entry = result.sensitivityTable.find(
                                (e) => e.returnRate === rr && e.savings === s
                              );
                              const years = entry?.yearsToFire ?? -1;
                              const isCurrentScenario =
                                rr === parseFloat(form.annualReturn) &&
                                s === parseFloat(form.monthlySavings);
                              return (
                                <TableCell
                                  key={s}
                                  className={`text-center font-mono ${
                                    isCurrentScenario
                                      ? "bg-indigo-100 font-bold text-indigo-700"
                                      : years === -1
                                      ? "text-muted-foreground"
                                      : years <= result.yearsToFire
                                      ? "text-emerald-600"
                                      : "text-amber-600"
                                  }`}
                                >
                                  {years === -1 ? "50+" : `${years} yr`}
                                </TableCell>
                              );
                            })}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
          {!result && (
            <Card className="flex items-center justify-center h-96">
              <div className="text-center">
                <Flame className="h-12 w-12 text-muted-foreground/30 mx-auto mb-3" />
                <p className="text-muted-foreground">Enter your details and click Calculate FIRE</p>
                <p className="text-xs text-muted-foreground mt-1">to see your path to financial independence</p>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

export default function FirePage() { return <DevModeGuard><FirePageContent /></DevModeGuard>; }
