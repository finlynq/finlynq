"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  TrendingUp, BarChart3, Coins, Briefcase, Plus, Flame, Snowflake,
} from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { useDevMode } from "@/hooks/use-dev-mode";
import { useDisplayCurrency } from "@/components/currency-provider";
import {
  HoldingEditForm,
  type HoldingEditFormHolding,
} from "@/components/holdings/holding-edit-form";
import { PerformanceChart } from "@/components/portfolio/PerformanceChart";
import { buttonVariants } from "@/components/ui/button";

import {
  ASSET_TYPE_CONFIG, REGION_COLORS, SECTOR_COLORS,
  clientCanonicalKey,
  type EnrichedHolding, type EtfXrayTab, type FilterType,
} from "./_types";
import { usePortfolioOverview, useBenchmarks } from "./_hooks/use-portfolio";
import { ChangeBadge, DayChange, PortfolioSkeleton } from "./_components/portfolio-ui";
import { HoldingsTable } from "./_components/holdings-table";
import { EtfXrayCard } from "./_components/etf-xray-card";
import { AllocationCharts } from "./_components/allocation-charts";
import { BenchmarkChart } from "./_components/benchmark-chart";
import { HoldingsByAccount } from "./_components/holdings-by-account";

// ── Main Page ───────────────────────────────────────────────────────
export default function PortfolioPage() {
  const devMode = useDevMode();
  const { displayCurrency } = useDisplayCurrency();
  const { data, loading, reload } = usePortfolioOverview(displayCurrency);
  const [filter, setFilter] = useState<FilterType>("all");
  // Edit/delete dialog for individual portfolio holdings. Null = closed.
  // (Create-mode was removed — "Add holding" now navigates to the consolidated
  // /settings/investments page; this dialog is edit-in-place only.)
  const [editingHolding, setEditingHolding] = useState<EnrichedHolding | null>(null);
  const [benchmarkPeriod, setBenchmarkPeriod] = useState("1y");
  const { benchmarks, benchmarkLoading } = useBenchmarks(benchmarkPeriod, !!devMode);
  const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(new Set());
  const [sortField, setSortField] = useState<"name" | "totalQty" | "avgCost" | "price" | "marketValueDisplay" | "totalCost" | "dayChangeDisplay" | "dayChangePct" | "unrealizedGainDisplay" | "unrealizedGainPct" | "realizedGain" | "accounts">("marketValueDisplay");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  // Tracks expanded rows by canonical-holding key (string) — issue #25
  // restructure. Was Set<number> (portfolio_holdings.id) before the
  // top-level All Holdings table aggregated by canonical key.
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [etfXrayTab, setEtfXrayTab] = useState<EtfXrayTab>("stocks");
  const [stocksPage, setStocksPage] = useState(1);
  const STOCKS_PER_PAGE = 25;
  // Show the All Holdings table in each holding's own (native) currency
  // instead of the display/reporting currency. Re-introduced after the API
  // started returning per-row native-currency rollups on `byHolding`; rows
  // that span multiple currencies fall back to display currency per-row.
  // Component-state only (resets on reload).
  const [showNative, setShowNative] = useState(false);
  // Hide entries with no current position. For table rows: quantity is null
  // or 0 (matches the row's own `hasMetrics` rule below — these are the
  // rows that already render as "--" across Qty/Avg/Mkt Value). For chart
  // buckets: aggregated value rounds to $0 (>0.005 keeps half-cent rounding
  // safe). Default on — empty rows are noise on a value-weighted view.
  // Toggle lives in the holdings table filter bar.
  const [hideEmpty, setHideEmpty] = useState(true);

  // Issue #25 restructure: top-level All Holdings rows are canonical-
  // holding rollups (one row per ticker / cash sleeve / currency code),
  // not per-(account, holding) `portfolio_holdings.id` rows. Sort + filter
  // operate on `byHolding`. Per-account members live in the expand region.
  const filteredHoldings = useMemo(() => {
    if (!data?.byHolding) return [];
    let list = data.byHolding;
    if (filter !== "all") list = list.filter(r => r.assetType === filter);
    if (hideEmpty) list = list.filter(r => r.totalQty !== 0 || r.marketValueDisplay !== 0);

    list = [...list].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "name": cmp = (a.name ?? "").localeCompare(b.name ?? ""); break;
        case "totalQty": cmp = (a.totalQty ?? 0) - (b.totalQty ?? 0); break;
        case "avgCost": cmp = (a.avgCostDisplay ?? 0) - (b.avgCostDisplay ?? 0); break;
        case "price": cmp = (a.currentPriceDisplay ?? 0) - (b.currentPriceDisplay ?? 0); break;
        case "marketValueDisplay": cmp = (a.marketValueDisplay ?? 0) - (b.marketValueDisplay ?? 0); break;
        case "totalCost": cmp = (a.costBasisDisplay ?? 0) - (b.costBasisDisplay ?? 0); break;
        case "dayChangeDisplay": cmp = (a.dayChangeDisplay ?? 0) - (b.dayChangeDisplay ?? 0); break;
        case "dayChangePct": cmp = (a.dayChangePct ?? 0) - (b.dayChangePct ?? 0); break;
        case "unrealizedGainDisplay": cmp = (a.unrealizedGainDisplay ?? 0) - (b.unrealizedGainDisplay ?? 0); break;
        case "unrealizedGainPct": cmp = (a.unrealizedGainPct ?? 0) - (b.unrealizedGainPct ?? 0); break;
        case "realizedGain": cmp = (a.realizedGainDisplay ?? 0) - (b.realizedGainDisplay ?? 0); break;
        case "accounts": cmp = (a.accountCount ?? 0) - (b.accountCount ?? 0); break;
      }
      return sortDir === "desc" ? -cmp : cmp;
    });
    return list;
  }, [data, filter, sortField, sortDir, hideEmpty]);

  // Per-canonical-key list of the underlying per-(account, holding) rows
  // — the body of the expanded section under each top-level row.
  const holdingsByCanonicalKey = useMemo(() => {
    if (!data?.holdings) return new Map<string, EnrichedHolding[]>();
    const map = new Map<string, EnrichedHolding[]>();
    for (const h of data.holdings) {
      const k = clientCanonicalKey(h);
      const arr = map.get(k) ?? [];
      arr.push(h);
      map.set(k, arr);
    }
    // Sort each bucket by accountName for stable rendering.
    for (const [k, arr] of map) {
      map.set(k, arr.slice().sort((a, b) => (a.accountName ?? "").localeCompare(b.accountName ?? "")));
    }
    return map;
  }, [data]);

  // Account groups for collapsible section
  const accountGroups = useMemo(() => {
    if (!data) return [];
    const groups = new Map<string, EnrichedHolding[]>();
    for (const h of data.holdings) {
      const acc = h.accountName;
      groups.set(acc, [...(groups.get(acc) ?? []), h]);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => (a ?? "").localeCompare(b ?? ""));
  }, [data]);

  const toggleAccount = (name: string) => {
    setExpandedAccounts(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const handleSort = (field: "name" | "totalQty" | "avgCost" | "price" | "marketValueDisplay" | "totalCost" | "dayChangeDisplay" | "dayChangePct" | "unrealizedGainDisplay" | "unrealizedGainPct" | "realizedGain" | "accounts") => {
    if (sortField === field) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortField(field); setSortDir("asc"); }
  };

  const toggleRow = (key: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  if (loading) return <PortfolioSkeleton />;
  if (!data) return <div className="text-center py-12 text-muted-foreground">Unable to load portfolio data.</div>;

  // Empty state — no holdings yet
  if (data.summary.totalHoldings === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center gap-4">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-cyan-100 text-cyan-600">
          <TrendingUp className="h-8 w-8" />
        </div>
        <div>
          <h3 className="text-lg font-semibold">No holdings yet</h3>
          <p className="text-sm text-muted-foreground mt-1 max-w-xs">
            Add investment accounts and holdings to track your portfolio performance.
          </p>
        </div>
        <div className="flex gap-3">
          <Link href="/accounts" className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors">
            Add Account
          </Link>
          <Link href="/import" className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium hover:bg-accent transition-colors">
            Import Data
          </Link>
        </div>
      </div>
    );
  }

  const { summary, byType, etfXray, topGainers, topLosers } = data;

  // Allocation data — value-weighted in display currency. `value` powers
  // both slice size and legend amount; we filter zero-value buckets when
  // hideEmpty is on (>0.005 keeps half-cent rounding safe).
  const allocationByType = Object.entries(byType)
    .filter(([, v]) => v.count > 0 && (!hideEmpty || v.value > 0.005))
    .map(([type, v]) => ({
      name: ASSET_TYPE_CONFIG[type]?.label ?? type,
      value: v.value,
      pct: summary.totalValueDisplay > 0
        ? Math.round((v.value / summary.totalValueDisplay) * 100)
        : 0,
      color: ASSET_TYPE_CONFIG[type]?.color ?? "#64748b",
    }));

  const allocationByAccount = Object.entries(data.byAccount)
    .filter(([, v]) => v.count > 0 && (!hideEmpty || v.value > 0.005))
    .sort(([, a], [, b]) => b.value - a.value)
    .map(([name, v]) => ({
      name,
      value: v.value,
      pct: summary.totalValueDisplay > 0
        ? Math.round((v.value / summary.totalValueDisplay) * 100)
        : 0,
    }));

  // ETF X-Ray data
  const regionData = Object.entries(etfXray.regions)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([name, pct]) => ({ name, pct, color: REGION_COLORS[name] ?? "#64748b" }));

  const sectorData = Object.entries(etfXray.sectors)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([name, pct]) => ({ name, pct, color: SECTOR_COLORS[name] ?? "#64748b" }));

  const hasEtfData = etfXray.etfCount > 0;

  return (
    <div className="space-y-6">
      {/* ── Header ────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Portfolio</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {summary.totalHoldings} holdings across {summary.totalAccounts} accounts
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Phase 2 nav — realized gains + dividends dashboards. Each
              dashboard reads its own data; they're not modal extensions
              of this page, just deeper drills into the same portfolio.
              `buttonVariants` styles a plain Link as a button — Button
              itself uses base-ui ButtonPrimitive which doesn't accept
              asChild per shadcn v4 (uses `render` prop instead, but
              that's not wired here yet). */}
          <Link
            href="/portfolio/realized-gains"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Realized gains
          </Link>
          <Link
            href="/portfolio/dividends"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Dividends
          </Link>
          {/* Add holding → the consolidated /settings/investments page (the old
              inline create dialog was removed; securities are defined + linked
              to accounts there). Per-row edit-in-place stays on the dialog below. */}
          <Link
            href="/settings/investments"
            className={buttonVariants({ size: "sm" })}
          >
            <Plus className="h-4 w-4 mr-1.5" /> Add holding
          </Link>
        </div>
      </div>

      {/* Phase 3 performance chart — TWRR/MWRR + daily value series.
          Empty-state copy in the component explains how to populate
          /portfolio_snapshots via the nightly cron + admin backfill. */}
      <PerformanceChart accountId={null} />

      {/* Re-login prompt — surfaces when the server couldn't decrypt
          tx.portfolio_holding (cold DEK cache after a server restart).
          Without this the page would render every encrypted tx as a separate
          orphan row because each AES-GCM IV is unique. */}
      {(data.undecryptedTxCount ?? 0) > 0 && (
        <div className="rounded-lg border border-amber-300 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 p-4 flex items-start gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/50 shrink-0">
            <span className="text-amber-700 dark:text-amber-300 font-semibold">!</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
              {data.undecryptedTxCount} transaction{data.undecryptedTxCount === 1 ? "" : "s"} couldn&apos;t be decrypted
            </p>
            <p className="text-xs text-amber-800/80 dark:text-amber-300/80 mt-0.5">
              Your session needs to refresh after the last deploy.{" "}
              <Link href="/login" className="underline font-medium">Sign in again</Link>{" "}
              to unlock your portfolio data.
            </p>
          </div>
        </div>
      )}

      {/* ── Hero Summary Cards ────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="relative overflow-hidden">
          <CardContent className="pt-5">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Total Holdings</p>
                <p className="text-2xl font-bold tracking-tight hero-number">{summary.totalHoldings}</p>
                <p className="text-xs text-muted-foreground">{summary.totalAccounts} accounts</p>
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400">
                <Briefcase className="h-5 w-5" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden">
          <CardContent className="pt-5">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Day Change</p>
                <div className="flex items-baseline gap-1.5">
                  <ChangeBadge value={summary.dayChangePct} className="text-lg font-bold" />
                </div>
                <p className={`text-xs font-mono ${summary.dayChangeDisplay >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                  {summary.dayChangeDisplay >= 0 ? "+" : ""}{formatCurrency(summary.dayChangeDisplay, displayCurrency)}
                </p>
              </div>
              <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${summary.dayChangePct >= 0 ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400" : "bg-rose-100 text-rose-600 dark:bg-rose-500/10 dark:text-rose-400"}`}>
                <TrendingUp className="h-5 w-5" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden">
          <CardContent className="pt-5">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">ETFs / Stocks</p>
                <p className="text-2xl font-bold tracking-tight hero-number">
                  {byType.etf.count + byType.stock.count}
                </p>
                <p className="text-xs text-muted-foreground">
                  {byType.etf.count} ETFs, {byType.stock.count} stocks
                </p>
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-100 text-cyan-600 dark:bg-cyan-500/10 dark:text-cyan-400">
                <BarChart3 className="h-5 w-5" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden">
          <CardContent className="pt-5">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Crypto</p>
                <p className="text-2xl font-bold tracking-tight hero-number">{byType.crypto.count}</p>
                <p className="text-xs text-muted-foreground">{byType.cash.count} cash positions</p>
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400">
                <Coins className="h-5 w-5" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Investment P&L Summary ────────────────────────────── */}
      {summary.hasQuantityData && summary.totalCostBasisDisplay > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-indigo-500" />
              <CardTitle className="text-base">Investment Returns</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
              {/* Market Value */}
              <div className="space-y-0.5">
                <p className="text-xs text-muted-foreground">Market Value</p>
                <p className="text-sm font-bold font-mono hero-number">{formatCurrency(summary.totalValueDisplay, displayCurrency)}</p>
              </div>
              {/* Cost Basis */}
              <div className="space-y-0.5">
                <p className="text-xs text-muted-foreground">Cost Basis</p>
                <p className="text-sm font-bold font-mono hero-number">{formatCurrency(summary.totalCostBasisDisplay, displayCurrency)}</p>
              </div>
              {/* Unrealized G/L */}
              <div className="space-y-0.5">
                <p className="text-xs text-muted-foreground">Unrealized G/L</p>
                <p className={`text-sm font-bold font-mono hero-number ${summary.totalUnrealizedGainDisplay >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                  {summary.totalUnrealizedGainDisplay >= 0 ? "+" : ""}{formatCurrency(summary.totalUnrealizedGainDisplay, displayCurrency)}
                </p>
                <p className={`text-xs font-mono ${summary.totalUnrealizedGainPct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                  {summary.totalUnrealizedGainPct >= 0 ? "+" : ""}{summary.totalUnrealizedGainPct.toFixed(2)}%
                </p>
              </div>
              {/* Realized G/L */}
              <div className="space-y-0.5">
                <p className="text-xs text-muted-foreground">Realized G/L</p>
                <p className={`text-sm font-bold font-mono hero-number ${summary.totalRealizedGainDisplay >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                  {summary.totalRealizedGainDisplay >= 0 ? "+" : ""}{formatCurrency(summary.totalRealizedGainDisplay, displayCurrency)}
                </p>
              </div>
              {/* Dividends */}
              <div className="space-y-0.5">
                <p className="text-xs text-muted-foreground">Dividends</p>
                <p className="text-sm font-bold font-mono hero-number text-emerald-600 dark:text-emerald-400">
                  +{formatCurrency(summary.totalDividendsDisplay, displayCurrency)}
                </p>
              </div>
              {/* Total Return */}
              <div className="space-y-0.5">
                <p className="text-xs text-muted-foreground">Total Return</p>
                <p className={`text-sm font-bold font-mono hero-number ${summary.totalReturnDisplay >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                  {summary.totalReturnDisplay >= 0 ? "+" : ""}{formatCurrency(summary.totalReturnDisplay, displayCurrency)}
                </p>
                <p className={`text-xs font-mono ${summary.totalReturnPct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                  {summary.totalReturnPct >= 0 ? "+" : ""}{summary.totalReturnPct.toFixed(2)}%
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Top Movers ────────────────────────────────────────── */}
      {(topGainers.length > 0 || topLosers.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {topGainers.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <Flame className="h-4 w-4 text-emerald-500" />
                  <CardTitle className="text-sm font-medium">Top Gainers</CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {topGainers.map(m => (
                    <div key={m.key} className="flex items-center justify-between py-1">
                      <div className="flex items-center gap-2">
                        {m.image && <img src={m.image} alt="" className="h-5 w-5 rounded-full" />}
                        <span className="text-sm font-medium">{m.symbol ?? m.name}</span>
                        {m.name !== (m.symbol ?? m.name) && (
                          <span className="text-xs text-muted-foreground hidden sm:inline">{m.name}</span>
                        )}
                      </div>
                      <DayChange pct={m.changePct} amount={m.dayChangeDisplay} currency={displayCurrency} />
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
          {topLosers.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <Snowflake className="h-4 w-4 text-rose-500" />
                  <CardTitle className="text-sm font-medium">Top Losers</CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {topLosers.map(m => (
                    <div key={m.key} className="flex items-center justify-between py-1">
                      <div className="flex items-center gap-2">
                        {m.image && <img src={m.image} alt="" className="h-5 w-5 rounded-full" />}
                        <span className="text-sm font-medium">{m.symbol ?? m.name}</span>
                        {m.name !== (m.symbol ?? m.name) && (
                          <span className="text-xs text-muted-foreground hidden sm:inline">{m.name}</span>
                        )}
                      </div>
                      <DayChange pct={m.changePct} amount={m.dayChangeDisplay} currency={displayCurrency} />
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ── Holdings Table ────────────────────────────────────── */}
      <HoldingsTable
        data={data}
        displayCurrency={displayCurrency}
        filteredHoldings={filteredHoldings}
        holdingsByCanonicalKey={holdingsByCanonicalKey}
        filter={filter}
        setFilter={setFilter}
        hideEmpty={hideEmpty}
        setHideEmpty={setHideEmpty}
        showNative={showNative}
        setShowNative={setShowNative}
        sortField={sortField}
        sortDir={sortDir}
        handleSort={handleSort}
        expandedRows={expandedRows}
        toggleRow={toggleRow}
        setEditingHolding={setEditingHolding}
      />

      {/* ── ETF X-Ray (Combined) — dev only ──────────────────── */}
      {devMode && hasEtfData && (
        <EtfXrayCard
          etfXray={etfXray}
          etfXrayTab={etfXrayTab}
          setEtfXrayTab={setEtfXrayTab}
          stocksPage={stocksPage}
          setStocksPage={setStocksPage}
          stocksPerPage={STOCKS_PER_PAGE}
          regionData={regionData}
          sectorData={sectorData}
          displayCurrency={displayCurrency}
        />
      )}

      {/* ── Allocation Overview ────────────────────────────────── */}
      <AllocationCharts
        allocationByType={allocationByType}
        allocationByAccount={allocationByAccount}
        displayCurrency={displayCurrency}
      />

      {/* ── Performance vs Benchmarks — dev only ─────────────── */}
      {devMode && (
        <BenchmarkChart
          benchmarks={benchmarks}
          benchmarkLoading={benchmarkLoading}
          benchmarkPeriod={benchmarkPeriod}
          setBenchmarkPeriod={setBenchmarkPeriod}
        />
      )}

      {/* ── Holdings by Account (Collapsible) ───────────────────
          Issue #25 (decision 2026-05-01): the standalone "By Holding"
          panel was folded into the "All Holdings" table above — each
          top-level row there is the canonical-holding rollup, and the
          expand region surfaces the per-account breakdown + drill-down.
          This Holdings-by-Account panel stays as-is per the same decision
          ("the per-account button row is unchanged"). */}
      <HoldingsByAccount
        accountGroups={accountGroups}
        expandedAccounts={expandedAccounts}
        toggleAccount={toggleAccount}
        displayCurrency={displayCurrency}
      />

      {/* Edit / create holding dialog — wraps the shared
          <HoldingEditForm> from src/components/holdings/holding-edit-form.tsx.
          Issue #100: the inline HoldingEditDialog that previously lived
          here was extracted so /settings/investments can mount the SAME
          form. Edits never silently diverge between the two surfaces
          because there's only one component. */}
      <Dialog
        open={editingHolding !== null}
        onOpenChange={(open) => {
          if (!open) setEditingHolding(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Holding</DialogTitle>
          </DialogHeader>
          {editingHolding !== null && (
            <HoldingEditForm
              holdingId={editingHolding.id}
              initialHolding={holdingFromEnriched(editingHolding)}
              onCancel={() => setEditingHolding(null)}
              onSave={() => {
                setEditingHolding(null);
                reload();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Adapter from `EnrichedHolding` (the rich row type used by /portfolio)
 * down to the small subset that the shared form needs. Skips the extra
 * GET round-trip in the form's edit path because we already have the
 * row hydrated in the page state.
 */
function holdingFromEnriched(h: EnrichedHolding): HoldingEditFormHolding {
  return {
    id: h.id,
    accountId: h.accountId,
    name: h.name,
    symbol: h.symbol,
    currency: h.currency,
    isCrypto: (h as unknown as { isCrypto?: number }).isCrypto ?? null,
    note: (h as unknown as { note?: string }).note ?? null,
  };
}
