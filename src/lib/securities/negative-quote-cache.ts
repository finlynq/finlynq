/**
 * In-process negative cache for market-data quote misses (price-service.ts).
 *
 * A Yahoo symbol that returns nothing is never written to `price_cache` (that
 * table is written only on success), so without this it would be re-fetched on
 * EVERY page load. The cache skips a known-bad symbol for a while; entries
 * expire so a transient outage self-heals.
 *
 * Why two TTLs (2026-10-31): prod re-tried ~21 delisted / renamed tickers
 * (SQ, VIAC, SWN, WE, MULN, …) every 10 minutes for DAYS — Yahoo answers
 * HTTP 404 ("No data found, symbol may be delisted") for each, and 231 of the
 * last 1,000 outbound market-data calls were those 404s. A 404 is Yahoo saying
 * the SYMBOL is unknown, which does not fix itself in ten minutes, while a
 * timeout / 5xx / 429 says nothing about the symbol. So:
 *
 *   - any miss is cached for NEGATIVE_QUOTE_TTL_MS (10 min) — unchanged;
 *   - CONSECUTIVE 404s double the back-off per strike: 10 → 20 → 40 → … min,
 *     capped at NEGATIVE_QUOTE_NOT_FOUND_MAX_MS (24 h). The strike count
 *     SURVIVES expiry (an expired entry is kept, not deleted) — otherwise the
 *     next 404 would start over at 10 min and nothing would ever back off;
 *   - a non-404 miss never lengthens the back-off and never resets the
 *     strikes (a timeout is not evidence the symbol exists);
 *   - any SUCCESSFUL fetch clears the entry, so a symbol that comes back
 *     (a new listing, a Yahoo hiccup) is forgiven at once and a much later
 *     404 starts over at 10 min.
 *
 * Per process: a deploy / restart forgets everything, which is the escape
 * hatch if a cap ever looks wrong. Worst case for a genuinely new listing a
 * user adds before its first trading day: priced up to a day late.
 *
 * Pure (no imports, injectable clock) so the back-off is unit-testable without
 * the DB or network. price-service.ts owns the single instance + the log line.
 */

/** Base TTL for any miss, and the only TTL a non-404 miss ever gets. */
export const NEGATIVE_QUOTE_TTL_MS = 10 * 60 * 1000; // 10 min
/** Cap for a run of consecutive 404s. */
export const NEGATIVE_QUOTE_NOT_FOUND_MAX_MS = 24 * 60 * 60 * 1000; // 24 h

export interface NegativeQuoteEntry {
  /** Skip fetches for this symbol until this epoch-ms. */
  until: number;
  /** Consecutive HTTP 404s — the only miss that lengthens the back-off. */
  notFoundStrikes: number;
}

export interface QuoteMissMark {
  /** How long this miss is cached for. */
  ttlMs: number;
  /** The run length after this miss (0 when the symbol has never 404'd). */
  notFoundStrikes: number;
}

/**
 * Back-off for the Nth consecutive 404: 10 min doubled per strike, capped at
 * 24 h. Strike 0 / garbage → the base TTL.
 */
export function negativeQuoteBackoffMs(notFoundStrikes: number): number {
  if (!(notFoundStrikes >= 1)) return NEGATIVE_QUOTE_TTL_MS;
  return Math.min(NEGATIVE_QUOTE_TTL_MS * 2 ** (notFoundStrikes - 1), NEGATIVE_QUOTE_NOT_FOUND_MAX_MS);
}

export class NegativeQuoteCache {
  private readonly entries = new Map<string, NegativeQuoteEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  /** True while the symbol's most recent miss is still being honoured. */
  isCached(symbol: string): boolean {
    const entry = this.entries.get(symbol);
    if (!entry) return false;
    if (this.now() > entry.until) {
      // Expired. A transient miss is forgotten outright; a 404 run keeps its
      // strike count so the NEXT 404 backs off longer instead of restarting.
      if (entry.notFoundStrikes === 0) this.entries.delete(symbol);
      return false;
    }
    return true;
  }

  /**
   * Record a miss. `status` is the HTTP status Yahoo answered with, or null for
   * a timeout / network error. Only 404 escalates.
   */
  markMiss(symbol: string, status: number | null): QuoteMissMark {
    const prev = this.entries.get(symbol);
    const prevStrikes = prev?.notFoundStrikes ?? 0;
    const notFound = status === 404;
    const notFoundStrikes = notFound ? prevStrikes + 1 : prevStrikes;
    const ttlMs = notFound ? negativeQuoteBackoffMs(notFoundStrikes) : NEGATIVE_QUOTE_TTL_MS;
    this.entries.set(symbol, { until: this.now() + ttlMs, notFoundStrikes });
    return { ttlMs, notFoundStrikes };
  }

  /** A successful fetch: forget the symbol entirely (strikes included). */
  clear(symbol: string): void {
    this.entries.delete(symbol);
  }

  /** The stored entry, if any (tests + diagnostics). */
  peek(symbol: string): NegativeQuoteEntry | undefined {
    return this.entries.get(symbol);
  }

  get size(): number {
    return this.entries.size;
  }
}
