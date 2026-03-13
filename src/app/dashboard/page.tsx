"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/currency";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line, Area, AreaChart,
} from "recharts";
import {
  DollarSign, TrendingUp, TrendingDown, CreditCard,
  AlertTriangle, RefreshCw, Store, ArrowUpRight, ArrowDownRight,
} from "lucide-react";

const CHART_COLORS = [
  "#6366f1", "#06b6d4", "#10b981", "#f59e0b", "#f43f5e",
  "#8b5cf6", "#14b8a6", "#84cc16", "#ec4899", "#f97316",
];

type Balance = {
  accountId: number;
  accountName: string;
  accountType: string;
  accountGroup: string;
  currency: string;
  balance: number;
};

type IncomeExpense = { month: string; type: string; total: number };
type CategorySpend = {
  categoryId: number;
  categoryName: string;
  categoryGroup: string;
  total: number;
};
type NetWorthPoint = { month: string; currency: string; cumulative: number };

type DashboardData = {
  balances: Balance[];
  incomeVsExpenses: IncomeExpense[];
  spendingByCategory: CategorySpend[];
  netWorthOverTime: NetWorthPoint[];
};

function CustomTooltip({ active, payload, label, currency = "CAD" }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string; currency?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border bg-card/95 backdrop-blur-sm px-3 py-2 shadow-lg">
      <p className="text-xs font-medium text-muted-foreground mb-1">{label}</p>
      {payload.map((entry, i) => (
        <div key={i} className="flex items-center gap-2 text-sm">
          <div className="h-2 w-2 rounded-full" style={{ background: entry.color }} />
          <span className="text-muted-foreground">{entry.name}:</span>
          <span className="font-semibold">{formatCurrency(entry.value, currency)}</span>
        </div>
      ))}
    </div>
  );
}

