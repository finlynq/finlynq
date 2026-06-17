"use client";

/**
 * All Holdings table sub-surface (FINLYNQ-118 Phase 3).
 *
 * Extracted verbatim from portfolio/page.tsx. Issue #25 restructure: top-level
 * rows are canonical-holding rollups (one row per ticker / cash sleeve /
 * currency code); the expand region surfaces the per-account breakdown +
 * drill-down. Sort / filter / hide-empty / expand state + the derived
 * `filteredHoldings` + `holdingsByCanonicalKey` are owned by the page and
 * passed in; this component is presentational.
 */

import Link from "next/link";
import { useState } from "react";
import { ChevronDown, ChevronUp, Download, Layers } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LotInspectorDialog } from "@/components/portfolio/lot-inspector-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/currency";
import { buildTxDrillUrl } from "@/lib/transactions/drill-url";
import { exportByHoldingToCSV } from "./csv";
import { holdingDescription } from "./holding-description";
import {
  ASSET_TYPE_CONFIG,
  type ByHoldingRow,
  type EnrichedHolding,
  type FilterType,
  type OverviewData,
} from "../_types";

type SortField = "name" | "marketValueDisplay" | "unrealizedGainPct";

// Hoisted to module scope so it isn't re-created on every HoldingsTable render
// (react-hooks/static-components, FINLYNQ-119). The active sort state is passed
// in rather than closed over.
function SortIcon({
  field,
  sortField,
  sortDir,
}: {
  field: SortField;
  sortField: SortField;
  sortDir: "asc" | "desc";
}) {
  if (sortField !== field) return null;
  return sortDir === "asc" ? (
    <ChevronUp className="h-3 w-3 inline ml-0.5" />
  ) : (
    <ChevronDown className="h-3 w-3 inline ml-0.5" />
  );
}

