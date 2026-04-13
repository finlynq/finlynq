import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { generateImportHash, checkDuplicates } from "./import-hash";
import type { RawTransaction } from "./import-pipeline";

/**
 * Robust CSV parser that handles:
 * - Quoted fields with commas inside
 * - Mixed line endings (\r\n, \n, \r)
 * - Empty files and headers-only files
 * - UTF-8 BOM
 * - Latin-1 / Windows-1252 characters (best-effort)
 */
export function parseCSV(text: string): Record<string, string>[] {
  // Strip UTF-8 BOM if present
  const cleaned = text.replace(/^\uFEFF/, "");

  if (!cleaned.trim()) return [];

  const lines = splitCSVLines(cleaned);
  if (lines.length === 0) return [];

  const headers = parseCSVRow(lines[0]);
  if (headers.length === 0) return [];

  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = parseCSVRow(line);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] ?? "";
    });
    rows.push(row);
  }

  return rows;
}

/** Split text into lines, respecting quoted fields that span multiple lines. */
function splitCSVLines(text: string): string[] {
  const lines: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (!inQuotes && (ch === "\n" || ch === "\r")) {
      lines.push(current);
      current = "";
      // Handle \r\n
      if (ch === "\r" && text[i + 1] === "\n") i++;
    } else {
      current += ch;
    }
  }
  if (current.trim()) lines.push(current);
  return lines;
}

/** Parse a single CSV row, handling quoted fields with escaped quotes (""). */
function parseCSVRow(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        current += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ",") {
        values.push(current.trim());
        current = "";
        i++;
      } else {
        current += ch;
        i++;
      }
    }
  }
  values.push(current.trim());
  return values;
}

/**
 * Parse a raw amount string, handling:
 * - Currency symbols ($, €, £, ¥)
 * - Thousands separators (commas and spaces)
 * - Parenthesized negatives: (1,234.56) → -1234.56
 * - Unicode minus (−)
 * - European format: 1.234,56 → 1234.56
 */
export function parseAmount(raw: string): number {
  if (!raw || !raw.trim()) return NaN;

  let s = raw.trim();

  // Remove currency symbols
  s = s.replace(/[$€£¥₹]/g, "");

  // Unicode minus → regular minus
  s = s.replace(/−/g, "-");

  // Parenthesized negatives
  if (s.startsWith("(") && s.endsWith(")")) {
    s = "-" + s.slice(1, -1);
  }

  s = s.trim();

  // Detect European format: if there's exactly one comma and it has 2 digits after it
  // AND either no dots or dots used as thousands separators
  const europeanMatch = s.match(/^-?\d{1,3}(\.\d{3})*,\d{1,2}$/);
  if (europeanMatch) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    // Standard format: remove commas and spaces used as thousands separators
    s = s.replace(/[,\s]/g, "");
  }

  const result = parseFloat(s);
  return isNaN(result) ? NaN : result;
}

/**
 * Normalize date strings to YYYY-MM-DD format.
 * Handles: YYYY-MM-DD, MM/DD/YYYY, DD-MM-YYYY, DD/MM/YYYY (when day > 12),
 * MMM DD YYYY, YYYY/MM/DD
 */
export function normalizeDate(raw: string): string | null {
  if (!raw || !raw.trim()) return null;
  const s = raw.trim();

  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return validateDate(s) ? s : null;
  }

  // YYYY/MM/DD
  const ymdSlash = s.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (ymdSlash) {
    const d = `${ymdSlash[1]}-${ymdSlash[2]}-${ymdSlash[3]}`;
    return validateDate(d) ? d : null;
  }

  // MM/DD/YYYY or DD/MM/YYYY (assume MM/DD/YYYY unless day > 12)
  const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const a = parseInt(slashMatch[1], 10);
    const b = parseInt(slashMatch[2], 10);
    const year = slashMatch[3];
    // If first number > 12, it must be DD/MM/YYYY
    if (a > 12 && b <= 12) {
      const d = `${year}-${String(b).padStart(2, "0")}-${String(a).padStart(2, "0")}`;
      return validateDate(d) ? d : null;
    }
    // Default: MM/DD/YYYY
    const d = `${year}-${String(a).padStart(2, "0")}-${String(b).padStart(2, "0")}`;
    return validateDate(d) ? d : null;
  }

  // DD-MM-YYYY
  const dashMatch = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dashMatch) {
    const d = `${dashMatch[3]}-${dashMatch[2].padStart(2, "0")}-${dashMatch[1].padStart(2, "0")}`;
    return validateDate(d) ? d : null;
  }

  // MMM DD, YYYY or MMM DD YYYY
  const MONTHS: Record<string, string> = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  };
  const namedMatch = s.match(/^(\w{3})\s+(\d{1,2}),?\s+(\d{4})$/i);
  if (namedMatch) {
    const m = MONTHS[namedMatch[1].toLowerCase()];
    if (m) {
      const d = `${namedMatch[3]}-${m}-${namedMatch[2].padStart(2, "0")}`;
      return validateDate(d) ? d : null;
    }
  }

  return null;
}

