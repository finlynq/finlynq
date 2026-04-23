/**
 * In-memory decrypted transaction cache per user.
 *
 * Why: several MCP tools need to GROUP BY / match against plaintext payee
 * (detect_subscriptions, test_rule, payee-frequency suggestions). AES-GCM
 * uses a random IV per row so SQL GROUP BY on the ciphertext is wrong —
 * every identical payee becomes a different group. This cache fetches the
 * user's transactions once, decrypts payee / note / tags in memory, and
 * hands out a simple array of plaintext rows for aggregation tools.
 *
 * Lifetime: process-lifetime. Survives HMR via `globalThis.__pfTxCache`.
 *   Bounds:
 *   - Up to 10 users cached simultaneously (LRU eviction).
 *   - Up to 50k rows per user (oldest-by-date rows dropped if exceeded).
 *
 * Invalidation: every write path that touches a user's transactions MUST
 * call `invalidateUser(userId)`. Missing an invalidation = Claude reading
 * stale payees. Known call sites to wire into in Wave 2:
 *   - /api/transactions POST/PUT/DELETE
 *   - /api/transactions/bulk (all actions)
 *   - /api/transactions/splits (any mutation)
 *   - /api/data/import, /api/import/execute, /api/import/backfill
 *   - MCP record_transaction, bulk_record_transactions, update_transaction,
 *     delete_transaction, categorize_transaction, apply_rules_to_uncategorized
 *
 * Security: the DEK is only used to decrypt rows on miss. It's not stored
 * on the entry. If the DEK passed in is null (session cache miss after
 * deploy) we fall back to whatever `decryptTxRows` returns — legacy
 * plaintext stays readable; encrypted rows ship as `v1:...` blobs. This
 * matches the soft-guard behavior used elsewhere in the codebase.
 */

import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { decryptTxRows } from "@/lib/crypto/encrypted-columns";

export interface CachedTx {
  id: number;
  date: string;
  amount: number;
  /** Plaintext after decrypt (or `v1:` blob if DEK was null at load time). */
  payee: string;
  categoryId: number | null;
  accountId: number | null;
  /** Plaintext after decrypt. */
  tags: string;
  /** Plaintext after decrypt. */
  note: string;
}

interface CacheEntry {
  rows: CachedTx[];
  loadedAt: number;
  lastAccess: number;
  /** True if loaded with a null DEK — payee/note/tags may be ciphertext. */
  degraded: boolean;
}

const MAX_USERS = 10;
const MAX_ROWS_PER_USER = 50_000;

// HMR-safe registry. Same pattern as `src/db/index.ts`.
type CacheMap = Map<string, CacheEntry>;
const g = globalThis as typeof globalThis & {
  __pfTxCache?: CacheMap;
};
function getStore(): CacheMap {
  if (!g.__pfTxCache) g.__pfTxCache = new Map();
  return g.__pfTxCache;
}

/** Evict least-recently-accessed user until we're under MAX_USERS. */
function evictIfNeeded(store: CacheMap): void {
  while (store.size > MAX_USERS) {
    let oldestKey: string | null = null;
    let oldestTs = Infinity;
    for (const [k, v] of store) {
      if (v.lastAccess < oldestTs) {
        oldestTs = v.lastAccess;
        oldestKey = k;
      }
    }
    if (oldestKey === null) break;
    store.delete(oldestKey);
  }
}

async function loadFromDb(userId: string, dek: Buffer | null): Promise<CachedTx[]> {
  const raw = await db
    .select({
      id: schema.transactions.id,
      date: schema.transactions.date,
      amount: schema.transactions.amount,
      payee: schema.transactions.payee,
      note: schema.transactions.note,
      tags: schema.transactions.tags,
      categoryId: schema.transactions.categoryId,
      accountId: schema.transactions.accountId,
    })
    .from(schema.transactions)
    .where(eq(schema.transactions.userId, userId));

  const decrypted = decryptTxRows(dek, raw);

  // Cap rows. Keep the newest by date — subscription/rule tools care about
  // recent history, and historical backfill users can legitimately exceed
  // 50k rows. Oldest dropped.
  let rows = decrypted as typeof raw;
  if (rows.length > MAX_ROWS_PER_USER) {
    rows = [...rows]
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      .slice(0, MAX_ROWS_PER_USER);
  }

  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    amount: Number(r.amount) || 0,
    payee: r.payee ?? "",
    categoryId: r.categoryId ?? null,
    accountId: r.accountId ?? null,
    tags: r.tags ?? "",
    note: r.note ?? "",
  }));
}

/**
 * Get decrypted transactions for a user. Caches the result in memory; second
 * call is O(1) until something calls `invalidateUser(userId)`.
 *
 * Pass the caller's session DEK so encrypted fields decrypt correctly. A
 * null DEK is tolerated — rows pass through `decryptTxRows` unchanged, so
 * encrypted fields surface as `v1:` blobs rather than 423-ing the caller.
 * Mark the entry as `degraded` in that case and reload on the next call
 * that supplies a real DEK.
 */
export async function getUserTransactions(
  userId: string,
  dek: Buffer | null
): Promise<CachedTx[]> {
  const store = getStore();
  const existing = store.get(userId);

  // Reload if we previously cached a degraded (null-DEK) result and we now
  // have a real DEK. Otherwise a hit is a hit.
  if (existing && !(existing.degraded && dek)) {
    existing.lastAccess = Date.now();
    return existing.rows;
  }

  const rows = await loadFromDb(userId, dek);
  const now = Date.now();
  store.set(userId, {
    rows,
    loadedAt: now,
    lastAccess: now,
    degraded: dek === null,
  });
  evictIfNeeded(store);
  return rows;
}

/**
 * Drop the cached entry for a user. Call from every write path that mutates
 * this user's `transactions` rows. Idempotent.
 */
export function invalidateUser(userId: string): void {
  const store = getStore();
  store.delete(userId);
}

/** Test/debug helper — nukes the whole cache. Not for production use. */
export function __clearAll(): void {
  getStore().clear();
}

/** Test/debug helper — current cached user count. */
export function __size(): number {
  return getStore().size;
}

/** Exported for tests / observability. */
export const __internals = { MAX_USERS, MAX_ROWS_PER_USER };
