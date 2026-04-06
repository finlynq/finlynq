"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { formatCurrency } from "@/lib/currency";
import { CHART_COLORS } from "@/lib/chart-colors";
import { useDevMode } from "@/hooks/use-dev-mode";
import { SankeyChart } from "@/components/sankey-chart";
import {
  Download,
  FileText,
  BarChart3,
  ArrowUpRight,
  ArrowDownRight,
  GitCompareArrows,
  Workflow,
  TrendingUp,
  TrendingDown,
  DollarSign,
  PiggyBank,
  ChevronRight,
  ChevronDown,
  Calendar,
  Layers,
} from "lucide-react";
import {
  BarChart,
  Bar,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

// ── Types ──

type Period = "daily" | "weekly" | "monthly" | "quarterly";
type GroupByOption = "category" | "group";

type TimeseriesPoint = {
  period: string;
  label: string;
  income: number;
  expenses: number;
  net: number;
};

type BreakdownItem = {
  name: string;
  group: string;
  total: number;
  count: number;
  periods: Record<string, number>;
};

type TrendsData = {
  period: Period;
  groupBy: GroupByOption;
  startDate: string;
  endDate: string;
  timeseries: TimeseriesPoint[];
  income: BreakdownItem[];
  expenses: BreakdownItem[];
  totalIncome: number;
  totalExpenses: number;
  netSavings: number;
  savingsRate: number;
};

type BalanceSheet = {
  date: string;
  assets: { accountGroup: string; accountName: string; currency: string; balance: number }[];
  liabilities: { accountGroup: string; accountName: string; currency: string; balance: number }[];
  totalAssets: number;
  totalLiabilities: number;
  netWorth: number;
};

type YoYData = {
  year1: number;
  year2: number;
  categories: { name: string; year1Amount: number; year2Amount: number; change: number }[];
  monthly: { month: string; year1Income: number; year1Expenses: number; year2Income: number; year2Expenses: number }[];
};

// ── Helpers ──

function getPresetRange(preset: string): { start: string; end: string } {
  const now = new Date();
  const end = now.toISOString().split("T")[0];
  const y = now.getFullYear();
  const m = now.getMonth();

  switch (preset) {
    case "mtd":
      return { start: `${y}-${String(m + 1).padStart(2, "0")}-01`, end };
    case "qtd": {
      const qStart = Math.floor(m / 3) * 3;
      return { start: `${y}-${String(qStart + 1).padStart(2, "0")}-01`, end };
    }
    case "ytd":
      return { start: `${y}-01-01`, end };
    case "last-month": {
      const lm = m === 0 ? 11 : m - 1;
      const ly = m === 0 ? y - 1 : y;
      const days = new Date(ly, lm + 1, 0).getDate();
      return {
        start: `${ly}-${String(lm + 1).padStart(2, "0")}-01`,
        end: `${ly}-${String(lm + 1).padStart(2, "0")}-${days}`,
      };
    }
    case "last-quarter": {
      const cq = Math.floor(m / 3);
      const lq = cq === 0 ? 3 : cq - 1;
      const lqy = cq === 0 ? y - 1 : y;
      const qsm = lq * 3;
      const qem = qsm + 2;
      const qed = new Date(lqy, qem + 1, 0).getDate();
      return {
        start: `${lqy}-${String(qsm + 1).padStart(2, "0")}-01`,
        end: `${lqy}-${String(qem + 1).padStart(2, "0")}-${qed}`,
      };
    }
    case "last-year":
      return { start: `${y - 1}-01-01`, end: `${y - 1}-12-31` };
    case "last-12":
    default: {
      const past = new Date(now);
      past.setFullYear(past.getFullYear() - 1);
      return { start: past.toISOString().split("T")[0], end };
    }
  }
}

// ── Component ──

export default function ReportsPage() {
  const currentYear = new Date().getFullYear();

  // Shared filters
  const [startDate, setStartDate] = useState(`${currentYear}-01-01`);
  const [endDate, setEndDate] = useState(new Date().toISOString().split("T")[0]);
  const [isBusiness, setIsBusiness] = useState(false);
  const [period, setPeriod] = useState<Period>("monthly");
  const [groupBy, setGroupBy] = useState<GroupByOption>("category");
  const [datePreset, setDatePreset] = useState<string>("ytd");

  // Data states
  const [trendsData, setTrendsData] = useState<TrendsData | null>(null);
  const [balanceSheet, setBalanceSheet] = useState<BalanceSheet | null>(null);
  const [yoyData, setYoyData] = useState<YoYData | null>(null);
  const [yoyYear1, setYoyYear1] = useState(currentYear - 1);
  const [yoyYear2, setYoyYear2] = useState(currentYear);

  // Expand/collapse groups
  const [expandedIncomeGroups, setExpandedIncomeGroups] = useState<Set<string>>(new Set());
  const [expandedExpenseGroups, setExpandedExpenseGroups] = useState<Set<string>>(new Set());

  // Active tab
  const [activeTab, setActiveTab] = useState("income");
  const devMode = useDevMode();

  // Preset handler
  const handlePreset = useCallback((preset: string) => {
    setDatePreset(preset);
    const { start, end } = getPresetRange(preset);
    setStartDate(start);
    setEndDate(end);
  }, []);

  // Fetch trends data
  useEffect(() => {
    const biz = isBusiness ? "&business=true" : "";
    fetch(`/api/reports/trends?startDate=${startDate}&endDate=${endDate}&period=${period}&groupBy=${groupBy}${biz}`)
      .then((r) => r.json())
      .then(setTrendsData);
  }, [startDate, endDate, period, groupBy, isBusiness]);

  // Fetch balance sheet
  useEffect(() => {
    fetch(`/api/reports?type=balance-sheet&endDate=${endDate}`)
      .then((r) => r.json())
      .then(setBalanceSheet);
  }, [endDate]);

  // Fetch YoY
  useEffect(() => {
    fetch(`/api/reports/yoy?year1=${yoyYear1}&year2=${yoyYear2}`)
      .then((r) => r.json())
      .then(setYoyData);
  }, [yoyYear1, yoyYear2]);

  // Sankey data
  const sankeyIncome = useMemo(() => {
    if (!trendsData) return [];
    return trendsData.income
      .filter((r) => r.total > 0)
      .sort((a, b) => b.total - a.total)
      .map((r) => ({ name: r.name, value: r.total }));
  }, [trendsData]);

  const sankeyExpenses = useMemo(() => {
    if (!trendsData) return [];
    return trendsData.expenses
      .filter((r) => r.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 10)
      .map((r) => ({ name: r.name, value: r.total }));
  }, [trendsData]);

  // Group items by category group for collapsible view
  const groupItems = useCallback((items: BreakdownItem[]) => {
    const groups = new Map<string, { items: BreakdownItem[]; total: number }>();
    for (const item of items) {
      const g = item.group || "Other";
      if (!groups.has(g)) groups.set(g, { items: [], total: 0 });
      const entry = groups.get(g)!;
      entry.items.push(item);
      entry.total += item.total;
    }
    return Array.from(groups.entries())
      .map(([name, data]) => ({ name, ...data }))
      .sort((a, b) => b.total - a.total);
  }, []);

  const toggleGroup = useCallback((type: "income" | "expense", group: string) => {
    const setter = type === "income" ? setExpandedIncomeGroups : setExpandedExpenseGroups;
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }, []);

  function exportCSV(data: Record<string, unknown>[], filename: string) {
    if (!data.length) return;
    const headers = Object.keys(data[0]);
    const csv = [headers.join(","), ...data.map((row) => headers.map((h) => String(row[h] ?? "")).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  const periodLabels: Record<Period, string> = {
    daily: "Daily",
    weekly: "Weekly",
    monthly: "Monthly",
    quarterly: "Quarterly",
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Financial Reports</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Analyze income, expenses, cash flow, and trends across any time period
        </p>
      </div>

      {/* ── Filters Bar ── */}
      <Card className="bg-muted/30 border-dashed">
        <CardContent className="pt-4 pb-4">
          <div className="flex items-end gap-3 flex-wrap">
            {/* Date presets */}
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Range</Label>
              <Select value={datePreset} onValueChange={(v) => handlePreset(v ?? "ytd")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mtd">Month to Date</SelectItem>
                  <SelectItem value="qtd">Quarter to Date</SelectItem>
                  <SelectItem value="ytd">Year to Date</SelectItem>
                  <SelectItem value="last-month">Last Month</SelectItem>
                  <SelectItem value="last-quarter">Last Quarter</SelectItem>
                  <SelectItem value="last-year">Last Year</SelectItem>
                  <SelectItem value="last-12">Last 12 Months</SelectItem>
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Custom dates */}
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Start</Label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  setDatePreset("custom");
                }}
                className="w-36"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">End</Label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => {
                  setEndDate(e.target.value);
                  setDatePreset("custom");
                }}
                className="w-36"
              />
            </div>

            <Separator orientation="vertical" className="h-8 mx-1" />

            {/* Period granularity */}
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">
                <Calendar className="inline h-3 w-3 mr-1" />
                Period
              </Label>
              <Select value={period} onValueChange={(v) => setPeriod((v ?? "monthly") as Period)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="quarterly">Quarterly</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Group by */}
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">
                <Layers className="inline h-3 w-3 mr-1" />
                Group By
              </Label>
              <Select value={groupBy} onValueChange={(v) => setGroupBy((v ?? "category") as GroupByOption)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="category">Category</SelectItem>
                  <SelectItem value="group">Category Group</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Separator orientation="vertical" className="h-8 mx-1" />

            <Button
              variant={isBusiness ? "default" : "outline"}
              size="sm"
              onClick={() => setIsBusiness(!isBusiness)}
              className="h-8"
            >
              {isBusiness ? "Business Only" : "All Transactions"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Summary Cards ── */}
      {trendsData && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className="card-hover">
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-2 mb-1">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400">
                  <TrendingUp className="h-3.5 w-3.5" />
                </div>
                <span className="text-xs text-muted-foreground font-medium">Total Income</span>
              </div>
              <p className="text-xl font-bold font-mono hero-number text-emerald-600 dark:text-emerald-400">
                {formatCurrency(trendsData.totalIncome, "CAD")}
              </p>
            </CardContent>
          </Card>
          <Card className="card-hover">
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-2 mb-1">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-rose-100 text-rose-600 dark:bg-rose-950 dark:text-rose-400">
                  <TrendingDown className="h-3.5 w-3.5" />
                </div>
                <span className="text-xs text-muted-foreground font-medium">Total Expenses</span>
              </div>
              <p className="text-xl font-bold font-mono hero-number text-rose-600 dark:text-rose-400">
                {formatCurrency(trendsData.totalExpenses, "CAD")}
              </p>
            </CardContent>
          </Card>
          <Card className="card-hover">
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-2 mb-1">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-100 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400">
                  <DollarSign className="h-3.5 w-3.5" />
                </div>
                <span className="text-xs text-muted-foreground font-medium">Net Savings</span>
              </div>
              <p className={`text-xl font-bold font-mono hero-number ${trendsData.netSavings >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                {formatCurrency(trendsData.netSavings, "CAD")}
              </p>
            </CardContent>
          </Card>
          <Card className="card-hover">
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-2 mb-1">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-100 text-violet-600 dark:bg-violet-950 dark:text-violet-400">
                  <PiggyBank className="h-3.5 w-3.5" />
                </div>
                <span className="text-xs text-muted-foreground font-medium">Savings Rate</span>
              </div>
              <p className={`text-xl font-bold font-mono hero-number ${trendsData.savingsRate >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                {trendsData.savingsRate}%
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Trend Chart ── */}
      {trendsData && trendsData.timeseries.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400">
                  <BarChart3 className="h-5 w-5" />
                </div>
                <div>
                  <CardTitle className="text-base">Income vs Expenses</CardTitle>
                  <CardDescription>{periodLabels[period]} trend &middot; {startDate} to {endDate}</CardDescription>
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trendsData.timeseries} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                  <defs>
                    <linearGradient id="incomeGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={CHART_COLORS.positive} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={CHART_COLORS.positive} stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="expenseGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={CHART_COLORS.negative} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={CHART_COLORS.negative} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis
                    dataKey="label"
                    className="text-xs fill-muted-foreground"
                    tick={{ fontSize: 11 }}
                    interval={period === "daily" ? Math.max(0, Math.floor(trendsData.timeseries.length / 12)) : 0}
                    angle={period === "daily" ? -45 : 0}
                    textAnchor={period === "daily" ? "end" : "middle"}
                    height={period === "daily" ? 60 : 30}
                  />
                  <YAxis
                    className="text-xs fill-muted-foreground"
                    tick={{ fontSize: 11 }}
                    tickFormatter={(v) => formatCurrency(Number(v), "CAD")}
                    width={90}
                  />
                  <Tooltip
                    formatter={(v) => formatCurrency(Number(v), "CAD")}
                    contentStyle={{ borderRadius: "8px", fontSize: "12px" }}
                    labelStyle={{ fontWeight: 600, marginBottom: 4 }}
                  />
                  <Legend wrapperStyle={{ fontSize: "12px" }} />
                  <Area
                    type="monotone"
                    dataKey="income"
                    name="Income"
                    stroke={CHART_COLORS.positive}
                    fill="url(#incomeGrad)"
                    strokeWidth={2}
                  />
                  <Area
                    type="monotone"
                    dataKey="expenses"
                    name="Expenses"
                    stroke={CHART_COLORS.negative}
                    fill="url(#expenseGrad)"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Tabs ── */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="income">
            <BarChart3 className="h-3.5 w-3.5 mr-1.5" /> Income Statement
          </TabsTrigger>
          <TabsTrigger value="balance">
            <FileText className="h-3.5 w-3.5 mr-1.5" /> Balance Sheet
          </TabsTrigger>
          {devMode && (
            <TabsTrigger value="cashflow">
              <Workflow className="h-3.5 w-3.5 mr-1.5" /> Cash Flow
            </TabsTrigger>
          )}
          {devMode && (
            <TabsTrigger value="yoy">
              <GitCompareArrows className="h-3.5 w-3.5 mr-1.5" /> Year over Year
            </TabsTrigger>
          )}
        </TabsList>

        {/* ============ Income Statement ============ */}
        <TabsContent value="income">
          {trendsData && (
            <div className="space-y-6">
              {/* Expense breakdown bar chart */}
              {trendsData.timeseries.length > 1 && (
                <Card>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <div>
                        <CardTitle className="text-base">{periodLabels[period]} Breakdown</CardTitle>
                        <CardDescription>Stacked income and expenses per {period === "daily" ? "day" : period === "weekly" ? "week" : period === "monthly" ? "month" : "quarter"}</CardDescription>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="h-72">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={trendsData.timeseries} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                          <XAxis
                            dataKey="label"
                            className="text-xs fill-muted-foreground"
                            tick={{ fontSize: 11 }}
                            interval={period === "daily" ? Math.max(0, Math.floor(trendsData.timeseries.length / 12)) : 0}
                            angle={period === "daily" ? -45 : 0}
                            textAnchor={period === "daily" ? "end" : "middle"}
                            height={period === "daily" ? 60 : 30}
                          />
                          <YAxis
                            className="text-xs fill-muted-foreground"
                            tick={{ fontSize: 11 }}
                            tickFormatter={(v) => formatCurrency(Number(v), "CAD")}
                            width={90}
                          />
                          <Tooltip
                            formatter={(v) => formatCurrency(Number(v), "CAD")}
                            contentStyle={{ borderRadius: "8px", fontSize: "12px" }}
                          />
                          <Legend wrapperStyle={{ fontSize: "12px" }} />
                          <Bar dataKey="income" name="Income" fill={CHART_COLORS.positive} radius={[3, 3, 0, 0]} />
                          <Bar dataKey="expenses" name="Expenses" fill={CHART_COLORS.negative} radius={[3, 3, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Income table with grouping */}
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400">
                        <ArrowUpRight className="h-5 w-5" />
                      </div>
                      <div>
                        <CardTitle className="text-base">Income</CardTitle>
                        <CardDescription>
                          {trendsData.income.length} {groupBy === "group" ? "groups" : "categories"} &middot; {formatCurrency(trendsData.totalIncome, "CAD")}
                        </CardDescription>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        exportCSV(
                          trendsData.income.map((i) => ({ group: i.group, name: i.name, total: i.total, transactions: i.count })),
                          "income-breakdown.csv"
                        )
                      }
                    >
                      <Download className="h-4 w-4 mr-1" /> Export
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  {groupBy === "category" ? (
                    <GroupedTable
                      groups={groupItems(trendsData.income)}
                      expanded={expandedIncomeGroups}
                      onToggle={(g) => toggleGroup("income", g)}
                      colorClass="text-emerald-600 dark:text-emerald-400"
                      total={trendsData.totalIncome}
                    />
                  ) : (
                    <FlatTable items={trendsData.income} colorClass="text-emerald-600 dark:text-emerald-400" />
                  )}
                  <div className="flex justify-between items-center p-3 mt-3 rounded-xl bg-muted/50">
                    <span className="font-semibold text-sm">Total Income</span>
                    <span className="font-bold font-mono text-emerald-600 dark:text-emerald-400">
                      {formatCurrency(trendsData.totalIncome, "CAD")}
                    </span>
                  </div>
                </CardContent>
              </Card>

              {/* Expenses table with grouping */}
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-rose-100 text-rose-600 dark:bg-rose-950 dark:text-rose-400">
                        <ArrowDownRight className="h-5 w-5" />
                      </div>
                      <div>
                        <CardTitle className="text-base">Expenses</CardTitle>
                        <CardDescription>
                          {trendsData.expenses.length} {groupBy === "group" ? "groups" : "categories"} &middot; {formatCurrency(trendsData.totalExpenses, "CAD")}
                        </CardDescription>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        exportCSV(
                          trendsData.expenses.map((e) => ({ group: e.group, name: e.name, total: e.total, transactions: e.count })),
                          "expense-breakdown.csv"
                        )
                      }
                    >
                      <Download className="h-4 w-4 mr-1" /> Export
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  {groupBy === "category" ? (
                    <GroupedTable
                      groups={groupItems(trendsData.expenses)}
                      expanded={expandedExpenseGroups}
                      onToggle={(g) => toggleGroup("expense", g)}
                      colorClass="text-rose-600 dark:text-rose-400"
                      total={trendsData.totalExpenses}
                    />
                  ) : (
                    <FlatTable items={trendsData.expenses} colorClass="text-rose-600 dark:text-rose-400" />
                  )}
                  <div className="flex justify-between items-center p-3 mt-3 rounded-xl bg-muted/50">
                    <span className="font-semibold text-sm">Total Expenses</span>
                    <span className="font-bold font-mono text-rose-600 dark:text-rose-400">
                      {formatCurrency(trendsData.totalExpenses, "CAD")}
                    </span>
                  </div>
                </CardContent>
              </Card>

              {/* Net summary */}
              <Card className="bg-muted/30">
                <CardContent className="pt-5 pb-5">
                  <div className="flex justify-between items-center">
                    <div>
                      <p className="text-lg font-bold">Net Savings</p>
                      <p className="text-sm text-muted-foreground">
                        Savings Rate: <span className="font-semibold">{trendsData.savingsRate}%</span>
                      </p>
                    </div>
                    <p
                      className={`text-2xl font-bold font-mono hero-number ${
                        trendsData.netSavings >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"
                      }`}
                    >
                      {formatCurrency(trendsData.netSavings, "CAD")}
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </TabsContent>

        {/* ============ Balance Sheet ============ */}
        <TabsContent value="balance">
          {balanceSheet && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-100 text-violet-600 dark:bg-violet-950 dark:text-violet-400">
                      <FileText className="h-5 w-5" />
                    </div>
                    <div>
                      <CardTitle className="text-base">Balance Sheet</CardTitle>
                      <p className="text-xs text-muted-foreground">As of {balanceSheet.date}</p>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      exportCSV(
                        [
                          ...balanceSheet.assets.map((a) => ({ ...a, type: "Asset" })),
                          ...balanceSheet.liabilities.map((l) => ({ ...l, type: "Liability" })),
                        ],
                        "balance-sheet.csv"
                      )
                    }
                  >
                    <Download className="h-4 w-4 mr-1" /> Export
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2 mb-3">
                  <ArrowUpRight className="h-4 w-4 text-emerald-600" />
                  <h3 className="font-semibold text-emerald-600 dark:text-emerald-400">Assets</h3>
                </div>
                <Table>
                  <TableBody>
                    {balanceSheet.assets.map((r, i) => (
                      <TableRow key={i} className="hover:bg-muted/30">
                        <TableCell className="text-muted-foreground text-xs">{r.accountGroup}</TableCell>
                        <TableCell className="text-sm">{r.accountName}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px]">
                            {r.currency}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm font-semibold">
                          {formatCurrency(r.balance, r.currency)}
                        </TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="font-bold border-t-2">
                      <TableCell colSpan={3}>Total Assets</TableCell>
                      <TableCell className="text-right font-mono text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(balanceSheet.totalAssets, "CAD")}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
                <Separator className="my-5" />
                <div className="flex items-center gap-2 mb-3">
                  <ArrowDownRight className="h-4 w-4 text-rose-600" />
                  <h3 className="font-semibold text-rose-600 dark:text-rose-400">Liabilities</h3>
                </div>
                <Table>
                  <TableBody>
                    {balanceSheet.liabilities.map((r, i) => (
                      <TableRow key={i} className="hover:bg-muted/30">
                        <TableCell className="text-muted-foreground text-xs">{r.accountGroup}</TableCell>
                        <TableCell className="text-sm">{r.accountName}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px]">
                            {r.currency}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm font-semibold">
                          {formatCurrency(r.balance, r.currency)}
                        </TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="font-bold border-t-2">
                      <TableCell colSpan={3}>Total Liabilities</TableCell>
                      <TableCell className="text-right font-mono text-rose-600 dark:text-rose-400">
                        {formatCurrency(balanceSheet.totalLiabilities, "CAD")}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
                <Separator className="my-5" />
                <div className="flex justify-between items-center p-4 rounded-xl bg-muted/50">
                  <p className="text-lg font-bold">Net Worth</p>
                  <p
                    className={`text-2xl font-bold font-mono hero-number ${
                      balanceSheet.netWorth >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"
                    }`}
                  >
                    {formatCurrency(balanceSheet.netWorth, "CAD")}
                  </p>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ============ Cash Flow (Sankey) — dev only ============ */}
        {devMode && (
          <TabsContent value="cashflow">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-100 text-cyan-600 dark:bg-cyan-950 dark:text-cyan-400">
                    <Workflow className="h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle className="text-base">Cash Flow Diagram</CardTitle>
                    <CardDescription>
                      How income flows into expense categories ({startDate} to {endDate})
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <SankeyChart incomeData={sankeyIncome} expenseData={sankeyExpenses} />
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {/* ============ Year over Year — dev only ============ */}
        {devMode && <TabsContent value="yoy">
          <div className="space-y-6">
            <Card className="bg-muted/30 border-dashed">
              <CardContent className="pt-4">
                <div className="flex items-end gap-4 flex-wrap">
                  <div>
                    <Label className="text-xs text-muted-foreground">Year 1</Label>
                    <Input
                      type="number"
                      value={yoyYear1}
                      onChange={(e) => setYoyYear1(parseInt(e.target.value, 10))}
                      className="mt-1 w-28"
                      min={2000}
                      max={currentYear}
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Year 2</Label>
                    <Input
                      type="number"
                      value={yoyYear2}
                      onChange={(e) => setYoyYear2(parseInt(e.target.value, 10))}
                      className="mt-1 w-28"
                      min={2000}
                      max={currentYear}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            {yoyData && (
              <>
                <Card>
                  <CardHeader>
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100 text-amber-600 dark:bg-amber-950 dark:text-amber-400">
                        <GitCompareArrows className="h-5 w-5" />
                      </div>
                      <div>
                        <CardTitle className="text-base">Monthly Spending Comparison</CardTitle>
                        <CardDescription>
                          {yoyData.year1} vs {yoyData.year2} expenses by month
                        </CardDescription>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="h-80">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={yoyData.monthly} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                          <XAxis dataKey="month" className="text-xs fill-muted-foreground" tick={{ fontSize: 12 }} />
                          <YAxis
                            className="text-xs fill-muted-foreground"
                            tick={{ fontSize: 12 }}
                            tickFormatter={(v) => formatCurrency(Number(v), "CAD")}
                          />
                          <Tooltip
                            formatter={(v) => formatCurrency(Number(v), "CAD")}
                            contentStyle={{ borderRadius: "8px", fontSize: "12px" }}
                          />
                          <Legend wrapperStyle={{ fontSize: "12px" }} />
                          <Bar
                            dataKey="year1Expenses"
                            name={`${yoyData.year1} Expenses`}
                            fill={CHART_COLORS.categories[0]}
                            radius={[3, 3, 0, 0]}
                          />
                          <Bar
                            dataKey="year2Expenses"
                            name={`${yoyData.year2} Expenses`}
                            fill={CHART_COLORS.categories[1]}
                            radius={[3, 3, 0, 0]}
                          />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Monthly Income Comparison</CardTitle>
                    <CardDescription>
                      {yoyData.year1} vs {yoyData.year2} income by month
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="h-80">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={yoyData.monthly} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                          <XAxis dataKey="month" className="text-xs fill-muted-foreground" tick={{ fontSize: 12 }} />
                          <YAxis
                            className="text-xs fill-muted-foreground"
                            tick={{ fontSize: 12 }}
                            tickFormatter={(v) => formatCurrency(Number(v), "CAD")}
                          />
                          <Tooltip
                            formatter={(v) => formatCurrency(Number(v), "CAD")}
                            contentStyle={{ borderRadius: "8px", fontSize: "12px" }}
                          />
                          <Legend wrapperStyle={{ fontSize: "12px" }} />
                          <Bar
                            dataKey="year1Income"
                            name={`${yoyData.year1} Income`}
                            fill={CHART_COLORS.positive}
                            radius={[3, 3, 0, 0]}
                          />
                          <Bar
                            dataKey="year2Income"
                            name={`${yoyData.year2} Income`}
                            fill={CHART_COLORS.categories[3]}
                            radius={[3, 3, 0, 0]}
                          />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Category Comparison</CardTitle>
                    <CardDescription>Expense categories year-over-year change</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Category</TableHead>
                          <TableHead className="text-right">{yoyData.year1}</TableHead>
                          <TableHead className="text-right">{yoyData.year2}</TableHead>
                          <TableHead className="text-right">Change</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {yoyData.categories.map((cat, i) => (
                          <TableRow key={i} className="hover:bg-muted/30">
                            <TableCell className="text-sm font-medium">{cat.name}</TableCell>
                            <TableCell className="text-right font-mono text-sm">
                              {formatCurrency(cat.year1Amount, "CAD")}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm">
                              {formatCurrency(cat.year2Amount, "CAD")}
                            </TableCell>
                            <TableCell className="text-right">
                              <Badge
                                variant="outline"
                                className={
                                  cat.change > 5
                                    ? "text-rose-600 border-rose-200 bg-rose-50 dark:bg-rose-950/50 dark:border-rose-800"
                                    : cat.change < -5
                                    ? "text-emerald-600 border-emerald-200 bg-emerald-50 dark:bg-emerald-950/50 dark:border-emerald-800"
                                    : "text-muted-foreground"
                                }
                              >
                                {cat.change > 0 ? "+" : ""}
                                {cat.change}%
                              </Badge>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              </>
            )}
          </div>
        </TabsContent>}
      </Tabs>
    </div>
  );
}

// ── Grouped Table (collapsible category groups) ──

function GroupedTable({
  groups,
  expanded,
  onToggle,
  colorClass,
  total,
}: {
  groups: { name: string; items: { name: string; group: string; total: number; count: number }[]; total: number }[];
  expanded: Set<string>;
  onToggle: (group: string) => void;
  colorClass: string;
  total: number;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8"></TableHead>
          <TableHead>Name</TableHead>
          <TableHead className="text-right">Transactions</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead className="text-right w-20">%</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((group) => {
          const isOpen = expanded.has(group.name);
          return (
            <GroupRow
              key={group.name}
              group={group}
              isOpen={isOpen}
              onToggle={() => onToggle(group.name)}
              colorClass={colorClass}
              total={total}
            />
          );
        })}
      </TableBody>
    </Table>
  );
}

function GroupRow({
  group,
  isOpen,
  onToggle,
  colorClass,
  total,
}: {
  group: { name: string; items: { name: string; total: number; count: number }[]; total: number };
  isOpen: boolean;
  onToggle: () => void;
  colorClass: string;
  total: number;
}) {
  const pct = total > 0 ? ((group.total / total) * 100).toFixed(1) : "0.0";
  return (
    <>
      <TableRow
        className="hover:bg-muted/30 cursor-pointer font-medium"
        onClick={onToggle}
      >
        <TableCell className="w-8 pr-0">
          {isOpen ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </TableCell>
        <TableCell className="text-sm font-semibold">{group.name}</TableCell>
        <TableCell className="text-right text-xs text-muted-foreground">
          {group.items.reduce((s, i) => s + i.count, 0)}
        </TableCell>
        <TableCell className={`text-right font-mono text-sm font-semibold ${colorClass}`}>
          {formatCurrency(group.total, "CAD")}
        </TableCell>
        <TableCell className="text-right text-xs text-muted-foreground">{pct}%</TableCell>
      </TableRow>
      {isOpen &&
        group.items
          .sort((a, b) => b.total - a.total)
          .map((item, i) => {
            const itemPct = total > 0 ? ((item.total / total) * 100).toFixed(1) : "0.0";
            return (
              <TableRow key={i} className="hover:bg-muted/20 bg-muted/10">
                <TableCell></TableCell>
                <TableCell className="text-sm pl-6 text-muted-foreground">{item.name}</TableCell>
                <TableCell className="text-right text-xs text-muted-foreground">{item.count}</TableCell>
                <TableCell className={`text-right font-mono text-sm ${colorClass}`}>
                  {formatCurrency(item.total, "CAD")}
                </TableCell>
                <TableCell className="text-right text-xs text-muted-foreground">{itemPct}%</TableCell>
              </TableRow>
            );
          })}
    </>
  );
}

// ── Flat Table ──

function FlatTable({
  items,
  colorClass,
}: {
  items: { name: string; group: string; total: number; count: number }[];
  colorClass: string;
}) {
  const total = items.reduce((s, i) => s + i.total, 0);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead className="text-right">Transactions</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead className="text-right w-20">%</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item, i) => {
          const pct = total > 0 ? ((item.total / total) * 100).toFixed(1) : "0.0";
          return (
            <TableRow key={i} className="hover:bg-muted/30">
              <TableCell className="text-sm">{item.name}</TableCell>
              <TableCell className="text-right text-xs text-muted-foreground">{item.count}</TableCell>
              <TableCell className={`text-right font-mono text-sm font-semibold ${colorClass}`}>
                {formatCurrency(item.total, "CAD")}
              </TableCell>
              <TableCell className="text-right text-xs text-muted-foreground">{pct}%</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
