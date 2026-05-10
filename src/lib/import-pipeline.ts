import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { generateImportHash, checkDuplicates, checkFitIdDuplicates } from "./import-hash";
import { applyRulesToBatch, type TransactionRule } from "./auto-categorize";
import { normalizeDate, parseAmount as parseAmountStr } from "./csv-parser";
import { encryptField, decryptField, tryDecryptField } from "./crypto/envelope";
import { nameLookup } from "./crypto/encrypted-columns";
import { buildHoldingResolver } from "./external-import/portfolio-holding-resolver";
import { getInvestmentAccountIds } from "./investment-account";
import {
  validateSignVsCategory,
  getCategoryTypeMap,
} from "./transactions/sign-category-invariant";
import { safeConvertToAccountCurrency } from "./currency-conversion";
import { prewarmRates } from "./fx-service";
import {
  detectProbableDuplicates,
  type DuplicateMatch,
} from "./external-import/duplicate-detect";
import { buildDuplicateCandidatePool } from "./external-import/duplicate-detect-pool";

export interface RawTransaction {
  date: string;
  account: string;
  /** The amount in the row's "natural" (entered) currency. For most CSVs
   *  this equals the account-currency amount because the row was written
   *  in account currency to begin with — but for multi-currency exports
   *  (WealthPosition, brokerage statements with FX trades), it's the
   *  trade amount and the importer converts to account currency. */
  amount: number;
  payee: string;
  category?: string;
  /** The row's currency. Treated as the entered currency when it differs
   *  from the linked account's currency — the importer then converts to
   *  account-currency via the locked-at-entry FX rate. */
  currency?: string;
  /** Optional: explicit user-typed amount, separate from `amount`. When
   *  set, `amount` becomes the account-currency value and these two are
   *  the entered side. Most CSV importers don't need this — `amount` +
   *  `currency` already capture the trade. */
  enteredAmount?: number;
  enteredCurrency?: string;
  note?: string;
  tags?: string;
  quantity?: number;
  portfolioHolding?: string;
  /**
   * Issue #155: explicit portfolio_holdings.id override. When set, takes
   * precedence over the holding-name resolver — `portfolioHolding` is
   * ignored. Used by the staging-approve flow where the user picked a
   * holding in the review UI and we already have the FK on hand;
   * round-tripping through the name resolver would (a) add a needless
   * decrypt + lookup, (b) risk creating a duplicate auto-Cash holding
   * if the row's name happens to be empty. Caller is responsible for
   * verifying ownership before passing the id.
   */
  portfolioHoldingId?: number | null;
  fitId?: string;
  /** Groups multi-leg rows (transfer, same-account conversion, liquidation)
   *  so the UI can display them as linked siblings. Every row in one group
   *  shares the same linkId; unset for standalone transactions. */
  linkId?: string;
}

export interface PreviewResult {
  valid: Array<RawTransaction & { hash: string; rowIndex: number }>;
  duplicates: Array<RawTransaction & { hash: string; rowIndex: number }>;
  /**
   * Issue #65: rows that survived exact-match dedup but look like a fuzzy
   * match against an existing transaction (FX-spread + settlement-vs-posting
   * date drift). Warning surface — these stay in `valid` and will commit
   * unless the user explicitly skips them. Cross-reference by `rowIndex`.
   */
  probableDuplicates: DuplicateMatch[];
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
    // Stream D Phase 4 — plaintext name/alias dropped; ciphertext only.
    const plainName = a.nameCt && dek ? tryDecryptField(dek, a.nameCt, "accounts.name_ct") : null;
    const plainAlias = a.aliasCt && dek ? tryDecryptField(dek, a.aliasCt, "accounts.alias_ct") : null;
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
    const plainName = c.nameCt && dek ? tryDecryptField(dek, c.nameCt, "categories.name_ct") : null;
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
    return { valid: [], duplicates: [], probableDuplicates: [], errors };
  }

  if (rows.length > MAX_IMPORT_ROWS) {
    errors.push({
      rowIndex: 0,
      message: `File contains ${rows.length.toLocaleString()} rows, which exceeds the ${MAX_IMPORT_ROWS.toLocaleString()} row limit. Please split the file into smaller chunks.`,
    });
    return { valid: [], duplicates: [], probableDuplicates: [], errors };
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
  const existingFitIds = await checkFitIdDuplicates(fitIdRows.map((v) => v.fitId!), userId);
  // hash-based dedup
  const existingHashes = await checkDuplicates(hashOnlyRows.map((v) => v.hash), userId);

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

  // Issue #65: cross-source fuzzy duplicate detection. Runs AFTER exact-match
  // dedup so it only sees rows that aren't already caught by import_hash /
  // fitId. Pool query is one round trip scoped to the union of touched
  // accounts and the date window; helper is pure and pre-tested.
  const probableDuplicates = await runProbableDuplicateDetection(
    nonDuplicates,
    accountMap,
    userId,
    dek ?? null,
  );

  return { valid: nonDuplicates, duplicates, probableDuplicates, errors };
}

