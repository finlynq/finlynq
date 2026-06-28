// Pure transform: a generic, multi-account "full ledger" CSV → Finlynq
// RawTransaction[]. Unlike a single-account bank statement (handled by the
// per-account /import column mapper), this is the shape a whole-portfolio
// export takes — many accounts, transfers, and currencies in ONE file:
//
//   date, amount, currency, account, note, category, account_to
//
// The columns are vendor-neutral, so this connector is intentionally NOT
// keyed on exact header names. A caller supplies a `GenericCsvMapping`
// (logical field → header name); `suggestGenericCsvMapping(headers)` derives a
// best-guess mapping via alias matching so a clean file imports in one click,
// while a slightly different file just needs a column re-pointed in the UI
// rather than failing detection outright.
//
// Semantics (v1):
//   * `amount` is SIGNED (negative = outflow, positive = inflow) — no Type col.
//   * `currency` is a per-row ISO code column (falls back to the amount symbol,
//     then `defaultCurrency`). HKD + CNY can coexist in one file / one account.
//   * `account_to` present on a row makes it a SINGLE-ROW TRANSFER: we emit two
//     RawTransactions sharing a `linkId` (outflow on `account`, inflow on
//     `account_to`). A same-currency transfer mirrors the source magnitude onto
//     the inflow leg in the row currency. A CROSS-CURRENCY (FX) transfer that
//     supplies `amountTo` + `currencyTo` records the inflow leg FAITHFULLY in
//     its own currency (e.g. -5000 HKD out, +502.18 GBP in) — each leg then
//     matches its own account's currency, so the orchestrator no longer has to
//     refuse it. Same-currency-row transfers into different-currency accounts
//     (no received amount) are still refused by the ORCHESTRATOR.
//   * `(OPENING BALANCE)` category → an "Opening Balance" transaction (gated by
//     `includeOpeningBalance`). `(AUDIT)` category → an "Adjustment" transaction.
//   * Dates accept ISO `YYYY-MM-DD` and slash/dot/dash `D/M/Y` (or `M/D/Y` via
//     `dateOrder`), with an optional trailing time, so the parser survives drift.
//
// This package is zero-dep and must not import from Finlynq (`@/...`) or Next.

import type { RawTransaction } from "../types";
import { isReasonableAmount, sourceTagFor } from "../types";

/** Logical field → the source CSV header that supplies it. `date`, `amount`,
 *  and `account` are required; the rest are optional (absent `accountTo`
 *  simply means the file has no transfers). */
export interface GenericCsvMapping {
  date: string;
  amount: string;
  account: string;
  currency?: string;
  note?: string;
  category?: string;
  accountTo?: string;
  /** Cross-currency (FX) transfers only — the amount CREDITED to `accountTo`,
   *  in `currencyTo`. When present (alongside `accountTo`), the inflow leg is
   *  recorded with this magnitude in `currencyTo` rather than mirroring the
   *  source amount. Absent → same-currency transfer (inflow mirrors source). */
  amountTo?: string;
  /** ISO currency of `amountTo`. Pairs with `amountTo`; both are needed to
   *  treat a transfer as cross-currency. */
  currencyTo?: string;
}

export const GENERIC_CSV_FIELDS = [
  "date",
  "amount",
  "account",
  "currency",
  "note",
  "category",
  "accountTo",
  "amountTo",
  "currencyTo",
] as const;

export type GenericCsvField = (typeof GENERIC_CSV_FIELDS)[number];

export const GENERIC_REQUIRED_FIELDS: GenericCsvField[] = ["date", "amount", "account"];

/** Header synonyms per logical field, normalized (lowercase, `_`/`-` → space,
 *  collapsed spaces). First matching header wins. Order matters within a list
 *  only for readability — matching is by membership. */
const FIELD_ALIASES: Record<GenericCsvField, string[]> = {
  date: ["date", "transaction date", "txn date", "posted", "posted date", "value date", "booking date"],
  amount: ["amount", "value", "sum", "total"],
  account: ["account", "account name", "account from", "from account", "source account", "from"],
  currency: ["currency", "ccy", "cur", "iso currency"],
  note: ["note", "memo", "description", "payee", "details", "narration", "reference", "remark", "remarks"],
  category: ["category", "cat", "categories"],
  accountTo: [
    "account to",
    "account (to)",
    "to account",
    "destination account",
    "transfer to",
    "destination",
    "to",
  ],
  amountTo: [
    "amount received",
    "amount to",
    "received amount",
    "amount (to)",
    "amount credited",
    "credit amount",
    "destination amount",
  ],
  currencyTo: [
    "currency to",
    "currency received",
    "received currency",
    "currency (to)",
    "to currency",
    "destination currency",
  ],
};

