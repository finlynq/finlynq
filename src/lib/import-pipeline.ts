import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { generateImportHash, checkDuplicates, checkFitIdDuplicates } from "./import-hash";
import { applyRulesToBatch, type TransactionRule } from "./auto-categorize";
import { normalizeDate, parseAmount as parseAmountStr } from "./csv-parser";

export interface RawTransaction {
  date: string;
  account: string;
  amount: number;
  payee: string;
  category?: string;
  currency?: string;
  note?: string;
  tags?: string;
  quantity?: number;
  portfolioHolding?: string;
  fitId?: string;
}

export interface PreviewResult {
  valid: Array<RawTransaction & { hash: string; rowIndex: number }>;
  duplicates: Array<RawTransaction & { hash: string; rowIndex: number }>;
  errors: Array<{ rowIndex: number; message: string }>;
}

export interface ImportResult {
  total: number;
  imported: number;
  skippedDuplicates: number;
  errors?: string[];
}

/** Max rows per import to prevent memory issues */
const MAX_IMPORT_ROWS = 50_000;

function buildLookups() {
  const allAccounts = db.select().from(schema.accounts).all();
  const accountMap = new Map(allAccounts.map((a) => [a.name, a.id]));
  const accountCurrencyMap = new Map(allAccounts.map((a) => [a.name, a.currency]));
  const allCategories = db.select().from(schema.categories).all();
  const categoryMap = new Map(allCategories.map((c) => [c.name, c.id]));
  return { accountMap, accountCurrencyMap, categoryMap };
}

export function previewImport(rows: RawTransaction[]): PreviewResult {
  const { accountMap } = buildLookups();
  const valid: PreviewResult["valid"] = [];
  const errors: PreviewResult["errors"] = [];

  if (rows.length === 0) {
    errors.push({ rowIndex: 0, message: "No data to import" });
    return { valid: [], duplicates: [], errors };
  }

  if (rows.length > MAX_IMPORT_ROWS) {
    errors.push({
      rowIndex: 0,
      message: `File contains ${rows.length.toLocaleString()} rows, which exceeds the ${MAX_IMPORT_ROWS.toLocaleString()} row limit. Please split the file into smaller chunks.`,
    });
    return { valid: [], duplicates: [], errors };
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    // Validate account
    const accountId = accountMap.get(row.account);
    if (!row.account) {
      errors.push({ rowIndex: i, message: "Missing account name" });
      continue;
    }
    if (!accountId) {
      errors.push({ rowIndex: i, message: `Unknown account: "${row.account}". Create it first or check the spelling.` });
      continue;
    }

    // Validate date
    if (!row.date) {
      errors.push({ rowIndex: i, message: "Missing date" });
      continue;
    }
    const normalizedDate = normalizeDate(row.date);
    if (!normalizedDate) {
      errors.push({ rowIndex: i, message: `Invalid date: "${row.date}". Expected formats: YYYY-MM-DD, MM/DD/YYYY, DD-MM-YYYY` });
      continue;
    }

    // Validate amount
    if (typeof row.amount === "string") {
      const parsed = parseAmountStr(row.amount as unknown as string);
      if (isNaN(parsed)) {
        errors.push({ rowIndex: i, message: `Invalid amount: "${row.amount}"` });
        continue;
      }
      row.amount = parsed;
    }
    if (isNaN(row.amount)) {
      errors.push({ rowIndex: i, message: "Invalid amount" });
      continue;
    }

    // Normalize the date in the row
    row.date = normalizedDate;

    const hash = generateImportHash(row.date, accountId, row.amount, row.payee);
    valid.push({ ...row, hash, rowIndex: i });
  }

  // Check duplicates — use fitId when available, fall back to content hash
  const fitIdRows = valid.filter((v) => v.fitId);
  const hashOnlyRows = valid.filter((v) => !v.fitId);

  // fitId-based dedup
  const existingFitIds = checkFitIdDuplicates(fitIdRows.map((v) => v.fitId!));
  // hash-based dedup
  const existingHashes = checkDuplicates(hashOnlyRows.map((v) => v.hash));

  const duplicates: PreviewResult["valid"] = [];
  const nonDuplicates: PreviewResult["valid"] = [];

  for (const row of fitIdRows) {
    if (existingFitIds.has(row.fitId!)) {
      duplicates.push(row);
    } else {
      nonDuplicates.push(row);
    }
  }
  for (const row of hashOnlyRows) {
    if (existingHashes.has(row.hash)) {
      duplicates.push(row);
    } else {
      nonDuplicates.push(row);
    }
  }

  return { valid: nonDuplicates, duplicates, errors };
}

