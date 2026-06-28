/**
 * Portfolio CSV export helpers (FINLYNQ-118 Phase 3).
 *
 * Extracted verbatim from portfolio/page.tsx. `exportHoldingsToCSV` was
 * removed 2026-05-01 (issue #25): the All Holdings table now renders
 * canonical-holding rows from `byHolding`, not per-(account, holding) rows
 * from `holdings`. The CSV button uses `exportByHoldingToCSV` below; users
 * who want a per-account dump can use the Holdings-by-Account panel's
 * per-row drill-down or the /api/portfolio endpoint.
 */

import type { AggregatedStock, ByHoldingRow } from "../_types";

function downloadCSV(csv: string, filename: string) {
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportStocksToCSV(stocks: AggregatedStock[], etfTotalValueDisplay: number, displayCurrency: string) {
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

// CSV is always emitted in the display currency (a single-currency export),
// regardless of the table's "Holding currency" toggle. Column order mirrors the
// All Holdings table left→right: Avg Cost, Current Price, Cost Basis, Mkt Value,
// Day G/L, then the gain columns.
export function exportByHoldingToCSV(rows: ByHoldingRow[], displayCurrency: string) {
  const header = ["#", "Holding", "Description", "Symbol", "Type", "Total Qty", `Avg Cost ${displayCurrency}`, `Current Price ${displayCurrency}`, `Cost Basis ${displayCurrency}`, `Mkt Value ${displayCurrency}`, `Day G/L ${displayCurrency}`, "Day %", "Unrealized G/L", "Unrealized %", "Realized G/L", "Dividends", "Total Return", "Total Return %", "Accounts", "Weight %"];
  const out = rows.map((r, i) => [
    i + 1,
    `"${r.name}"`,
    // FINLYNQ-174: quote long name (Yahoo shortName); blank when none.
    `"${r.description ?? ""}"`,
    r.symbol ?? "",
    r.assetType,
    r.totalQty,
    r.avgCostDisplay?.toFixed(4) ?? "",
    r.currentPriceDisplay?.toFixed(4) ?? "",
    r.costBasisDisplay.toFixed(2),
    r.marketValueDisplay.toFixed(2),
    r.dayChangeDisplay?.toFixed(2) ?? "",
    r.dayChangePct?.toFixed(2) ?? "",
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
  const totalDay = rows.reduce((s, r) => s + (r.dayChangeDisplay ?? 0), 0);
  const totalUnreal = rows.reduce((s, r) => s + r.unrealizedGainDisplay, 0);
  // 20 columns. Build the TOTAL row positionally so the indices can't drift:
  // [1]=label, [9]=Mkt Value, [10]=Day G/L, [12]=Unrealized G/L, [19]=Weight %.
  const total = Array<string>(header.length).fill("");
  total[1] = "TOTAL";
  total[9] = totalMV.toFixed(2);
  total[10] = totalDay.toFixed(2);
  total[12] = totalUnreal.toFixed(2);
  total[19] = "100.00";
  out.push(total as unknown as string[]);
  const csv = [header.join(","), ...out.map(r => (r as (string | number | null)[]).join(","))].join("\n");
  downloadCSV(csv, `portfolio-by-holding-${new Date().toISOString().slice(0, 10)}.csv`);
}
