// Tiny single-consumer FIFO queue that enforces a minimum interval between
// fetches. Shared by all ConnectorClient implementations that talk to a
// rate-limited upstream. No external dep — uses globalThis.fetch + setTimeout.

export interface RateLimitedFetchOptions {
  /** Minimum milliseconds between request *starts*. Default 1000 = 1 req/s. */
  minIntervalMs?: number;
}

export interface RateLimitedFetch {
  /** Drop-in replacement for `fetch` that queues behind the interval limit. */
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export function createRateLimitedFetch(
  opts: RateLimitedFetchOptions = {},
): RateLimitedFetch {
  const minIntervalMs = opts.minIntervalMs ?? 1000;
  let nextAvailable = 0;

  return async function rateLimited(input, init) {
    const now = Date.now();
    const scheduled = Math.max(nextAvailable, now);
    nextAvailable = scheduled + minIntervalMs;
    const wait = scheduled - now;
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
    return fetch(input, init);
  };
}
