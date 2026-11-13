"use client";

/**
 * Category view — one category's spending (or income) over time.
 *
 * Bars month by month (6 / 12 / 24 months or all time) or calendar year by
 * year (3 / 5 / 10 years or all time; added 2026-11-13 from in-app feedback),
 * with the average and budget, comparisons with the previous period and the
 * same point a year ago, share of all spending, top payees and recent
 * transactions. Data: GET /api/reports/category (math in
 * lib/reports/category-detail.ts). Reached from the Reports category tables and
 * the Budgets page; the switcher in the header moves between categories and
 * keeps the chosen view.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Combobox, type ComboboxItemShape } from "@/components/ui/combobox";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ErrorState } from "@/components/error-state";
import { PageSkeleton } from "@/components/page-skeleton";
import { useDropdownOrder } from "@/components/dropdown-order-provider";
import { formatCurrency, formatDate } from "@/lib/currency";
import { formatCompactNumber } from "@/lib/utils/number";
import { CHART_COLORS } from "@/lib/chart-colors";
import { buildTxDrillUrl } from "@/lib/transactions/drill-url";
import { todayISO } from "@/lib/utils/date";
import {
  CATEGORY_WINDOWS,
  CATEGORY_YEAR_WINDOWS,
  type CategoryDetail,
  type CategoryRange,
  type CategoryYearlyDetail,
} from "@/lib/reports/category-detail";
import { ArrowLeft, ArrowDownRight, ArrowUpRight, Receipt, Store } from "lucide-react";

type CategoryInfo = { id: number; name: string | null; type: "E" | "I" | "R"; group: string };
type Common = { category: CategoryInfo; displayCurrency: string; payeesLocked: boolean; range: CategoryRange };
type MonthlyResponse = CategoryDetail & Common & { period: "month"; windowMonths: number };
type YearlyResponse = CategoryYearlyDetail & Common & { period: "year"; windowYears: number };
type CategoryResponse = MonthlyResponse | YearlyResponse;

type Period = "month" | "year";
type CategoryOption = { id: number; name: string | null; type: string };

/** One bar, whichever the grouping. */
type ChartRow = { key: string; label: string; title: string; amount: number; count: number; budget: number | null; partial: boolean };

const DEFAULT_RANGE: Record<Period, CategoryRange> = { month: 12, year: "all" };

function monthLabel(key: string, style: "short" | "long" = "short"): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
    month: style === "short" ? "short" : "long",
    year: style === "short" ? "2-digit" : "numeric",
    timeZone: "UTC",
  });
}

