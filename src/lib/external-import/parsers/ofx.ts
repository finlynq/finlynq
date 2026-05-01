/**
 * OFX/QFX → canonical RawTransaction[] emitter (issue #64).
 *
 * Wraps the SGML-tolerant `parseOfx()` / `parseOfxInvestments()` from
 * `src/lib/ofx-parser.ts` and produces the import-pipeline's canonical row
 * shape, covering BOTH bank-style and investment-style statements in one
 * call.
 *
 * What it emits per OFX construct:
 *
 *  | OFX construct                     | Output rows
 *  | ---                               | ---
 *  | <STMTTRN> in <STMTRS>/<CCSTMTRS>  | One RawTransaction (payee=NAME, fitId=FITID)
 *  | <BUYSTOCK>/<BUYMF>/<BUYOPT>/...   | TWO rows sharing a `linkId`:
 *  |                                   |  - cash leg: amount=TOTAL (negative), portfolioHolding="Cash"
 *  |                                   |  - position leg: amount=UNITS*UNITPRICE, quantity=+UNITS, portfolioHolding=ticker name
 *  | <SELLSTOCK>/<SELLMF>/...          | TWO rows sharing a `linkId`:
 *  |                                   |  - position leg: amount=UNITS*UNITPRICE (negative), quantity=-UNITS
 *  |                                   |  - cash leg:     amount=TOTAL (positive), portfolioHolding="Cash"
 *  | <COMMISSION>/<FEES> in trade      | ONE additional cash-leg row tagged `trade-link:<linkId>`
 *  | <INCOME>                          | ONE cash-sleeve row, payee includes incomeType + ticker
 *  | <REINVEST>                        | TWO rows: an income credit + an offsetting buy on the same holding
 *  | <INVBANKTRAN>                     | ONE cash-sleeve row (deposit / withdrawal / fee — no security)
 *  | <TRANSFER>                        | ONE position-leg row (in-kind movement, signed by `units`)
 *
 * Sign convention: amount and quantity follow the WP/external-import rule
 * (`amt > 0 + qty > 0` = position grew). The portfolio aggregator classifies
 * a buy by `qty > 0` regardless of amount sign — DO NOT FLIP signs in the
 * parser. (CLAUDE.md gotcha "Portfolio aggregator".)
 *
 * Holding name vs ticker: every position-leg row sets `portfolioHolding` to
 * the **holding NAME** (`secName` from SECLIST, or the uppercased ticker
 * when SECLIST is empty). The resolver's dual-index lookup picks up an
 * existing row by that name; on a miss the resolver auto-creates with that
 * name. (import-connectors.md invariant #2.)
 *
 * `linkId` here is a parser-side TEMP value used to group sibling rows when
 * the import-pipeline emits them. The pipeline persists `link_id` as-is —
 * the "server-generated only" rule applies to MCP `record_trade` /
 * `createTransferPair`, not import. The pipeline accepts a `linkId` from
 * the row and uses it directly.
 */

import { parseOfx, parseOfxInvestments } from "@/lib/ofx-parser";
import type {
  OfxInvestmentParseResult,
  OfxInvestmentTrade,
  OfxInvestmentIncome,
  OfxInvestmentTransfer,
} from "@/lib/ofx-parser";
import type { RawTransaction } from "@/lib/import-pipeline";
import { sourceTagFor, type FormatTag } from "@/lib/tx-source";

/** Synthetic external id format for OFX bank/CC accounts. */
export function ofxBankAccountExternalId(bankId: string, acctId: string): string {
  return `ofx:acct:${bankId}:${acctId}`;
}

/** Synthetic external id format for OFX investment accounts. */
export function ofxInvestmentAccountExternalId(brokerId: string, acctId: string): string {
  return `ofx:invacct:${brokerId}:${acctId}`;
}

/** A brokerage / bank account inventoried from the file — surfaced to the
 *  client mapping dialog so the user can bind to a Finlynq account. */
export interface OfxExternalAccount {
  externalId: string;
  /** Display label: includes broker id, account number, type, currency. */
  displayName: string;
  /** Inferred Finlynq account type. */
  type: "Brokerage" | "Bank" | "Credit Card";
  currency: string;
  isInvestment: boolean;
  /** For investment statements only. Used by the canonical emitter to
   *  prefix per-row payees and to bind. */
  brokerId?: string;
  accountId: string;
}

