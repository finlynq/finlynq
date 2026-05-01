/**
 * Reconciliation mode (issue #36).
 *
 * Statement-import workflow that classifies each parsed row against
 * existing Finlynq state before any write happens, then commits the
 * user-approved subset atomically.
 *
 * Three-way classification (vs the binary NEW / DUPLICATE the regular
 * import preview produces):
 *
 *   - NEW                — no fit_id or import_hash hit
 *   - EXISTING           — exact dedup hit (same row already in DB)
 *   - PROBABLE_DUPLICATE — same (account, signed amount) within ±N days
 *                          but no exact hash hit. Settlement-vs-posting
 *                          gaps are the canonical case.
 *
 * Pure logic — file parsing lives in csv-parser/ofx-parser; this module
 * orchestrates classification + atomic commit. Used by
 * /api/import/reconcile/{preview,commit}.
 */

import { db, schema } from "@/db";
import { and, eq, inArray, or } from "drizzle-orm";
import { generateImportHash, checkDuplicates, checkFitIdDuplicates } from "./import-hash";
import { normalizeDate } from "./csv-parser";
import { tryDecryptField, encryptField } from "./crypto/envelope";
import { applyRulesToBatch, type TransactionRule } from "./auto-categorize";
import { getInvestmentAccountIds } from "./investment-account";
import { safeConvertToAccountCurrency } from "./currency-conversion";
import { prewarmRates } from "./fx-service";
import { invalidateUser as invalidateUserTxCache } from "./mcp/user-tx-cache";
import { detectProbableDuplicates } from "./external-import/duplicate-detect";
import { buildDuplicateCandidatePool } from "./external-import/duplicate-detect-pool";
import type { RawTransaction } from "./import-pipeline";

/** Default settlement-vs-posting fuzz window. */
export const DEFAULT_DATE_TOLERANCE_DAYS = 3;

/** Hard cap for one reconcile session — keeps preview classification cheap. */
export const MAX_RECONCILE_ROWS = 10_000;

export type ReconcileStatus = "new" | "existing" | "probable_duplicate";

/** Existing-row pointer attached to EXISTING / PROBABLE_DUPLICATE rows. */
export interface ReconcileMatch {
  transactionId: number;
  date: string;
  amount: number;
  payee: string;
  /** Days between the parsed row's date and the matched row's date. */
  daysOff: number;
}

/** A parsed row enriched with classification + resolved ids. */
export interface ReconcileRow {
  /** 0-based index back into the parsed input. Stable across edits. */
  rowIndex: number;
  date: string;
  /** Resolved account name (post-edit). May be empty if unresolved. */
  account: string;
  /** Resolved Finlynq account id, or null if the account name didn't resolve. */
  accountId: number | null;
  amount: number;
  payee: string;
  category?: string;
  /** Resolved category id; null = leave uncategorized. */
  categoryId?: number | null;
  currency?: string;
  enteredAmount?: number;
  enteredCurrency?: string;
  note?: string;
  tags?: string;
  quantity?: number;
  portfolioHolding?: string;
  portfolioHoldingId?: number | null;
  fitId?: string;
  linkId?: string;
  hash: string;
  status: ReconcileStatus;
  /** Set when status !== 'new'. */
  match?: ReconcileMatch;
}

export interface ReconcileClassifyOptions {
  /** Days fuzz window for probable-duplicate detection. */
  dateToleranceDays?: number;
}

export interface ReconcileClassifyResult {
  rows: ReconcileRow[];
  errors: Array<{ rowIndex: number; message: string }>;
  /** Convenience counts for the UI summary card. */
  counts: { new: number; existing: number; probableDuplicate: number; errors: number };
}

interface AccountLookup {
  id: number;
  currency: string;
}

async function buildAccountLookup(
  userId: string,
  dek: Buffer,
): Promise<Map<string, AccountLookup>> {
  const rows = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.userId, userId))
    .all();
  const map = new Map<string, AccountLookup>();
  for (const a of rows) {
    const plainName = a.nameCt
      ? (tryDecryptField(dek, a.nameCt, "accounts.name_ct") ?? a.name)
      : a.name;
    const plainAlias = a.aliasCt
      ? (tryDecryptField(dek, a.aliasCt, "accounts.alias_ct") ?? a.alias)
      : a.alias;
    if (plainName) {
      const key = plainName.toLowerCase().trim();
      map.set(key, { id: a.id, currency: a.currency });
    }
    if (plainAlias) {
      const key = plainAlias.toLowerCase().trim();
      if (key && !map.has(key)) {
        map.set(key, { id: a.id, currency: a.currency });
      }
    }
  }
  return map;
}

