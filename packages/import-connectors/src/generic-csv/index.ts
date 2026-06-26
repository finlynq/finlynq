// Generic multi-account "full ledger" CSV importer — public surface.
//
// Usage:
//   import { genericCsv } from "@finlynq/import-connectors";
//   const headers = genericCsv.genericCsvHeaders(csvText);
//   const { mapping } = genericCsv.suggestGenericCsvMapping(headers);
//   const { transactions, errors } = genericCsv.parseGenericCsv(csvText, mapping);
//
// Detection (for the upload picker): genericCsv.isGenericCsv(headers).

import { parseCsv, parseCsvDicts } from "../wealthposition/csv";
import {
  genericCsvRowsToRawTransactions,
  type GenericCsvMapping,
  type GenericCsvOptions,
  type GenericCsvTransformResult,
} from "./transform";

export {
  genericCsvRowsToRawTransactions,
  suggestGenericCsvMapping,
  isGenericCsv,
  parseFlexibleDate,
  GENERIC_CSV_FIELDS,
  GENERIC_REQUIRED_FIELDS,
} from "./transform";
export type {
  GenericCsvMapping,
  GenericCsvField,
  GenericCsvOptions,
  GenericCsvTransformResult,
  GenericCsvRowError,
} from "./transform";

/** Parse raw generic-ledger CSV text end-to-end with an explicit mapping. */
export function parseGenericCsv(
  csvText: string,
  mapping: GenericCsvMapping,
  opts: GenericCsvOptions = {},
): GenericCsvTransformResult {
  const rows = parseCsvDicts(csvText);
  return genericCsvRowsToRawTransactions(rows, mapping, opts);
}

/** First row of the CSV as trimmed header names (for detection / mapping UI). */
export function genericCsvHeaders(csvText: string): string[] {
  const rows = parseCsv(csvText);
  return rows.length ? rows[0].map((h) => h.trim()) : [];
}

/** First `n` data rows as header-keyed dicts — feeds the mapping preview. */
export function sampleGenericCsvRows(
  csvText: string,
  n = 5,
): Array<Record<string, string>> {
  return parseCsvDicts(csvText).slice(0, Math.max(0, n));
}
