/**
 * In-memory per-session DEK cache.
 *
 * Populated on login (when we unwrap the DEK), read on every request that
 * needs to decrypt/encrypt a column, invalidated on logout.
 *
 * Survives Next.js HMR in dev via the globalThis singleton pattern
 * (same trick used for the DB adapter).
 *
 * A process restart wipes the cache; clients must re-authenticate to
 * repopulate it. API routes that fail to find a DEK for a session must
 * return 423 Locked and the UI should surface a "please log in again" prompt.
 */

interface Entry {
  dek: Buffer;
  /** Hard expiry — absolute max TTL. Never extended by activity. */
  expiresAt: number;
  /** Idle expiry — extends on each getDEK(). Drops the entry after N minutes
   * of inactivity even if the hard TTL hasn't hit. Finding #15. */
  idleExpiresAt: number;
}

/** Idle window for sliding expiry. After this many ms without a read, the
 * DEK is evicted and the user must re-auth for the next sensitive op. */
const IDLE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;

if (!g.__pfDekCache) {
  g.__pfDekCache = new Map<string, Entry>();
}

const cache: Map<string, Entry> = g.__pfDekCache;

// Background sweeper — runs once per process. Avoids unbounded memory if a
// lot of sessions come and go without an explicit logout. `setInterval` is
// absent from Edge runtime; the lazy-eviction path in getDEK() still cleans
// individual entries even without the sweeper, so no-op there is safe.
if (!g.__pfDekCacheSweeper && typeof setInterval === "function") {
  const handle = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of cache) {
      // Evict if EITHER the hard TTL OR the idle window has expired.
      if (v.expiresAt <= now || v.idleExpiresAt <= now) cache.delete(k);
    }
  }, 60_000);
  // Node: don't keep the event loop alive for the sweeper.
  (handle as unknown as { unref?: () => void }).unref?.();
  g.__pfDekCacheSweeper = handle;
}

/** Store a DEK for a session. `ttlMs` should match the JWT's remaining lifetime. */
export function putDEK(sessionId: string, dek: Buffer, ttlMs: number): void {
  const now = Date.now();
  cache.set(sessionId, {
    dek,
    expiresAt: now + ttlMs,
    idleExpiresAt: now + IDLE_TTL_MS,
  });
}

/** Retrieve the DEK for a session, or null if missing/expired. Extends the
 * idle window on each successful read — Finding #15 sliding-window. */
export function getDEK(sessionId: string): Buffer | null {
  const entry = cache.get(sessionId);
  if (!entry) return null;
  const now = Date.now();
  if (entry.expiresAt <= now || entry.idleExpiresAt <= now) {
    cache.delete(sessionId);
    return null;
  }
  // Extend idle window on read, capped by the hard expiry.
  entry.idleExpiresAt = Math.min(now + IDLE_TTL_MS, entry.expiresAt);
  return entry.dek;
}

/** Explicit logout — wipes the DEK from the cache. */
export function deleteDEK(sessionId: string): void {
  cache.delete(sessionId);
}

/** For debugging / health endpoints. Does NOT expose keys. */
export function getCacheStats(): { size: number } {
  return { size: cache.size };
}

/** Wipe everything. Used by tests and administrative commands. */
export function clearAllDEKs(): void {
  cache.clear();
}