async function buildCategoryLookup(
  userId: string,
  dek: Buffer,
): Promise<Map<string, number>> {
  const rows = await db
    .select()
    .from(schema.categories)
    .where(eq(schema.categories.userId, userId))
    .all();
  const map = new Map<string, number>();
  for (const c of rows) {
    const plainName = c.nameCt
      ? (tryDecryptField(dek, c.nameCt, "categories.name_ct") ?? c.name)
      : c.name;
    if (plainName) map.set(plainName.toLowerCase().trim(), c.id);
  }
  return map;
}

function daysBetween(a: string, b: string): number {
  const ams = Date.parse(a + "T00:00:00Z");
  const bms = Date.parse(b + "T00:00:00Z");
  if (Number.isNaN(ams) || Number.isNaN(bms)) return Number.POSITIVE_INFINITY;
  return Math.round(Math.abs(ams - bms) / 86_400_000);
}

/**
 * Classify a batch of parsed rows against existing Finlynq state.
 *
 * Resolution order per row:
 *   1. account name → accounts.id (lower/trim, plaintext + alias)
 *   2. fit_id hit  → EXISTING
 *   3. import_hash hit → EXISTING
 *   4. (account_id, amount) match within ±tolerance days, not also hash-matched → PROBABLE_DUPLICATE
 *   5. else → NEW
 */