export function executeImport(
  rows: RawTransaction[],
  forceImportIndices: number[] = [],
): ImportResult {
  if (rows.length === 0) {
    return { total: 0, imported: 0, skippedDuplicates: 0 };
  }

  if (rows.length > MAX_IMPORT_ROWS) {
    return {
      total: rows.length,
      imported: 0,
      skippedDuplicates: 0,
      errors: [`Import exceeds ${MAX_IMPORT_ROWS.toLocaleString()} row limit`],
    };
  }

  const { accountMap, accountCurrencyMap, categoryMap } = buildLookups();
  const forceSet = new Set(forceImportIndices);
  const batchSize = 500;
  let imported = 0;
  let skippedDuplicates = 0;
  const importErrors: string[] = [];

  // Build insertable rows with hashes
  const insertable: Array<{
    date: string;
    accountId: number;
    categoryId: number | null;
    currency: string;
    amount: number;
    quantity: number | null;
    portfolioHolding: string | null;
    note: string;
    payee: string;
    tags: string;
    importHash: string;
    fitId: string | null;
    rowIndex: number;
  }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const accountId = accountMap.get(row.account);
    if (!accountId) {
      importErrors.push(`Row ${i + 1}: Unknown account "${row.account}"`);
      continue;
    }

    // Normalize date
    const normalizedDate = normalizeDate(row.date);
    if (!normalizedDate) {
      importErrors.push(`Row ${i + 1}: Invalid date "${row.date}"`);
      continue;
    }

    // Validate amount
    if (isNaN(row.amount)) {
      importErrors.push(`Row ${i + 1}: Invalid amount`);
      continue;
    }

    const categoryId = row.category ? (categoryMap.get(row.category) ?? null) : null;
    const hash = generateImportHash(normalizedDate, accountId, row.amount, row.payee);

    // Inherit currency from account when not specified in import data
    const currency = row.currency || accountCurrencyMap.get(row.account) || "CAD";

    insertable.push({
      date: normalizedDate,
      accountId,
      categoryId,
      currency,
      amount: row.amount,
      quantity: row.quantity ?? null,
      portfolioHolding: row.portfolioHolding ?? null,
      note: row.note ?? "",
      payee: row.payee ?? "",
      tags: row.tags ?? "",
      importHash: hash,
      fitId: row.fitId ?? null,
      rowIndex: i,
    });
  }

  // Check duplicates — fitId takes priority when available
  const fitIdRows = insertable.filter((r) => r.fitId);
  const hashOnlyRows = insertable.filter((r) => !r.fitId);

  const existingFitIds = checkFitIdDuplicates(fitIdRows.map((r) => r.fitId!));
  const existingHashes = checkDuplicates(hashOnlyRows.map((r) => r.importHash));

  // Filter: keep non-duplicates + force-imported duplicates
  const toInsert = insertable.filter((r) => {
    const isDuplicate = r.fitId
      ? existingFitIds.has(r.fitId)
      : existingHashes.has(r.importHash);

    if (isDuplicate) {
      if (forceSet.has(r.rowIndex)) return true;
      skippedDuplicates++;
      return false;
    }
    return true;
  });

  // Auto-categorize uncategorized transactions using rules
  try {
    const activeRules = db
      .select()
      .from(schema.transactionRules)
      .where(eq(schema.transactionRules.isActive, 1))
      .all() as TransactionRule[];

    if (activeRules.length > 0) {
      const uncategorized = toInsert.filter((r) => !r.categoryId);
      if (uncategorized.length > 0) {
        const results = applyRulesToBatch(
          uncategorized.map((r) => ({ payee: r.payee, amount: r.amount, tags: r.tags })),
          activeRules,
        );
        for (const { index, match } of results) {
          if (match) {
            const row = uncategorized[index];
            if (match.assignCategoryId) row.categoryId = match.assignCategoryId;
            if (match.assignTags) row.tags = match.assignTags;
            if (match.renameTo) row.payee = match.renameTo;
          }
        }
      }
    }
  } catch {
    // Auto-categorize is best-effort — don't fail the import
  }

  // Batch insert
  for (let i = 0; i < toInsert.length; i += batchSize) {
    const batch = toInsert.slice(i, i + batchSize);
    const values = batch.map(({ rowIndex: _, ...rest }) => rest);
    if (values.length > 0) {
      try {
        db.insert(schema.transactions).values(values).run();
        imported += values.length;
      } catch (e) {
        importErrors.push(`Batch insert failed at row ${i + 1}: ${e instanceof Error ? e.message : "Unknown error"}`);
      }
    }
  }

  return {
    total: rows.length,
    imported,
    skippedDuplicates,
    errors: importErrors.length > 0 ? importErrors : undefined,
  };
}
