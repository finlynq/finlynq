/**
 * Portfolio-page shared types + constants (FINLYNQ-118 Phase 3).
 *
 * Extracted verbatim from portfolio/page.tsx so the page, the data hooks
 * (_hooks/use-portfolio.ts), and the sub-surface components (_components/)
 * all share one definition and never drift.
 */

import {
  BarChart3, Coins, DollarSign, Layers, Gem, type LucideIcon,
} from "lucide-react";
import { isMetalCurrency } from "@/lib/fx/supported-currencies";

// Mirror of /api/portfolio/overview's `canonicalKey()`. Keep in sync with
// the server-side function — both must produce the same key for a given
// holding so the row-membership lookup matches the API's `byHolding` array.
export function clientCanonicalKey(
  h: { assetType: string; symbol: string | null; currency: string; name: string },
): string {
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
export const PIE_COLORS = [
  "#6366f1", "#06b6d4", "#10b981", "#f59e0b", "#f43f5e",
  "#8b5cf6", "#14b8a6", "#84cc16", "#ec4899", "#f97316",
];

export const ASSET_TYPE_CONFIG: Record<string, { label: string; color: string; icon: LucideIcon }> = {
  etf: { label: "ETFs", color: "#6366f1", icon: Layers },
  stock: { label: "Stocks", color: "#06b6d4", icon: BarChart3 },
  crypto: { label: "Crypto", color: "#f59e0b", icon: Coins },
  cash: { label: "Cash", color: "#10b981", icon: DollarSign },
  metal: { label: "Metals", color: "#ca8a04", icon: Gem },
};

export const REGION_COLORS: Record<string, string> = {
  US: "#6366f1", Canada: "#10b981", Europe: "#f59e0b", Japan: "#f43f5e",
  Asia: "#8b5cf6", Emerging: "#06b6d4", Other: "#64748b",
};

export const SECTOR_COLORS: Record<string, string> = {
  Tech: "#6366f1", Healthcare: "#10b981", Financials: "#f59e0b",
  Consumer: "#f43f5e", Industrials: "#06b6d4", Energy: "#8b5cf6",
  Materials: "#14b8a6", Other: "#64748b",
};

// ── Types ───────────────────────────────────────────────────────────
export type AssetType = "etf" | "stock" | "crypto" | "cash" | "metal";

export type EnrichedHolding = {
  id: number;
  accountId: number | null;
  accountName: string;
  name: string;
  // FINLYNQ-194: the decrypted `securities.name_ct` for this position's
  // security, or null when the read-flip is off / the row is un-backfilled /
  // no DEK. When present it is the SINGLE source of the display name (a user
  // rename in the Securities catalog), preferred over Yahoo `quoteName` and the
  // per-position `name` so All Holdings + Top Movers + By Account all agree.
  securityName: string | null;
  symbol: string | null;
  // FINLYNQ-174: human-readable long name from the quote layer (Yahoo
  // `meta.shortName`). Null for cash/metals/custom holdings and on a
  // warm-price-cache hit (the cache doesn't persist the name). Resolved
  // for display via `holdingDescription(...)`.
  quoteName: string | null;
  currency: string;
  assetType: AssetType;
  price: number | null;
  change: number | null;
  changePct: number | null;
  dayChangeDisplay: number | null;
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

export type ByHoldingRow = {
  key: string;
  symbol: string | null;
  name: string;
  // FINLYNQ-174: human-readable long name (Yahoo `meta.shortName`) carried
  // up from the per-account members. Null when no member has a quote
  // description (cash/metals/custom or warm-cache hit). For the canonical
  // row `name` is the ticker code itself, so this is the descriptive label.
  description: string | null;
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

export type AggregatedStock = {
  ticker: string;
  name: string;
  sector: string;
  country: string;
  effectiveWeight: number;
  effectiveValueDisplay: number;
  contributingEtfs: { symbol: string; weight: number }[];
};

export type EtfDetail = {
  symbol: string;
  name: string;
  account: string;
  fullName: string;
  totalHoldings: number;
  valueCAD: number;
  weightPct: number;
};

export type OverviewData = {
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
  topGainers: Mover[];
  topLosers: Mover[];
};

// FINLYNQ-190: a consolidated Top Movers row — one per ticker (canonical
// security key), with the day-change $ summed across accounts and a
// value-weighted aggregate %. Keyed on the canonical key, NOT a per-position id.
export type Mover = {
  key: string;
  symbol: string | null;
  name: string;
  image: string | null;
  dayChangeDisplay: number;
  changePct: number | null;
};

export type BenchmarkData = {
  symbol: string;
  name: string;
  color: string;
  returnPct: number;
  series: { date: string; value: number }[];
};

export type FilterType = "all" | AssetType;
export type EtfXrayTab = "stocks" | "regions" | "sectors" | "etfs";