/**
 * Issue #65 cross-source duplicate detection over the post-exact-dedup pool.
 * Resolves account names → ids the same way the row's import_hash was
 * computed, builds a one-shot candidate pool, and asks the pure scoring
 * helper for matches. Returns [] on errors (warning surface only — never
 * blocks the import).
 */
async function runProbableDuplicateDetection(
  rows: PreviewResult["valid"],
  accountMap: Map<string, number>,
  userId: string,
  dek: Buffer | null,
): Promise<DuplicateMatch[]> {
  if (rows.length === 0) return [];

  const inputs: Array<{
    rowIndex: number;
    date: string;
    accountId: number;
    amount: number;
    payeePlain: string;
    importHash: string;
  }> = [];
  const accountIdSet = new Set<number>();
  for (const row of rows) {
    const accountKey = row.account ? row.account.toLowerCase().trim() : "";
    const accountId = accountMap.get(accountKey);
    if (accountId == null) continue;
    accountIdSet.add(accountId);
    inputs.push({
      rowIndex: row.rowIndex,
      date: row.date,
      accountId,
      amount: row.amount,
      payeePlain: row.payee ?? "",
      importHash: row.hash,
    });
  }
  if (inputs.length === 0) return [];

  const dates = inputs.map((r) => r.date).sort();
  const dateMin = dates[0];
  const dateMax = dates[dates.length - 1];

  try {
    const pool = await buildDuplicateCandidatePool({
      userId,
      dek,
      accountIds: [...accountIdSet],
      dateMin,
      dateMax,
    });
    return detectProbableDuplicates(inputs, pool);
  } catch {
    // Warning surface — never block the import on a heuristic failure.
    return [];
  }
}

