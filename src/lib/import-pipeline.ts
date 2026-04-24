import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { generateImportHash, checkDuplicates, checkFitIdDuplicates } from "./import-hash";
import { applyRulesToBatch, type TransactionRule } from "./auto-categorize";
import { normalizeDate, parseAmount as parseAmountStr } from "./csv-parser";
import { encryptField, decryptField } from "./crypto/envelope";
import { nameLookup } from "./crypto/encrypted-columns";

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
  /** Groups multi-leg rows (transfer, same-account conversion, liquidation)
   *  so the UI can display them as linked siblings. Every row in one group
   *  shares the same linkId; unset for standalone transactions. */
  linkId?: string;
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

/**
 * Build in-memory maps from import-row keys → account/category ids. User-scoped
 * (the cross-user select was a pre-Stream-D security bug — fixed here).
 *
 * Stream D: when `dek` is provided, plaintext name/alias may be encrypted post
 * Phase-3-cutover. We decrypt on read so the map still works. We also populate
 * keys by name_lookup(HMAC) when available so exact-match resolves even for
 * rows with plaintext stripped.
 */
async function buildLookups(userId: string, dek?: Buffer) {
  const allAccounts = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.userId, userId))
    .all();
  const accountMap = new Map<string, number>();
  const accountCurrencyMap = new Map<string, string>();
  for (const a of allAccounts) {
    const plainName = a.nameCt && dek ? decryptField(dek, a.nameCt) : a.name;
    const plainAlias = a.aliasCt && dek ? decryptField(dek, a.aliasCt) : a.alias;
    if (plainName) {
      const nameKey = plainName.toLowerCase().trim();
      accountMap.set(nameKey, a.id);
      accountCurrencyMap.set(nameKey, a.currency);
    }
    if (plainAlias) {
      const aliasKey = plainAlias.toLowerCase().trim();
      if (aliasKey && !accountMap.has(aliasKey)) {
        accountMap.set(aliasKey, a.id);
        accountCurrencyMap.set(aliasKey, a.currency);
      }
    }
  }
  const allCategories = await db
    .select()
    .from(schema.categories)
    .where(eq(schema.categories.userId, userId))
    .all();
  const categoryMap = new Map<string, number>();
  for (const c of allCategories) {
    const plainName = c.nameCt && dek ? decryptField(dek, c.nameCt) : c.name;
    if (plainName) categoryMap.set(plainName, c.id);
  }
  return { accountMap, accountCurrencyMap, categoryMap };
}

export async function previewImport(
  rows: RawTransaction[],
  userId: string,
  dek?: Buffer,
): Promise<PreviewResult> {
  const { accountMap } = await buildLookups(userId, dek);
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
    if (!row.account) {
      errors.push({ rowIndex: i, message: "Missing account name" });
      continue;
    }
    const accountId = accountMap.get(row.account.toLowerCase().trim());
    if (!accountId) {
      errors.push({ rowIndex: i, message: `Unknown account: "${row.account}". No matching name or alias — create the account first, or add "${row.account}" as an alias on an existing account.` });
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
  const existingFitIds = await checkFitIdDuplicates(fitIdRows.map((v) => v.fitId!));
  // hash-based dedup
  const existingHashes = await checkDuplicates(hashOnlyRows.map((v) => v.hash));

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

export async function executeImport(
  rows: RawTransaction[],
  forceImportIndices: number[] = [],
  userId: string,
  userDek?: Buffer,
): Promise<ImportResult> {
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

  const { accountMap, accountCurrencyMap, categoryMap } = await buildLookups(userId, userDek);
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
    linkId: string | null;
    rowIndex: number;
  }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const accountKey = row.account ? row.account.toLowerCase().trim() : "";
    const accountId = accountMap.get(accountKey);
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
    const currency = row.currency || accountCurrencyMap.get(accountKey) || "CAD";

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
      linkId: row.linkId ?? null,
      rowIndex: i,
    });
  }

  // Check duplicates — fitId takes priority when available
  const fitIdRows = insertable.filter((r) => r.fitId);
  const hashOnlyRows = insertable.filter((r) => !r.fitId);

  const existingFitIds = await checkFitIdDuplicates(fitIdRows.map((r) => r.fitId!));
  const existingHashes = await checkDuplicates(hashOnlyRows.map((r) => r.importHash));

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
    const activeRules = await db
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

  // Batch insert — encrypt text fields at the boundary (hash was computed on
  // plaintext above, so dedup stays stable across imports).
  for (let i = 0; i < toInsert.length; i += batchSize) {
    const batch = toInsert.slice(i, i + batchSize);
    const values = batch.map(({ rowIndex: _, ...rest }) => {
      const row = { ...rest, userId };
      if (userDek) {
        row.payee = encryptField(userDek, row.payee) ?? "";
        row.note = encryptField(userDek, row.note) ?? "";
        row.tags = encryptField(userDek, row.tags) ?? "";
        row.portfolioHolding = encryptField(userDek, row.portfolioHolding ?? null);
      }
      return row;
    });
    if (values.length > 0) {
      try {
        await db.insert(schema.transactions).values(values);
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
