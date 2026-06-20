import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { generateImportHash, checkDuplicates } from "./import-hash";
import type { RawTransaction } from "./import-pipeline";
import { buildNameFields, decryptName, nameLookup } from "./crypto/encrypted-columns";
import { resolveOrCreateSecurity } from "./securities/resolve";
// `parseAmount` moved to the dependency-free `./parse-amount` module
// (2026-06-04) so client components can import it without pulling this file's
// server-only `@/db` dependency into the browser bundle. Imported here for
// internal use and re-exported below so every existing server-side
// `import { parseAmount } from "./csv-parser"` callsite keeps working.
import { parseAmount } from "./parse-amount";

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

// Re-export so external `import { parseAmount } from "./csv-parser"` callers
// (excel-parser, pdf-parser, import-pipeline, stage-email-import, tests) keep
// working — the implementation now lives in the pure `./parse-amount` module
// (imported above for this file's own internal use).
export { parseAmount };

/**
 * Date format override (FINLYNQ-54) — when the user picks an explicit format
 * on the upload UI, the parser short-circuits the day-vs-month inference and
 * uses the supplied layout. Three layouts mirror the upload-form dropdown.
 */
export type DateFormatOverride = "DD/MM/YYYY" | "MM/DD/YYYY" | "YYYY-MM-DD";

/**
 * Normalize date strings to YYYY-MM-DD format.
 * Handles: YYYY-MM-DD, MM/DD/YYYY, DD-MM-YYYY, DD/MM/YYYY (when day > 12),
 * MMM DD YYYY, YYYY/MM/DD
 *
 * Optional `dateFormatOverride` (FINLYNQ-54): when set, slash-separated dates
 * (`X/Y/ZZZZ`) are interpreted under that explicit layout — skips the
 * "assume MM/DD/YYYY unless day > 12" inference that silently mis-parses
 * EU/ME exports where every date in January–December falls into the
 * ambiguous range. `YYYY-MM-DD` and `YYYY/MM/DD` keep their canonical
 * interpretation regardless (they're unambiguous).
 */
