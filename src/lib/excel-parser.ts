import * as XLSX from "xlsx";
import type { RawTransaction } from "./import-pipeline";
import { normalizeDate, parseAmount } from "./csv-parser";

export interface SheetInfo {
  name: string;
  headers: string[];
  sampleRows: string[][];
  totalRows: number;
}

export function parseExcelSheets(buffer: Buffer): SheetInfo[] {
  try {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    return workbook.SheetNames.map((name) => {
      const sheet = workbook.Sheets[name];
      const data: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
      if (data.length === 0) return { name, headers: [], sampleRows: [], totalRows: 0 };

      const headers = data[0].map((h) => String(h).trim());
      const sampleRows = data.slice(1, 6).map((row) => row.map((c) => String(c)));
      return { name, headers, sampleRows, totalRows: Math.max(data.length - 1, 0) };
    });
  } catch (e) {
    throw new Error(
      `Could not read Excel file: ${e instanceof Error ? e.message : "The file may be corrupted or in an unsupported format"}`
    );
  }
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

export function extractExcelRows(
  buffer: Buffer,
  sheetName: string,
  mapping: ColumnMapping,
  hasHeaders: boolean = true,
): ExcelParseResult {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: "buffer" });
  } catch (e) {
    throw new Error(
      `Could not read Excel file: ${e instanceof Error ? e.message : "The file may be corrupted or in an unsupported format"}`
    );
  }

  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    throw new Error(`Sheet "${sheetName}" not found. Available sheets: ${workbook.SheetNames.join(", ")}`);
  }

  const data: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  if (data.length === 0) {
    return { rows: [], errors: [{ row: 0, message: "Sheet is empty" }], totalRows: 0 };
  }

  let headers: string[];
  let dataRows: string[][];

  if (hasHeaders) {
    headers = data[0].map((h) => String(h).trim());
    dataRows = data.slice(1);
  } else {
    headers = data[0].map((_, i) => String.fromCharCode(65 + i));
    dataRows = data;
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
    const rawDate = String(row[dateIdx] ?? "").trim();
    const rawAmount = String(row[amountIdx] ?? "").trim();

    // Skip fully empty rows
    if (!rawDate && !rawAmount) continue;

    const rowNum = hasHeaders ? i + 2 : i + 1;

    // Normalize date — try Excel serial number first, then string formats
    let date: string | null = null;
    const num = Number(rawDate);
    if (!isNaN(num) && num > 10000 && num < 200000) {
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
      account: accountIdx >= 0 ? String(row[accountIdx] ?? "").trim() : "",
      amount,
      payee: payeeIdx >= 0 ? String(row[payeeIdx] ?? "").trim() : "",
      category: categoryIdx >= 0 ? String(row[categoryIdx] ?? "").trim() || undefined : undefined,
      currency: currencyIdx >= 0 ? String(row[currencyIdx] ?? "").trim() || "CAD" : "CAD",
      note: noteIdx >= 0 ? String(row[noteIdx] ?? "").trim() : "",
      tags: tagsIdx >= 0 ? String(row[tagsIdx] ?? "").trim() : "",
      quantity: quantityIdx >= 0 ? parseFloat(String(row[quantityIdx])) || undefined : undefined,
      portfolioHolding: holdingIdx >= 0 ? String(row[holdingIdx] ?? "").trim() || undefined : undefined,
    });
  }

  return { rows, errors, totalRows: dataRows.length };
}
