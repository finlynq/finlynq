/**
 * IBKR FlexQuery XML → canonical RawTransaction[] emitter (issue #64).
 *
 * Replaces the file-upload path that used to go through
 * `@finlynq/import-connectors/ibkr` (currently broken). The parsing logic
 * is the same as the connector's `parse-xml.ts` — IB Flex XML is a regular
 * attribute-driven format — but the output goes straight into the unified
 * import pipeline as RawTransaction[] instead of the connector's
 * ExternalTransaction wire shape.
 *
 * Output rows mirror what `ofx.ts` emits so the downstream pipeline
 * (`previewImport` / `executeImport`) sees a consistent shape regardless
 * of which broker statement format the user uploaded:
 *
 *  | IBKR XML row                  | Output rows
 *  | ---                           | ---
 *  | <Trade buy/sell="BUY">        | TWO rows sharing a `linkId`:
 *  |                               |  - cash leg: amount = netCash, portfolioHolding = "Cash"
 *  |                               |  - position leg: amount = qty * tradePrice, quantity = +qty,
 *  |                               |    portfolioHolding = symbol
 *  |                               | (commission already inside netCash; surfaced via note)
 *  | <Trade buy/sell="SELL">       | mirror with negative qty
 *  | <Trade assetCategory="CASH">  | TWO rows = same-account FX conversion: each leg's
 *  |                               | account = synthetic id for that currency. Both share linkId.
 *  | <CashTransaction>             | ONE cash-sleeve row, payee = `${type} ${symbol}`
 *  | <FxTranslation>               | ONE cash-sleeve row, FX revaluation P&L
 *
 * Sign convention preserved: amount and quantity follow `qty > 0` = grew.
 */

import type { RawTransaction } from "@/lib/import-pipeline";
import { sourceTagFor } from "@/lib/tx-source";
import type { OfxCanonicalResult, OfxExternalAccount } from "./ofx";

// ── XML helpers (lightweight, attribute-driven — IB Flex is regular) ──

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseAttributes(attrBlock: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w[\w-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrBlock))) {
    out[m[1]] = decodeEntities(m[2]);
  }
  return out;
}

function findElements(
  region: string,
  tagName: string,
): Array<Record<string, string>> {
  const re = new RegExp(`<${tagName}\\b([^>]*)/?>`, "g");
  const out: Array<Record<string, string>> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(region))) {
    out.push(parseAttributes(m[1]));
  }
  return out;
}

function findFlexStatementRegions(
  xml: string,
): Array<{ attrs: Record<string, string>; region: string }> {
  const out: Array<{ attrs: Record<string, string>; region: string }> = [];
  const openRe = /<FlexStatement\b([^>]*)>/g;
  let openMatch: RegExpExecArray | null;
  while ((openMatch = openRe.exec(xml))) {
    const attrs = parseAttributes(openMatch[1]);
    const start = openMatch.index + openMatch[0].length;
    const closeIdx = xml.indexOf("</FlexStatement>", start);
    if (closeIdx === -1) continue;
    out.push({ attrs, region: xml.slice(start, closeIdx) });
  }
  return out;
}

function isoDate(raw: string | undefined): string {
  if (!raw) return "";
  const datePart = raw.split(";")[0];
  if (datePart.length !== 8) return raw;
  return `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}`;
}

