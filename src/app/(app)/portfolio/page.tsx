"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip,
  LineChart, Line, XAxis, YAxis, Legend,
} from "recharts";
import {
  TrendingUp, Wallet, BarChart3, Coins, ArrowUpRight, ArrowDownRight,
  Globe2, Building2, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Layers, PieChart as PieChartIcon,
  Briefcase, DollarSign, Flame, Snowflake, Search, Download, Plus,
} from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { motion, AnimatePresence } from "framer-motion";
import { useDevMode } from "@/hooks/use-dev-mode";
import { useDisplayCurrency } from "@/components/currency-provider";
import { isMetalCurrency } from "@/lib/fx/supported-currencies";
import {
  HoldingEditForm,
  type HoldingEditFormHolding,
} from "@/components/holdings/holding-edit-form";

// Mirror of /api/portfolio/overview's `canonicalKey()`. Keep in sync with
// the server-side function — both must produce the same key for a given
// holding so the row-membership lookup matches the API's `byHolding` array.
function clientCanonicalKey(h: { assetType: string; symbol: string | null; currency: string; name: string }): string {
  const sym = h.symbol ? h.symbol.trim().toUpperCase() : "";
  if (h.assetType === "crypto" && sym) return `crypto:${sym}`;
  if ((h.assetType === "stock" || h.assetType === "etf") && sym) return `eq:${sym}`;
  if (h.assetType === "cash") {
    if (sym) {
      if (isMetalCurrency(sym)) return `metal:${sym}`;
      return `cash:${sym}`;
    }
    const cur = (h.currency || "").toUpperCase();
    return `cash:${cur}`;
  }
  return `custom:${(h.name || "?").trim().toLowerCase()}`;
}

// ── Colors ──────────────────────────────────────────────────────────
const PIE_COLORS = [
  "#6366f1", "#06b6d4", "#10b981", "#f59e0b", "#f43f5e",
  "#8b5cf6", "#14b8a6", "#84cc16", "#ec4899", "#f97316",
];

const ASSET_TYPE_CONFIG: Record<string, { label: string; color: string; icon: typeof Coins }> = {
  etf: { label: "ETFs", color: "#6366f1", icon: Layers },
  stock: { label: "Stocks", color: "#06b6d4", icon: BarChart3 },
  crypto: { label: "Crypto", color: "#f59e0b", icon: Coins },
  cash: { label: "Cash", color: "#10b981", icon: DollarSign },
};

const REGION_COLORS: Record<string, string> = {
  US: "#6366f1", Canada: "#10b981", Europe: "#f59e0b", Japan: "#f43f5e",
  Asia: "#8b5cf6", Emerging: "#06b6d4", Other: "#64748b",
};

const SECTOR_COLORS: Record<string, string> = {
  Tech: "#6366f1", Healthcare: "#10b981", Financials: "#f59e0b",
  Consumer: "#f43f5e", Industrials: "#06b6d4", Energy: "#8b5cf6",
  Materials: "#14b8a6", Other: "#64748b",
};

// ── Types ───────────────────────────────────────────────────────────
type AssetType = "etf" | "stock" | "crypto" | "cash";

type EnrichedHolding = {
  id: number;
  accountId: number | null;
  accountName: string;
  name: string;
  symbol: string | null;
  currency: string;
  assetType: AssetType;
  price: number | null;
  change: number | null;
  changePct: number | null;
  quoteCurrency: string | null;
  marketCap: number | null;
  image: string | null;
  quantity: number | null;
  avgCostPerShare: number | null;
  totalCostBasis: number | null;
  lifetimeCostBasis: number | null;
  marketValue: number | null;
  marketValueDisplay: number | null;
  unrealizedGain: number | null;
  unrealizedGainPct: number | null;
  unrealizedGainDisplay: number | null;
  realizedGain: number | null;
  dividendsReceived: number | null;
  totalReturn: number | null;
  totalReturnDisplay: number | null;
  totalReturnPct: number | null;
  firstPurchaseDate: string | null;
  daysHeld: number | null;
  pctOfPortfolio: number | null;
};

type ByHoldingRow = {
  key: string;
  symbol: string | null;
  name: string;
  assetType: AssetType;
  totalQty: number;
  avgCostDisplay: number | null;
  costBasisDisplay: number;
  marketValueDisplay: number;
  unrealizedGainDisplay: number;
  unrealizedGainPct: number | null;
  realizedGainDisplay: number;
  dividendsDisplay: number;
  totalReturnDisplay: number;
  totalReturnPct: number | null;
  pctOfPortfolio: number | null;
  accountCount: number;
  image: string | null;
};

type AggregatedStock = {
  ticker: string;
  name: string;
  sector: string;
  country: string;
  effectiveWeight: number;
  effectiveValueDisplay: number;
  contributingEtfs: { symbol: string; weight: number }[];
};

type EtfDetail = {
  symbol: string;
  name: string;
  account: string;
  fullName: string;
  totalHoldings: number;
  valueCAD: number;
  weightPct: number;
};

type OverviewData = {
  holdings: EnrichedHolding[];
  byHolding?: ByHoldingRow[];
  // Currency the API used for FX conversion + summary totals.
  // marketValueDisplay field on each holding is denominated in this — the
  // legacy "CAD" suffix on the field name is misleading, the value
  // tracks the user's display currency.
  displayCurrency?: string;
  undecryptedTxCount?: number;
  summary: {
    totalHoldings: number;
    totalAccounts: number;
    totalValueDisplay: number;
    dayChangeDisplay: number;
    dayChangePct: number;
    hasQuantityData: boolean;
    totalCostBasisDisplay: number;
    totalUnrealizedGainDisplay: number;
    totalUnrealizedGainPct: number;
    totalRealizedGainDisplay: number;
    totalDividendsDisplay: number;
    totalReturnDisplay: number;
    totalReturnPct: number;
  };
  byType: Record<AssetType, { count: number; value: number }>;
  byAccount: Record<string, { count: number; value: number }>;
  etfXray: {
    etfCount: number;
    etfTotalValueDisplay: number;
    etfs: EtfDetail[];
    regions: Record<string, number>;
    sectors: Record<string, number>;
    aggregatedStocks: AggregatedStock[];
  };
  topGainers: EnrichedHolding[];
  topLosers: EnrichedHolding[];
};

type BenchmarkData = {
  symbol: string;
  name: string;
  color: string;
  returnPct: number;
  series: { date: string; value: number }[];
};

type FilterType = "all" | AssetType;
type EtfXrayTab = "stocks" | "regions" | "sectors" | "etfs";

