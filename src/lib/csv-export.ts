/**
 * csv-export.ts — pure, reusable CSV serialization + client download trigger.
 *
 * Consolidates the RFC-4180-style quoting that previously lived inline in the
 * reports page (`exportCSV`) and the settings/data page (`buildCsv` + `csvCell`)
 * WITHOUT modifying those files (consolidation onto this module is logged in the
 * Tier-3 backlog ticket). Financial-data CSV correctness matters, so the quoting
 * here is the single authority going forward:
 *
 *   - A field is quoted iff it contains a comma, a double-quote, a CR, or an LF.
 *   - Embedded double-quotes are escaped by doubling them ("" per RFC 4180).
 *   - Rows are joined with CRLF (the RFC line terminator Excel expects).
 *   - An optional UTF-8 BOM (default ON) lets Excel detect UTF-8 so accented
 *     payees / non-ASCII names don't mojibake on open.
 *
 * `exportCsv` is the column-mapped entry point: callers pass a `columns`
 * descriptor (header label + an accessor) so the on-disk header row + value
 * extraction are decoupled from the raw row shape. `buildCsvString` /
 * `csvField` are exported for unit tests and any caller that already has a
 * fully-materialized string matrix.
 */

/** A single export column: a header label + a pure accessor over a row. */
export type CsvColumn<Row> = {
  /** Header cell text written as the first CSV line. */
  header: string;
  /**
   * Extract this column's value from a row. Return anything; it is coerced to a
   * string via `String(value ?? "")` before quoting. Keep it pure.
   */
  accessor: (row: Row) => unknown;
};

export type ExportCsvOptions = {
  /** Prepend a UTF-8 BOM so Excel detects UTF-8. Default `true`. */
  bom?: boolean;
};

/**
 * RFC-4180-quote a single field. Quotes iff the value contains a comma, a
 * double-quote, a CR, or an LF; escapes embedded quotes by doubling them.
 */
export function csvField(value: unknown): string {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Build the CSV body from a header row + a matrix of already-extracted cell
 * values. CRLF line terminators; every cell passed through `csvField`. Pure —
 * no BOM, no DOM. Returns "" for an empty matrix with no header.
 */
export function buildCsvString(header: string[], matrix: unknown[][]): string {
  const lines = [header.map(csvField).join(",")];
  for (const row of matrix) {
    lines.push(row.map(csvField).join(","));
  }
  return lines.join("\r\n");
}

/**
 * Serialize `rows` to a CSV string using the `columns` descriptor. Pure (no
 * DOM); prepends a UTF-8 BOM unless `opts.bom === false`.
 */
export function serializeCsv<Row>(
  rows: Row[],
  columns: CsvColumn<Row>[],
  opts: ExportCsvOptions = {},
): string {
  const header = columns.map((c) => c.header);
  const matrix = rows.map((row) => columns.map((c) => c.accessor(row)));
  const body = buildCsvString(header, matrix);
  return opts.bom === false ? body : `﻿${body}`;
}

/**
 * Serialize `rows` via `columns` and trigger a browser download of the result
 * as `filename`. No-op outside the browser (guards `document`). The Blob is
 * tagged `text/csv;charset=utf-8` and the object URL is revoked after the click.
 */
export function exportCsv<Row>(
  rows: Row[],
  columns: CsvColumn<Row>[],
  filename: string,
  opts: ExportCsvOptions = {},
): void {
  const csv = serializeCsv(rows, columns, opts);
  if (typeof document === "undefined") return;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