function num(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 0;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

// ── canonical emitter ────────────────────────────────────────────────

const CASH_HOLDING_NAME = "Cash";

/** Synthetic external id format: `ibkr:acct:<accountId>:<currency>`. One per
 *  per-currency cash sleeve so the user can map (or auto-create) a Finlynq
 *  account for each. */
export function ibkrAccountExternalId(accountId: string, currency: string): string {
  return `ibkr:acct:${accountId}:${currency}`;
}

function ibkrAccountDisplayName(
  accountName: string,
  accountId: string,
  currency: string,
): string {
  const base = accountName?.trim() || accountId;
  return `${base} (${accountId} · ${currency})`;
}

interface ParsedTrade {
  accountId: string;
  date: string;
  currency: string;
  assetCategory: string;
  symbol: string;
  description: string;
  quantity: number;
  tradePrice: number;
  netCash: number;
  buySell: "BUY" | "SELL";
  ibCommission: number;
  tradeId: string | undefined;
}

interface ParsedCashTxn {
  accountId: string;
  date: string;
  currency: string;
  symbol: string;
  type: string;
  amount: number;
  description: string;
  actionId?: string;
  tradeId?: string;
}

interface ParsedFxTranslation {
  accountId: string;
  date: string;
  currency: string;
  amount: number;
  description: string;
}

interface ParsedStatement {
  accountId: string;
  accountName: string;
  baseCurrency: string;
  fromDate: string | null;
  toDate: string | null;
  cashTransactions: ParsedCashTxn[];
  trades: ParsedTrade[];
  fxTranslations: ParsedFxTranslation[];
}

function parseStatementXml(
  attrs: Record<string, string>,
  region: string,
): ParsedStatement {
  const accountInfo = findElements(region, "AccountInformation")[0] ?? {};
  const accountId =
    attrs.accountId ?? accountInfo.accountId ?? accountInfo.acctAlias ?? "";
  const accountName =
    accountInfo.name ?? accountInfo.acctAlias ?? accountId;
  const baseCurrency = accountInfo.currency ?? attrs.currency ?? "USD";

  const cashTransactions: ParsedCashTxn[] = findElements(
    region,
    "CashTransaction",
  ).map((a) => ({
    accountId: a.accountId || accountId,
    date: isoDate(a.dateTime || a.settleDate || a.reportDate),
    currency: a.currency || baseCurrency,
    symbol: a.symbol || "",
    type: a.type || "",
    amount: num(a.amount),
    description: a.description || "",
    actionId: a.actionID || a.actionId || undefined,
    tradeId: a.tradeID || a.tradeId || undefined,
  }));

  const trades: ParsedTrade[] = findElements(region, "Trade").map((a) => {
    const buySell = (a.buySell || "").toUpperCase() as "BUY" | "SELL";
    return {
      accountId: a.accountId || accountId,
      date: isoDate(a.dateTime || a.tradeDate),
      currency: a.currency || baseCurrency,
      assetCategory: a.assetCategory || "STK",
      symbol: a.symbol || "",
      description: a.description || "",
      quantity: num(a.quantity),
      tradePrice: num(a.tradePrice),
      netCash: num(a.netCash),
      buySell: buySell === "SELL" ? "SELL" : "BUY",
      ibCommission: num(a.ibCommission),
      tradeId: a.tradeID || a.tradeId || undefined,
    };
  });

  const fxTranslations: ParsedFxTranslation[] = findElements(
    region,
    "FxTranslation",
  ).map((a) => ({
    accountId: a.accountId || accountId,
    date: isoDate(a.reportDate || a.date || ""),
    currency: a.currency || baseCurrency,
    amount: num(a.translationPnl ?? a.amount),
    description: a.description || "FX Translation P&L",
  }));

  return {
    accountId,
    accountName,
    baseCurrency,
    fromDate: attrs.fromDate ? isoDate(attrs.fromDate) : null,
    toDate: attrs.toDate ? isoDate(attrs.toDate) : null,
    cashTransactions,
    trades,
    fxTranslations,
  };
}

/**
 * Cancellation-triplet detection. IB encodes a withhold + cancel + re-issue
 * (or any analogous reversal pattern) by reusing the same `actionId` across
 * the three rows. We sum amounts inside the group; if it nets to zero, drop
 * the group entirely (it cancelled itself out). Otherwise emit ONE row with
 * the net amount on the latest date.
 *
 * Ported from `packages/import-connectors/src/ibkr/transform.ts` —
 * load-bearing for matching IB's actual statement balances.
 */
function netCancellationTriplets(rows: ParsedCashTxn[]): ParsedCashTxn[] {
  const groups = new Map<string, ParsedCashTxn[]>();
  const passthrough: ParsedCashTxn[] = [];
  for (const r of rows) {
    if (!r.actionId) {
      passthrough.push(r);
      continue;
    }
    const key = `${r.accountId} ${r.currency} ${r.actionId}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }

  const netted: ParsedCashTxn[] = [];
  for (const [, arr] of groups) {
    if (arr.length === 1) {
      netted.push(arr[0]);
      continue;
    }
    const sum = arr.reduce((s, r) => s + r.amount, 0);
    if (Math.abs(sum) < 1e-9) continue; // self-cancelled
    const first = arr[0];
    const latestDate = arr.reduce((d, r) => (r.date > d ? r.date : d), first.date);
    netted.push({
      ...first,
      date: latestDate,
      amount: round2(sum),
      description: `${first.description} (net of ${arr.length} cancellation legs)`,
    });
  }
  return [...passthrough, ...netted];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Map an IB cash-transaction `type` to a payee prefix the rule engine /
 *  `pickInvestmentCategoryByPayee` can match on. */
function payeeForCashType(type: string, symbol: string, description: string): string {
  const t = type.trim();
  if (!t) return description || "IBKR cash";
  if (symbol) return `${t} ${symbol}`;
  return description ? `${t} – ${description}` : t;
}

function emitTrade(
  trade: ParsedTrade,
  accountName: string,
  sourceTag: string,
  out: RawTransaction[],
): void {
  // Forex trade — collapse into a same-account currency conversion. Both
  // legs go to per-currency synthetic accounts that the user maps.
  if (trade.assetCategory === "CASH") {
    const parts = trade.symbol.split(".");
    if (parts.length !== 2) return;
    const baseCcy = parts[0];
    const quoteCcy = parts[1];
    const ourCcy = trade.currency;
    if (ourCcy !== baseCcy && ourCcy !== quoteCcy) return;
    const otherCcy = ourCcy === baseCcy ? quoteCcy : baseCcy;
    const ourLegAmount = trade.netCash;
    const otherLegAmount =
      ourCcy === baseCcy
        ? -trade.netCash
        : trade.quantity * (trade.buySell === "BUY" ? 1 : -1);

    const linkId = `ibkr:fx:${trade.accountId}:${trade.tradeId ?? `${trade.date}:${trade.symbol}`}`;
    out.push({
      date: trade.date,
      account: ibkrAccountExternalId(trade.accountId, ourCcy),
      amount: round2(ourLegAmount),
      payee: `FX ${trade.symbol} ${trade.buySell}`,
      currency: ourCcy,
      tags: sourceTag,
      fitId: `${linkId}:our`,
      linkId,
      portfolioHolding: CASH_HOLDING_NAME,
    });
    out.push({
      date: trade.date,
      account: ibkrAccountExternalId(trade.accountId, otherCcy),
      amount: round2(otherLegAmount),
      payee: `FX ${trade.symbol} ${trade.buySell}`,
      currency: otherCcy,
      tags: sourceTag,
      fitId: `${linkId}:other`,
      linkId,
      portfolioHolding: CASH_HOLDING_NAME,
    });
    return;
  }

  // Securities trade — cash leg + position leg.
  const externalId = ibkrAccountExternalId(trade.accountId, trade.currency);
  const linkId = `ibkr:trade:${trade.accountId}:${trade.tradeId ?? `${trade.date}:${trade.symbol}:${trade.quantity}`}`;
  const sideLabel = trade.buySell;
  const ticker = trade.symbol || trade.description || "Unknown";
  const positionAmount = trade.quantity * trade.tradePrice; // signed by trade.quantity in IB

  out.push({
    date: trade.date,
    account: externalId,
    amount: round2(trade.netCash),
    payee: `${sideLabel} ${ticker}`,
    currency: trade.currency,
    note: trade.ibCommission
      ? `Commission ${round2(Math.abs(trade.ibCommission))}`
      : (trade.description || ""),
    tags: sourceTag,
    fitId: `${linkId}:cash`,
    linkId,
    portfolioHolding: CASH_HOLDING_NAME,
  });
  out.push({
    date: trade.date,
    account: externalId,
    amount: round2(positionAmount),
    payee: `${sideLabel} ${ticker}`,
    currency: trade.currency,
    note: trade.description || "",
    tags: sourceTag,
    fitId: `${linkId}:position`,
    linkId,
    quantity: trade.quantity,
    portfolioHolding: ticker,
  });
}

function emitCashTxn(
  row: ParsedCashTxn,
  sourceTag: string,
  out: RawTransaction[],
): void {
  if (!row.date || row.amount === 0) return;
  out.push({
    date: row.date,
    account: ibkrAccountExternalId(row.accountId, row.currency),
    amount: round2(row.amount),
    payee: payeeForCashType(row.type, row.symbol, row.description),
    currency: row.currency,
    note: row.description || "",
    tags: sourceTag,
    fitId: row.actionId ?? row.tradeId ??
      `ibkr:cash:${row.accountId}:${row.date}:${row.type}:${row.amount}:${row.symbol}`,
    portfolioHolding: CASH_HOLDING_NAME,
  });
}

function emitFxTranslation(
  fx: ParsedFxTranslation,
  sourceTag: string,
  out: RawTransaction[],
): void {
  if (!fx.date || fx.amount === 0) return;
  out.push({
    date: fx.date,
    account: ibkrAccountExternalId(fx.accountId, fx.currency),
    amount: round2(fx.amount),
    payee: fx.description || "FX Translation P&L",
    currency: fx.currency,
    tags: sourceTag,
    fitId: `ibkr:fxpnl:${fx.accountId}:${fx.date}:${fx.currency}`,
    portfolioHolding: CASH_HOLDING_NAME,
  });
}

/**
 * Parse an IBKR FlexQuery XML file and emit canonical rows. Reuses the
 * same `OfxCanonicalResult` shape so the dispatcher in /api/import/preview
 * stays uniform across all investment formats.
 */
export function parseIbkrFlexXmlToCanonical(raw: string): OfxCanonicalResult {
  const sourceTag = sourceTagFor("ibkr-xml");
  const externalAccounts: OfxExternalAccount[] = [];
  const seenAccounts = new Set<string>();
  const rows: RawTransaction[] = [];

  const ensureAccount = (
    accountId: string,
    accountName: string,
    currency: string,
  ): void => {
    const externalId = ibkrAccountExternalId(accountId, currency);
    if (seenAccounts.has(externalId)) return;
    seenAccounts.add(externalId);
    externalAccounts.push({
      externalId,
      displayName: ibkrAccountDisplayName(accountName, accountId, currency),
      type: "Brokerage",
      currency,
      isInvestment: true,
      accountId,
    });
  };

  const blocks = findFlexStatementRegions(raw);
  for (const b of blocks) {
    const stmt = parseStatementXml(b.attrs, b.region);
    if (!stmt.accountId) continue;

    const netted = netCancellationTriplets(stmt.cashTransactions);
    for (const row of netted) {
      ensureAccount(stmt.accountId, stmt.accountName, row.currency);
      emitCashTxn(row, sourceTag, rows);
    }

    for (const t of stmt.trades) {
      if (!t.date) continue;
      if (t.assetCategory === "CASH") {
        const parts = t.symbol.split(".");
        if (parts.length === 2) {
          ensureAccount(stmt.accountId, stmt.accountName, parts[0]);
          ensureAccount(stmt.accountId, stmt.accountName, parts[1]);
        }
      } else {
        ensureAccount(stmt.accountId, stmt.accountName, t.currency);
      }
      emitTrade(t, stmt.accountName, sourceTag, rows);
    }

    for (const fx of stmt.fxTranslations) {
      ensureAccount(stmt.accountId, stmt.accountName, fx.currency);
      emitFxTranslation(fx, sourceTag, rows);
    }
  }

  // Aggregate date range
  const allDates = rows.map((r) => r.date).filter((d) => d).sort();
  const dateRange = allDates.length
    ? { start: allDates[0], end: allDates[allDates.length - 1] }
    : null;

  return {
    format: "ibkr-xml",
    externalAccounts,
    rows,
    dateRange,
    balances: [],
  };
}
