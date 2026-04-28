/**
 * Excel (.xlsx / .xls) parser — backed by `exceljs`.
 *
 * Swapped from `xlsx@0.18.5` (CVE-2023-30533 prototype-pollution — fix lives
 * only on the SheetJS paid/CDN channel, never published to npm) on
 * 2026-04-23 as part of V2 remediation Stream A. See
 * [AUDIT_REMEDIATION_PLAN_V2.md](../../../AUDIT_REMEDIATION_PLAN_V2.md).
 *
 * Both exported functions are async because `exceljs` workbook loading is
 * Promise-based (internal zip stream). All four callers live in async
 * request handlers, so they just added `await`.
 */

import ExcelJS from "exceljs";
import type { RawTransaction } from "./import-pipeline";
import { normalizeDate, parseAmount } from "./csv-parser";

export interface SheetInfo {
  name: string;
  headers: string[];
  sampleRows: string[][];
  totalRows: number;
}

/**
 * Normalize an exceljs cell value to a string.
 *
 * exceljs returns structured objects for some cell types where `xlsx` used
 * to return primitives: rich text (`{ richText: [{ text }...] }`), hyperlink
 * (`{ text, hyperlink }`), formula (`{ formula, result }`), error
 * (`{ error }`), and Date. We normalize all of those to plain strings so
 * downstream row-level logic (`normalizeDate`, `parseAmount`) behaves the
 * same way it did under `xlsx`.
 */
function cellToString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) {
    // Use UTC components so timezones don't shift the date by ±1 day.
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, "0");
    const d = String(value.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.richText)) {
      return (obj.richText as Array<{ text?: string }>)
        .map((r) => r.text ?? "")
        .join("");
    }
    if (typeof obj.text === "string") return obj.text;
    if ("result" in obj) return cellToString(obj.result);
    if ("error" in obj) return "";
    if ("hyperlink" in obj && typeof obj.hyperlink === "string") return obj.hyperlink;
  }
  return String(value);
}

/** Read all rows of a sheet as `string[][]` (header in row 0). */
function sheetToMatrix(sheet: ExcelJS.Worksheet): string[][] {
  const matrix: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    // row.values is `[undefined, ...cols]` — 1-indexed under exceljs.
    const raw = Array.isArray(row.values) ? (row.values as unknown[]).slice(1) : [];
    // Pad trailing empties so the header row defines the column count.
    const cells = raw.map((v) => cellToString(v).trim());
    matrix.push(cells);
  });
  return matrix;
}

export async function parseExcelSheets(buffer: Buffer): Promise<SheetInfo[]> {
  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs ships its own `declare interface Buffer extends ArrayBuffer`
    // in index.d.ts which doesn't line up with Node's real Buffer under
    // modern @types/node (Buffer<ArrayBufferLike>). The runtime accepts a
    // Node Buffer fine — the cast is only to silence tsc.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await workbook.xlsx.load(buffer as any);
  } catch (e) {
    throw new Error(
      `Could not read Excel file: ${e instanceof Error ? e.message : "The file may be corrupted or in an unsupported format"}`
    );
  }

  const out: SheetInfo[] = [];
  workbook.eachSheet((sheet) => {
    const matrix = sheetToMatrix(sheet);
    if (matrix.length === 0) {
      out.push({ name: sheet.name, headers: [], sampleRows: [], totalRows: 0 });
      return;
    }
    const headers = matrix[0].map((h) => h.trim());
    const sampleRows = matrix.slice(1, 6);
    out.push({ name: sheet.name, headers, sampleRows, totalRows: Math.max(matrix.length - 1, 0) });
  });
  return out;
}

export interface ColumnMapping {
  date: string;
  amount: string;
  account?: string;
  payee?: string;
  category?: string;
  currency?: string;
  note?: string;
  tags?: string;
  quantity?: string;
  portfolioHolding?: string;
}

export interface ExcelParseResult {
  rows: RawTransaction[];
  errors: Array<{ row: number; message: string }>;
  totalRows: number;
}