// ── Tooltip Components ──────────────────────────────────────────────
function GlassTooltip({
  active, payload, label, formatter,
}: {
  active?: boolean;
  payload?: { name: string; value: number; color?: string; payload?: Record<string, unknown> }[];
  label?: string;
  formatter?: (value: number, name: string) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border/50 bg-card/95 backdrop-blur-sm px-3 py-2 shadow-lg">
      {label && <p className="text-xs text-muted-foreground mb-1">{label}</p>}
      {payload.map((entry, i) => (
        <div key={i} className="flex items-center gap-2 text-sm">
          {entry.color && <div className="h-2 w-2 rounded-full" style={{ background: entry.color }} />}
          <span className="text-muted-foreground">{entry.name}:</span>
          <span className="font-semibold">
            {formatter ? formatter(entry.value, entry.name) : entry.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function ExposurePieTooltip({
  active, payload,
}: {
  active?: boolean;
  payload?: { name: string; value: number; payload: { name: string; pct: number } }[];
}) {
  if (!active || !payload?.length) return null;
  const entry = payload[0];
  return (
    <div className="rounded-lg border border-border/50 bg-card/95 backdrop-blur-sm px-3 py-2 shadow-lg">
      <p className="text-xs font-semibold">{entry.payload.name}</p>
      <p className="text-sm font-bold">{entry.payload.pct}%</p>
    </div>
  );
}

// ── Change Badge ────────────────────────────────────────────────────
function ChangeBadge({ value, className = "" }: { value: number | null; className?: string }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">--</span>;
  const isPositive = value >= 0;
  return (
    <span className={`inline-flex items-center gap-0.5 font-mono text-sm font-medium ${isPositive ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"} ${className}`}>
      {isPositive ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
      {Math.abs(value).toFixed(2)}%
    </span>
  );
}

// ── CSV Export ──────────────────────────────────────────────────────
function downloadCSV(csv: string, filename: string) {
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportStocksToCSV(stocks: AggregatedStock[], etfTotalValueDisplay: number, displayCurrency: string) {
  const header = ["#", "Stock", "Ticker", "Sector", "Country", "Weight %", `Value ${displayCurrency}`, "Contributing ETFs", "ETF Weights"];
  const rows = stocks.map((s, i) => [
    i + 1,
    `"${s.name}"`,
    s.ticker,
    s.sector,
    s.country,
    s.effectiveWeight.toFixed(2),
    s.effectiveValueDisplay.toFixed(2),
    `"${s.contributingEtfs.map(e => e.symbol).join(", ")}"`,
    `"${s.contributingEtfs.map(e => `${e.symbol}: ${e.weight}%`).join(", ")}"`,
  ]);
  const totalWeight = stocks.reduce((s, x) => s + x.effectiveWeight, 0);
  const totalValue = stocks.reduce((s, x) => s + x.effectiveValueDisplay, 0);
  rows.push(["", "", "", "", "TOTAL", totalWeight.toFixed(2), totalValue.toFixed(2), "", ""] as unknown as string[]);
  rows.push(["", "", "", "", "ETF Portfolio Value", "", etfTotalValueDisplay.toFixed(2), "", ""] as unknown as string[]);

  const csv = [header.join(","), ...rows.map(r => (r as (string | number)[]).join(","))].join("\n");
  downloadCSV(csv, `etf-stock-exposure-${new Date().toISOString().slice(0, 10)}.csv`);
}

// `exportHoldingsToCSV` was removed 2026-05-01 (issue #25): the All
// Holdings table now renders canonical-holding rows from `byHolding`,
// not per-(account, holding) rows from `holdings`. The CSV button uses
// `exportByHoldingToCSV` below; users who want a per-account dump can
// use the Holdings-by-Account panel's per-row drill-down or the
// /api/portfolio endpoint.
function exportByHoldingToCSV(rows: ByHoldingRow[], displayCurrency: string) {
  const header = ["#", "Holding", "Symbol", "Type", "Total Qty", `Avg Cost ${displayCurrency}`, `Cost Basis ${displayCurrency}`, `Mkt Value ${displayCurrency}`, "Unrealized G/L", "Unrealized %", "Realized G/L", "Dividends", "Total Return", "Total Return %", "Accounts", "Weight %"];
  const out = rows.map((r, i) => [
    i + 1,
    `"${r.name}"`,
    r.symbol ?? "",
    r.assetType,
    r.totalQty,
    r.avgCostDisplay?.toFixed(4) ?? "",
    r.costBasisDisplay.toFixed(2),
    r.marketValueDisplay.toFixed(2),
    r.unrealizedGainDisplay.toFixed(2),
    r.unrealizedGainPct?.toFixed(2) ?? "",
    r.realizedGainDisplay.toFixed(2),
    r.dividendsDisplay.toFixed(2),
    r.totalReturnDisplay.toFixed(2),
    r.totalReturnPct?.toFixed(2) ?? "",
    r.accountCount,
    r.pctOfPortfolio?.toFixed(2) ?? "",
  ]);
  const totalMV = rows.reduce((s, r) => s + r.marketValueDisplay, 0);
  const totalUnreal = rows.reduce((s, r) => s + r.unrealizedGainDisplay, 0);
  out.push(["", "TOTAL", "", "", "", "", "", totalMV.toFixed(2), totalUnreal.toFixed(2), "", "", "", "", "", "", "100.00"] as unknown as string[]);
  const csv = [header.join(","), ...out.map(r => (r as (string | number | null)[]).join(","))].join("\n");
  downloadCSV(csv, `portfolio-by-holding-${new Date().toISOString().slice(0, 10)}.csv`);
}

// ── Skeleton ────────────────────────────────────────────────────────
function PortfolioSkeleton() {
  return (
    <div className="space-y-6">
      <div>
        <div className="h-8 w-48 bg-muted animate-shimmer rounded-lg" />
        <div className="h-4 w-72 bg-muted animate-shimmer rounded-lg mt-2" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="pt-5">
              <div className="space-y-2">
                <div className="h-3 w-20 bg-muted animate-shimmer rounded" />
                <div className="h-8 w-28 bg-muted animate-shimmer rounded" />
                <div className="h-3 w-16 bg-muted animate-shimmer rounded" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader><div className="h-5 w-36 bg-muted animate-shimmer rounded" /></CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 py-2">
              <div className="h-8 w-8 rounded-full bg-muted animate-shimmer" />
              <div className="h-4 w-24 bg-muted animate-shimmer rounded" />
              <div className="h-4 w-16 bg-muted animate-shimmer rounded ml-auto" />
              <div className="h-4 w-16 bg-muted animate-shimmer rounded" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Main Page ───────────────────────────────────────────────────────
export default function PortfolioPage() {
  const devMode = useDevMode();
  const { displayCurrency } = useDisplayCurrency();
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterType>("all");
  // Edit/delete dialog for individual portfolio holdings. Null = closed.
  const [editingHolding, setEditingHolding] = useState<EnrichedHolding | null>(null);
  // Create-mode dialog for adding a new holding. When non-null, opens the
  // shared <HoldingEditForm> with the dropdown defaulted to that account.
  // {} = open with no default account (header-level "Add holding" button).
  const [creatingHolding, setCreatingHolding] = useState<{ accountId?: number } | null>(null);
  const [benchmarks, setBenchmarks] = useState<BenchmarkData[]>([]);
  const [benchmarkPeriod, setBenchmarkPeriod] = useState("1y");
  const [benchmarkLoading, setBenchmarkLoading] = useState(false);
  const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(new Set());
  const [sortField, setSortField] = useState<"name" | "marketValueDisplay" | "unrealizedGainPct">("marketValueDisplay");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  // Tracks expanded rows by canonical-holding key (string) — issue #25
  // restructure. Was Set<number> (portfolio_holdings.id) before the
  // top-level All Holdings table aggregated by canonical key.
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [etfXrayTab, setEtfXrayTab] = useState<EtfXrayTab>("stocks");
  const [stocksPage, setStocksPage] = useState(1);
  const STOCKS_PER_PAGE = 25;
  // (Removed showInReporting toggle 2026-05-01: the All Holdings table
  // now renders byHolding rows that are already in display currency, so
  // the toggle had no effect. Per-account members in the expanded section
  // still show native currency for clarity.)
  // Hide entries with no current position. For table rows: quantity is null
  // or 0 (matches the row's own `hasMetrics` rule below — these are the
  // rows that already render as "--" across Qty/Avg/Mkt Value). For chart
  // buckets: aggregated value rounds to $0 (>0.005 keeps half-cent rounding
  // safe). Default on — empty rows are noise on a value-weighted view.
  // Toggle lives in the holdings table filter bar.
  const [hideEmpty, setHideEmpty] = useState(true);

  // Fetch portfolio overview — re-runs when display currency changes so
  // totals + currency-as-holding prices reflect the user's choice.
  useEffect(() => {
    fetch(`/api/portfolio/overview?currency=${encodeURIComponent(displayCurrency)}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [displayCurrency]);

  // Fetch benchmarks (dev mode only)
  useEffect(() => {
    if (!devMode) return;
    setBenchmarkLoading(true);
    fetch(`/api/portfolio/benchmarks?period=${benchmarkPeriod}`)
      .then(r => r.json())
      .then(d => { setBenchmarks(d.benchmarks ?? []); setBenchmarkLoading(false); })
      .catch(() => setBenchmarkLoading(false));
  }, [benchmarkPeriod, devMode]);

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
        case "name": cmp = a.name.localeCompare(b.name); break;
        case "marketValueDisplay": cmp = (a.marketValueDisplay ?? 0) - (b.marketValueDisplay ?? 0); break;
        case "unrealizedGainPct": cmp = (a.unrealizedGainPct ?? 0) - (b.unrealizedGainPct ?? 0); break;
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
      map.set(k, arr.slice().sort((a, b) => a.accountName.localeCompare(b.accountName)));
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
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [data]);

  const toggleAccount = (name: string) => {
    setExpandedAccounts(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const handleSort = (field: typeof sortField) => {
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

  const SortIcon = ({ field }: { field: typeof sortField }) => {
    if (sortField !== field) return null;
    return sortDir === "asc" ? <ChevronUp className="h-3 w-3 inline ml-0.5" /> : <ChevronDown className="h-3 w-3 inline ml-0.5" />;
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

  // Build benchmark chart data
  const benchmarkChartData = buildBenchmarkChartData(benchmarks);

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
        {/* Add holding entry point — opens the shared <HoldingEditForm>
            in create mode. The same form lives at /settings/investments;
            both are driven by src/components/holdings/holding-edit-form.tsx
            so the field set never drifts between surfaces (issue #100). */}
        <Button onClick={() => setCreatingHolding({})} size="sm">
          <Plus className="h-4 w-4 mr-1.5" /> Add holding
        </Button>
      </div>

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
              {data.undecryptedTxCount} transaction{data.undecryptedTxCount === 1 ? "" : "s"} couldn't be decrypted
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
                  {topGainers.map(h => (
                    <div key={h.id} className="flex items-center justify-between py-1">
                      <div className="flex items-center gap-2">
                        {h.image && <img src={h.image} alt="" className="h-5 w-5 rounded-full" />}
                        <span className="text-sm font-medium">{h.symbol ?? h.name}</span>
                        <span className="text-xs text-muted-foreground hidden sm:inline">{h.name}</span>
                      </div>
                      <ChangeBadge value={h.changePct} />
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
                  {topLosers.map(h => (
                    <div key={h.id} className="flex items-center justify-between py-1">
                      <div className="flex items-center gap-2">
                        {h.image && <img src={h.image} alt="" className="h-5 w-5 rounded-full" />}
                        <span className="text-sm font-medium">{h.symbol ?? h.name}</span>
                        <span className="text-xs text-muted-foreground hidden sm:inline">{h.name}</span>
                      </div>
                      <ChangeBadge value={h.changePct} />
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ── Holdings Table ────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">All Holdings</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                Live prices from Yahoo Finance &amp; CoinGecko
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex gap-1 flex-wrap">
                {(["all", "etf", "stock", "crypto", "cash"] as const).map(t => (
                  <Button
                    key={t}
                    variant={filter === t ? "default" : "outline"}
                    size="sm"
                    className="text-xs h-7 px-2.5"
                    onClick={() => setFilter(t)}
                  >
                    {t === "all" ? "All" : ASSET_TYPE_CONFIG[t]?.label ?? t}
                    <Badge variant="secondary" className="ml-1 text-[10px] h-4 px-1 bg-transparent">
                      {t === "all" ? summary.totalHoldings : byType[t]?.count ?? 0}
                    </Badge>
                  </Button>
                ))}
              </div>
              <Button
                variant={hideEmpty ? "default" : "outline"}
                size="sm"
                className="text-xs gap-1.5 h-7"
                onClick={() => setHideEmpty(!hideEmpty)}
                title="Hide holdings with no current position (quantity = 0, e.g. fully-sold)"
              >
                {hideEmpty ? "Hiding empty" : "Showing all"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-xs gap-1.5 h-7"
                onClick={() => exportByHoldingToCSV(data.byHolding ?? [], data.displayCurrency ?? displayCurrency)}
              >
                <Download className="h-3 w-3" />
                CSV
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="cursor-pointer select-none w-8" />
                  <TableHead className="cursor-pointer select-none" onClick={() => handleSort("name")}>
                    Holding <SortIcon field="name" />
                  </TableHead>
                  <TableHead className="text-right">Total Qty</TableHead>
                  <TableHead className="text-right">Avg Cost</TableHead>
                  <TableHead className="text-right cursor-pointer select-none" onClick={() => handleSort("marketValueDisplay")}>
                    Mkt Value <SortIcon field="marketValueDisplay" />
                  </TableHead>
                  <TableHead className="text-right cursor-pointer select-none" onClick={() => handleSort("unrealizedGainPct")}>
                    Unrealized G/L <SortIcon field="unrealizedGainPct" />
                  </TableHead>
                  <TableHead className="text-right">Realized G/L</TableHead>
                  <TableHead className="text-right">Accounts</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredHoldings.map(r => {
                  const typeConf = ASSET_TYPE_CONFIG[r.assetType];
                  const isExpanded = expandedRows.has(r.key);
                  const reportCcy = data.displayCurrency ?? displayCurrency;
                  const memberHoldings = holdingsByCanonicalKey.get(r.key) ?? [];
                  // Aggregate-level first-purchase / days-held are derived
                  // from the per-account members so they reflect the
                  // earliest buy across every account that holds this
                  // canonical position.
                  const earliestPurchase = memberHoldings.reduce<string | null>((acc, h) => {
                    if (!h.firstPurchaseDate) return acc;
                    if (!acc || h.firstPurchaseDate < acc) return h.firstPurchaseDate;
                    return acc;
                  }, null);
                  const today = new Date();
                  const daysHeld = earliestPurchase
                    ? Math.floor((today.getTime() - new Date(earliestPurchase).getTime()) / 86400000)
                    : null;
                  return (
                    <>
                      <TableRow
                        key={r.key}
                        className="hover:bg-muted/30 transition-colors cursor-pointer"
                        onClick={() => toggleRow(r.key)}
                      >
                        <TableCell className="text-muted-foreground">
                          {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {r.image && <img src={r.image} alt="" className="h-6 w-6 rounded-full" />}
                            <div>
                              <span className="font-medium text-sm">{r.name}</span>
                              <div className="flex items-center gap-1 mt-0.5">
                                {r.symbol && <Badge variant="secondary" className="font-mono text-[10px] h-4 px-1">{r.symbol}</Badge>}
                                <Badge variant="outline" className="text-[10px] h-4 px-1" style={{ borderColor: typeConf?.color, color: typeConf?.color }}>
                                  {typeConf?.label ?? r.assetType}
                                </Badge>
                              </div>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {r.totalQty !== 0
                            ? r.totalQty.toLocaleString("en-CA", { minimumFractionDigits: 0, maximumFractionDigits: r.totalQty % 1 === 0 ? 0 : 4 })
                            : <span className="text-muted-foreground text-xs">--</span>}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {r.avgCostDisplay != null ? formatCurrency(r.avgCostDisplay, reportCcy) : <span className="text-muted-foreground text-xs">--</span>}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm font-medium">
                          {r.marketValueDisplay !== 0 ? formatCurrency(r.marketValueDisplay, reportCcy) : <span className="text-muted-foreground text-xs">--</span>}
                        </TableCell>
                        <TableCell className="text-right">
                          <div>
                            <p className={`text-sm font-mono font-medium ${r.unrealizedGainDisplay >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                              {r.unrealizedGainDisplay >= 0 ? "+" : ""}{formatCurrency(r.unrealizedGainDisplay, reportCcy)}
                            </p>
                            {r.unrealizedGainPct != null && (
                              <p className={`text-xs font-mono ${r.unrealizedGainPct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                                {r.unrealizedGainPct >= 0 ? "+" : ""}{r.unrealizedGainPct.toFixed(2)}%
                              </p>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {r.realizedGainDisplay !== 0 ? (
                            <span className={`${r.realizedGainDisplay >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                              {r.realizedGainDisplay >= 0 ? "+" : ""}{formatCurrency(r.realizedGainDisplay, reportCcy)}
                            </span>
                          ) : <span className="text-muted-foreground text-xs">--</span>}
                        </TableCell>
                        <TableCell className="text-right">
                          <Badge variant="outline" className="text-[10px]">
                            {r.accountCount}
                          </Badge>
                        </TableCell>
                      </TableRow>
                      {isExpanded && (
                        <TableRow key={`${r.key}-detail`} className="bg-muted/10 border-0">
                          <TableCell />
                          <TableCell colSpan={7} className="py-3">
                            {/* Aggregate-level info grid (shared across the
                                accounts inside this canonical position). */}
                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3 text-xs">
                              <div>
                                <p className="text-muted-foreground">First Purchase</p>
                                <p className="font-medium">{earliestPurchase ?? "--"}</p>
                              </div>
                              <div>
                                <p className="text-muted-foreground">Days Held</p>
                                <p className="font-medium">{daysHeld != null ? `${daysHeld.toLocaleString()} days` : "--"}</p>
                              </div>
                              <div>
                                <p className="text-muted-foreground">% of Portfolio</p>
                                <p className="font-medium">{r.pctOfPortfolio != null ? `${r.pctOfPortfolio.toFixed(2)}%` : "--"}</p>
                              </div>
                              <div>
                                <p className="text-muted-foreground">Cost Basis</p>
                                <p className="font-medium font-mono">{r.costBasisDisplay !== 0 ? formatCurrency(r.costBasisDisplay, reportCcy) : "--"}</p>
                              </div>
                              <div>
                                <p className="text-muted-foreground">Dividends</p>
                                <p className="font-medium font-mono text-emerald-600 dark:text-emerald-400">
                                  {r.dividendsDisplay > 0 ? `+${formatCurrency(r.dividendsDisplay, reportCcy)}` : "--"}
                                </p>
                              </div>
                              <div>
                                <p className="text-muted-foreground">Total Return</p>
                                <p className={`font-medium font-mono ${r.totalReturnDisplay >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                                  {r.totalReturnDisplay !== 0 ? `${r.totalReturnDisplay >= 0 ? "+" : ""}${formatCurrency(r.totalReturnDisplay, reportCcy)}` : "--"}
                                  {r.totalReturnPct != null && (
                                    <span className="ml-1 text-[10px]">({r.totalReturnPct >= 0 ? "+" : ""}{r.totalReturnPct.toFixed(1)}%)</span>
                                  )}
                                </p>
                              </div>
                            </div>

                            {/* Per-account breakdown (issue #25 spec). One
                                row per (canonical-holding, account) pair
                                with a "View transactions" drill-down. Always
                                rendered — for single-account holdings it
                                doubles as the only edit affordance, since
                                the account-name cell opens the editor. */}
                            {memberHoldings.length > 0 && (
                              <div className="mt-3 rounded-md border border-border overflow-hidden">
                                <Table>
                                  <TableHeader className="bg-muted/40">
                                    <TableRow className="hover:bg-transparent border-border">
                                      <TableHead className="text-[10px] uppercase tracking-wider text-muted-foreground">Account</TableHead>
                                      <TableHead className="text-right text-[10px] uppercase tracking-wider text-muted-foreground">Qty</TableHead>
                                      <TableHead className="text-right text-[10px] uppercase tracking-wider text-muted-foreground">Avg Cost</TableHead>
                                      <TableHead className="text-right text-[10px] uppercase tracking-wider text-muted-foreground">Mkt Value</TableHead>
                                      <TableHead className="text-right text-[10px] uppercase tracking-wider text-muted-foreground">Unrealized G/L</TableHead>
                                      <TableHead className="text-right text-[10px] uppercase tracking-wider text-muted-foreground">Realized G/L</TableHead>
                                      <TableHead className="text-right" />
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {memberHoldings.map(h => {
                                      const hasMetrics = h.quantity !== null && h.quantity !== 0;
                                      const nativeCcy = h.quoteCurrency ?? h.currency;
                                      return (
                                        <TableRow key={h.id} className="hover:bg-muted/30 border-border/60">
                                          <TableCell className="text-xs">
                                            <button
                                              type="button"
                                              className="text-left hover:underline"
                                              onClick={(e) => { e.stopPropagation(); setEditingHolding(h); }}
                                              title="Edit this per-account holding row"
                                            >
                                              {h.accountName}
                                            </button>
                                          </TableCell>
                                          <TableCell className="text-right font-mono text-xs">
                                            {hasMetrics && h.quantity != null
                                              ? h.quantity.toLocaleString("en-CA", { minimumFractionDigits: 0, maximumFractionDigits: h.quantity % 1 === 0 ? 0 : 4 })
                                              : <span className="text-muted-foreground">--</span>}
                                          </TableCell>
                                          <TableCell className="text-right font-mono text-xs">
                                            {hasMetrics && h.avgCostPerShare != null
                                              ? formatCurrency(h.avgCostPerShare, nativeCcy)
                                              : <span className="text-muted-foreground">--</span>}
                                          </TableCell>
                                          <TableCell className="text-right font-mono text-xs font-medium">
                                            {hasMetrics && h.marketValueDisplay != null
                                              ? formatCurrency(h.marketValueDisplay, reportCcy)
                                              : <span className="text-muted-foreground">--</span>}
                                          </TableCell>
                                          <TableCell className="text-right text-xs">
                                            {hasMetrics && h.unrealizedGain != null ? (
                                              <span className={`font-mono ${h.unrealizedGain >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                                                {h.unrealizedGain >= 0 ? "+" : ""}{formatCurrency(h.unrealizedGain, nativeCcy)}
                                              </span>
                                            ) : <span className="text-muted-foreground">--</span>}
                                          </TableCell>
                                          <TableCell className="text-right text-xs">
                                            {h.realizedGain != null && h.realizedGain !== 0 ? (
                                              <span className={`font-mono ${h.realizedGain >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                                                {h.realizedGain >= 0 ? "+" : ""}{formatCurrency(h.realizedGain, nativeCcy)}
                                              </span>
                                            ) : <span className="text-muted-foreground">--</span>}
                                          </TableCell>
                                          <TableCell className="text-right">
                                            <Link
                                              href={`/transactions?portfolioHolding=${encodeURIComponent(h.name)}${h.accountId ? `&accountId=${h.accountId}` : ""}`}
                                              onClick={(e) => e.stopPropagation()}
                                              className="text-[11px] text-primary hover:underline whitespace-nowrap"
                                              title="View transactions for this holding in this account"
                                            >
                                              View txns →
                                            </Link>
                                          </TableCell>
                                        </TableRow>
                                      );
                                    })}
                                  </TableBody>
                                </Table>
                              </div>
                            )}

                            <div className="mt-3 pt-3 border-t border-border/50 flex justify-end gap-3">
                              {/* "View transactions" — same canonical
                                  holding across every account it lives in.
                                  Mirrors the existing
                                  /transactions?portfolioHolding=<name>
                                  contract; the per-account "View txns"
                                  links above scope to a single account.
                                  Per-account Edit lives on the account-name
                                  cell in the breakdown table above. */}
                              <Link
                                href={`/transactions?portfolioHolding=${encodeURIComponent(r.name)}`}
                                onClick={(e) => e.stopPropagation()}
                                className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline font-medium"
                              >
                                View transactions →
                              </Link>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </>
                  );
                })}
                {filteredHoldings.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                      No {filter === "all" ? "" : ASSET_TYPE_CONFIG[filter]?.label} holdings found.
                      {hideEmpty && data.holdings.length > 0 && (
                        <span className="block mt-1 text-xs">
                          Showing only positions with quantity &gt; 0.
                          <button
                            onClick={() => setHideEmpty(false)}
                            className="ml-1 underline hover:text-foreground"
                          >
                            Show all
                          </button>
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* ── ETF X-Ray (Combined) — dev only ──────────────────── */}
      {devMode && hasEtfData && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <Search className="h-4 w-4 text-indigo-500" />
                  <CardTitle className="text-base">ETF X-Ray</CardTitle>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Effective exposure across {etfXray.etfCount} ETF{etfXray.etfCount !== 1 ? "s" : ""} in your portfolio
                </p>
              </div>
              <div className="flex gap-1">
                {([
                  { key: "stocks" as const, label: "Stocks", icon: BarChart3 },
                  { key: "regions" as const, label: "Regions", icon: Globe2 },
                  { key: "sectors" as const, label: "Sectors", icon: Building2 },
                  { key: "etfs" as const, label: "Per ETF", icon: Layers },
                ]).map(tab => (
                  <Button
                    key={tab.key}
                    variant={etfXrayTab === tab.key ? "default" : "outline"}
                    size="sm"
                    className="text-xs h-7 px-2.5"
                    onClick={() => setEtfXrayTab(tab.key)}
                  >
                    <tab.icon className="h-3 w-3 mr-1" />
                    {tab.label}
                  </Button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {/* ── Stocks Tab: Aggregated look-through ── */}
            {etfXrayTab === "stocks" && (
              <div className="space-y-4">
                <p className="text-xs text-muted-foreground">
                  Your effective stock exposure across all ETFs, weighted by each ETF&apos;s portfolio allocation.
                </p>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-8">#</TableHead>
                        <TableHead>Stock</TableHead>
                        <TableHead>Ticker</TableHead>
                        <TableHead>Sector</TableHead>
                        <TableHead>Country</TableHead>
                        <TableHead className="text-right">Weight</TableHead>
                        <TableHead className="text-right">Value (CAD)</TableHead>
                        <TableHead className="w-28">Exposure</TableHead>
                        <TableHead>Via ETFs</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {etfXray.aggregatedStocks
                        .slice((stocksPage - 1) * STOCKS_PER_PAGE, stocksPage * STOCKS_PER_PAGE)
                        .map((s, i) => {
                          const globalIdx = (stocksPage - 1) * STOCKS_PER_PAGE + i;
                          return (
                            <TableRow key={s.ticker} className={`hover:bg-muted/30 transition-colors ${s.ticker === "OTHER" ? "bg-muted/20 border-t" : ""}`}>
                              <TableCell className="text-xs text-muted-foreground font-mono">{globalIdx + 1}</TableCell>
                              <TableCell className={`text-sm ${s.ticker === "OTHER" ? "italic text-muted-foreground" : "font-medium"}`}>{s.name}</TableCell>
                              <TableCell>
                                {s.ticker !== "OTHER" && <Badge variant="secondary" className="font-mono text-xs">{s.ticker}</Badge>}
                              </TableCell>
                              <TableCell>
                                <Badge
                                  variant="outline"
                                  className="text-[10px]"
                                  style={{
                                    borderColor: SECTOR_COLORS[s.sector] ?? "#64748b",
                                    color: SECTOR_COLORS[s.sector] ?? "#64748b",
                                  }}
                                >
                                  {s.sector}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground">{s.country}</TableCell>
                              <TableCell className="text-right">
                                <span className="text-sm font-mono font-semibold">{s.effectiveWeight.toFixed(1)}%</span>
                              </TableCell>
                              <TableCell className="text-right">
                                <span className="text-sm font-mono text-muted-foreground">{formatCurrency(s.effectiveValueDisplay, "CAD")}</span>
                              </TableCell>
                              <TableCell>
                                <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden">
                                  <div
                                    className="h-full rounded-full bg-indigo-500"
                                    style={{ width: `${Math.min(s.effectiveWeight * 10, 100)}%` }}
                                  />
                                </div>
                              </TableCell>
                              <TableCell>
                                <div className="flex gap-1 flex-wrap">
                                  {s.contributingEtfs.map((e, ei) => (
                                    <span key={`${e.symbol}-${ei}`} className="text-[10px] font-mono text-muted-foreground bg-muted px-1 py-0.5 rounded">
                                      {e.symbol} {e.weight}%
                                    </span>
                                  ))}
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                    </TableBody>
                  </Table>
                </div>
                {etfXray.aggregatedStocks.length > 0 && (() => {
                  const totalPages = Math.ceil(etfXray.aggregatedStocks.length / STOCKS_PER_PAGE);
                  const totalWeight = etfXray.aggregatedStocks.reduce((s, x) => s + x.effectiveWeight, 0);
                  return (
                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
                      <p className="text-xs text-muted-foreground">
                        {etfXray.aggregatedStocks.length} stocks · Total weight: {totalWeight.toFixed(1)}%
                      </p>
                      <div className="flex items-center gap-2">
                        {totalPages > 1 && (
                          <div className="flex items-center gap-1">
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 w-7 p-0"
                              disabled={stocksPage <= 1}
                              onClick={() => setStocksPage(p => p - 1)}
                            >
                              <ChevronLeft className="h-3 w-3" />
                            </Button>
                            <span className="text-xs text-muted-foreground px-1">
                              {stocksPage} / {totalPages}
                            </span>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 w-7 p-0"
                              disabled={stocksPage >= totalPages}
                              onClick={() => setStocksPage(p => p + 1)}
                            >
                              <ChevronRight className="h-3 w-3" />
                            </Button>
                          </div>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-xs gap-1.5"
                          onClick={() => exportStocksToCSV(etfXray.aggregatedStocks, etfXray.etfTotalValueDisplay, displayCurrency)}
                        >
                          <Download className="h-3 w-3" />
                          Export CSV
                        </Button>
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* ── Regions Tab ── */}
            {etfXrayTab === "regions" && (
              <div className="space-y-4">
                {regionData.length > 0 ? (
                  <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6">
                    <div className="w-48 h-48 shrink-0">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={regionData}
                            dataKey="pct"
                            nameKey="name"
                            cx="50%"
                            cy="50%"
                            innerRadius={45}
                            outerRadius={85}
                            strokeWidth={2}
                            stroke="var(--color-card)"
                          >
                            {regionData.map((d, i) => (
                              <Cell key={i} fill={d.color} />
                            ))}
                          </Pie>
                          <Tooltip content={<ExposurePieTooltip />} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="flex-1 space-y-2 min-w-0">
                      {regionData.map(d => (
                        <div key={d.name} className="flex items-center gap-2">
                          <div className="h-3 w-3 rounded-full shrink-0" style={{ background: d.color }} />
                          <span className="text-sm text-muted-foreground flex-1">{d.name}</span>
                          <div className="flex items-center gap-2">
                            <div className="w-24 h-2 rounded-full bg-muted overflow-hidden">
                              <div className="h-full rounded-full" style={{ width: `${d.pct}%`, background: d.color }} />
                            </div>
                            <span className="text-sm font-mono font-semibold w-12 text-right">{d.pct}%</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-8">No region data available.</p>
                )}
              </div>
            )}

            {/* ── Sectors Tab ── */}
            {etfXrayTab === "sectors" && (
              <div className="space-y-4">
                {sectorData.length > 0 ? (
                  <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6">
                    <div className="w-48 h-48 shrink-0">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={sectorData}
                            dataKey="pct"
                            nameKey="name"
                            cx="50%"
                            cy="50%"
                            innerRadius={45}
                            outerRadius={85}
                            strokeWidth={2}
                            stroke="var(--color-card)"
                          >
                            {sectorData.map((d, i) => (
                              <Cell key={i} fill={d.color} />
                            ))}
                          </Pie>
                          <Tooltip content={<ExposurePieTooltip />} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="flex-1 space-y-2 min-w-0">
                      {sectorData.map(d => (
                        <div key={d.name} className="flex items-center gap-2">
                          <div className="h-3 w-3 rounded-full shrink-0" style={{ background: d.color }} />
                          <span className="text-sm text-muted-foreground flex-1">{d.name}</span>
                          <div className="flex items-center gap-2">
                            <div className="w-24 h-2 rounded-full bg-muted overflow-hidden">
                              <div className="h-full rounded-full" style={{ width: `${d.pct}%`, background: d.color }} />
                            </div>
                            <span className="text-sm font-mono font-semibold w-12 text-right">{d.pct}%</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-8">No sector data available.</p>
                )}
              </div>
            )}

            {/* ── Per ETF Tab ── */}
            {etfXrayTab === "etfs" && (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Your ETF holdings and their weight in the ETF portfolio.
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>ETF</TableHead>
                      <TableHead>Fund Name</TableHead>
                      <TableHead>Account</TableHead>
                      <TableHead className="text-right">Holdings</TableHead>
                      <TableHead className="text-right">Portfolio Weight</TableHead>
                      <TableHead className="w-24"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {etfXray.etfs.map(etf => (
                      <TableRow key={`${etf.symbol}-${etf.account}`} className="hover:bg-muted/30 transition-colors">
                        <TableCell>
                          <Badge variant="secondary" className="font-mono text-xs">{etf.symbol}</Badge>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm font-medium">{etf.fullName}</span>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{etf.account}</TableCell>
                        <TableCell className="text-right text-sm font-mono text-muted-foreground">
                          {etf.totalHoldings.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right">
                          <span className="text-sm font-mono font-semibold">{etf.weightPct}%</span>
                        </TableCell>
                        <TableCell>
                          <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden">
                            <div
                              className="h-full rounded-full bg-indigo-500"
                              style={{ width: `${Math.min(etf.weightPct, 100)}%` }}
                            />
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Allocation Overview ────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* By Asset Type */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <PieChartIcon className="h-4 w-4 text-indigo-500" />
              <CardTitle className="text-base">By Asset Type</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-6">
              <div className="w-36 h-36 shrink-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={allocationByType}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={36}
                      outerRadius={64}
                      strokeWidth={2}
                      stroke="var(--color-card)"
                    >
                      {allocationByType.map((d, i) => (
                        <Cell key={i} fill={d.color} />
                      ))}
                    </Pie>
                    <Tooltip content={<ExposurePieTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="flex-1 space-y-2 min-w-0">
                {allocationByType.map(d => (
                  <div key={d.name} className="flex items-center gap-2">
                    <div className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: d.color }} />
                    <span className="text-xs text-muted-foreground flex-1">{d.name}</span>
                    <span className="text-xs font-medium tabular-nums">{formatCurrency(d.value, displayCurrency)} ({d.pct}%)</span>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* By Account */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <Wallet className="h-4 w-4 text-violet-500" />
              <CardTitle className="text-base">By Account</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-6">
              <div className="w-36 h-36 shrink-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={allocationByAccount}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={36}
                      outerRadius={64}
                      strokeWidth={2}
                      stroke="var(--color-card)"
                    >
                      {allocationByAccount.map((_, i) => (
                        <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip content={<ExposurePieTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="flex-1 space-y-1.5 min-w-0 max-h-36 overflow-y-auto">
                {allocationByAccount.map((d, i) => (
                  <div key={d.name} className="flex items-center gap-2">
                    <div className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                    <span className="text-xs text-muted-foreground flex-1 truncate">{d.name}</span>
                    <span className="text-xs font-medium tabular-nums">{formatCurrency(d.value, displayCurrency)} ({d.pct}%)</span>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Performance vs Benchmarks — dev only ─────────────── */}
      {devMode && <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Performance vs Benchmarks</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                Compare major indices over time (% change)
              </p>
            </div>
            <div className="flex gap-1">
              {(["ytd", "1y", "3y", "5y"] as const).map(p => (
                <Button
                  key={p}
                  variant={benchmarkPeriod === p ? "default" : "outline"}
                  size="sm"
                  className="text-xs h-7 px-2"
                  onClick={() => setBenchmarkPeriod(p)}
                >
                  {p.toUpperCase()}
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {benchmarkLoading ? (
            <div className="h-64 flex items-center justify-center">
              <div className="h-8 w-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : benchmarks.length > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={benchmarkChartData}>
                  <XAxis
                    dataKey="date"
                    fontSize={10}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={v => {
                      const d = new Date(v + "T00:00:00");
                      return d.toLocaleDateString("en-CA", { month: "short", year: "2-digit" });
                    }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    fontSize={10}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={v => `${v > 0 ? "+" : ""}${v}%`}
                  />
                  <Tooltip
                    content={<GlassTooltip formatter={(v) => `${Number(v) > 0 ? "+" : ""}${Number(v).toFixed(2)}%`} />}
                    labelFormatter={label => {
                      const d = new Date(label + "T00:00:00");
                      return d.toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric" });
                    }}
                  />
                  <Legend />
                  {benchmarks.map(b => (
                    <Line
                      key={b.symbol}
                      type="monotone"
                      dataKey={b.name}
                      stroke={b.color}
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
              <div className="mt-4 grid grid-cols-2 lg:grid-cols-4 gap-3">
                {benchmarks.map(b => (
                  <div key={b.symbol} className="flex items-center gap-2 p-2 rounded-lg bg-muted/30">
                    <div className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: b.color }} />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-muted-foreground truncate">{b.name}</p>
                      <p className={`text-sm font-mono font-semibold ${b.returnPct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                        {b.returnPct >= 0 ? "+" : ""}{b.returnPct.toFixed(2)}%
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="h-64 flex items-center justify-center text-muted-foreground text-sm">
              Unable to load benchmark data. Try again later.
            </div>
          )}
        </CardContent>
      </Card>}

      {/* ── Holdings by Account (Collapsible) ───────────────────
          Issue #25 (decision 2026-05-01): the standalone "By Holding"
          panel was folded into the "All Holdings" table above — each
          top-level row there is the canonical-holding rollup, and the
          expand region surfaces the per-account breakdown + drill-down.
          This Holdings-by-Account panel stays as-is per the same decision
          ("the per-account button row is unchanged"). */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-indigo-500" />
            <CardTitle className="text-base">Holdings by Account</CardTitle>
          </div>
          <p className="text-xs text-muted-foreground">Click to expand account details</p>
        </CardHeader>
        <CardContent className="space-y-1">
          {accountGroups.map(([accountName, items]) => {
            const isExpanded = expandedAccounts.has(accountName);
            const etfs = items.filter(h => h.assetType === "etf").length;
            const stocks = items.filter(h => h.assetType === "stock").length;
            const cryptos = items.filter(h => h.assetType === "crypto").length;
            const cash = items.filter(h => h.assetType === "cash").length;
            // Inline aggregate stats per account — sum the per-holding
            // *Display fields the API already emits in displayCurrency.
            const acctMktValue = items.reduce((s, h) => s + (h.marketValueDisplay ?? 0), 0);
            const acctUnrealized = items.reduce((s, h) => s + (h.unrealizedGainDisplay ?? 0), 0);
            // Realized + dividends are emitted in each holding's quote ccy,
            // not display ccy — fold via marketValue/marketValueDisplay
            // ratio (the same "implied FX" the per-row toolbar mode uses).
            const acctRealized = items.reduce((s, h) => {
              if (h.realizedGain == null) return s;
              const conv = (h.marketValue && h.marketValueDisplay && h.marketValue !== 0)
                ? h.marketValueDisplay / h.marketValue
                : 1;
              return s + h.realizedGain * conv;
            }, 0);

            return (
              <div key={accountName} className="border rounded-lg overflow-hidden">
                <button
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors text-left"
                  onClick={() => toggleAccount(accountName)}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="font-medium text-sm truncate">{accountName}</span>
                    <Badge variant="outline" className="text-[10px] flex-shrink-0">
                      {items.length} holding{items.length !== 1 ? "s" : ""}
                    </Badge>
                    <div className="hidden sm:flex items-center gap-1.5">
                      {etfs > 0 && <Badge variant="secondary" className="text-[10px] h-4" style={{ borderColor: ASSET_TYPE_CONFIG.etf.color, color: ASSET_TYPE_CONFIG.etf.color }}>{etfs} ETF</Badge>}
                      {stocks > 0 && <Badge variant="secondary" className="text-[10px] h-4" style={{ borderColor: ASSET_TYPE_CONFIG.stock.color, color: ASSET_TYPE_CONFIG.stock.color }}>{stocks} Stock</Badge>}
                      {cryptos > 0 && <Badge variant="secondary" className="text-[10px] h-4" style={{ borderColor: ASSET_TYPE_CONFIG.crypto.color, color: ASSET_TYPE_CONFIG.crypto.color }}>{cryptos} Crypto</Badge>}
                      {cash > 0 && <Badge variant="secondary" className="text-[10px] h-4" style={{ borderColor: ASSET_TYPE_CONFIG.cash.color, color: ASSET_TYPE_CONFIG.cash.color }}>{cash} Cash</Badge>}
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="hidden md:flex items-center gap-3 text-xs">
                      <div className="text-right">
                        <p className="text-muted-foreground text-[10px]">Mkt Value</p>
                        <p className="font-mono font-medium">{formatCurrency(acctMktValue, displayCurrency)}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-muted-foreground text-[10px]">Unrealized</p>
                        <p className={`font-mono font-medium ${acctUnrealized >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                          {acctUnrealized >= 0 ? "+" : ""}{formatCurrency(acctUnrealized, displayCurrency)}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-muted-foreground text-[10px]">Realized</p>
                        <p className={`font-mono font-medium ${acctRealized >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                          {acctRealized !== 0 ? `${acctRealized >= 0 ? "+" : ""}${formatCurrency(acctRealized, displayCurrency)}` : "--"}
                        </p>
                      </div>
                    </div>
                    {isExpanded ? <ChevronUp className="h-4 w-4 text-muted-foreground flex-shrink-0" /> : <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />}
                  </div>
                </button>
                <AnimatePresence>
                  {isExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden"
                    >
                      <div className="border-t">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Holding</TableHead>
                              <TableHead className="text-right">Qty</TableHead>
                              <TableHead className="text-right">Avg Cost</TableHead>
                              <TableHead className="text-right">Price</TableHead>
                              <TableHead className="text-right">Mkt Value</TableHead>
                              <TableHead className="text-right">Unrealized G/L</TableHead>
                              <TableHead className="text-right">Day Chg</TableHead>
                              <TableHead className="text-right" />
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {items.map(h => {
                              const hasMetrics = h.quantity !== null && h.quantity !== 0;
                              return (
                                <TableRow key={h.id} className="hover:bg-muted/30 transition-colors">
                                  <TableCell>
                                    <div className="flex items-center gap-2">
                                      {h.image && <img src={h.image} alt="" className="h-5 w-5 rounded-full" />}
                                      <div>
                                        <span className="font-medium text-sm">{h.name}</span>
                                        {h.symbol && <Badge variant="secondary" className="ml-1 font-mono text-[10px] h-4 px-1">{h.symbol}</Badge>}
                                      </div>
                                    </div>
                                  </TableCell>
                                  <TableCell className="text-right font-mono text-sm">
                                    {hasMetrics && h.quantity != null
                                      ? h.quantity.toLocaleString("en-CA", { minimumFractionDigits: 0, maximumFractionDigits: h.quantity % 1 === 0 ? 0 : 4 })
                                      : <span className="text-muted-foreground text-xs">--</span>}
                                  </TableCell>
                                  <TableCell className="text-right font-mono text-sm">
                                    {hasMetrics && h.avgCostPerShare != null
                                      ? formatCurrency(h.avgCostPerShare, h.quoteCurrency ?? h.currency)
                                      : <span className="text-muted-foreground text-xs">--</span>}
                                  </TableCell>
                                  <TableCell className="text-right font-mono text-sm">
                                    {h.price != null ? formatCurrency(h.price, h.quoteCurrency ?? h.currency) : "--"}
                                  </TableCell>
                                  <TableCell className="text-right font-mono text-sm font-medium">
                                    {hasMetrics && h.marketValueDisplay != null
                                      ? formatCurrency(h.marketValueDisplay, displayCurrency)
                                      : <span className="text-muted-foreground text-xs">--</span>}
                                  </TableCell>
                                  <TableCell className="text-right">
                                    {hasMetrics && h.unrealizedGain != null ? (
                                      <div>
                                        <p className={`text-xs font-mono font-medium ${h.unrealizedGain >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                                          {h.unrealizedGain >= 0 ? "+" : ""}{formatCurrency(h.unrealizedGain, h.quoteCurrency ?? h.currency)}
                                        </p>
                                        {h.unrealizedGainPct != null && (
                                          <p className={`text-[10px] font-mono ${h.unrealizedGainPct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                                            {h.unrealizedGainPct >= 0 ? "+" : ""}{h.unrealizedGainPct.toFixed(2)}%
                                          </p>
                                        )}
                                      </div>
                                    ) : <span className="text-muted-foreground text-xs">--</span>}
                                  </TableCell>
                                  <TableCell className="text-right">
                                    <ChangeBadge value={h.changePct} />
                                  </TableCell>
                                  <TableCell className="text-right">
                                    <Link
                                      href={`/transactions?portfolioHolding=${encodeURIComponent(h.name)}${h.accountId ? `&accountId=${h.accountId}` : ""}`}
                                      onClick={(e) => e.stopPropagation()}
                                      className="text-[11px] text-primary hover:underline whitespace-nowrap"
                                      title="View transactions for this holding in this account"
                                    >
                                      View txns →
                                    </Link>
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Edit / create holding dialog — wraps the shared
          <HoldingEditForm> from src/components/holdings/holding-edit-form.tsx.
          Issue #100: the inline HoldingEditDialog that previously lived
          here was extracted so /settings/investments can mount the SAME
          form. Edits never silently diverge between the two surfaces
          because there's only one component. */}
      <Dialog
        open={editingHolding !== null || creatingHolding !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditingHolding(null);
            setCreatingHolding(null);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingHolding ? "Edit Holding" : "Add Holding"}
            </DialogTitle>
          </DialogHeader>
          {(editingHolding !== null || creatingHolding !== null) && (
            <HoldingEditForm
              holdingId={editingHolding?.id}
              defaultAccountId={creatingHolding?.accountId}
              initialHolding={
                editingHolding
                  ? holdingFromEnriched(editingHolding)
                  : undefined
              }
              onCancel={() => {
                setEditingHolding(null);
                setCreatingHolding(null);
              }}
              onSave={() => {
                setEditingHolding(null);
                setCreatingHolding(null);
                setLoading(true);
                fetch(
                  `/api/portfolio/overview?currency=${encodeURIComponent(displayCurrency)}`,
                )
                  .then((r) => r.json())
                  .then((d) => {
                    setData(d);
                    setLoading(false);
                  });
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

// ── Helper ──────────────────────────────────────────────────────────
function buildBenchmarkChartData(benchmarks: BenchmarkData[]): Record<string, unknown>[] {
  if (benchmarks.length === 0) return [];
  const dateMap = new Map<string, Record<string, unknown>>();
  for (const b of benchmarks) {
    for (const pt of b.series) {
      if (!dateMap.has(pt.date)) dateMap.set(pt.date, { date: pt.date });
      dateMap.get(pt.date)![b.name] = pt.value;
    }
  }
  return Array.from(dateMap.values()).sort((a, b) =>
    (a.date as string).localeCompare(b.date as string)
  );
}