export interface OfxCanonicalResult {
  /** Format tag emitted on every row (`source:ofx` or `source:qfx` or
   *  `source:ibkr-xml`). */
  format: FormatTag;
  /** All accounts found in the file. The user binds each to a Finlynq
   *  account in the mapping dialog. */
  externalAccounts: OfxExternalAccount[];
  /** Canonical rows. The `account` field on each row is the synthetic
   *  external id (`ofx:acct:…` / `ofx:invacct:…`) — the pipeline wrapper
   *  rewrites it to the bound Finlynq account name before
   *  `previewImport()`. */
  rows: RawTransaction[];
  /** Date range across the whole file. */
  dateRange: { start: string; end: string } | null;
  /** Per-statement balances surfaced for the preview dialog. */
  balances: Array<{
    externalId: string;
    balanceAmount: number | null;
    balanceDate: string | null;
  }>;
}

/**
 * Parse an OFX/QFX file and return canonical rows. Bank, credit-card, and
 * investment statements are all handled in one pass.
 *
 * The `format` arg is the format tag (one of the FORMAT_TAGS from
 * tx-source.ts). For QFX files the caller passes `"qfx"`; the actual
 * SGML/XML parser is the same.
 */
export function parseOfxToCanonical(
  raw: string,
  format: FormatTag = "ofx",
): OfxCanonicalResult {
  const sourceTag = sourceTagFor(format);
  const externalAccounts: OfxExternalAccount[] = [];
  const rows: RawTransaction[] = [];
  const balances: OfxCanonicalResult["balances"] = [];

  // ── Bank / credit-card path ──────────────────────────────────────────
  const bank = parseOfx(raw);
  if (bank.transactions.length > 0 || bank.account.accountId) {
    const externalId = ofxBankAccountExternalId(
      bank.account.bankId,
      bank.account.accountId,
    );
    const acctType = (bank.account.accountType || "").toUpperCase();
    externalAccounts.push({
      externalId,
      displayName: ofxBankDisplayName(bank.account, bank.currency),
      type: acctType.includes("CREDIT") ? "Credit Card" : "Bank",
      currency: bank.currency,
      isInvestment: false,
      accountId: bank.account.accountId,
    });
    balances.push({
      externalId,
      balanceAmount: bank.balanceAmount,
      balanceDate: bank.balanceDate,
    });
    for (const t of bank.transactions) {
      rows.push({
        date: t.date,
        account: externalId,
        amount: t.amount,
        payee: t.payee,
        currency: bank.currency,
        note: t.memo,
        tags: sourceTag,
        fitId: t.fitId,
      });
    }
  }

  // ── Investment path ─────────────────────────────────────────────────
  const investments = parseOfxInvestments(raw);
  for (const stmt of investments) {
    const externalId = ofxInvestmentAccountExternalId(
      stmt.account.brokerId,
      stmt.account.accountId,
    );
    externalAccounts.push({
      externalId,
      displayName: ofxInvestmentDisplayName(stmt),
      type: "Brokerage",
      currency: stmt.currency,
      isInvestment: true,
      brokerId: stmt.account.brokerId,
      accountId: stmt.account.accountId,
    });
    balances.push({
      externalId,
      balanceAmount: stmt.availCash,
      balanceDate: stmt.dateRange?.end ?? null,
    });

    emitInvestmentRows(stmt, externalId, sourceTag, rows);
  }

  // Aggregate date range
  const allDates = rows.map((r) => r.date).filter((d) => d).sort();
  const dateRange = allDates.length
    ? { start: allDates[0], end: allDates[allDates.length - 1] }
    : null;

  return { format, externalAccounts, rows, dateRange, balances };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function ofxBankDisplayName(
  account: { bankId: string; accountId: string; accountType: string },
  currency: string,
): string {
  const masked = account.accountId
    ? `…${account.accountId.slice(-4)}`
    : "(unknown)";
  const type = account.accountType || "BANK";
  return `${type} ${masked} (${currency})`;
}

function ofxInvestmentDisplayName(stmt: OfxInvestmentParseResult): string {
  const masked = stmt.account.accountId
    ? `…${stmt.account.accountId.slice(-4)}`
    : "(unknown)";
  const broker = stmt.account.brokerId || "Brokerage";
  return `${broker} ${masked} (${stmt.currency})`;
}

/** Cash-sleeve holding name. Per CLAUDE.md "investment-account constraint",
 *  every investment-account row needs a portfolioHolding. Pure cash legs
 *  (commission, deposit, dividend credit) carry "Cash" — the resolver maps
 *  it to the per-account Cash holding. */
const CASH_HOLDING_NAME = "Cash";

/** Holding name to record on the position leg. Falls back to ticker when
 *  SECLIST didn't supply a friendly name; falls back to "Unknown holding"
 *  if the file has neither (extremely rare — would be a malformed file). */
function holdingNameFor(secName: string, ticker: string): string {
  if (secName?.trim()) return secName.trim();
  if (ticker?.trim()) return ticker.trim().toUpperCase();
  return "Unknown holding";
}

/** Format a stable, parser-side linkId for the trade pair so the cash leg,
 *  position leg, and any commission/fee row share the same value. The
 *  pipeline persists this verbatim. */
function tradeLinkId(externalId: string, fitId: string): string {
  return `ofx:trade:${externalId}:${fitId}`;
}

function emitInvestmentRows(
  stmt: OfxInvestmentParseResult,
  externalId: string,
  sourceTag: string,
  out: RawTransaction[],
): void {
  for (const e of stmt.entries) {
    if (e.kind === "trade") {
      emitTrade(e, externalId, stmt.currency, sourceTag, out);
    } else if (e.kind === "income") {
      emitIncome(e, externalId, stmt.currency, sourceTag, out);
    } else if (e.kind === "transfer") {
      emitTransfer(e, externalId, stmt.currency, sourceTag, out);
    }
  }
}

function emitTrade(
  trade: OfxInvestmentTrade,
  externalId: string,
  defaultCurrency: string,
  sourceTag: string,
  out: RawTransaction[],
): void {
  const linkId = tradeLinkId(externalId, trade.fitId);
  const holdingName = holdingNameFor(trade.secName, trade.ticker);
  const currency = trade.currency || defaultCurrency;
  const sideLabel = trade.side === "BUY" ? "BUY" : "SELL";
  const tickerLabel = trade.ticker || trade.secName || holdingName;

  // OFX <TOTAL> is the all-in cash impact, signed per OFX convention:
  // negative for buys (cash leaves the account), positive for sells.
  // We use it directly for the cash leg.
  const cashImpact = trade.total;
  // <UNITS> in OFX is positive in the file regardless of side. We sign the
  // quantity per the WP/import convention (qty > 0 on buy, qty < 0 on sell).
  const signedUnits = trade.side === "BUY" ? trade.units : -trade.units;
  const positionAmount = trade.units * trade.unitPrice * (trade.side === "BUY" ? 1 : -1);

  // Cash leg (acts on the per-account Cash sleeve).
  out.push({
    date: trade.date,
    account: externalId,
    amount: cashImpact,
    payee: `${sideLabel} ${tickerLabel}`,
    currency,
    note: trade.memo || "",
    tags: sourceTag,
    fitId: `${trade.fitId}:cash`,
    linkId,
    portfolioHolding: CASH_HOLDING_NAME,
  });

  // Position leg (acts on the security holding — quantity-bearing).
  out.push({
    date: trade.date,
    account: externalId,
    amount: positionAmount,
    payee: `${sideLabel} ${tickerLabel}`,
    currency,
    note: trade.memo || "",
    tags: sourceTag,
    fitId: `${trade.fitId}:position`,
    linkId,
    quantity: signedUnits,
    portfolioHolding: holdingName,
  });

  // Commission / fees: separate negative cash-sleeve rows tagged with the
  // shared linkId. Both are positive in the OFX file; we negate for the
  // cash impact (commission is always an outflow).
  if (trade.commission > 0) {
    out.push({
      date: trade.date,
      account: externalId,
      amount: -Math.abs(trade.commission),
      payee: `Commission ${tickerLabel}`,
      currency,
      tags: `${sourceTag},trade-link:${linkId}`,
      fitId: `${trade.fitId}:commission`,
      linkId,
      portfolioHolding: CASH_HOLDING_NAME,
    });
  }
  if (trade.fees > 0) {
    out.push({
      date: trade.date,
      account: externalId,
      amount: -Math.abs(trade.fees),
      payee: `Fees ${tickerLabel}`,
      currency,
      tags: `${sourceTag},trade-link:${linkId}`,
      fitId: `${trade.fitId}:fees`,
      linkId,
      portfolioHolding: CASH_HOLDING_NAME,
    });
  }
}

function emitIncome(
  inc: OfxInvestmentIncome,
  externalId: string,
  defaultCurrency: string,
  sourceTag: string,
  out: RawTransaction[],
): void {
  const currency = inc.currency || defaultCurrency;
  const ticker = inc.ticker || inc.secName || "";
  const label = inc.incomeType || "INCOME";
  // Investment-aware auto-categorize will pick this up later via the rule
  // engine + `pickInvestmentCategoryByPayee`. Just emit a clean payee that
  // includes both the kind (DIV / INTEREST / CGLONG) and the security so
  // the rules can match on substring.
  const payee = ticker ? `${label} ${ticker}` : label;
  out.push({
    date: inc.date,
    account: externalId,
    amount: Math.abs(inc.total),
    payee,
    currency,
    note: inc.memo || "",
    tags: sourceTag,
    fitId: inc.fitId,
    portfolioHolding: CASH_HOLDING_NAME,
  });
}

function emitTransfer(
  t: OfxInvestmentTransfer,
  externalId: string,
  defaultCurrency: string,
  sourceTag: string,
  out: RawTransaction[],
): void {
  const currency = t.currency || defaultCurrency;
  const ticker = t.ticker || t.secName || "";
  const holdingName = holdingNameFor(t.secName, t.ticker);

  if (t.subKind === "INVBANKTRAN") {
    // Plain cash deposit / withdrawal / fee tied to the brokerage cash
    // sleeve. No security side.
    out.push({
      date: t.date,
      account: externalId,
      amount: t.total,
      payee: t.memo || (t.total >= 0 ? "Deposit" : "Withdrawal"),
      currency,
      tags: sourceTag,
      fitId: t.fitId,
      portfolioHolding: CASH_HOLDING_NAME,
    });
    return;
  }

  if (t.subKind === "REINVEST") {
    // Two rows: an income credit (positive) + an offsetting buy of the
    // same holding (cash leg negative + position leg positive units).
    // Share a linkId across all three legs so the UI sees them as siblings.
    const linkId = tradeLinkId(externalId, t.fitId);
    const cashCredit = Math.abs(t.total);
    const buyCash = -Math.abs(t.total);
    const positionAmount = t.units * t.unitPrice;
    out.push({
      date: t.date,
      account: externalId,
      amount: cashCredit,
      payee: ticker ? `REINVEST ${t.incomeType ?? "DIV"} ${ticker}` : `REINVEST ${t.incomeType ?? "DIV"}`,
      currency,
      note: t.memo || "",
      tags: sourceTag,
      fitId: `${t.fitId}:income`,
      linkId,
      portfolioHolding: CASH_HOLDING_NAME,
    });
    out.push({
      date: t.date,
      account: externalId,
      amount: buyCash,
      payee: `BUY ${ticker || holdingName} (reinvest)`,
      currency,
      tags: sourceTag,
      fitId: `${t.fitId}:cash`,
      linkId,
      portfolioHolding: CASH_HOLDING_NAME,
    });
    out.push({
      date: t.date,
      account: externalId,
      amount: positionAmount,
      payee: `BUY ${ticker || holdingName} (reinvest)`,
      currency,
      tags: sourceTag,
      fitId: `${t.fitId}:position`,
      linkId,
      quantity: Math.abs(t.units),
      portfolioHolding: holdingName,
    });
    return;
  }

  // TRANSFER: in-kind security movement. We emit one position-leg row.
  // Real cross-account transfers need both sides in the file; OFX TRANSFER
  // blocks express them as a single signed row per account. Same-account
  // rebalances pass through unchanged via the relaxed transfer-pair rules.
  const signedUnits = t.units; // sign already encoded in OFX UNITS via TRNTYPE
  out.push({
    date: t.date,
    account: externalId,
    amount: t.total,
    payee: ticker ? `TRANSFER ${ticker}` : "TRANSFER",
    currency,
    note: t.memo || "",
    tags: sourceTag,
    fitId: t.fitId,
    quantity: signedUnits,
    portfolioHolding: holdingName,
  });
}