export async function extractExcelRows(
  buffer: Buffer,
  sheetName: string,
  mapping: ColumnMapping,
  hasHeaders: boolean = true,
): Promise<ExcelParseResult> {
  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs ships its own `declare interface Buffer extends ArrayBuffer`
    // in index.d.ts which doesn't line up with Node's real Buffer under
    // modern @types/node (Buffer<ArrayBufferLike>). The runtime accepts a
    // Node Buffer fine — the cast is only to silence tsc.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await workbook.xlsx.load(buffer as any);
  } catch (e) {
    throw new Error(
      `Could not read Excel file: ${e instanceof Error ? e.message : "The file may be corrupted or in an unsupported format"}`
    );
  }

  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) {
    const names = workbook.worksheets.map((s) => s.name).join(", ");
    throw new Error(`Sheet "${sheetName}" not found. Available sheets: ${names}`);
  }

  const matrix = sheetToMatrix(sheet);
  if (matrix.length === 0) {
    return { rows: [], errors: [{ row: 0, message: "Sheet is empty" }], totalRows: 0 };
  }

  let headers: string[];
  let dataRows: string[][];

  if (hasHeaders) {
    headers = matrix[0].map((h) => h.trim());
    dataRows = matrix.slice(1);
  } else {
    headers = matrix[0].map((_, i) => String.fromCharCode(65 + i));
    dataRows = matrix;
  }

  if (dataRows.length === 0) {
    return { rows: [], errors: [{ row: 0, message: "File contains only headers" }], totalRows: 0 };
  }

  const colIndex = (field: string | undefined) => {
    if (!field) return -1;
    return headers.indexOf(field);
  };

  const dateIdx = colIndex(mapping.date);
  const amountIdx = colIndex(mapping.amount);

  if (dateIdx === -1) {
    throw new Error(`Date column "${mapping.date}" not found in headers: ${headers.join(", ")}`);
  }
  if (amountIdx === -1) {
    throw new Error(`Amount column "${mapping.amount}" not found in headers: ${headers.join(", ")}`);
  }

  const accountIdx = colIndex(mapping.account);
  const payeeIdx = colIndex(mapping.payee);
  const categoryIdx = colIndex(mapping.category);
  const currencyIdx = colIndex(mapping.currency);
  const noteIdx = colIndex(mapping.note);
  const tagsIdx = colIndex(mapping.tags);
  const quantityIdx = colIndex(mapping.quantity);
  const holdingIdx = colIndex(mapping.portfolioHolding);

  const rows: RawTransaction[] = [];
  const errors: Array<{ row: number; message: string }> = [];

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const rawDate = (row[dateIdx] ?? "").trim();
    const rawAmount = (row[amountIdx] ?? "").trim();

    // Skip fully empty rows
    if (!rawDate && !rawAmount) continue;

    const rowNum = hasHeaders ? i + 2 : i + 1;

    // Normalize date — cellToString already handled Date objects + formulas;
    // we still want to support Excel serial numbers from the legacy xlsx
    // path (users uploading statements where the date column is stored as
    // a serial, not a formatted Date).
    let date: string | null = null;
    const num = Number(rawDate);
    if (!isNaN(num) && num > 10000 && num < 200000 && !rawDate.includes("-") && !rawDate.includes("/")) {
      const d = new Date((num - 25569) * 86400 * 1000);
      date = d.toISOString().slice(0, 10);
    } else {
      date = normalizeDate(rawDate);
    }

    if (!date) {
      errors.push({ row: rowNum, message: `Invalid date: "${rawDate}"` });
      continue;
    }

    const amount = parseAmount(rawAmount);
    if (isNaN(amount)) {
      errors.push({ row: rowNum, message: `Invalid amount: "${rawAmount}"` });
      continue;
    }

    rows.push({
      date,
      account: accountIdx >= 0 ? (row[accountIdx] ?? "").trim() : "",
      amount,
      payee: payeeIdx >= 0 ? (row[payeeIdx] ?? "").trim() : "",
      category: categoryIdx >= 0 ? (row[categoryIdx] ?? "").trim() || undefined : undefined,
      currency: currencyIdx >= 0 ? (row[currencyIdx] ?? "").trim() || "CAD" : "CAD",
      note: noteIdx >= 0 ? (row[noteIdx] ?? "").trim() : "",
      tags: tagsIdx >= 0 ? (row[tagsIdx] ?? "").trim() : "",
      quantity: quantityIdx >= 0 ? parseFloat(row[quantityIdx] ?? "") || undefined : undefined,
      portfolioHolding: holdingIdx >= 0 ? (row[holdingIdx] ?? "").trim() || undefined : undefined,
    });
  }

  return { rows, errors, totalRows: dataRows.length };
}