export async function executeImport(
  rows: RawTransaction[],
  forceImportIndices: number[] = [],
  userId: string,
  userDek?: Buffer,
  // Issue #28: writer surface for the audit column. Defaults to 'import'
  // because every caller of this pipeline today is a CSV/Excel/PDF/OFX
  // import flow. Connector orchestrators (WP, future brokerages) call into
  // reconciliation.ts directly and pass 'connector' on those INSERTs.
  txSource: "import" | "connector" = "import",
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

  // Prewarm FX rates for any cross-currency rows. One batched lookup
  // beats N per-row Yahoo fetches during a 6,000-row import.
  const prewarmCurrencies = new Set<string>();
  const prewarmDates = new Set<string>();
  for (const row of rows) {
    const accKey = row.account ? row.account.toLowerCase().trim() : "";
    const accCcy = accountCurrencyMap.get(accKey);
    if (!accCcy) continue;
    const enteredCcy = (row.enteredCurrency || row.currency || accCcy).toUpperCase();
    if (enteredCcy !== accCcy.toUpperCase()) {
      prewarmCurrencies.add(enteredCcy);
      prewarmCurrencies.add(accCcy.toUpperCase());
      const d = normalizeDate(row.date);
      if (d) prewarmDates.add(d);
    }
  }
  if (prewarmCurrencies.size > 0 && prewarmDates.size > 0) {
    try {
      await prewarmRates([...prewarmCurrencies], [...prewarmDates], userId);
    } catch {
      // Best-effort — per-row lookups will fall through normally.
    }
  }

  // Build insertable rows with hashes + entered_* trilogy
  const insertable: Array<{
    date: string;
    accountId: number;
    categoryId: number | null;
    currency: string;
    amount: number;
    enteredCurrency: string;
    enteredAmount: number;
    enteredFxRate: number;
    quantity: number | null;
    portfolioHolding: string | null;
    portfolioHoldingId: number | null;
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
    // Hash on the user-typed amount (= row.amount). Stable across re-imports
    // even when FX rates move — only entered_amount + entered_currency stay
    // in sync with the source CSV.
    const hash = generateImportHash(normalizedDate, accountId, row.amount, row.payee);

    // Resolve the trilogy:
    //   entered_(amount, currency) = what the user typed (defaults to row.*)
    //   (amount, currency)         = settled in account currency
    //   entered_fx_rate            = entered → account at locked rate
    const accountCurrency = (accountCurrencyMap.get(accountKey) || "CAD").toUpperCase();
    const enteredAmount = row.enteredAmount ?? row.amount;
    const enteredCurrency = (row.enteredCurrency || row.currency || accountCurrency).toUpperCase();

    let amount = row.amount;
    let currency = enteredCurrency;
    let enteredFxRate = 1;
    if (enteredCurrency !== accountCurrency) {
      const conv = await safeConvertToAccountCurrency({
        enteredAmount,
        enteredCurrency,
        accountCurrency,
        date: normalizedDate,
        userId,
      });
      amount = conv.amount;
      currency = conv.currency;
      enteredFxRate = conv.enteredFxRate;
    } else {
      // Same currency — entered = account, rate = 1
      amount = enteredAmount;
      currency = accountCurrency;
    }

    insertable.push({
      date: normalizedDate,
      accountId,
      categoryId,
      currency,
      amount,
      enteredCurrency,
      enteredAmount,
      enteredFxRate,
      quantity: row.quantity ?? null,
      portfolioHolding: row.portfolioHolding ?? null,
      // Issue #155: pre-fill the FK when the caller supplied one (staging
      // approve flow). The resolver pass below skips rows whose FK is
      // already non-null. When portfolioHoldingId is unset, fall back to
      // the historical resolver-based path (CSV/OFX upload, email path).
      portfolioHoldingId: row.portfolioHoldingId ?? null,
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

  const existingFitIds = await checkFitIdDuplicates(fitIdRows.map((r) => r.fitId!), userId);
  const existingHashes = await checkDuplicates(hashOnlyRows.map((r) => r.importHash), userId);

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

  // Resolve the holding name → portfolio_holdings.id for every row that has
  // a name. Auto-creates the holding when missing. Single resolver instance
  // for the whole import — pre-loaded with the user's holdings so per-row
  // .resolve() is a Map lookup until a miss triggers an auto-create.
  try {
    const resolver = await buildHoldingResolver(userId, userDek ?? null);
    for (const row of toInsert) {
      // Issue #155: skip rows that the caller pre-populated with an
      // explicit FK (the staging-approve path). The caller is responsible
      // for owner-verification — we don't re-check here.
      if (row.portfolioHoldingId != null) continue;
      if (!row.portfolioHolding) continue;
      row.portfolioHoldingId = await resolver.resolve(
        row.accountId,
        row.portfolioHolding,
      );
    }
  } catch (err) {
    // Resolver failure shouldn't blow up the whole import — leave FKs null
    // and surface to the user via importErrors.
    importErrors.push(
      `Holding resolver failed: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }

  // Investment-account constraint pass (strict — issue #22): any row whose
  // account is flagged is_investment but didn't get a holding from the
  // resolver above (no portfolioHolding text — pure cash leg, fee, deposit)
  // is rejected with a per-row error and excluded from the batch. The
  // resolver above still maps user-typed `Cash` (or any explicit holding
  // name) to a real FK, so a CSV that sets `portfolioHolding` for cash legs
  // continues to work end-to-end. The previous permissive default-to-Cash
  // behavior silently masked broken mappings; this loud failure surfaces
  // them at import time before they pollute the portfolio aggregator.
  let rejected: number[] = [];
  try {
    const investmentAccountIds = await getInvestmentAccountIds(userId);
    if (investmentAccountIds.size > 0) {
      rejected = toInsert
        .map((row, i) =>
          row.portfolioHoldingId == null && investmentAccountIds.has(row.accountId)
            ? i
            : -1,
        )
        .filter((i) => i >= 0);
      for (const idx of rejected) {
        const row = toInsert[idx];
        importErrors.push(
          `Row ${row.rowIndex + 1}: investment account requires a portfolio holding — map a holding column (or set "Cash") for this row.`,
        );
      }
    }
  } catch (err) {
    importErrors.push(
      `Investment-account holding check failed: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
  if (rejected.length > 0) {
    const rejectedSet = new Set(rejected);
    for (let i = toInsert.length - 1; i >= 0; i--) {
      if (rejectedSet.has(i)) toInsert.splice(i, 1);
    }
  }

  // Issue #212 — sign-vs-category invariant pass. Pre-fetch the (id → type)
  // map once per batch (one SELECT for every distinct categoryId in the
  // pending rows), then per-row reject violations into importErrors[]. The
  // legacy investment-account-rejection block above is the canonical
  // pattern for "fail this row, keep the batch going" and we mirror its
  // shape exactly.
  let signRejected: number[] = [];
  try {
    const distinctCatIds = new Set<number>();
    for (const row of toInsert) {
      if (row.categoryId != null) distinctCatIds.add(row.categoryId);
    }
    if (distinctCatIds.size > 0) {
      const catTypeMap = await getCategoryTypeMap(userId, userDek ?? null, distinctCatIds);
      signRejected = toInsert
        .map((row, i) => {
          if (row.categoryId == null) return -1;
          const cat = catTypeMap.get(row.categoryId);
          if (!cat) return -1;
          const sErr = validateSignVsCategory({
            amount: row.amount,
            categoryType: cat.type,
            categoryName: cat.name,
          });
          return sErr ? i : -1;
        })
        .filter((i) => i >= 0);
      for (const idx of signRejected) {
        const row = toInsert[idx];
        const cat = catTypeMap.get(row.categoryId!);
        importErrors.push(
          `Row ${row.rowIndex + 1}: category "${cat?.name ?? "?"}" (type ${cat?.type ?? "?"}) disagrees with amount sign (${row.amount}). Flip the sign or pick a different category.`,
        );
      }
    }
  } catch (err) {
    importErrors.push(
      `Sign-vs-category check failed: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
  if (signRejected.length > 0) {
    const rejectedSet = new Set(signRejected);
    for (let i = toInsert.length - 1; i >= 0; i--) {
      if (rejectedSet.has(i)) toInsert.splice(i, 1);
    }
  }

  // Batch insert — encrypt text fields at the boundary (hash was computed on
  // plaintext above, so dedup stays stable across imports). Phase 6
  // (2026-04-29) dropped the legacy portfolio_holding text column; the
  // in-memory `portfolioHolding` field stays for the resolver above but
  // is stripped before each insert via destructuring.
  for (let i = 0; i < toInsert.length; i += batchSize) {
    const batch = toInsert.slice(i, i + batchSize);
    const values = batch.map(({ rowIndex: _, portfolioHolding: _ph, ...rest }) => {
      // Issue #28: stamp the writer surface explicitly. Default 'import'
      // covers CSV/Excel/PDF/OFX/email; connector orchestrators pass
      // 'connector' so reconciliation lineage stays distinct from
      // user-uploaded files.
      const row = { ...rest, userId, source: txSource };
      if (userDek) {
        row.payee = encryptField(userDek, row.payee) ?? "";
        row.note = encryptField(userDek, row.note) ?? "";
        row.tags = encryptField(userDek, row.tags) ?? "";
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