/** Validate that a YYYY-MM-DD string is a real date */
function validateDate(dateStr: string): boolean {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

/** Extract just the header row from a CSV without parsing all rows. */
export function extractCSVHeaders(csvText: string): string[] {
  const cleaned = csvText.replace(/^\uFEFF/, "");
  if (!cleaned.trim()) return [];
  const lines = splitCSVLines(cleaned);
  if (lines.length === 0) return [];
  return parseCSVRow(lines[0]);
}

export function csvToRawTransactions(csvText: string): { rows: RawTransaction[]; errors: Array<{ row: number; message: string }> } {
  const parsed = parseCSV(csvText);
  const rows: RawTransaction[] = [];
  const errors: Array<{ row: number; message: string }> = [];

  if (parsed.length === 0) {
    return { rows: [], errors: [{ row: 0, message: "File is empty or contains only headers" }] };
  }

  for (let i = 0; i < parsed.length; i++) {
    const row = parsed[i];
    const dateRaw = row["Date"] ?? "";
    const amountRaw = row["Amount"] ?? "";

    const date = normalizeDate(dateRaw);
    if (!date) {
      errors.push({ row: i + 2, message: `Invalid date: "${dateRaw}"` });
      continue;
    }

    const amount = parseAmount(amountRaw);
    if (isNaN(amount)) {
      errors.push({ row: i + 2, message: `Invalid amount: "${amountRaw}"` });
      continue;
    }

    rows.push({
      date,
      account: row["Account"] ?? "",
      amount,
      payee: row["Payee"] ?? "",
      category: row["Categorization"] ?? "",
      currency: row["Currency"] ?? "CAD",
      note: row["Note"] ?? "",
      tags: row["Tags"] ?? "",
      quantity: row["Quantity"] ? parseFloat(row["Quantity"]) || undefined : undefined,
      portfolioHolding: row["Portfolio holding"] || undefined,
    });
  }

  return { rows, errors };
}

/**
 * Parse CSV using a user-provided column mapping.
 * mapping format: { date: "Column Header", amount: "Column Header", payee?: "...", ... }
 * Mirrors the ColumnMapping format used by the Excel parser.
 */
export function csvToRawTransactionsWithMapping(
  csvText: string,
  mapping: Record<string, string>,
): { rows: RawTransaction[]; errors: Array<{ row: number; message: string }> } {
  const parsed = parseCSV(csvText);
  const rows: RawTransaction[] = [];
  const errors: Array<{ row: number; message: string }> = [];

  if (parsed.length === 0) {
    return { rows: [], errors: [{ row: 0, message: "File is empty or contains only headers" }] };
  }

  // Invert: field → header  (mapping already is { field: header })
  const dateCol = mapping["date"];
  const amountCol = mapping["amount"];

  if (!dateCol || !amountCol) {
    return { rows: [], errors: [{ row: 0, message: "Column mapping must include date and amount" }] };
  }

  for (let i = 0; i < parsed.length; i++) {
    const row = parsed[i];
    const dateRaw = row[dateCol] ?? "";
    const amountRaw = row[amountCol] ?? "";

    const date = normalizeDate(dateRaw);
    if (!date) {
      errors.push({ row: i + 2, message: `Invalid date: "${dateRaw}"` });
      continue;
    }

    const amount = parseAmount(amountRaw);
    if (isNaN(amount)) {
      errors.push({ row: i + 2, message: `Invalid amount: "${amountRaw}"` });
      continue;
    }

    rows.push({
      date,
      account: mapping["account"] ? (row[mapping["account"]] ?? "") : "",
      amount,
      payee: mapping["payee"] ? (row[mapping["payee"]] ?? "") : "",
      category: mapping["category"] ? (row[mapping["category"]] ?? "") : undefined,
      currency: mapping["currency"] ? (row[mapping["currency"]] ?? "CAD") : "CAD",
      note: mapping["note"] ? (row[mapping["note"]] ?? "") : undefined,
      tags: mapping["tags"] ? (row[mapping["tags"]] ?? "") : undefined,
      quantity: mapping["quantity"] ? (parseFloat(row[mapping["quantity"]] ?? "") || undefined) : undefined,
      portfolioHolding: mapping["portfolioHolding"] ? (row[mapping["portfolioHolding"]] || undefined) : undefined,
    });
  }

  return { rows, errors };
}

/**
 * Extract just the header row from a CSV text (for template matching).
 */
export function extractCsvHeaders(csvText: string): string[] {
  const cleaned = csvText.replace(/^\uFEFF/, "");
  const lines = splitCSVLines(cleaned);
  if (lines.length === 0) return [];
  return parseCSVRow(lines[0]);
}

export async function importAccounts(csvText: string, userId?: string) {
  const rows = parseCSV(csvText);
  if (rows.length === 0) return { total: 0, imported: 0, errors: ["File is empty or contains only headers"] };

  let imported = 0;
  const errors: string[] = [];

  for (const row of rows) {
    if (!row["Account"]) {
      errors.push("Row missing Account field");
      continue;
    }
    try {
      const existing = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.name, row["Account"]))
        .get();
      if (!existing) {
        await db.insert(schema.accounts)
          .values({
            type: row["Type"] || "A",
            group: row["Group"] ?? "",
            name: row["Account"],
            currency: row["Currency"] ?? "CAD",
            note: row["Note"] ?? "",
            ...(userId ? { userId } : {}),
          })
          ;
        imported++;
      }
    } catch (e) {
      errors.push(`Failed to import account "${row["Account"]}": ${e instanceof Error ? e.message : "Unknown error"}`);
    }
  }
  return { total: rows.length, imported, errors: errors.length > 0 ? errors : undefined };
}