export async function classifyForReconcile(
  userId: string,
  dek: Buffer,
  rows: RawTransaction[],
  opts: ReconcileClassifyOptions = {},
): Promise<ReconcileClassifyResult> {
  const tolerance = opts.dateToleranceDays ?? DEFAULT_DATE_TOLERANCE_DAYS;
  const errors: ReconcileClassifyResult["errors"] = [];

  if (rows.length > MAX_RECONCILE_ROWS) {
    errors.push({
      rowIndex: 0,
      message: `Statement contains ${rows.length.toLocaleString()} rows, exceeding the ${MAX_RECONCILE_ROWS.toLocaleString()} reconcile limit. Split the file into smaller chunks.`,
    });
    return { rows: [], errors, counts: { new: 0, existing: 0, probableDuplicate: 0, errors: 1 } };
  }

  const accountLookup = await buildAccountLookup(userId, dek);
  const categoryLookup = await buildCategoryLookup(userId, dek);

  // First pass: resolve and shape — collect rows that pass basic validation.
  const shaped: ReconcileRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const accountKey = (row.account ?? "").toLowerCase().trim();
    const acct = accountKey ? accountLookup.get(accountKey) : undefined;

    if (!row.date) {
      errors.push({ rowIndex: i, message: "Missing date" });
      continue;
    }
    const normalizedDate = normalizeDate(row.date);
    if (!normalizedDate) {
      errors.push({
        rowIndex: i,
        message: `Invalid date "${row.date}". Expected YYYY-MM-DD, MM/DD/YYYY, or DD-MM-YYYY.`,
      });
      continue;
    }
    if (typeof row.amount !== "number" || Number.isNaN(row.amount)) {
      errors.push({ rowIndex: i, message: "Invalid amount" });
      continue;
    }

    const categoryId = row.category
      ? (categoryLookup.get(row.category.toLowerCase().trim()) ?? null)
      : null;

    const accountId = acct?.id ?? null;
    // Hash uses 0 when accountId is unknown — re-computed in commitReconcile
    // once the user has bound a real account in preview-edit. Stable enough
    // here for the dedup join below; an unresolved account skips dedup
    // anyway.
    const hash = generateImportHash(
      normalizedDate,
      accountId ?? 0,
      row.amount,
      row.payee ?? "",
    );

    shaped.push({
      rowIndex: i,
      date: normalizedDate,
      account: row.account ?? "",
      accountId,
      amount: row.amount,
      payee: row.payee ?? "",
      category: row.category,
      categoryId,
      currency: row.currency,
      enteredAmount: row.enteredAmount,
      enteredCurrency: row.enteredCurrency,
      note: row.note,
      tags: row.tags,
      quantity: row.quantity,
      portfolioHolding: row.portfolioHolding,
      fitId: row.fitId,
      linkId: row.linkId,
      hash,
      status: "new",
    });
  }

  // Exact-match dedup pass (fit_id + import_hash). Matches the regular
  // import preview semantics so a row that's already been imported through
  // any pipeline shows up as EXISTING here.
  const fitIds = shaped.filter((r) => r.fitId).map((r) => r.fitId!);
  const hashes = shaped.filter((r) => r.accountId !== null).map((r) => r.hash);
  const existingFitIds = await checkFitIdDuplicates(fitIds);
  const existingHashes = await checkDuplicates(hashes);

  // Pull the matching rows so we can attach a ReconcileMatch (id + date).
  // Only fetch by ids we actually need — the union of fitId hits and hash
  // hits keeps this query small.
  const fitIdHits = fitIds.filter((f) => existingFitIds.has(f));
  const hashHits = hashes.filter((h) => existingHashes.has(h));
  // inArray(col, []) renders as `false` in drizzle so we OR the two
  // arms unconditionally — the empty side just contributes nothing.
  const exactMatchRows =
    fitIdHits.length === 0 && hashHits.length === 0
      ? []
      : await db
          .select({
            id: schema.transactions.id,
            date: schema.transactions.date,
            amount: schema.transactions.amount,
            payeeCt: schema.transactions.payee,
            fitId: schema.transactions.fitId,
            importHash: schema.transactions.importHash,
          })
          .from(schema.transactions)
          .where(
            and(
              eq(schema.transactions.userId, userId),
              or(
                inArray(schema.transactions.fitId, fitIdHits),
                inArray(schema.transactions.importHash, hashHits),
              ),
            ),
          )
          .all();
  const matchByFitId = new Map<string, (typeof exactMatchRows)[number]>();
  const matchByHash = new Map<string, (typeof exactMatchRows)[number]>();
  for (const row of exactMatchRows) {
    if (row.fitId) matchByFitId.set(row.fitId, row);
    if (row.importHash) matchByHash.set(row.importHash, row);
  }

  for (const row of shaped) {
    const exact =
      (row.fitId && matchByFitId.get(row.fitId)) ||
      (row.accountId !== null && matchByHash.get(row.hash));
    if (!exact) continue;
    row.status = "existing";
    row.match = {
      transactionId: exact.id,
      date: exact.date,
      amount: exact.amount,
      payee: tryDecryptPayee(dek, exact.payeeCt) ?? exact.payeeCt ?? "",
      daysOff: daysBetween(row.date, exact.date),
    };
  }

  // Probable-duplicate pass: rows still marked NEW with a resolved account.
  // Delegates to the shared cross-source detector (issue #65) with tight
  // reconcile semantics — exact-amount-cents (pct=0, floor=0.005), ±tolerance
  // days, no soft hints required (threshold=0.5). The shared helper handles
  // the consume-once-per-existing-row invariant, the import-hash skip, and
  // the closest-date tiebreaker so the four-way classification stays
  // consistent with the regular import preview.
  const candidates = shaped.filter(
    (r) => r.status === "new" && r.accountId !== null,
  );
  if (candidates.length > 0) {
    const accountIds = Array.from(new Set(candidates.map((r) => r.accountId!)));
    const dates = candidates.map((r) => r.date).sort();
    const dateMin = dates[0];
    const dateMax = dates[dates.length - 1];
    const pool = await buildDuplicateCandidatePool({
      userId,
      dek,
      accountIds,
      dateMin,
      dateMax,
      dateToleranceDays: tolerance,
    });

    // Mark candidates already consumed by exact-match so the detector
    // doesn't double-flag the same existing transaction.
    const exactMatchedIds = new Set<number>();
    for (const r of shaped) {
      if (r.match) exactMatchedIds.add(r.match.transactionId);
    }
    if (exactMatchedIds.size > 0) {
      for (const arr of pool.byAccount.values()) {
        for (let i = arr.length - 1; i >= 0; i--) {
          if (exactMatchedIds.has(arr[i].id)) arr.splice(i, 1);
        }
      }
    }

    const matches = detectProbableDuplicates(
      candidates.map((c) => ({
        rowIndex: c.rowIndex,
        date: c.date,
        accountId: c.accountId!,
        amount: c.amount,
        payeePlain: c.payee,
        importHash: c.hash,
      })),
      pool,
      {
        dateToleranceDays: tolerance,
        amountTolerancePct: 0,
        amountToleranceFloor: 0.005,
        scoreThreshold: 0.5, // amount + date alone (= 0.7) clears this
      },
    );
    const matchByRowIndex = new Map<number, (typeof matches)[number]>();
    for (const m of matches) matchByRowIndex.set(m.rowIndex, m);

    // Pull the matched-row payees in one shot for nice display strings. The
    // detector itself returns ids; reconcile UI wants payee text.
    const matchedIds = matches.map((m) => m.matchedTransactionId);
    let payeeById = new Map<number, string>();
    if (matchedIds.length > 0) {
      const payeeRows = await db
        .select({
          id: schema.transactions.id,
          payeeCt: schema.transactions.payee,
        })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.userId, userId),
            inArray(schema.transactions.id, matchedIds),
          ),
        )
        .all();
      payeeById = new Map(
        payeeRows.map((p) => [p.id, tryDecryptPayee(dek, p.payeeCt) ?? p.payeeCt ?? ""]),
      );
    }

    for (const row of candidates) {
      const m = matchByRowIndex.get(row.rowIndex);
      if (!m) continue;
      row.status = "probable_duplicate";
      row.match = {
        transactionId: m.matchedTransactionId,
        date: m.matchedTx.date,
        amount: m.matchedTx.amount,
        payee: payeeById.get(m.matchedTransactionId) ?? "",
        daysOff: m.matchedTx.daysOff,
      };
    }
  }

  const counts = {
    new: shaped.filter((r) => r.status === "new").length,
    existing: shaped.filter((r) => r.status === "existing").length,
    probableDuplicate: shaped.filter((r) => r.status === "probable_duplicate").length,
    errors: errors.length,
  };

  return { rows: shaped, errors, counts };
}

