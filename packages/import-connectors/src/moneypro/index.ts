// Money Pro (iBear) CSV importer — public surface.
//
// Usage:
//   import { moneypro } from "@finlynq/import-connectors";
//   const { transactions, errors } = moneypro.parseMoneyProCsv(csvText, { defaultCurrency: "HKD" });
//
// Detection (for the upload picker): moneypro.isMoneyProCsv(headers).

import { parseCsv, parseCsvDicts } from "../wealthposition/csv";
import {
  moneyProRowsToRawTransactions,
  type MoneyProTransformOptions,
  type MoneyProTransformResult,
} from "./transform";

export {
  moneyProRowsToRawTransactions,
  isMoneyProCsv,
  parseMoneyProDate,
  MONEY_PRO_HEADERS,
} from "./transform";
export type {
  MoneyProTransformOptions,
  MoneyProTransformResult,
  MoneyProRowError,
} from "./transform";

/** Parse raw Money Pro CSV text end-to-end into Finlynq RawTransaction[]. */
export function parseMoneyProCsv(
  csvText: string,
  opts: MoneyProTransformOptions = {},
): MoneyProTransformResult {
  const rows = parseCsvDicts(csvText);
  return moneyProRowsToRawTransactions(rows, opts);
}

/** First row of the CSV as trimmed header names (for `isMoneyProCsv`). */
export function moneyProHeaders(csvText: string): string[] {
  const rows = parseCsv(csvText);
  return rows.length ? rows[0].map((h) => h.trim()) : [];
}
