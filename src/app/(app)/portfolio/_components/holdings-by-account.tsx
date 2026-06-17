"use client";

/**
 * Holdings-by-Account collapsible sub-surface (FINLYNQ-118 Phase 3).
 *
 * Extracted verbatim from portfolio/page.tsx. Issue #25 (decision 2026-05-01):
 * the standalone "By Holding" panel was folded into the "All Holdings" table;
 * this Holdings-by-Account panel stays as-is. The `accountGroups` array (with
 * its `(a ?? "").localeCompare(...)` null-guard) is computed on the page and
 * passed in; expand state stays on the page.
 */

import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { Wallet, ChevronDown, ChevronUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/currency";
import { buildTxDrillUrl } from "@/lib/transactions/drill-url";
import { safeName } from "@/lib/safe-name";
import { DayChange } from "./portfolio-ui";
import { holdingDescription } from "./holding-description";
import { ASSET_TYPE_CONFIG, type EnrichedHolding } from "../_types";

export function HoldingsByAccount({
  accountGroups,
  expandedAccounts,
  toggleAccount,
  displayCurrency,
}: {
  accountGroups: [string, EnrichedHolding[]][];
  expandedAccounts: Set<string>;
  toggleAccount: (name: string) => void;
  displayCurrency: string;
}) {
  return (
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
          const metals = items.filter(h => h.assetType === "metal").length;
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
                    {etfs > 0 && (
                      <Badge
                        variant="secondary"
                        className="text-[10px] h-4"
                        ref={(el: HTMLElement | null) => {
                          if (el) {
                            el.style.borderColor = ASSET_TYPE_CONFIG.etf.color;
                            el.style.color = ASSET_TYPE_CONFIG.etf.color;
                          }
                        }}
                      >
                        {etfs} ETF
                      </Badge>
                    )}
                    {stocks > 0 && (
                      <Badge
                        variant="secondary"
                        className="text-[10px] h-4"
                        ref={(el: HTMLElement | null) => {
                          if (el) {
                            el.style.borderColor = ASSET_TYPE_CONFIG.stock.color;
                            el.style.color = ASSET_TYPE_CONFIG.stock.color;
                          }
                        }}
                      >
                        {stocks} Stock
                      </Badge>
                    )}
                    {cryptos > 0 && (
                      <Badge
                        variant="secondary"
                        className="text-[10px] h-4"
                        ref={(el: HTMLElement | null) => {
                          if (el) {
                            el.style.borderColor = ASSET_TYPE_CONFIG.crypto.color;
                            el.style.color = ASSET_TYPE_CONFIG.crypto.color;
                          }
                        }}
                      >
                        {cryptos} Crypto
                      </Badge>
                    )}
                    {cash > 0 && (
                      <Badge
                        variant="secondary"
                        className="text-[10px] h-4"
                        ref={(el: HTMLElement | null) => {
                          if (el) {
                            el.style.borderColor = ASSET_TYPE_CONFIG.cash.color;
                            el.style.color = ASSET_TYPE_CONFIG.cash.color;
                          }
                        }}
                      >
                        {cash} Cash
                      </Badge>
                    )}
                    {metals > 0 && (
                      <Badge
                        variant="secondary"
                        className="text-[10px] h-4"
                        ref={(el: HTMLElement | null) => {
                          if (el) {
                            el.style.borderColor = ASSET_TYPE_CONFIG.metal.color;
                            el.style.color = ASSET_TYPE_CONFIG.metal.color;
                          }
                        }}
                      >
                        {metals} Metal
                      </Badge>
                    )}
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
                            // FINLYNQ-174: prefer the quote long name (Yahoo
                            // shortName); fall back to the stored holding name
                            // (null-safe) so the cell is never empty.
                            const label = holdingDescription({ quoteName: h.quoteName, name: h.name, symbol: h.symbol })
                              ?? safeName(h.name, "Holding", h.id);
                            return (
                              <TableRow key={h.id} className="hover:bg-muted/30 transition-colors">
                                <TableCell>
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    {h.image && <img src={h.image} alt="" className="h-5 w-5 rounded-full flex-shrink-0" />}
                                    {h.symbol && <Badge variant="secondary" className="font-mono text-[10px] h-4 px-1">{h.symbol}</Badge>}
                                    <span className="font-medium text-sm">{label}</span>
                                    {hasMetrics && h.quantity != null && h.quantity < 0 && (
                                      <Badge variant="outline" className="text-[10px] h-4 px-1 border-rose-500 text-rose-600 dark:border-rose-400 dark:text-rose-400" title="Net-short position">Short</Badge>
                                    )}
                                  </div>
                                </TableCell>
                                <TableCell className={`text-right font-mono text-sm ${hasMetrics && h.quantity != null && h.quantity < 0 ? "text-rose-600 dark:text-rose-400" : ""}`}>
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
                                  <DayChange pct={h.changePct} amount={h.dayChangeDisplay} currency={displayCurrency} />
                                </TableCell>
                                <TableCell className="text-right">
                                  <Link
                                    href={buildTxDrillUrl({ portfolioHolding: h.name, accountId: h.accountId ? String(h.accountId) : undefined })}
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
  );
}