function normalizeHeader(h: string): string {
  return (h ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * Best-guess mapping from a header row. Each logical field binds to the first
 * header whose normalized form is one of that field's aliases. Returns the
 * partial mapping plus the list of required fields it couldn't resolve.
 */
export function suggestGenericCsvMapping(headers: string[]): {
  mapping: Partial<GenericCsvMapping>;
  missingRequired: GenericCsvField[];
} {
  const normToOriginal = new Map<string, string>();
  for (const h of headers) {
    const n = normalizeHeader(h);
    if (n && !normToOriginal.has(n)) normToOriginal.set(n, h.trim());
  }
  const mapping: Partial<GenericCsvMapping> = {};
  for (const field of GENERIC_CSV_FIELDS) {
    for (const alias of FIELD_ALIASES[field]) {
      const hit = normToOriginal.get(alias);
      if (hit) {
        mapping[field] = hit;
        break;
      }
    }
  }
  const missingRequired = GENERIC_REQUIRED_FIELDS.filter((f) => !mapping[f]);
  return { mapping, missingRequired };
}

/** True when the required trio (date, amount, account) can be auto-mapped.
 *  Tolerant by design — exact header names are NOT required. */
export function isGenericCsv(headers: string[]): boolean {
  return suggestGenericCsvMapping(headers).missingRequired.length === 0;
}

export interface GenericCsvOptions {
  /** Currency used when neither a currency column nor an amount symbol resolves. Default "USD". */
  defaultCurrency?: string;
  /** Emit a transaction for `(OPENING BALANCE)` rows. Default true. */
  includeOpeningBalance?: boolean;
  /** Interpretation of ambiguous slash/dot dates. Default "dmy" (day-first). */
  dateOrder?: "dmy" | "mdy";
  /** European number format ("1.234,56"). Default false (dot decimal). */
  decimalComma?: boolean;
  /** Category values (normalized) treated as opening balances. Default ["opening balance"]. */
  openingBalanceMarkers?: string[];
  /** Category values (normalized) treated as adjustments. Default ["audit"]. */
  auditMarkers?: string[];
}

export interface GenericCsvRowError {
  /** 1-based index among data rows (header excluded). */
  row: number;
  reason: string;
  raw: Record<string, string>;
}

export interface GenericCsvTransformResult {
  transactions: RawTransaction[];
  errors: GenericCsvRowError[];
}

/** Currency symbols a row's amount might carry, most-specific first. */
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
  ["RMB", "CNY"],
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
    digits = t.replace(/[^0-9,]/g, "").replace(/,/g, ".");
  } else {
    digits = t.replace(/[^0-9.]/g, "");
  }
  const n = parseFloat(digits);
  if (!Number.isFinite(n)) return NaN;
  return negative ? -n : n;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** ISO `YYYY-MM-DD` or slash/dot/dash `D/M/Y` (per `order`), optional trailing
 *  time. Returns "YYYY-MM-DD" or null. Self-disambiguates when one component
 *  is clearly the day (>12). */
export function parseFlexibleDate(raw: string, order: "dmy" | "mdy" = "dmy"): string | null {
  if (!raw) return null;
  const datePart = raw.trim().split(/[,T ]/)[0]?.trim();
  if (!datePart) return null;

  const iso = datePart.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const year = parseInt(iso[1], 10);
    const month = parseInt(iso[2], 10);
    const day = parseInt(iso[3], 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${pad2(month)}-${pad2(day)}`;
  }

  const slash = datePart.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/);
  if (slash) {
    const a = parseInt(slash[1], 10);
    const b = parseInt(slash[2], 10);
    let year = parseInt(slash[3], 10);
    if (slash[3].length <= 2) year += year < 70 ? 2000 : 1900;
    let day: number;
    let month: number;
    if (order === "mdy") {
      month = a;
      day = b;
    } else {
      day = a;
      month = b;
    }
    // Disambiguate an obviously-day-first value given the wrong order.
    if (month > 12 && day <= 12) {
      const t = month;
      month = day;
      day = t;
    }
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${pad2(month)}-${pad2(day)}`;
  }

  return null;
}

const cell = (row: Record<string, string>, header: string | undefined): string =>
  header ? (row[header] ?? "").trim() : "";

const stripParens = (s: string): string => s.replace(/^\((.*)\)$/, "$1").trim();

/**
 * Transform parsed generic-ledger CSV dict rows into Finlynq RawTransaction[].
 * Never throws — unparseable rows are collected in `errors`.
 */
export function genericCsvRowsToRawTransactions(
  rows: Array<Record<string, string>>,
  mapping: GenericCsvMapping,
  opts: GenericCsvOptions = {},
): GenericCsvTransformResult {
  const defaultCurrency = opts.defaultCurrency ?? "USD";
  const includeOpening = opts.includeOpeningBalance ?? true;
  const dateOrder = opts.dateOrder ?? "dmy";
  const decimalComma = opts.decimalComma ?? false;
  const openingSet = new Set(
    (opts.openingBalanceMarkers ?? ["opening balance"]).map((m) => m.toLowerCase().trim()),
  );
  const auditSet = new Set(
    (opts.auditMarkers ?? ["audit"]).map((m) => m.toLowerCase().trim()),
  );

  const transactions: RawTransaction[] = [];
  const errors: GenericCsvRowError[] = [];
  const tags = sourceTagFor("csv");

  rows.forEach((row, idx) => {
    const rowNum = idx + 1;
    const fail = (reason: string) => errors.push({ row: rowNum, reason, raw: row });

    const date = parseFlexibleDate(cell(row, mapping.date), dateOrder);
    if (!date) {
      fail(`Unparseable date "${cell(row, mapping.date) || "(empty)"}".`);
      return;
    }

    const account = cell(row, mapping.account);
    if (!account) {
      fail("Row has no account.");
      return;
    }

    const amountStr = cell(row, mapping.amount);
    const signed = parseSignedMoney(amountStr, decimalComma);
    if (!isReasonableAmount(signed)) {
      fail(`Amount out of range or non-numeric ("${amountStr || "(empty)"}").`);
      return;
    }

    const currencyCell = cell(row, mapping.currency);
    const currency = currencyCell
      ? currencyCell.toUpperCase()
      : detectCurrency(amountStr, defaultCurrency);
    const noteVal = cell(row, mapping.note) || undefined;
    const categoryRaw = cell(row, mapping.category);
    const accountTo = cell(row, mapping.accountTo);

    // 1) Transfer — single row carrying both legs (shared linkId).
    if (accountTo) {
      const mag = Math.abs(signed);
      if (!isReasonableAmount(mag)) {
        fail(`Transfer amount out of range ("${amountStr}").`);
        return;
      }

      // Cross-currency (FX) transfer: an explicit received amount + currency
      // records the destination leg FAITHFULLY in its own currency, instead of
      // mirroring the source magnitude. Needs BOTH amountTo + currencyTo;
      // otherwise it stays a same-currency transfer (inflow mirrors source).
      let inflowAmount = mag;
      let inflowCurrency = currency;
      const amountToStr = cell(row, mapping.amountTo);
      const currencyToCell = cell(row, mapping.currencyTo);
      if (amountToStr || currencyToCell) {
        const recvMag = Math.abs(parseSignedMoney(amountToStr, decimalComma));
        const recvCurrency = currencyToCell.toUpperCase();
        if (amountToStr && !isReasonableAmount(recvMag)) {
          fail(`Transfer received amount out of range ("${amountToStr}").`);
          return;
        }
        if (isReasonableAmount(recvMag) && recvCurrency) {
          inflowAmount = recvMag;
          inflowCurrency = recvCurrency;
        }
      }

      const linkId = `generic-transfer-${rowNum}`;
      transactions.push({
        date,
        account,
        amount: -mag,
        payee: `Transfer to ${accountTo}`,
        category: "Transfer",
        currency,
        note: noteVal,
        tags,
        linkId,
      });
      transactions.push({
        date,
        account: accountTo,
        amount: inflowAmount,
        payee: `Transfer from ${account}`,
        category: "Transfer",
        currency: inflowCurrency,
        note: noteVal,
        tags,
        linkId,
      });
      return;
    }

    const catNorm = categoryRaw.toLowerCase().trim();
    const isOpening = openingSet.has(catNorm) || openingSet.has(stripParens(catNorm));
    const isAudit = auditSet.has(catNorm) || auditSet.has(stripParens(catNorm));

    // 2) Opening balance.
    if (isOpening) {
      if (!includeOpening) return;
      transactions.push({
        date,
        account,
        amount: signed,
        payee: noteVal ?? "Opening Balance",
        category: "Opening Balance",
        currency,
        tags,
      });
      return;
    }

    // 3) Audit / adjustment.
    if (isAudit) {
      transactions.push({
        date,
        account,
        amount: signed,
        payee: noteVal ?? "Adjustment",
        category: "Adjustment",
        currency,
        tags,
      });
      return;
    }

    // 4) Ordinary income / expense.
    transactions.push({
      date,
      account,
      amount: signed,
      payee: noteVal ?? categoryRaw ?? "Transaction",
      category: categoryRaw || undefined,
      currency,
      tags,
    });
  });

  return { transactions, errors };
}