function tryDecryptPayee(dek: Buffer, value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith("v1:")) return value;
  return tryDecryptField(dek, value, "transactions.payee");
}

/** Subset of ReconcileRow the commit handler accepts back from the client. */
export interface ApprovedReconcileRow {
  rowIndex: number;
  date: string;
  accountId: number;
  amount: number;
  payee: string;
  categoryId?: number | null;
  currency?: string;
  enteredAmount?: number;
  enteredCurrency?: string;
  note?: string;
  tags?: string;
  quantity?: number;
  portfolioHoldingId?: number | null;
  fitId?: string;
  linkId?: string;
}

export interface CommitResult {
  total: number;
  imported: number;
  errors: string[];
}

/**
 * Atomic commit. The whole batch lives inside one `db.transaction()` —
 * any failure rolls back every insert so the user is never left with a
 * partial commit they can't see.
 *
 * Re-validates account ownership inside the transaction (defends against
 * tampered finlynqAccountId values from the client).
 */
export async function commitReconcile(
  userId: string,
  dek: Buffer,
  approved: ApprovedReconcileRow[],
): Promise<CommitResult> {
  const errors: string[] = [];
  if (approved.length === 0) {
    return { total: 0, imported: 0, errors };
  }
  if (approved.length > MAX_RECONCILE_ROWS) {
    return {
      total: approved.length,
      imported: 0,
      errors: [`Commit exceeds ${MAX_RECONCILE_ROWS} row limit`],
    };
  }

  // Account ownership + currency lookup. Reject any row whose accountId
  // doesn't belong to this user before we open the transaction.
  const accountIds = Array.from(new Set(approved.map((r) => r.accountId)));
  const accountRows = await db
    .select({ id: schema.accounts.id, currency: schema.accounts.currency })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.userId, userId),
        inArray(schema.accounts.id, accountIds),
      ),
    )
    .all();
  const accountById = new Map<number, { currency: string }>();
  for (const a of accountRows) accountById.set(a.id, { currency: a.currency });
  for (const id of accountIds) {
    if (!accountById.has(id)) {
      return {
        total: approved.length,
        imported: 0,
        errors: [`Account #${id} not found or not owned by current user`],
      };
    }
  }

  // Investment-account holding constraint pass (matches import-pipeline).
  const investmentAccountIds = await getInvestmentAccountIds(userId);
  for (const row of approved) {
    if (
      investmentAccountIds.has(row.accountId) &&
      (row.portfolioHoldingId == null || row.portfolioHoldingId === 0)
    ) {
      return {
        total: approved.length,
        imported: 0,
        errors: [
          `Row ${row.rowIndex + 1}: investment account requires a portfolio holding — pick one in preview before committing.`,
        ],
      };
    }
  }

  // Prewarm FX rates for cross-currency rows so the per-row conversion
  // inside the transaction doesn't trigger N Yahoo fetches.
  const prewarmCcy = new Set<string>();
  const prewarmDates = new Set<string>();
  for (const row of approved) {
    const acctCcy = accountById.get(row.accountId)?.currency ?? "CAD";
    const enteredCcy = (row.enteredCurrency ?? row.currency ?? acctCcy).toUpperCase();
    if (enteredCcy !== acctCcy.toUpperCase()) {
      prewarmCcy.add(enteredCcy);
      prewarmCcy.add(acctCcy.toUpperCase());
      prewarmDates.add(row.date);
    }
  }
  if (prewarmCcy.size > 0 && prewarmDates.size > 0) {
    try {
      await prewarmRates([...prewarmCcy], [...prewarmDates], userId);
    } catch {
      // best-effort
    }
  }

  // Build insertable rows, run auto-categorize on uncategorized ones, then
  // open the transaction and INSERT in one atomic batch. If any INSERT
  // throws, the whole transaction rolls back.
  const insertable = await Promise.all(
    approved.map(async (row) => {
      const acctCcy = (accountById.get(row.accountId)?.currency ?? "CAD").toUpperCase();
      const enteredAmount = row.enteredAmount ?? row.amount;
      const enteredCurrency = (row.enteredCurrency ?? row.currency ?? acctCcy).toUpperCase();
      let amount = row.amount;
      let currency = enteredCurrency;
      let enteredFxRate = 1;
      if (enteredCurrency !== acctCcy) {
        const conv = await safeConvertToAccountCurrency({
          enteredAmount,
          enteredCurrency,
          accountCurrency: acctCcy,
          date: row.date,
          userId,
        });
        amount = conv.amount;
        currency = conv.currency;
        enteredFxRate = conv.enteredFxRate;
      } else {
        amount = enteredAmount;
        currency = acctCcy;
      }
      const importHash = generateImportHash(
        row.date,
        row.accountId,
        row.amount,
        row.payee,
      );
      return {
        rowIndex: row.rowIndex,
        userId,
        date: row.date,
        accountId: row.accountId,
        categoryId: row.categoryId ?? null,
        currency,
        amount,
        enteredCurrency,
        enteredAmount,
        enteredFxRate,
        quantity: row.quantity ?? null,
        portfolioHoldingId: row.portfolioHoldingId ?? null,
        note: row.note ?? "",
        payee: row.payee ?? "",
        tags: row.tags ?? "",
        importHash,
        fitId: row.fitId ?? null,
        linkId: row.linkId ?? null,
        source: "import" as const,
      };
    }),
  );

  // Apply auto-categorize rules to rows whose user-supplied categoryId is
  // null (matches import-pipeline behavior — best-effort).
  try {
    const activeRules = (await db
      .select()
      .from(schema.transactionRules)
      .where(eq(schema.transactionRules.isActive, 1))
      .all()) as TransactionRule[];
    if (activeRules.length > 0) {
      const uncategorized = insertable.filter((r) => !r.categoryId);
      if (uncategorized.length > 0) {
        const results = applyRulesToBatch(
          uncategorized.map((r) => ({ payee: r.payee, amount: r.amount, tags: r.tags })),
          activeRules,
        );
        for (const { index, match } of results) {
          if (match) {
            const r = uncategorized[index];
            if (match.assignCategoryId) r.categoryId = match.assignCategoryId;
            if (match.assignTags) r.tags = match.assignTags;
            if (match.renameTo) r.payee = match.renameTo;
          }
        }
      }
    }
  } catch {
    // best-effort
  }

  let imported = 0;
  try {
    await db.transaction(async (tx) => {
      // Encrypt at the boundary — same envelope semantics as import-pipeline.
      const values = insertable.map(({ rowIndex: _i, ...rest }) => ({
        ...rest,
        payee: encryptField(dek, rest.payee) ?? "",
        note: encryptField(dek, rest.note) ?? "",
        tags: encryptField(dek, rest.tags) ?? "",
      }));
      // One INSERT, all-or-nothing. Postgres handles batch values fine for
      // up to a few thousand rows; the MAX_RECONCILE_ROWS cap protects us.
      if (values.length > 0) {
        await tx.insert(schema.transactions).values(values);
        imported = values.length;
      }
    });
  } catch (e) {
    return {
      total: approved.length,
      imported: 0,
      errors: [
        `Atomic commit failed — no rows imported: ${e instanceof Error ? e.message : "Unknown error"}`,
      ],
    };
  }

  if (imported > 0) invalidateUserTxCache(userId);
  return { total: approved.length, imported, errors };
}