function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(n * 100 < 10 ? 1 : 0)}%`;
}

/** "+12% vs average" style comparison; null when there's no baseline. */
function changeVs(value: number, base: number | null): { text: string; up: boolean } | null {
  if (base == null || base === 0) return null;
  const change = (value - base) / Math.abs(base);
  return { text: `${change >= 0 ? "+" : ""}${Math.round(change * 100)}%`, up: change >= 0 };
}

/** Parse the range for a period from the URL; anything unknown is the default. */
function parseRange(period: Period, raw: string | null): CategoryRange {
  if (raw === "all") return "all";
  const n = Number(raw);
  const allowed: readonly number[] = period === "year" ? CATEGORY_YEAR_WINDOWS : CATEGORY_WINDOWS;
  return allowed.includes(n) ? n : DEFAULT_RANGE[period];
}

/** The page's query string for a view; defaults are left out. */
function viewQuery(period: Period, range: CategoryRange): string {
  if (period === "year") return range === "all" ? "?period=year" : `?period=year&years=${range}`;
  return range === 12 ? "" : `?months=${range}`;
}

/** "last 12 months", "last 5 years", "all time". */
function rangeLabel(period: Period, range: CategoryRange): string {
  if (range === "all") return "all time";
  return period === "year" ? `last ${range} years` : `last ${range} months`;
}

export default function CategoryPage() {
  return (
    <Suspense fallback={<PageSkeleton variant="list" rows={4} />}>
      <CategoryPageContent />
    </Suspense>
  );
}

function CategoryPageContent() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const categoryId = Number(params.id);
  const period: Period = searchParams.get("period") === "year" ? "year" : "month";
  const range = parseRange(period, searchParams.get(period === "year" ? "years" : "months"));

  const [data, setData] = useState<CategoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<"not_found" | "failed" | null>(null);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const sortCategory = useDropdownOrder("category");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = period === "year" ? `period=year&years=${range}` : `months=${range}`;
      const res = await fetch(`/api/reports/category?categoryId=${categoryId}&${q}`);
      if (res.status === 404 || res.status === 400) {
        setError("not_found");
        return;
      }
      if (!res.ok) throw new Error("load failed");
      const json = await res.json();
      setData(json.data as CategoryResponse);
    } catch {
      setError("failed");
    } finally {
      setLoading(false);
    }
  }, [categoryId, period, range]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    fetch("/api/categories")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => setCategories(Array.isArray(rows) ? rows : []))
      .catch(() => {});
  }, []);

  const switcherItems = useMemo(
    () =>
      sortCategory(
        categories
          .filter((c) => c.type === "E" || c.type === "I")
          .map((c): ComboboxItemShape => ({ value: String(c.id), label: c.name ?? `Category #${c.id}` })),
        (c) => Number(c.value),
        (a, z) => (a.label ?? "").localeCompare(z.label ?? ""),
      ),
    [categories, sortCategory],
  );

  function setView(nextPeriod: Period, nextRange: CategoryRange) {
    router.replace(`/categories/${categoryId}${viewQuery(nextPeriod, nextRange)}`, { scroll: false });
  }
  function setPeriod(next: Period) {
    if (next === period) return;
    // All time stays all time; otherwise each grouping opens on its default.
    setView(next, range === "all" ? "all" : DEFAULT_RANGE[next]);
  }

  // Only render data for the view that was asked for, so switching the grouping
  // shows the skeleton instead of the old shape for a moment.
  const shown = data && data.period === period ? data : null;
  if (loading && !shown) return <PageSkeleton variant="list" rows={4} />;
  if (error === "not_found") {
    return <ErrorState title="Category not found" message="This category doesn't exist or isn't yours." />;
  }
  if (error || !shown) {
    return <ErrorState title="Couldn't load this category" message="Please try again." onRetry={load} />;
  }

  const { category, displayCurrency: cur } = shown;
  const isIncome = category.type === "I";
  const noun = isIncome ? "income" : "spending";
  const barColor = isIncome ? CHART_COLORS.positive : CHART_COLORS.negative;
  const today = todayISO();
  const span = rangeLabel(period, shown.range);
  const unit = period === "year" ? "year" : "month";

  const rows: ChartRow[] =
    shown.period === "year"
      ? shown.years.map((y) => ({ key: y.year, label: y.year, title: y.year, amount: y.amount, count: y.count, budget: y.budget, partial: y.partial }))
      : shown.months.map((m) => ({ key: m.month, label: monthLabel(m.month), title: monthLabel(m.month, "long"), amount: m.amount, count: m.count, budget: m.budget, partial: m.partial }));
  const windowStart =
    shown.period === "year"
      ? `${shown.years[0]?.year ?? today.slice(0, 4)}-01-01`
      : `${shown.months[0]?.month ?? today.slice(0, 7)}-01`;
  const average =shown.period === "year" ? shown.stats.averageYearly : shown.stats.averageMonthly;
  const highest =
    shown.period === "year"
      ? shown.stats.highestYear && { label: shown.stats.highestYear.year, amount: shown.stats.highestYear.amount }
      : shown.stats.highestMonth && { label: monthLabel(shown.stats.highestMonth.month, "long"), amount: shown.stats.highestMonth.amount };
  const { total, transactionCount, averageTransaction } = shown.stats;
  const hasData = transactionCount > 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/categories${category.type === "I" ? "?type=I" : ""}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-3.5 w-3.5" /> Categories
          </Link>
          <h1 className="text-2xl font-bold mt-1 truncate">{category.name ?? "Category"}</h1>
          <div className="flex flex-wrap items-center gap-1.5 mt-1">
            <Badge variant="outline">{isIncome ? "Income" : category.type === "R" ? "Transfer" : "Expense"}</Badge>
            {category.group && <Badge variant="secondary">{category.group}</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {switcherItems.length > 0 && (
            <Combobox
              value={String(categoryId)}
              onValueChange={(v) => {
                if (v && v !== String(categoryId)) router.push(`/categories/${v}${viewQuery(period, range)}`);
              }}
              items={switcherItems}
              placeholder="Switch category"
              searchPlaceholder="Search categories…"
              emptyMessage="No matches"
              className="w-56"
            />
          )}
          <Tabs value={period} onValueChange={(v) => setPeriod(v === "year" ? "year" : "month")}>
            <TabsList>
              <TabsTrigger value="month" className="px-3">Monthly</TabsTrigger>
              <TabsTrigger value="year" className="px-3">Yearly</TabsTrigger>
            </TabsList>
          </Tabs>
          <Tabs value={String(range)} onValueChange={(v) => setView(period, parseRange(period, v))}>
            <TabsList>
              {(period === "year" ? CATEGORY_YEAR_WINDOWS : CATEGORY_WINDOWS).map((n) => (
                <TabsTrigger key={n} value={String(n)} className="px-3">{n}{period === "year" ? "Y" : "M"}</TabsTrigger>
              ))}
              <TabsTrigger value="all" className="px-3">All</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>

      {/* Stat tiles */}
      {shown.period === "year" ? (
        <YearlyTiles data={shown} cur={cur} noun={noun} span={span} isIncome={isIncome} />
      ) : (
        <MonthlyTiles data={shown} cur={cur} noun={noun} span={span} isIncome={isIncome} />
      )}

      {!hasData ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="font-semibold">
              {shown.range === "all" ? "No transactions in this category yet" : `No transactions in this category in the ${span}`}
            </p>
            <p className="text-sm text-muted-foreground mt-1">Try a longer range, or pick another category above.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Chart */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{period === "year" ? "Yearly" : "Monthly"} {noun}</CardTitle>
              <CardDescription>
                {shown.range === "all" ? "All time" : period === "year" ? `Last ${shown.range} years` : `Last ${shown.range} months`} in {cur}
                {average != null && ` · average ${formatCurrency(average, cur)}`}
                {shown.hasBudget && ` · budget in amber`}
                {` · this ${unit} is still running`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -6 }}>
                  <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="3 3" />
                  <XAxis dataKey="label" fontSize={11} tickLine={false} axisLine={false} tick={{ fill: "var(--color-muted-foreground)" }} interval="preserveStartEnd" />
                  <YAxis fontSize={11} tickLine={false} axisLine={false} tick={{ fill: "var(--color-muted-foreground)" }} tickFormatter={(v) => formatCompactNumber(Number(v))} />
                  <Tooltip
                    cursor={{ fill: "var(--color-muted)", opacity: 0.4 }}
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const r = payload[0].payload as ChartRow;
                      return (
                        <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
                          <p className="font-semibold">{r.title}{r.partial ? " (so far)" : ""}</p>
                          <p className="tabular-nums">{formatCurrency(r.amount, cur)} · {r.count} transaction{r.count === 1 ? "" : "s"}</p>
                          {r.budget != null && <p className="text-muted-foreground tabular-nums">Budget {formatCurrency(r.budget, cur)}</p>}
                        </div>
                      );
                    }}
                  />
                  <Bar dataKey="amount" radius={[4, 4, 0, 0]} maxBarSize={period === "year" ? 64 : 44} isAnimationActive={false}>
                    {rows.map((r) => (
                      <Cell key={r.key} fill={barColor} fillOpacity={r.partial ? 0.45 : 0.85} />
                    ))}
                  </Bar>
                  {shown.hasBudget && (
                    <Line
                      type="stepAfter"
                      dataKey="budget"
                      stroke={CHART_COLORS.categories[1]}
                      strokeWidth={2}
                      strokeDasharray="5 4"
                      // Dots too: a budget set for a single period is one point, which a line alone never draws.
                      dot={{ r: 3, fill: CHART_COLORS.categories[1], strokeWidth: 0 }}
                      connectNulls
                      isAnimationActive={false}
                    />
                  )}
                  {average != null && (
                    <ReferenceLine y={average} stroke="var(--color-muted-foreground)" strokeDasharray="4 4" />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Top payees */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2"><Store className="h-4 w-4" /> Top payees</CardTitle>
                <CardDescription>Where this {noun} went, {span}</CardDescription>
              </CardHeader>
              <CardContent>
                {shown.payeesLocked ? (
                  <p className="text-sm text-muted-foreground">Unlock your data to see payees.</p>
                ) : shown.topPayees.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No payees recorded.</p>
                ) : (
                  <ul className="space-y-3">
                    {shown.topPayees.map((p) => (
                      <li key={p.payee}>
                        <Link
                          href={buildTxDrillUrl({ categoryId: String(categoryId), search: p.payee === "(no payee)" ? "" : p.payee, startDate: windowStart, endDate: today })}
                          className="group block"
                          title={`View ${p.payee} transactions`}
                        >
                          <div className="flex items-baseline justify-between gap-3 text-sm">
                            <span className="truncate group-hover:underline">{p.payee}</span>
                            <span className="shrink-0 tabular-nums font-medium">
                              {formatCurrency(p.amount, cur)}
                              <span className="text-xs text-muted-foreground font-normal"> · {p.count}×</span>
                            </span>
                          </div>
                          <div className="mt-1 h-1.5 rounded-full bg-muted overflow-hidden">
                            <div className="h-full rounded-full" style={{ width: `${Math.max(2, Math.min(100, p.share * 100))}%`, backgroundColor: barColor, opacity: 0.8 }} />
                          </div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            {/* Recent transactions */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2"><Receipt className="h-4 w-4" /> Recent transactions</CardTitle>
                <CardDescription>
                  {transactionCount} {shown.range === "all" ? "in total" : `in the ${span}`}
                  {averageTransaction != null && ` · average ${formatCurrency(averageTransaction, cur)}`}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="divide-y">
                  {shown.recent.map((t) => (
                    <li key={t.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <div className="min-w-0">
                        <Link href={buildTxDrillUrl({ id: String(t.id) })} className="truncate block hover:underline">
                          {t.payee || "(no payee)"}
                        </Link>
                        <p className="text-xs text-muted-foreground truncate">
                          {formatDate(t.date)}{t.accountName ? ` · ${t.accountName}` : ""}
                        </p>
                      </div>
                      <span className={`shrink-0 tabular-nums font-medium ${t.amount < 0 ? "text-rose-600" : "text-emerald-600"}`}>
                        {formatCurrency(t.amount, t.currency)}
                      </span>
                    </li>
                  ))}
                </ul>
                <Link
                  href={buildTxDrillUrl({ categoryId: String(categoryId), startDate: windowStart, endDate: today })}
                  className="inline-block mt-3 text-sm font-medium text-primary hover:underline"
                >
                  View all {transactionCount} transactions
                </Link>
              </CardContent>
            </Card>
          </div>

          <p className="text-xs text-muted-foreground">
            {span.charAt(0).toUpperCase() + span.slice(1)}: {formatCurrency(total, cur)} in total
            {highest && ` · highest ${unit} ${highest.label} (${formatCurrency(highest.amount, cur)})`}
            . Amounts are in {cur}, converted at each transaction&apos;s historical rate.
          </p>
        </>
      )}
    </div>
  );
}

function MonthlyTiles({ data, cur, noun, span, isIncome }: { data: MonthlyResponse; cur: string; noun: string; span: string; isIncome: boolean }) {
  const { stats } = data;
  const currentMonth = data.months[data.months.length - 1];
  const lastVsAvg = changeVs(stats.lastMonth, stats.averageMonthly);
  return (
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
      <StatTile
        label="This month so far"
        value={formatCurrency(stats.thisMonth, cur)}
        sub={
          currentMonth?.budget != null
            ? `of ${formatCurrency(currentMonth.budget, cur)} budget`
            : `${currentMonth?.count ?? 0} transaction${currentMonth?.count === 1 ? "" : "s"}`
        }
      />
      <StatTile
        label={`Last month (${monthLabel(data.months[data.months.length - 2]?.month ?? "", "short")})`}
        value={formatCurrency(stats.lastMonth, cur)}
        sub={lastVsAvg ? `${lastVsAvg.text} vs average` : undefined}
        trend={lastVsAvg ? (lastVsAvg.up ? "up" : "down") : undefined}
        goodWhenUp={isIncome}
      />
      <StatTile
        label="Monthly average"
        value={stats.averageMonthly != null ? formatCurrency(stats.averageMonthly, cur) : "—"}
        sub={stats.medianMonthly != null ? `median ${formatCurrency(stats.medianMonthly, cur)}` : "needs a full month"}
      />
      <StatTile
        label={`${monthLabel(currentMonth?.month ?? "", "long").split(" ")[0]} last year`}
        value={formatCurrency(stats.sameMonthLastYear, cur)}
        sub="same month, a year ago"
      />
      <StatTile label={`Share of ${noun}`} value={pct(stats.shareOfType)} sub={`of all ${noun}, ${span}`} />
    </div>
  );
}

function YearlyTiles({ data, cur, noun, span, isIncome }: { data: YearlyResponse; cur: string; noun: string; span: string; isIncome: boolean }) {
  const { stats } = data;
  const currentYear = data.years[data.years.length - 1];
  const lastYear = String(Number(currentYear?.year ?? new Date().getFullYear()) - 1);
  const lastVsAvg = changeVs(stats.lastYear, stats.averageYearly);
  const thisVsSame = changeVs(stats.thisYear, stats.samePeriodLastYear);
  const sameDay = `${lastYear}${todayISO().slice(4)}`;
  return (
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
      <StatTile
        label="This year so far"
        value={formatCurrency(stats.thisYear, cur)}
        sub={
          currentYear?.budget != null
            ? `of ${formatCurrency(currentYear.budget, cur)} budget`
            : `${currentYear?.count ?? 0} transaction${currentYear?.count === 1 ? "" : "s"}`
        }
      />
      <StatTile
        label={`Last year (${lastYear})`}
        value={formatCurrency(stats.lastYear, cur)}
        sub={lastVsAvg ? `${lastVsAvg.text} vs average` : undefined}
        trend={lastVsAvg ? (lastVsAvg.up ? "up" : "down") : undefined}
        goodWhenUp={isIncome}
      />
      <StatTile
        label="Yearly average"
        value={stats.averageYearly != null ? formatCurrency(stats.averageYearly, cur) : "—"}
        sub={stats.medianYearly != null ? `median ${formatCurrency(stats.medianYearly, cur)}` : "needs a full year"}
      />
      <StatTile
        label="Same point last year"
        value={formatCurrency(stats.samePeriodLastYear, cur)}
        sub={thisVsSame ? `this year ${thisVsSame.text}` : `1 Jan to ${formatDate(sameDay)}`}
        trend={thisVsSame ? (thisVsSame.up ? "up" : "down") : undefined}
        goodWhenUp={isIncome}
      />
      <StatTile label={`Share of ${noun}`} value={pct(stats.shareOfType)} sub={`of all ${noun}, ${span}`} />
    </div>
  );
}

function StatTile({
  label,
  value,
  sub,
  trend,
  goodWhenUp = false,
}: {
  label: string;
  value: string;
  sub?: string;
  trend?: "up" | "down";
  goodWhenUp?: boolean;
}) {
  const good = trend ? (trend === "up") === goodWhenUp : null;
  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <p className="text-xs text-muted-foreground truncate">{label}</p>
        <p className="text-xl font-bold mt-1 tabular-nums truncate">{value}</p>
        {sub && (
          <p className={`text-xs mt-0.5 flex items-center gap-0.5 ${good == null ? "text-muted-foreground" : good ? "text-emerald-600" : "text-rose-600"}`}>
            {trend === "up" && <ArrowUpRight className="h-3 w-3" />}
            {trend === "down" && <ArrowDownRight className="h-3 w-3" />}
            {sub}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
