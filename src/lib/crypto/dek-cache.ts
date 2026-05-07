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
 *
 * B7 hardening (2026-05-07):
 *  - Each entry stores `userId` alongside the buffer. `getDEK` now requires
 *    both the jti AND the userId to match — defense-in-depth against a
 *    future jti-collision dev mistake (low-priority finding).
 *  - DEK buffers are zeroed (`buffer.fill(0)`) before being dropped from
 *    the cache (eviction, expiry, sweeper, logout, evictAllForUser). This
 *    is best-effort — the V8 GC may have copied the buffer elsewhere — but
 *    it removes the simplest "memory dump after logout" exposure (M-7).
 *  - `evictAllForUser(userId)` purges every cache entry owned by that user.
 *    Called from /api/auth/wipe-account so a fresh DEK can never be served
 *    out of an old session's slot post-wipe (H-7).
 */

interface Entry {
  /** The user this entry belongs to. Required match for getDEK to succeed. */
  userId: string;
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

/**
 * Best-effort buffer zeroing before dropping from cache. V8 may have copied
 * the buffer elsewhere (string interning, slow-path GC), but this removes
 * the simplest "core dump after logout still has the DEK" exposure (M-7).
 */
function zeroAndDrop(key: string, entry: Entry): void {
  try {
    entry.dek.fill(0);
  } catch {
    // Defensive — Buffer.fill should never throw on a normal Buffer.
  }
  cache.delete(key);
}

// Background sweeper — runs once per process. Avoids unbounded memory if a
// lot of sessions come and go without an explicit logout. `setInterval` is
// absent from Edge runtime; the lazy-eviction path in getDEK() still cleans
// individual entries even without the sweeper, so no-op there is safe.
if (!g.__pfDekCacheSweeper && typeof setInterval === "function") {
  const handle = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of cache) {
      // Evict if EITHER the hard TTL OR the idle window has expired.
      if (v.expiresAt <= now || v.idleExpiresAt <= now) zeroAndDrop(k, v);
    }
  }, 60_000);
  // Node: don't keep the event loop alive for the sweeper.
  (handle as unknown as { unref?: () => void }).unref?.();
  g.__pfDekCacheSweeper = handle;
}

/**
 * Store a DEK for a session. `ttlMs` should match the JWT's remaining
 * lifetime. The userId is stored alongside the buffer so getDEK can require
 * both jti AND userId to match — guards against a future jti-collision dev
 * mistake silently serving the wrong user's key.
 */
export function putDEK(
  sessionId: string,
  dek: Buffer,
  ttlMs: number,
  userId: string
): void {
  const now = Date.now();
  // If we're overwriting an existing entry for this jti, zero its old buffer
  // first — pending-token replacement on MFA verify hits this path.
  const existing = cache.get(sessionId);
  if (existing) {
    try {
      existing.dek.fill(0);
    } catch {
      // ignore
    }
  }
  cache.set(sessionId, {
    userId,
    dek,
    expiresAt: now + ttlMs,
    idleExpiresAt: now + IDLE_TTL_MS,
  });
}

/**
 * Retrieve the DEK for a session, or null if missing/expired/wrong-user.
 * Extends the idle window on each successful read — Finding #15 sliding-window.
 *
 * The `userId` parameter is REQUIRED. The cache entry's stored userId must
 * match for the lookup to succeed; a mismatch returns null (no buffer leak,
 * no log line — the auth strategy will treat the request as DEK-less and
 * downstream encrypted-write routes will 423).
 */
export function getDEK(sessionId: string, userId: string): Buffer | null {
  const entry = cache.get(sessionId);
  if (!entry) return null;
  const now = Date.now();
  if (entry.expiresAt <= now || entry.idleExpiresAt <= now) {
    zeroAndDrop(sessionId, entry);
    return null;
  }
  // Defense-in-depth: if a future bug ever issues two JWTs with the same jti
  // for different users, the userId check stops us from serving the wrong
  // key. No log line on miss — the failure path looks identical to "no DEK
  // cached" so a probe can't distinguish the two.
  if (entry.userId !== userId) return null;
  // Extend idle window on read, capped by the hard expiry.
  entry.idleExpiresAt = Math.min(now + IDLE_TTL_MS, entry.expiresAt);
  return entry.dek;
}

/**
 * Explicit logout — wipes the DEK from the cache. Buffer is zeroed before
 * the Map entry is deleted (M-7).
 */
export function deleteDEK(sessionId: string): void {
  const entry = cache.get(sessionId);
  if (!entry) return;
  zeroAndDrop(sessionId, entry);
}

/**
 * Wipe every cache entry belonging to `userId`. Used by /api/auth/wipe-account
 * post-rewrap so a fresh DEK can never be served out of an old session slot
 * (finding H-7). O(n) over the cache — n is bounded by concurrent users on
 * one process, expected ≪ 10k.
 */
export function evictAllForUser(userId: string): number {
  let evicted = 0;
  for (const [k, v] of cache) {
    if (v.userId === userId) {
      zeroAndDrop(k, v);
      evicted++;
    }
  }
  return evicted;
}

/** For debugging / health endpoints. Does NOT expose keys. */
export function getCacheStats(): { size: number } {
  return { size: cache.size };
}

/** Wipe everything. Used by tests and administrative commands. */
export function clearAllDEKs(): void {
  for (const [k, v] of cache) zeroAndDrop(k, v);
}
