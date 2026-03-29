import * as XLSX from "xlsx";
import type { RawTransaction } from "./import-pipeline";

export interface SheetInfo {
  name: string;
  headers: string[];
  sampleRows: string[][];
  totalRows: number;
}

export function parseExcelSheets(buffer: Buffer): SheetInfo[] {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const data: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    if (data.length === 0) return { name, headers: [], sampleRows: [], totalRows: 0 };

    const headers = data[0].map((h) => String(h).trim());
    const sampleRows = data.slice(1, 6).map((row) => row.map((c) => String(c)));
    return { name, headers, sampleRows, totalRows: Math.max(data.length - 1, 0) };
  });
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

export function extractExcelRows(
  buffer: Buffer,
  sheetName: string,
  mapping: ColumnMapping,
  hasHeaders: boolean = true,
): RawTransaction[] {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return [];

  const data: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  if (data.length === 0) return [];

  let headers: string[];
  let dataRows: string[][];

  if (hasHeaders) {
    headers = data[0].map((h) => String(h).trim());
    dataRows = data.slice(1);
  } else {
    // Use column letters as headers (A, B, C, ...)
    headers = data[0].map((_, i) => String.fromCharCode(65 + i));
    dataRows = data;
  }

  const colIndex = (field: string | undefined) => {
    if (!field) return -1;
    return headers.indexOf(field);
  };

  const dateIdx = colIndex(mapping.date);
  const amountIdx = colIndex(mapping.amount);

  if (dateIdx === -1 || amountIdx === -1) return [];

  const accountIdx = colIndex(mapping.account);
  const payeeIdx = colIndex(mapping.payee);
  const categoryIdx = colIndex(mapping.category);
  const currencyIdx = colIndex(mapping.currency);
  const noteIdx = colIndex(mapping.note);
  const tagsIdx = colIndex(mapping.tags);
  const quantityIdx = colIndex(mapping.quantity);
  const holdingIdx = colIndex(mapping.portfolioHolding);

  return dataRows
    .filter((row) => row[dateIdx] && row[amountIdx])
    .map((row) => {
      const rawDate = String(row[dateIdx]).trim();
      const date = normalizeExcelDate(rawDate);

      return {
        date,
        account: accountIdx >= 0 ? String(row[accountIdx]).trim() : "",
        amount: parseFloat(String(row[amountIdx]).replace(/[$,]/g, "")) || 0,
        payee: payeeIdx >= 0 ? String(row[payeeIdx]).trim() : "",
        category: categoryIdx >= 0 ? String(row[categoryIdx]).trim() : undefined,
        currency: currencyIdx >= 0 ? String(row[currencyIdx]).trim() : "CAD",
        note: noteIdx >= 0 ? String(row[noteIdx]).trim() : "",
        tags: tagsIdx >= 0 ? String(row[tagsIdx]).trim() : "",
        quantity: quantityIdx >= 0 ? parseFloat(String(row[quantityIdx])) || undefined : undefined,
        portfolioHolding: holdingIdx >= 0 ? String(row[holdingIdx]).trim() || undefined : undefined,
      };
    });
}

function normalizeExcelDate(value: string): string {
  // Excel serial number (e.g., 45306)
  const num = Number(value);
  if (!isNaN(num) && num > 10000 && num < 100000) {
    const date = new Date((num - 25569) * 86400 * 1000);
    return date.toISOString().slice(0, 10);
  }

  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  // MM/DD/YYYY or M/D/YYYY
  const slashMatch = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    return `${slashMatch[3]}-${slashMatch[1].padStart(2, "0")}-${slashMatch[2].padStart(2, "0")}`;
  }

  // DD-MM-YYYY
  const dashMatch = value.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dashMatch) {
    return `${dashMatch[3]}-${dashMatch[2].padStart(2, "0")}-${dashMatch[1].padStart(2, "0")}`;
  }

  return value;
}