export function normalizeDate(
  raw: string,
  dateFormatOverride?: DateFormatOverride | null,
): string | null {
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

  // MM/DD/YYYY or DD/MM/YYYY
  const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const a = parseInt(slashMatch[1], 10);
    const b = parseInt(slashMatch[2], 10);
    const year = slashMatch[3];
    if (dateFormatOverride === "DD/MM/YYYY") {
      const d = `${year}-${String(b).padStart(2, "0")}-${String(a).padStart(2, "0")}`;
      return validateDate(d) ? d : null;
    }
    if (dateFormatOverride === "MM/DD/YYYY") {
      const d = `${year}-${String(a).padStart(2, "0")}-${String(b).padStart(2, "0")}`;
      return validateDate(d) ? d : null;
    }
    // Auto-detect: if first number > 12, it must be DD/MM/YYYY
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

/**
 * Trim N raw lines off the top and/or bottom of a CSV before header detection
 * (FINLYNQ-54). Common on EU/ME bank exports that prepend a couple of
 * title/metadata rows or append a summary/total row.
 *
 * Uses `splitCSVLines` so multiline-quoted fields are counted as a single
 * "line" (matches what `parseCSV` sees as one row). UTF-8 BOM is preserved
 * on the first emitted line if it was on the original first line — caller
 * downstream still strips BOM via `parseCSV`.
 *
 * Both skips clamp to the available row count; if you ask to skip more rows
 * than the file contains, the result is an empty string and callers will
 * surface the standard "file is empty or contains only headers" error.
 */
export function trimCsvRows(
  csvText: string,
  skipHeaderRows: number,
  skipFooterRows: number,
): string {
  if (skipHeaderRows <= 0 && skipFooterRows <= 0) return csvText;
  if (!csvText) return csvText;
  // splitCSVLines respects quoted-field newlines. We split, slice, rejoin.
  const lines = splitCSVLines(csvText);
  if (lines.length === 0) return csvText;
  const head = Math.max(0, skipHeaderRows);
  const foot = Math.max(0, skipFooterRows);
  if (head + foot >= lines.length) return "";
  const sliced = lines.slice(head, lines.length - foot);
  return sliced.join("\n");
}

/** Extract just the header row from a CSV without parsing all rows. */
export function extractCSVHeaders(csvText: string): string[] {
  const cleaned = csvText.replace(/^\uFEFF/, "");
  if (!cleaned.trim()) return [];
  const lines = splitCSVLines(cleaned);
  if (lines.length === 0) return [];
  return parseCSVRow(lines[0]);
}

export function csvToRawTransactions(
  csvText: string,
  dateFormatOverride?: DateFormatOverride | null,
  defaultCurrency?: string | null,
): { rows: RawTransaction[]; errors: Array<{ row: number; message: string }> } {
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

    const date = normalizeDate(dateRaw, dateFormatOverride);
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
      // FINLYNQ — honor a template/upload default currency when the file has no
      // Currency column (or an empty cell). `||` (not `??`) so empty strings fall
      // through. CAD stays the last-resort so no-default imports are unchanged.
      currency: row["Currency"] || defaultCurrency || "CAD",
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
  dateFormatOverride?: DateFormatOverride | null,
  defaultCurrency?: string | null,
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

  // Optional sign-flip parser knob (ColumnMapping.flipSign). The mapping is
  // typed `Record<string, string>` for back-compat but a saved template's /
  // dialog's JSON carries a real boolean here, so read it defensively. When
  // true, every parsed amount is multiplied by -1 (cash amount only — never
  // quantity, never the Balance anchor).
  const flipSign = (mapping as { flipSign?: unknown }).flipSign === true;

  for (let i = 0; i < parsed.length; i++) {
    const row = parsed[i];
    const dateRaw = row[dateCol] ?? "";
    const amountRaw = row[amountCol] ?? "";

    const date = normalizeDate(dateRaw, dateFormatOverride);
    if (!date) {
      errors.push({ row: i + 2, message: `Invalid date: "${dateRaw}"` });
      continue;
    }

    const parsedAmount = parseAmount(amountRaw);
    if (isNaN(parsedAmount)) {
      errors.push({ row: i + 2, message: `Invalid amount: "${amountRaw}"` });
      continue;
    }
    // Guard -0 so a zero amount stays +0 after the flip.
    const amount = flipSign && parsedAmount !== 0 ? -parsedAmount : parsedAmount;

    rows.push({
      date,
      account: mapping["account"] ? (row[mapping["account"]] ?? "") : "",
      amount,
      payee: mapping["payee"] ? (row[mapping["payee"]] ?? "") : "",
      category: mapping["category"] ? (row[mapping["category"]] ?? "") : undefined,
      // FINLYNQ — fall back to the template/upload default currency when no
      // Currency column is mapped, or the mapped cell is empty. `||` so empty
      // cells fall through; CAD stays the last-resort.
      currency: mapping["currency"]
        ? (row[mapping["currency"]] || defaultCurrency || "CAD")
        : (defaultCurrency || "CAD"),
      note: mapping["note"] ? (row[mapping["note"]] ?? "") : undefined,
      tags: mapping["tags"] ? (row[mapping["tags"]] ?? "") : undefined,
      quantity: mapping["quantity"] ? (parseFloat(row[mapping["quantity"]] ?? "") || undefined) : undefined,
      portfolioHolding: mapping["portfolioHolding"] ? (row[mapping["portfolioHolding"]] || undefined) : undefined,
      // FINLYNQ-195 — security TICKER/SYMBOL (investment-account imports only;
      // mapping["ticker"] is unset for cash accounts so this stays undefined).
      ticker: mapping["ticker"] ? (row[mapping["ticker"]] || undefined) : undefined,
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

/**
 * Extract per-day bank balance anchors from a CSV with a Balance column
 * (2026-05-24). For each unique date in the file, keeps the LAST-in-file-
 * order balance for that date \u2014 the "last effective balance of the day"
 * semantic the user picked (handles ascending and descending file order
 * alike: walking the rows and overwriting on every hit always leaves the
 * last appearance, regardless of which sort direction the file uses).
 *
 * Returns an empty array when `mapping.balance` is unset, when no row has
 * a parseable balance value, or when no row has a valid date. Invalid
 * cells (empty, NaN, malformed date) are silently skipped \u2014 they're not
 * an error condition since this column is optional.
 *
 * `import_hash` is NEVER recomputed by this helper. The anchor is a
 * sibling fact, not a row attribute. Load-bearing per CLAUDE.md.
 */
export function extractBalanceAnchors(
  csvText: string,
  mapping: { date: string; balance?: string },
  dateFormatOverride: DateFormatOverride | null | undefined,
  currency: string,
): Array<{ date: string; balance: number; currency: string }> {
  if (!mapping.balance) return [];
  const rows = parseCSV(csvText);
  // Walk in file order; overwrite on every date hit so the final value
  // per key is the last appearance in the file. Works for both ASC and
  // DESC date sort \u2014 see CLAUDE.md "Bank balance anchors".
  const perDay = new Map<string, number>();
  for (const row of rows) {
    const dateRaw = row[mapping.date] ?? "";
    const balanceRaw = row[mapping.balance] ?? "";
    if (!balanceRaw.trim()) continue;
    const date = normalizeDate(dateRaw, dateFormatOverride);
    if (!date) continue;
    const balance = parseAmount(balanceRaw);
    if (isNaN(balance)) continue;
    perDay.set(date, balance);
  }
  return Array.from(perDay.entries()).map(([date, balance]) => ({
    date,
    balance,
    currency,
  }));
}

export async function importAccounts(csvText: string, userId: string, dek: Buffer | null = null) {
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
      // Stream D Phase 4 — match by name_lookup HMAC; persist ct/lookup only.
      const lookup = dek ? nameLookup(dek, row["Account"]) : null;
      const existing = lookup
        ? await db
            .select()
            .from(schema.accounts)
            .where(and(eq(schema.accounts.nameLookup, lookup), eq(schema.accounts.userId, userId)))
            .get()
        : null;
      if (!existing) {
        const enc = buildNameFields(dek, { name: row["Account"] });
        await db.insert(schema.accounts)
          .values({
            userId,
            type: row["Type"] || "A",
            group: row["Group"] ?? "",
            currency: row["Currency"] ?? "CAD",
            note: row["Note"] ?? "",
            ...enc,
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

export async function importCategories(csvText: string, userId: string, dek: Buffer | null = null) {
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
      // Stream D Phase 4 — match by name_lookup; persist ct/lookup only.
      const lookup = dek ? nameLookup(dek, row["Category"]) : null;
      const existing = lookup
        ? await db
            .select()
            .from(schema.categories)
            .where(and(eq(schema.categories.nameLookup, lookup), eq(schema.categories.userId, userId)))
            .get()
        : null;
      if (!existing) {
        const enc = buildNameFields(dek, { name: row["Category"] });
        await db.insert(schema.categories)
          .values({
            userId,
            type: row["Type"] || "E",
            group: row["Group"] ?? "",
            note: row["Note"] ?? "",
            ...enc,
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

export async function importPortfolio(csvText: string, userId: string, dek: Buffer | null = null) {
  const rows = parseCSV(csvText);
  if (rows.length === 0) return { total: 0, imported: 0, errors: ["File is empty or contains only headers"] };

  let imported = 0;
  const errors: string[] = [];

  for (const row of rows) {
    try {
      const acctLookup = dek ? nameLookup(dek, row["Portfolio account name"]) : null;
      const account = acctLookup
        ? await db
            .select()
            .from(schema.accounts)
            .where(and(eq(schema.accounts.nameLookup, acctLookup), eq(schema.accounts.userId, userId)))
            .get()
        : null;
      if (!account) {
        errors.push(`Account not found: "${row["Portfolio account name"]}"`);
        continue;
      }

      const holdingLookup = dek ? nameLookup(dek, row["Portfolio holding name"]) : null;
      const existing = holdingLookup
        ? await db
            .select()
            .from(schema.portfolioHoldings)
            .where(and(eq(schema.portfolioHoldings.nameLookup, holdingLookup), eq(schema.portfolioHoldings.userId, userId)))
            .get()
        : null;
      if (!existing) {
        const enc = buildNameFields(dek, {
          name: row["Portfolio holding name"],
          symbol: row["Symbol"] || null,
        });
        // Securities master (Phase B) — resolve the shared identity first.
        const holdingCurrency = row["Currency"] ?? "CAD";
        const securityId = await resolveOrCreateSecurity(userId, dek, {
          symbol: row["Symbol"] || null,
          name: row["Portfolio holding name"],
          isCryptoFlag: false,
          isCash: false,
          currency: holdingCurrency,
        });
        // Issue #205 — capture id via RETURNING + dual-write holding_accounts.
        // Without the pairing, every aggregator (issue #25) silently drops
        // transactions for this holding because the JOIN through
        // holding_accounts on (holding_id, account_id, user_id) misses.
        const insertedRow = await db.insert(schema.portfolioHoldings)
          .values({
            userId,
            accountId: account.id,
            currency: holdingCurrency,
            securityId,
            note: row["Note"] ?? "",
            ...enc,
          })
          .returning({ id: schema.portfolioHoldings.id });
        const inserted = Array.isArray(insertedRow) ? insertedRow[0] : insertedRow;
        const holdingId = inserted?.id;
        if (holdingId != null) {
          try {
            await db
              .insert(schema.holdingAccounts)
              .values({
                holdingId,
                accountId: account.id,
                userId,
                qty: 0,
                costBasis: 0,
                isPrimary: true,
              })
              .onConflictDoNothing();
          } catch (pairingErr) {
            await db
              .delete(schema.portfolioHoldings)
              .where(
                and(
                  eq(schema.portfolioHoldings.id, holdingId),
                  eq(schema.portfolioHoldings.userId, userId),
                ),
              );
            throw pairingErr;
          }
        }
        imported++;
      }
    } catch (e) {
      errors.push(`Failed to import holding: ${e instanceof Error ? e.message : "Unknown error"}`);
    }
  }
  return { total: rows.length, imported, errors: errors.length > 0 ? errors : undefined };
}

export async function importTransactions(csvText: string, userId: string, dek: Buffer | null = null) {
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

  // Stream D Phase 4 — match by decrypted name (or name_lookup if available).
  const allAccounts = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.userId, userId))
    .all();
  const accountMap = new Map(
    allAccounts.map((a) => [decryptName(a.nameCt, dek, null) ?? "", a.id] as [string, number]),
  );

  const allCategories = await db
    .select()
    .from(schema.categories)
    .where(eq(schema.categories.userId, userId))
    .all();
  const categoryMap = new Map(
    allCategories.map((c) => [decryptName(c.nameCt, dek, null) ?? "", c.id] as [string, number]),
  );

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const values = [];

    for (const row of batch) {
      const accountId = accountMap.get(row.account);
      const categoryId = row.category ? (categoryMap.get(row.category) ?? null) : null;
      if (!accountId) continue;

      const hash = generateImportHash(row.date, accountId, row.amount, row.payee);

      values.push({
        userId,
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
        // Issue #28: legacy CSV parser.
        source: "import",
      });
    }

    if (values.length > 0) {
      const hashes = values.map((v) => v.importHash);
      const existingHashes = await checkDuplicates(hashes, userId);
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
