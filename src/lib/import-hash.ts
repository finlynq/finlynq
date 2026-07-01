import { createHash } from "crypto";
import { db, schema } from "@/db";
import { and, eq, inArray } from "drizzle-orm";

export function generateImportHash(
  date: string,
  accountId: number,
  amount: number,
  payee: string,
): string {
  const normalized = [
    date.trim(),
    String(accountId),
    amount.toFixed(2),
    (payee || "").trim().toLowerCase(),
  ].join("|");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

/**
 * Check for duplicate transactions by `import_hash`.
 *
 * Dedup source-of-truth lives in `bank_transactions` post the two-ledger
 * refactor (2026-05-22). A deleted transaction no longer creates a re-
 * import gap — the bank ledger remembers every approved row regardless of
 * whether the system-side transaction was later edited or wiped.
 *
 * Scoped to the importing user — passing `userId` is required so an
 * authenticated user can't probe another tenant's hashes.
 */
export async function checkDuplicates(hashes: string[], userId: string): Promise<Set<string>> {
  if (hashes.length === 0) return new Set();

  const existing = new Set<string>();
  const batchSize = 900;

  for (let i = 0; i < hashes.length; i += batchSize) {
    const batch = hashes.slice(i, i + batchSize);
    const rows = await db
      .select({ hash: schema.bankTransactions.importHash })
      .from(schema.bankTransactions)
      .where(
        and(
          eq(schema.bankTransactions.userId, userId),
          inArray(schema.bankTransactions.importHash, batch),
        ),
      )
      .all();
    for (const row of rows) {
      if (row.hash) existing.add(row.hash);
    }
  }

  return existing;
}

/**
 * Check for duplicate transactions by fitId (bank-provided unique ID).
 * Returns the set of fitIds that already exist in the bank ledger for
 * the importing user. Same scoping rules as {@link checkDuplicates}.
 */
export async function checkFitIdDuplicates(fitIds: string[], userId: string): Promise<Set<string>> {
  if (fitIds.length === 0) return new Set();

  const existing = new Set<string>();
  const batchSize = 900;

  for (let i = 0; i < fitIds.length; i += batchSize) {
    const batch = fitIds.slice(i, i + batchSize);
    const rows = await db
      .select({ fitId: schema.bankTransactions.fitId })
      .from(schema.bankTransactions)
      .where(
        and(
          eq(schema.bankTransactions.userId, userId),
          inArray(schema.bankTransactions.fitId, batch),
        ),
      )
      .all();
    for (const row of rows) {
      if (row.fitId) existing.add(row.fitId);
    }
  }

  return existing;
}

/**
 * Account-scoped variant of {@link checkFitIdDuplicates}. A bank transaction id
 * (OFX FITID, SimpleFIN transaction id) is unique only WITHIN an account — some
 * providers (e.g. SimpleFIN's demo bridge) reuse the posted-epoch as the id, so
 * two accounts routinely share ids. A user-scoped check would wrongly flag
 * account B's rows as duplicates of account A's. Use this for any account-bound
 * import (OFX/QFX, connectors); fall back to the user-scoped version only when
 * there's no bound account.
 */
export async function checkFitIdDuplicatesForAccount(
  fitIds: string[],
  userId: string,
  accountId: number,
): Promise<Set<string>> {
  if (fitIds.length === 0) return new Set();

  const existing = new Set<string>();
  const batchSize = 900;

  for (let i = 0; i < fitIds.length; i += batchSize) {
    const batch = fitIds.slice(i, i + batchSize);
    const rows = await db
      .select({ fitId: schema.bankTransactions.fitId })
      .from(schema.bankTransactions)
      .where(
        and(
          eq(schema.bankTransactions.userId, userId),
          eq(schema.bankTransactions.accountId, accountId),
          inArray(schema.bankTransactions.fitId, batch),
        ),
      )
      .all();
    for (const row of rows) {
      if (row.fitId) existing.add(row.fitId);
    }
  }

  return existing;
}

/** Metadata about an existing transaction that an incoming row matched. */
export interface ExactDuplicateMatchInfo {
  /**
   * `transactions.id` of the currently-linked transaction. NULL when the
   * bank ledger has the row but the linked transaction was deleted (rare:
   * the user manually deleted an approved row, or backup-restore omitted
   * the transaction). Callers that render "#X" should fall back to
   * "previously imported" when null.
   */
  id: number | null;
  /**
   * Permanent UUID of the bank-ledger row. Always present — the bank
   * ledger is the source-of-truth for the dedup match.
   */
  bankTransactionId: string;
  date: string;
  amount: number;
  source: string | null;
}

/**
 * Like {@link checkDuplicates}, but also returns the matched bank-ledger
 * row's id plus the linked transaction's id (when present) so the UI can
 * show "Matches existing transaction #X" or "Previously imported (no
 * current transaction)".
 *
 * Picks the lowest-id linked transaction per hash on collision. If a hash
 * matches a bank row with no linked transaction, the entry surfaces with
 * `id: null` — the bank ledger remembers even if the system-side row was
 * deleted (this is the whole point of moving dedup to the bank ledger).
 *
 * If multiple bank rows share the same `import_hash` (legitimate same-day
 * duplicates split across different `occurrence_index` values), the
 * lowest-tx-id pairing across all of them wins — same contract as the
 * pre-refactor "lowest-id match per hash" rule.
 */
export async function findDuplicateMatches(
  hashes: string[],
  userId: string,
): Promise<Map<string, ExactDuplicateMatchInfo>> {
  const out = new Map<string, ExactDuplicateMatchInfo>();
  if (hashes.length === 0) return out;

  const batchSize = 900;
  for (let i = 0; i < hashes.length; i += batchSize) {
    const batch = hashes.slice(i, i + batchSize);
    const rows = await db
      .select({
        importHash: schema.bankTransactions.importHash,
        bankId: schema.bankTransactions.id,
        bankDate: schema.bankTransactions.date,
        bankAmount: schema.bankTransactions.amount,
        bankSource: schema.bankTransactions.source,
        txId: schema.transactions.id,
      })
      .from(schema.bankTransactions)
      .leftJoin(
        schema.transactions,
        and(
          eq(schema.transactions.bankTransactionId, schema.bankTransactions.id),
          eq(schema.transactions.userId, schema.bankTransactions.userId),
        ),
      )
      .where(
        and(
          eq(schema.bankTransactions.userId, userId),
          inArray(schema.bankTransactions.importHash, batch),
        ),
      )
      .all();

    for (const row of rows) {
      if (!row.importHash) continue;
      const existing = out.get(row.importHash);
      // Replace the existing entry only if the new row has a linked
      // transaction AND beats the existing's tx id (or the existing has
      // no link). A null-tx entry is the fallback when no row has a link.
      if (!existing) {
        out.set(row.importHash, {
          id: row.txId != null ? Number(row.txId) : null,
          bankTransactionId: row.bankId,
          date: row.bankDate,
          amount: Number(row.bankAmount),
          source: row.bankSource ?? null,
        });
        continue;
      }
      if (row.txId != null) {
        if (existing.id == null || Number(row.txId) < existing.id) {
          out.set(row.importHash, {
            id: Number(row.txId),
            bankTransactionId: row.bankId,
            date: row.bankDate,
            amount: Number(row.bankAmount),
            source: row.bankSource ?? null,
          });
        }
      }
    }
  }
  return out;
}

/** fitId-keyed sibling of {@link findDuplicateMatches}. */
export async function findFitIdMatches(
  fitIds: string[],
  userId: string,
): Promise<Map<string, ExactDuplicateMatchInfo>> {
  const out = new Map<string, ExactDuplicateMatchInfo>();
  if (fitIds.length === 0) return out;

  const batchSize = 900;
  for (let i = 0; i < fitIds.length; i += batchSize) {
    const batch = fitIds.slice(i, i + batchSize);
    const rows = await db
      .select({
        fitId: schema.bankTransactions.fitId,
        bankId: schema.bankTransactions.id,
        bankDate: schema.bankTransactions.date,
        bankAmount: schema.bankTransactions.amount,
        bankSource: schema.bankTransactions.source,
        txId: schema.transactions.id,
      })
      .from(schema.bankTransactions)
      .leftJoin(
        schema.transactions,
        and(
          eq(schema.transactions.bankTransactionId, schema.bankTransactions.id),
          eq(schema.transactions.userId, schema.bankTransactions.userId),
        ),
      )
      .where(
        and(
          eq(schema.bankTransactions.userId, userId),
          inArray(schema.bankTransactions.fitId, batch),
        ),
      )
      .all();

    for (const row of rows) {
      if (!row.fitId) continue;
      const existing = out.get(row.fitId);
      if (!existing) {
        out.set(row.fitId, {
          id: row.txId != null ? Number(row.txId) : null,
          bankTransactionId: row.bankId,
          date: row.bankDate,
          amount: Number(row.bankAmount),
          source: row.bankSource ?? null,
        });
        continue;
      }
      if (row.txId != null) {
        if (existing.id == null || Number(row.txId) < existing.id) {
          out.set(row.fitId, {
            id: Number(row.txId),
            bankTransactionId: row.bankId,
            date: row.bankDate,
            amount: Number(row.bankAmount),
            source: row.bankSource ?? null,
          });
        }
      }
    }
  }
  return out;
}

/**
 * Per-batch occurrence-index assignment. Within a single upload batch,
 * rows whose `(account_id, import_hash)` collide (intentional same-day
 * duplicates: two $5 coffees at the same place on the same day) get
 * distinct occurrence indices 0, 1, 2, … so the eventual bank-ledger
 * unique constraint `(user_id, account_id, import_hash, occurrence_index)`
 * doesn't collapse them via ON CONFLICT.
 *
 * Cross-batch collisions (re-uploading a file with the same rows) are
 * handled differently: the existing bank-ledger rows already carry
 * occurrence indices 0..N-1, and the new batch should reuse the SAME
 * indices so the upsert hits the existing rows. The simplest invariant:
 * occurrence_index is deterministic within a batch (group by hash, count
 * up from 0), and the upsert path handles cross-batch idempotency.
 *
 * @param rows Iterable of `(accountId, importHash)` pairs to label.
 * @returns Array of occurrence indices, parallel to the input order.
 */
export function assignOccurrenceIndices<T extends { accountId: number; hash: string }>(
  rows: readonly T[],
): number[] {
  const counts = new Map<string, number>();
  const out: number[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const key = `${rows[i].accountId}|${rows[i].hash}`;
    const next = counts.get(key) ?? 0;
    out[i] = next;
    counts.set(key, next + 1);
  }
  return out;
}
