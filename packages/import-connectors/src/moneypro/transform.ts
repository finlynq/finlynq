// Pure transform: Money Pro CSV rows → Finlynq RawTransaction[].
//
// Money Pro (iBear) exports a "Transactions" CSV with these 12 columns:
//
//   Date, Amount, Account, Amount received, Account (to), Balance,
//   Category, Description, Transaction Type, Agent, Check #, Class
//
// Confirmed from a real export (.numbers re-save of a CSV). The shape does NOT
// fit a 1:1 column mapping, which is why this is a dedicated transform:
//
//   * Amount is an UNSIGNED magnitude (e.g. "HK$2,131.64"). The DIRECTION lives
//     in `Transaction Type` (Expense / Income / Money Transfer / Opening Balance).
//   * There is NO currency column — currency is the symbol in the amount string
//     (HK$ → HKD). We fall back to `defaultCurrency` when the symbol is unknown.
//   * Transfers are a SINGLE row carrying both legs: source = (Amount, Account),
//     destination = (Amount received, Account (to)). We emit two RawTransactions
//     sharing a `linkId`.
//   * Dates are day-first with a time: "27/10/2025, 15:04" → 2025-10-27.
//   * `Opening Balance` rows put the starting value in the Balance column (Amount
//     is 0); we emit a single transaction for that value.
//   * `Class` ("Personal Daily") → tags. `Category` may be hierarchical
//     ("Entertainment: Travel") and is passed through verbatim.
//
// This package is zero-dep and must not import from Finlynq (`@/...`) or Next.

import type { RawTransaction } from "../types";
import { isReasonableAmount, sourceTagFor } from "../types";

/** The 12 Money Pro export columns, in file order. */
export const MONEY_PRO_HEADERS = [
  "Date",
  "Amount",
  "Account",
  "Amount received",
  "Account (to)",
  "Balance",
  "Category",
  "Description",
  "Transaction Type",
  "Agent",
  "Check #",
  "Class",
] as const;

/**
 * True when a header set looks like a Money Pro export. Keys on the trio of
 * columns no other app we support emits together: "Transaction Type",
 * "Amount received", and "Account (to)".
 */
export function isMoneyProCsv(headers: string[]): boolean {
  const set = new Set(headers.map((h) => h.trim().toLowerCase()));
  return (
    set.has("transaction type") &&
    set.has("amount received") &&
    set.has("account (to)")
  );
}

export interface MoneyProTransformOptions {
  /** Currency used when the amount symbol isn't recognized. Default "USD". */
  defaultCurrency?: string;
  /** European number format ("1.234,56"). Default false (dot decimal). */
  decimalComma?: boolean;
  /** Strip a single wrapping pair of parentheses from account names. Default true. */
  stripAccountParens?: boolean;
  /** Emit a transaction for `Opening Balance` rows (value taken from Balance). Default true. */
  includeOpeningBalance?: boolean;
}

export interface MoneyProRowError {
  /** 1-based index among data rows (header excluded). */
  row: number;
  reason: string;
  raw: Record<string, string>;
}

export interface MoneyProTransformResult {
  transactions: RawTransaction[];
  errors: MoneyProRowError[];
}

type Direction = "out" | "in" | "transfer" | "opening";

/** Lowercased `Transaction Type` → direction. Unknown types are reported as
 *  errors rather than guessed — a wrong sign corrupts the ledger. Extend this
 *  map as new Money Pro types surface (Refund, Balance Adjustment, …). */
const TYPE_DIRECTION: Record<string, Direction> = {
  expense: "out",
  income: "in",
  "money transfer": "transfer",
  "opening balance": "opening",
};

/** Currency symbols Money Pro prefixes, most-specific first so "CA$" wins over
 *  "A$" and "US$" over a bare "$". */
const CURRENCY_SYMBOLS: Array<[string, string]> = [
  ["HK$", "HKD"],
  ["NZ$", "NZD"],
  ["NT$", "TWD"],
  ["MX$", "MXN"],
  ["CA$", "CAD"],
  ["US$", "USD"],
  ["A$", "AUD"],
  ["C$", "CAD"],
  ["S$", "SGD"],
  ["R$", "BRL"],
  ["€", "EUR"],
  ["£", "GBP"],
  ["¥", "JPY"],
  ["₹", "INR"],
  ["₩", "KRW"],
  ["₫", "VND"],
];

function detectCurrency(amountStr: string, fallback: string): string {
  const s = amountStr ?? "";
  for (const [sym, code] of CURRENCY_SYMBOLS) {
    if (s.includes(sym)) return code;
  }
  // Bare "$" is ambiguous (USD/CAD/…) — defer to the caller's default.
  return fallback;
}

/** Parse a money string to a signed number. Strips currency symbol + thousands
 *  separators. Negative when prefixed with "-" or wrapped in "(...)". */
function parseSignedMoney(raw: string, decimalComma: boolean): number {
  if (!raw) return NaN;
  const t = raw.trim();
  const negative = /^-/.test(t) || /^\(.*\)$/.test(t);
  let digits: string;
  if (decimalComma) {
    // EU: "." is the thousands sep (dropped), "," is the decimal.
    digits = t.replace(/[^0-9,]/g, "").replace(/,/g, ".");
  } else {
    digits = t.replace(/[^0-9.]/g, "");
  }
  const n = parseFloat(digits);
  if (!Number.isFinite(n)) return NaN;
  return negative ? -n : n;
}