function PieTooltip({ active, payload, currency = "CAD" }: { active?: boolean; payload?: { name: string; value: number; payload: { name: string } }[]; currency?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border bg-card/95 backdrop-blur-sm px-3 py-2 shadow-lg">
      <p className="text-xs font-semibold mb-0.5">{payload[0].payload.name}</p>
      <p className="text-sm font-bold">{formatCurrency(payload[0].value, currency)}</p>
    </div>
  );
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);

  useEffect(() => {
    fetch("/api/dashboard")
      .then((r) => r.json())
      .then(setData);
  }, []);

  if (!data) return (
    <div className="space-y-6">
      <div className="h-8 w-48 bg-muted animate-pulse rounded-lg" />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => <div key={i} className="h-28 bg-muted animate-pulse rounded-xl" />)}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {[1, 2].map((i) => <div key={i} className="h-80 bg-muted animate-pulse rounded-xl" />)}
      </div>
    </div>
  );

  const cadAssets = data.balances.filter((b) => b.accountType === "A" && b.currency === "CAD").reduce((s, b) => s + b.balance, 0);
  const cadLiabilities = data.balances.filter((b) => b.accountType === "L" && b.currency === "CAD").reduce((s, b) => s + b.balance, 0);
  const usdAssets = data.balances.filter((b) => b.accountType === "A" && b.currency === "USD").reduce((s, b) => s + b.balance, 0);
  const usdLiabilities = data.balances.filter((b) => b.accountType === "L" && b.currency === "USD").reduce((s, b) => s + b.balance, 0);

  const monthMap = new Map<string, { month: string; income: number; expenses: number }>();
  data.incomeVsExpenses.forEach((row) => {
    const entry = monthMap.get(row.month) ?? { month: row.month, income: 0, expenses: 0 };
    if (row.type === "I") entry.income = row.total;
    if (row.type === "E") entry.expenses = Math.abs(row.total);
    monthMap.set(row.month, entry);
  });
  const incExpData = Array.from(monthMap.values()).slice(-12);

  const spendingData = data.spendingByCategory
    .map((c) => ({ name: c.categoryName ?? "Uncategorized", value: Math.abs(c.total) }))
    .slice(0, 8);
  const spendingTotal = spendingData.reduce((s, d) => s + d.value, 0);

  const nwMap = new Map<string, number>();
  let runningCAD = 0;
  data.netWorthOverTime
    .filter((p) => p.currency === "CAD")
    .forEach((p) => {
      runningCAD += p.cumulative;
      nwMap.set(p.month, runningCAD);
    });
  const netWorthData = Array.from(nwMap.entries())
    .map(([month, value]) => ({ month, value }))
    .slice(-24);

  const topAccounts = [...data.balances]
    .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance))
    .slice(0, 8);

  const lastMonthIncome = incExpData.length > 0 ? incExpData[incExpData.length - 1].income : 0;
  const lastMonthExpenses = incExpData.length > 0 ? incExpData[incExpData.length - 1].expenses : 0;

  const summaryCards = [
    {
      label: "Net Worth (CAD)",
      value: formatCurrency(cadAssets + cadLiabilities, "CAD"),
      sub: `Assets ${formatCurrency(cadAssets, "CAD")}`,
      icon: DollarSign,
      iconBg: "bg-indigo-100 text-indigo-600",
      trend: null,
    },
    {
      label: "Net Worth (USD)",
      value: formatCurrency(usdAssets + usdLiabilities, "USD"),
      sub: `Assets ${formatCurrency(usdAssets, "USD")}`,
      icon: DollarSign,
      iconBg: "bg-violet-100 text-violet-600",
      trend: null,
    },
    {
      label: "Monthly Income",
      value: formatCurrency(lastMonthIncome, "CAD"),
      sub: `${data.balances.filter((b) => b.accountType === "A").length} asset accounts`,
      icon: TrendingUp,
      iconBg: "bg-emerald-100 text-emerald-600",
      trend: "up" as const,
    },
    {
      label: "Monthly Expenses",
      value: formatCurrency(lastMonthExpenses, "CAD"),
      sub: lastMonthIncome > 0 ? `${Math.round((lastMonthExpenses / lastMonthIncome) * 100)}% of income` : "",
      icon: CreditCard,
      iconBg: "bg-rose-100 text-rose-600",
      trend: "down" as const,
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Your financial overview at a glance</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {summaryCards.map((card) => (
          <Card key={card.label} className="relative overflow-hidden">
            <CardContent className="pt-5">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">{card.label}</p>
                  <p className="text-2xl font-bold tracking-tight">{card.value}</p>
                  <p className="text-xs text-muted-foreground">{card.sub}</p>
                </div>
                <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${card.iconBg}`}>
                  <card.icon className="h-5 w-5" />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Income vs Expenses */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Income vs Expenses</CardTitle>
            <p className="text-xs text-muted-foreground">Last 12 months comparison</p>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={incExpData} barGap={4}>
                <XAxis dataKey="month" fontSize={11} tickLine={false} axisLine={false} tick={{ fill: 'var(--color-muted-foreground)' }} />
                <YAxis fontSize={11} tickLine={false} axisLine={false} tick={{ fill: 'var(--color-muted-foreground)' }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                <Tooltip content={<CustomTooltip />} cursor={{ fill: 'var(--color-muted)', opacity: 0.4 }} />
                <Bar dataKey="income" fill="#10b981" name="Income" radius={[4, 4, 0, 0]} />
                <Bar dataKey="expenses" fill="#f43f5e" name="Expenses" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
            <div className="flex items-center justify-center gap-6 mt-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <div className="h-2.5 w-2.5 rounded-sm bg-emerald-500" /> Income
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <div className="h-2.5 w-2.5 rounded-sm bg-rose-500" /> Expenses
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Spending by Category */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Spending by Category</CardTitle>
            <p className="text-xs text-muted-foreground">Current month breakdown</p>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-4">
              <div className="w-48 h-48 shrink-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={spendingData}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={45}
                      outerRadius={75}
                      strokeWidth={2}
                      stroke="var(--color-card)"
                    >
                      {spendingData.map((_, i) => (
                        <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip content={<PieTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="flex-1 space-y-1.5 min-w-0">
                {spendingData.slice(0, 6).map((cat, i) => (
                  <div key={cat.name} className="flex items-center gap-2 text-sm">
                    <div className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: CHART_COLORS[i] }} />
                    <span className="truncate text-xs text-muted-foreground flex-1">{cat.name}</span>
                    <span className="text-xs font-medium tabular-nums">{spendingTotal > 0 ? Math.round((cat.value / spendingTotal) * 100) : 0}%</span>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Net Worth Over Time */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Net Worth Over Time</CardTitle>
          <p className="text-xs text-muted-foreground">CAD cumulative trend</p>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={netWorthData}>
              <defs>
                <linearGradient id="nwGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#6366f1" stopOpacity={0.2} />
                  <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="month" fontSize={11} tickLine={false} axisLine={false} tick={{ fill: 'var(--color-muted-foreground)' }} />
              <YAxis fontSize={11} tickLine={false} axisLine={false} tick={{ fill: 'var(--color-muted-foreground)' }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="value" stroke="#6366f1" strokeWidth={2.5} fill="url(#nwGradient)" name="Net Worth" />
            </AreaChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Top Accounts */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Top Accounts</CardTitle>
          <p className="text-xs text-muted-foreground">Sorted by balance</p>
        </CardHeader>
        <CardContent>
          <div className="space-y-1">
            {topAccounts.map((a) => (
              <div key={a.accountId} className="flex items-center justify-between py-2.5 px-3 rounded-lg hover:bg-muted/50 transition-colors">
                <div className="flex items-center gap-3">
                  <div className={`h-8 w-8 rounded-lg flex items-center justify-center text-xs font-bold ${a.accountType === "A" ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
                    {a.accountName.charAt(0)}
                  </div>
                  <div>
                    <p className="font-medium text-sm">{a.accountName}</p>
                    <p className="text-xs text-muted-foreground">{a.accountGroup}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className={`font-mono text-sm font-semibold ${a.balance >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                    {formatCurrency(a.balance, a.currency)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">{a.currency}</p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Spending Insights & Recurring */}
      <InsightsSection />
    </div>
  );
}

function InsightsSection() {
  const [insights, setInsights] = useState<{
    anomalies: { category: string; currentMonth: number; average: number; percentAbove: number; severity: string }[];
    trends: { category: string; trend: string; changePercent: number }[];
    topMerchants: { payee: string; totalSpent: number; count: number }[];
    spendingByDay: { day: string; total: number; count: number }[];
  } | null>(null);
  const [recurring, setRecurring] = useState<{
    recurring: { payee: string; avgAmount: number; frequency: string; nextDate: string }[];
    monthlyRecurringTotal: number;
    count: number;
  } | null>(null);

  useEffect(() => {
    fetch("/api/insights").then((r) => r.json()).then(setInsights);
    fetch("/api/recurring").then((r) => r.json()).then(setRecurring);
  }, []);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Anomalies */}
      {insights && insights.anomalies.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-100 text-amber-600">
                <AlertTriangle className="h-4 w-4" />
              </div>
              <div>
                <CardTitle className="text-base">Spending Alerts</CardTitle>
                <p className="text-xs text-muted-foreground">Categories above average</p>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {insights.anomalies.slice(0, 5).map((a, i) => (
                <div key={i} className="flex items-center justify-between p-2.5 rounded-lg bg-amber-50 border border-amber-100">
                  <div>
                    <p className="text-sm font-medium">{a.category}</p>
                    <p className="text-xs text-muted-foreground">{a.percentAbove}% above average</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-mono font-semibold text-amber-700">{formatCurrency(a.currentMonth, "CAD")}</p>
                    <p className="text-xs text-muted-foreground">avg {formatCurrency(a.average, "CAD")}</p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recurring Transactions */}
      {recurring && recurring.count > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-100 text-cyan-600">
                <RefreshCw className="h-4 w-4" />
              </div>
              <div>
                <CardTitle className="text-base">Recurring ({recurring.count})</CardTitle>
                <p className="text-xs text-muted-foreground">{formatCurrency(recurring.monthlyRecurringTotal, "CAD")}/month</p>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {recurring.recurring.slice(0, 8).map((r, i) => (
                <div key={i} className="flex items-center justify-between py-2 px-2 rounded-lg hover:bg-muted/50 transition-colors">
                  <div>
                    <p className="text-sm font-medium">{r.payee}</p>
                    <p className="text-xs text-muted-foreground">{r.frequency} &middot; next: {r.nextDate}</p>
                  </div>
                  <p className={`text-sm font-mono font-semibold ${r.avgAmount < 0 ? "text-rose-600" : "text-emerald-600"}`}>
                    {formatCurrency(r.avgAmount, "CAD")}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Top Merchants */}
      {insights && insights.topMerchants.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-100 text-violet-600">
                <Store className="h-4 w-4" />
              </div>
              <div>
                <CardTitle className="text-base">Top Merchants</CardTitle>
                <p className="text-xs text-muted-foreground">Last 6 months spending</p>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {insights.topMerchants.slice(0, 8).map((m, i) => (
                <div key={i} className="flex items-center justify-between py-2 px-2 rounded-lg hover:bg-muted/50 transition-colors">
                  <div>
                    <p className="text-sm font-medium">{m.payee}</p>
                    <p className="text-xs text-muted-foreground">{m.count} transactions</p>
                  </div>
                  <p className="text-sm font-mono font-semibold text-rose-600">{formatCurrency(m.totalSpent, "CAD")}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Spending Trends */}
      {insights && insights.trends.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-100 text-indigo-600">
                <TrendingUp className="h-4 w-4" />
              </div>
              <div>
                <CardTitle className="text-base">Category Trends</CardTitle>
                <p className="text-xs text-muted-foreground">Spending direction by category</p>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {insights.trends.slice(0, 8).map((t, i) => (
                <div key={i} className="flex items-center justify-between py-2 px-2 rounded-lg hover:bg-muted/50 transition-colors">
                  <p className="text-sm">{t.category}</p>
                  <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full ${
                    t.trend === "rising"
                      ? "bg-rose-100 text-rose-700"
                      : t.trend === "declining"
                        ? "bg-emerald-100 text-emerald-700"
                        : "bg-slate-100 text-slate-700"
                  }`}>
                    {t.trend === "rising" ? <ArrowUpRight className="h-3 w-3" /> : t.trend === "declining" ? <ArrowDownRight className="h-3 w-3" /> : null}
                    {t.trend === "rising" ? "+" : ""}{t.changePercent}%
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
