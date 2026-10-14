"use client";

/**
 * Holdings-by-Account collapsible sub-surface (FINLYNQ-118 Phase 3).
 *
 * Extracted verbatim from portfolio/page.tsx. Issue #25 (decision 2026-05-01):
 * the standalone "By Holding" panel was folded into the "All Holdings" table;
 * this Holdings-by-Account panel stays as-is. The `accountGroups` array (with
 * its `(a ?? "").localeCompare(...)` null-guard) is computed on the page and
 * passed in; expand state stays on the page.
 *
 * Hide empty (2026-10-14): like All Holdings, rows with no current position
 * (no units and no value) can be hidden, and an account left with none drops
 * out. The account header still totals EVERY holding, so realized gains on
 * closed positions keep counting; it says how many rows are hidden.
 */

import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { Wallet, ChevronDown, ChevronUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/currency";
import { buildTxDrillUrl } from "@/lib/transactions/drill-url";
import { safeName } from "@/lib/safe-name";
import { DayChange } from "./portfolio-ui";
import { holdingDescription } from "./holding-description";
import { ASSET_TYPE_CONFIG, type EnrichedHolding } from "../_types";

/** No current position: no units and no value (the All Holdings rule). */
export const isEmptyHoldingRow = (h: Pick<EnrichedHolding, "quantity" | "marketValueDisplay">) =>
  (h.quantity ?? 0) === 0 && (h.marketValueDisplay ?? 0) === 0;

export function HoldingsByAccount({
  accountGroups,
  expandedAccounts,
  toggleAccount,
  displayCurrency,
  hideEmpty,
  setHideEmpty,
}: {
  accountGroups: [string, EnrichedHolding[]][];
  expandedAccounts: Set<string>;
  toggleAccount: (name: string) => void;
  displayCurrency: string;
  hideEmpty: boolean;
  setHideEmpty: (v: boolean) => void;
}) {
  const groups = accountGroups
    .map(([accountName, all]) => {
      const visible = hideEmpty ? all.filter((h) => !isEmptyHoldingRow(h)) : all;
      return { accountName, all, items: visible, hidden: all.length - visible.length };
    })
    .filter((g) => g.items.length > 0);
  const hiddenAccounts = accountGroups.length - groups.length;
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-indigo-500" />
            <CardTitle className="text-base">Holdings by Account</CardTitle>
          </div>
          <Button
            variant={hideEmpty ? "default" : "outline"}
            size="sm"
            className="text-xs h-7"
            onClick={() => setHideEmpty(!hideEmpty)}
            title="Hide holdings with no current position (no units and no value, e.g. fully sold)"
          >
            {hideEmpty ? "Hiding empty" : "Showing all"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Click to expand account details
          {hideEmpty && hiddenAccounts > 0
            ? ` · ${hiddenAccounts} account${hiddenAccounts === 1 ? "" : "s"} with nothing held hidden`
            : ""}
        </p>
      </CardHeader>
      <CardContent className="space-y-1">
        {groups.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Nothing is held in any account right now.{" "}
            <button type="button" className="text-primary hover:underline" onClick={() => setHideEmpty(false)}>
              Show all
            </button>
          </p>
        )}
        {groups.map(({ accountName, all, items, hidden }) => {
          const isExpanded = expandedAccounts.has(accountName);
          const etfs = items.filter(h => h.assetType === "etf").length;
          const stocks = items.filter(h => h.assetType === "stock").length;
          const cryptos = items.filter(h => h.assetType === "crypto").length;
          const cash = items.filter(h => h.assetType === "cash").length;
          const metals = items.filter(h => h.assetType === "metal").length;
          // Inline aggregate stats per account — sum the per-holding
          // *Display fields the API already emits in displayCurrency. Over
          // EVERY holding, hidden ones included (a closed position still
          // carries realized gain).
          const acctMktValue = all.reduce((s, h) => s + (h.marketValueDisplay ?? 0), 0);
          const acctUnrealized = all.reduce((s, h) => s + (h.unrealizedGainDisplay ?? 0), 0);
          // Realized gain is emitted by the API in displayCurrency as
          // `realizedGainDisplay` (historical-per-closure FX when the lots
          // read-flip is on — matching the realized-gains report). Sum it
          // directly instead of re-folding native via an implied current-rate.
          const acctRealized = all.reduce((s, h) => s + (h.realizedGainDisplay ?? 0), 0);

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
                  {hidden > 0 && (
                    <span className="text-[10px] text-muted-foreground flex-shrink-0">{hidden} empty hidden</span>
                  )}
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
                            // FINLYNQ-194: single source of names. When the
                            // security catalog name resolves (read-flip on +
                            // backfilled), it WINS — a user rename beats Yahoo's
                            // quoteName and the per-position name, so this view
                            // agrees with All Holdings + Top Movers. Otherwise
                            // keep FINLYNQ-174 behavior: prefer the quote long
                            // name, fall back to the stored holding name
                            // (null-safe) so the cell is never empty.
                            const secName = (h.securityName ?? "").trim();
                            const label = (secName.length > 0 ? secName : null)
                              ?? holdingDescription({ quoteName: h.quoteName, name: h.name, symbol: h.symbol })
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
                                {/* FINLYNQ-279: this panel always renders Mkt Value in the
                                    display currency, so Avg Cost + Price are shown in the display
                                    currency too (derived from the *Display fields ÷ qty) — a
                                    USD cash sleeve reads C$1.36 avg / C$1.42 price, matching the
                                    combined row, instead of a native $1.00 next to a CAD value. */}
                                <TableCell className="text-right font-mono text-sm">
                                  {hasMetrics && h.costBasisDisplay != null && h.quantity != null && h.quantity !== 0
                                    ? formatCurrency(h.costBasisDisplay / h.quantity, displayCurrency)
                                    : <span className="text-muted-foreground text-xs">--</span>}
                                </TableCell>
                                <TableCell className="text-right font-mono text-sm">
                                  {hasMetrics && h.marketValueDisplay != null && h.quantity != null && h.quantity !== 0
                                    ? formatCurrency(h.marketValueDisplay / h.quantity, displayCurrency)
                                    : "--"}
                                </TableCell>
                                <TableCell className="text-right font-mono text-sm font-medium">
                                  {hasMetrics && h.marketValueDisplay != null
                                    ? formatCurrency(h.marketValueDisplay, displayCurrency)
                                    : <span className="text-muted-foreground text-xs">--</span>}
                                </TableCell>
                                <TableCell className="text-right">
                                  {/* FINLYNQ-279: this panel shows Mkt Value in the display
                                      currency, so Unrealized must be the display-currency value
                                      too (it includes the FX-on-cost gain for foreign holdings)
                                      — native $0.000 next to a CAD market value was the mismatch.
                                      Pct is derived from the display figures so $ and % agree. */}
                                  {hasMetrics && h.unrealizedGainDisplay != null ? (
                                    (() => {
                                      const pct = h.costBasisDisplay ? (h.unrealizedGainDisplay / h.costBasisDisplay) * 100 : null;
                                      return (
                                        <div>
                                          <p className={`text-xs font-mono font-medium ${h.unrealizedGainDisplay >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                                            {h.unrealizedGainDisplay >= 0 ? "+" : ""}{formatCurrency(h.unrealizedGainDisplay, displayCurrency)}
                                          </p>
                                          {pct != null && (
                                            <p className={`text-[10px] font-mono ${pct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                                              {pct >= 0 ? "+" : ""}{pct.toFixed(2)}%
                                            </p>
                                          )}
                                        </div>
                                      );
                                    })()
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