/** Unsigned magnitude (Money Pro amounts are always unsigned in the export). */
function parseMagnitude(raw: string, decimalComma: boolean): number {
  const n = parseSignedMoney(raw, decimalComma);
  return Number.isFinite(n) ? Math.abs(n) : NaN;
}

/** "27/10/2025, 15:04" (day-first, optional time) → "2025-10-27". null on miss. */
export function parseMoneyProDate(raw: string): string | null {
  if (!raw) return null;
  const datePart = raw.split(",")[0].trim(); // drop ", HH:mm"
  const m = datePart.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  let year = parseInt(m[3], 10);
  if (m[3].length <= 2) year += year < 70 ? 2000 : 1900;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

function cleanAccount(name: string, strip: boolean): string {
  const t = (name ?? "").trim();
  if (strip && /^\(.*\)$/.test(t)) return t.slice(1, -1).trim();
  return t;
}

function buildTags(cls: string | undefined): string {
  const tags: string[] = [];
  const c = (cls ?? "").trim();
  if (c) tags.push(c);
  tags.push(sourceTagFor("csv"));
  return tags.join(",");
}

const cell = (row: Record<string, string>, key: string): string =>
  (row[key] ?? "").trim();

/**
 * Transform parsed Money Pro CSV rows into Finlynq RawTransaction[].
 * Never throws — unparseable / unknown-type rows are collected in `errors`.
 */
export function moneyProRowsToRawTransactions(
  rows: Array<Record<string, string>>,
  opts: MoneyProTransformOptions = {},
): MoneyProTransformResult {
  const defaultCurrency = opts.defaultCurrency ?? "USD";
  const decimalComma = opts.decimalComma ?? false;
  const stripParens = opts.stripAccountParens ?? true;
  const includeOpening = opts.includeOpeningBalance ?? true;

  const transactions: RawTransaction[] = [];
  const errors: MoneyProRowError[] = [];

  rows.forEach((row, idx) => {
    const rowNum = idx + 1;
    const fail = (reason: string) => errors.push({ row: rowNum, reason, raw: row });

    const rawType = cell(row, "Transaction Type");
    const dir = TYPE_DIRECTION[rawType.toLowerCase()];
    if (!dir) {
      fail(`Unknown Transaction Type "${rawType || "(empty)"}". Add it to TYPE_DIRECTION.`);
      return;
    }

    const date = parseMoneyProDate(cell(row, "Date"));
    if (!date) {
      fail(`Unparseable date "${cell(row, "Date")}".`);
      return;
    }

    const account = cleanAccount(cell(row, "Account"), stripParens);
    const category = cell(row, "Category") || undefined;
    const agent = cell(row, "Agent");
    const description = cell(row, "Description");
    const tags = buildTags(cell(row, "Class"));
    const amountStr = cell(row, "Amount");
    const currency = detectCurrency(amountStr, defaultCurrency);

    // payee = Agent when present, else Description; avoid duplicating into note.
    const payee = agent || description || rawType;
    const note = agent ? description || undefined : undefined;

    if (dir === "opening") {
      if (!includeOpening) return;
      // The opening value lives in Balance (Amount is 0 on these rows).
      const balanceStr = cell(row, "Balance");
      const value = Number.isFinite(parseSignedMoney(balanceStr, decimalComma))
        ? parseSignedMoney(balanceStr, decimalComma)
        : parseSignedMoney(amountStr, decimalComma);
      if (!isReasonableAmount(value)) {
        fail(`Opening Balance value out of range ("${balanceStr || amountStr}").`);
        return;
      }
      transactions.push({
        date,
        account,
        amount: value,
        payee: "Opening Balance",
        category: category ?? "Opening Balance",
        currency: detectCurrency(balanceStr || amountStr, defaultCurrency),
        tags,
      });
      return;
    }

    if (dir === "transfer") {
      const toAccount = cleanAccount(cell(row, "Account (to)"), stripParens);
      if (!toAccount) {
        fail("Money Transfer row has no destination (Account (to)).");
        return;
      }
      const recvStr = cell(row, "Amount received");
      const srcMag = parseMagnitude(amountStr, decimalComma);
      const dstMag = recvStr ? parseMagnitude(recvStr, decimalComma) : srcMag;
      if (!isReasonableAmount(srcMag) || !isReasonableAmount(dstMag)) {
        fail(`Transfer amount out of range ("${amountStr}" / "${recvStr}").`);
        return;
      }
      const linkId = `moneypro-transfer-${rowNum}`;
      const memo = description || undefined;
      // Source leg (outflow) and destination leg (inflow) — amounts/currencies
      // may differ (cross-currency transfer); each leg keeps its own.
      transactions.push({
        date,
        account,
        amount: -srcMag,
        payee: `Transfer to ${toAccount}`,
        category: "Transfer",
        currency,
        note: memo,
        tags,
        linkId,
      });
      transactions.push({
        date,
        account: toAccount,
        amount: dstMag,
        payee: `Transfer from ${account}`,
        category: "Transfer",
        currency: detectCurrency(recvStr || amountStr, defaultCurrency),
        note: memo,
        tags,
        linkId,
      });
      return;
    }

    // Expense / Income — unsigned magnitude, sign from the type.
    const mag = parseMagnitude(amountStr, decimalComma);
    if (!isReasonableAmount(mag)) {
      fail(`Amount out of range or non-numeric ("${amountStr}").`);
      return;
    }
    transactions.push({
      date,
      account,
      amount: dir === "out" ? -mag : mag,
      payee,
      category,
      currency,
      note,
      tags,
    });
  });

  return { transactions, errors };
}