export function HoldingsTable({
  data,
  displayCurrency,
  filteredHoldings,
  holdingsByCanonicalKey,
  filter,
  setFilter,
  hideEmpty,
  setHideEmpty,
  sortField,
  sortDir,
  handleSort,
  expandedRows,
  toggleRow,
  setEditingHolding,
}: {
  data: OverviewData;
  displayCurrency: string;
  filteredHoldings: ByHoldingRow[];
  holdingsByCanonicalKey: Map<string, EnrichedHolding[]>;
  filter: FilterType;
  setFilter: (f: FilterType) => void;
  hideEmpty: boolean;
  setHideEmpty: (v: boolean) => void;
  sortField: SortField;
  sortDir: "asc" | "desc";
  handleSort: (field: SortField) => void;
  expandedRows: Set<string>;
  toggleRow: (key: string) => void;
  setEditingHolding: (h: EnrichedHolding) => void;
}) {
  const { summary, byType } = data;

  // FINLYNQ-176 — read-only lot inspector (opened per-account-holding row).
  const [inspect, setInspect] = useState<{
    holdingId: number;
    accountId: number | null;
    holdingName: string;
    accountName: string;
  } | null>(null);

  return (
    <>
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
              {(["all", "etf", "stock", "crypto", "metal", "cash"] as const).map(t => (
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
                  Holding <SortIcon field="name" sortField={sortField} sortDir={sortDir} />
                </TableHead>
                <TableHead className="text-right">Total Qty</TableHead>
                <TableHead className="text-right">Avg Cost</TableHead>
                <TableHead className="text-right cursor-pointer select-none" onClick={() => handleSort("marketValueDisplay")}>
                  Mkt Value <SortIcon field="marketValueDisplay" sortField={sortField} sortDir={sortDir} />
                </TableHead>
                <TableHead className="text-right cursor-pointer select-none" onClick={() => handleSort("unrealizedGainPct")}>
                  Unrealized G/L <SortIcon field="unrealizedGainPct" sortField={sortField} sortDir={sortDir} />
                </TableHead>
                <TableHead className="text-right">Realized G/L</TableHead>
                <TableHead className="text-right">Accounts</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredHoldings.map(r => {
                const typeConf = ASSET_TYPE_CONFIG[r.assetType];
                const isExpanded = expandedRows.has(r.key);
                // FINLYNQ-174: human-readable description for the single-line
                // Holding cell. `r.name` is the canonical key (= ticker for
                // equities), so prefer the quote long name; null-safe fallback.
                const description = holdingDescription({ quoteName: r.description, name: r.name, symbol: r.symbol });
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
                        {/* FINLYNQ-174: single-line Holding cell — symbol badge
                            + human-readable description + asset-type badge,
                            with the Short badge inline. `description` resolves
                            the quote long name (Yahoo shortName) with a fallback
                            to the stored name, null-safe; `--` when neither is a
                            meaningful description (cash/metals/custom). */}
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {r.image && <img src={r.image} alt="" className="h-5 w-5 rounded-full flex-shrink-0" />}
                          {r.symbol && <Badge variant="secondary" className="font-mono text-[10px] h-4 px-1">{r.symbol}</Badge>}
                          {description ? (
                            <span className="font-medium text-sm">{description}</span>
                          ) : (
                            <span className="text-muted-foreground text-xs">--</span>
                          )}
                          <Badge
                            variant="outline"
                            className="text-[10px] h-4 px-1"
                            ref={(el) => {
                              if (el && typeConf?.color) {
                                el.style.borderColor = typeConf.color;
                                el.style.color = typeConf.color;
                              }
                            }}
                          >
                            {typeConf?.label ?? r.assetType}
                          </Badge>
                          {r.totalQty < 0 && (
                            <Badge
                              variant="outline"
                              className="text-[10px] h-4 px-1 border-rose-500 text-rose-600 dark:border-rose-400 dark:text-rose-400"
                              title="Net-short position — sales exceeded buys. Lots are tracked via holding_lots.side='short'; close by buying to cover."
                            >
                              Short
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className={`text-right font-mono text-sm ${r.totalQty < 0 ? "text-rose-600 dark:text-rose-400" : ""}`}>
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
                                        <TableCell className={`text-right font-mono text-xs ${hasMetrics && h.quantity != null && h.quantity < 0 ? "text-rose-600 dark:text-rose-400" : ""}`}>
                                          {hasMetrics && h.quantity != null
                                            ? h.quantity.toLocaleString("en-CA", { minimumFractionDigits: 0, maximumFractionDigits: h.quantity % 1 === 0 ? 0 : 4 })
                                            : <span className="text-muted-foreground">--</span>}
                                          {hasMetrics && h.quantity != null && h.quantity < 0 && (
                                            <span className="ml-1 text-[9px] uppercase tracking-wider text-rose-500" title="Short position">short</span>
                                          )}
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
                                          <div className="flex items-center justify-end gap-2 whitespace-nowrap">
                                            <button
                                              type="button"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                setInspect({
                                                  holdingId: h.id,
                                                  accountId: h.accountId ?? null,
                                                  holdingName: h.name,
                                                  accountName: h.accountName,
                                                });
                                              }}
                                              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                                              title="Inspect lots: see how this holding's lots are consumed"
                                            >
                                              <Layers className="h-3 w-3" /> Lots
                                            </button>
                                            <Link
                                              href={buildTxDrillUrl({ portfolioHolding: h.name, accountId: h.accountId ? String(h.accountId) : undefined })}
                                              onClick={(e) => e.stopPropagation()}
                                              className="text-[11px] text-primary hover:underline"
                                              title="View transactions for this holding in this account"
                                            >
                                              View txns →
                                            </Link>
                                          </div>
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
                              href={buildTxDrillUrl({ portfolioHolding: r.name })}
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
    <LotInspectorDialog
      open={inspect !== null}
      onOpenChange={(open) => { if (!open) setInspect(null); }}
      holdingId={inspect?.holdingId ?? null}
      accountId={inspect?.accountId ?? null}
      holdingName={inspect?.holdingName}
      accountName={inspect?.accountName}
    />
    </>
  );
}