export async function importCategories(csvText: string, userId?: string) {
  const rows = parseCSV(csvText);
  if (rows.length === 0) return { total: 0, imported: 0, errors: ["File is empty or contains only headers"] };

  let imported = 0;
  const errors: string[] = [];

  for (const row of rows) {
    if (!row["Category"]) {
      errors.push("Row missing Category field");
      continue;
    }
    try {
      const existing = await db
        .select()
        .from(schema.categories)
        .where(eq(schema.categories.name, row["Category"]))
        .get();
      if (!existing) {
        await db.insert(schema.categories)
          .values({
            type: row["Type"] || "E",
            group: row["Group"] ?? "",
            name: row["Category"],
            note: row["Note"] ?? "",
            ...(userId ? { userId } : {}),
          })
          ;
        imported++;
      }
    } catch (e) {
      errors.push(`Failed to import category "${row["Category"]}": ${e instanceof Error ? e.message : "Unknown error"}`);
    }
  }
  return { total: rows.length, imported, errors: errors.length > 0 ? errors : undefined };
}

export async function importPortfolio(csvText: string, userId?: string) {
  const rows = parseCSV(csvText);
  if (rows.length === 0) return { total: 0, imported: 0, errors: ["File is empty or contains only headers"] };

  let imported = 0;
  const errors: string[] = [];

  for (const row of rows) {
    try {
      const account = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.name, row["Portfolio account name"]))
        .get();
      if (!account) {
        errors.push(`Account not found: "${row["Portfolio account name"]}"`);
        continue;
      }

      const existing = await db
        .select()
        .from(schema.portfolioHoldings)
        .where(eq(schema.portfolioHoldings.name, row["Portfolio holding name"]))
        .get();
      if (!existing) {
        await db.insert(schema.portfolioHoldings)
          .values({
            accountId: account.id,
            name: row["Portfolio holding name"],
            symbol: row["Symbol"] || null,
            currency: row["Currency"] ?? "CAD",
            note: row["Note"] ?? "",
            ...(userId ? { userId } : {}),
          })
          ;
        imported++;
      }
    } catch (e) {
      errors.push(`Failed to import holding: ${e instanceof Error ? e.message : "Unknown error"}`);
    }
  }
  return { total: rows.length, imported, errors: errors.length > 0 ? errors : undefined };
}

export async function importTransactions(csvText: string, userId?: string) {
  const { rows, errors: parseErrors } = csvToRawTransactions(csvText);

  if (rows.length === 0) {
    return {
      total: 0,
      imported: 0,
      skippedDuplicates: 0,
      errors: parseErrors.length > 0
        ? parseErrors.map((e) => `Row ${e.row}: ${e.message}`)
        : ["No valid transactions found"],
    };
  }

  let imported = 0;
  let skippedDuplicates = 0;
  const batchSize = 500;

  const allAccounts = await db.select().from(schema.accounts).all();
  const accountMap = new Map(allAccounts.map((a) => [a.name, a.id]));

  const allCategories = await db.select().from(schema.categories).all();
  const categoryMap = new Map(allCategories.map((c) => [c.name, c.id]));

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const values = [];

    for (const row of batch) {
      const accountId = accountMap.get(row.account);
      const categoryId = row.category ? (categoryMap.get(row.category) ?? null) : null;
      if (!accountId) continue;

      const hash = generateImportHash(row.date, accountId, row.amount, row.payee);

      values.push({
        date: row.date,
        accountId,
        categoryId,
        currency: row.currency ?? "CAD",
        amount: row.amount,
        quantity: row.quantity ?? null,
        portfolioHolding: row.portfolioHolding ?? null,
        note: row.note ?? "",
        payee: row.payee ?? "",
        tags: row.tags ?? "",
        importHash: hash,
        ...(userId ? { userId } : {}),
      });
    }

    if (values.length > 0) {
      const hashes = values.map((v) => v.importHash);
      const existingHashes = await checkDuplicates(hashes);
      const newValues = values.filter((v) => !existingHashes.has(v.importHash));
      skippedDuplicates += values.length - newValues.length;

      if (newValues.length > 0) {
        await db.insert(schema.transactions).values(newValues);
        imported += newValues.length;
      }
    }
  }

  return {
    total: rows.length,
    imported,
    skippedDuplicates,
    errors: parseErrors.length > 0 ? parseErrors.map((e) => `Row ${e.row}: ${e.message}`) : undefined,
  };
}
