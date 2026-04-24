// Rate-limited fetch with optional per-bucket key so state survives across
// client instances (which matters for HTTP server contexts — every request
// spawns a fresh client but we need the WP 1 req/s window to hold across them).
// No external dep — uses globalThis.fetch + setTimeout.

export interface RateLimitedFetchOptions {
  /** Minimum milliseconds between request *starts*. Default 1200 (1 req/s + 200ms safety). */
  minIntervalMs?: number;
  /**
   * Bucket key. Multiple fetchers created with the same key share a single
   * queue so state persists across HTTP requests in the same process.
   * Defaults to a random key = per-instance queue (old behavior).
   */
  bucketKey?: string;
}

export interface RateLimitedFetch {
  /** Drop-in replacement for `fetch` that queues behind the interval limit. */
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

// Module-level registry so identical bucketKeys collapse onto one queue. Stored
// on globalThis so Next.js HMR / multiple requires don't fragment state.
interface Bucket {
  nextAvailable: number;
  /** Serialize callers on this bucket so Promise.all waits properly. */
  tail: Promise<void>;
}

const GLOBAL_KEY = Symbol.for("@finlynq/import-connectors.rateLimitBuckets");
type GlobalWithBuckets = typeof globalThis & { [k: symbol]: Map<string, Bucket> | undefined };
const globalWithBuckets = globalThis as GlobalWithBuckets;
if (!globalWithBuckets[GLOBAL_KEY]) {
  globalWithBuckets[GLOBAL_KEY] = new Map<string, Bucket>();
}
const buckets: Map<string, Bucket> = globalWithBuckets[GLOBAL_KEY]!;

function getBucket(key: string): Bucket {
  let b = buckets.get(key);
  if (!b) {
    b = { nextAvailable: 0, tail: Promise.resolve() };
    buckets.set(key, b);
  }
  return b;
}

export function createRateLimitedFetch(
  opts: RateLimitedFetchOptions = {},
): RateLimitedFetch {
  const minIntervalMs = opts.minIntervalMs ?? 1200;
  const bucketKey = opts.bucketKey ?? `ephemeral:${Math.random().toString(36).slice(2)}`;

  return async function rateLimited(input, init) {
    const bucket = getBucket(bucketKey);

    // Chain onto the bucket's tail so concurrent callers in the same request
    // (Promise.all) also serialize properly — not just cross-request calls.
    const myTurn = bucket.tail.then(async () => {
      const now = Date.now();
      const scheduled = Math.max(bucket.nextAvailable, now);
      bucket.nextAvailable = scheduled + minIntervalMs;
      const wait = scheduled - now;
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
      }
    });
    bucket.tail = myTurn.catch(() => undefined);
    await myTurn;
    return fetch(input, init);
  };
}
