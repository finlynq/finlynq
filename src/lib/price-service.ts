// Feature 2: Live Portfolio Prices
// Uses Yahoo Finance v8 API (no API key needed)
//
// Cache architecture:
//   - All Yahoo quote calls go through `price_cache` (table) keyed on
//     (symbol, date). Today's price is cached under date=today and reused
//     for the rest of the calendar day. Historical prices are cached
//     forever (immutable). The cache is populated on first miss.
//   - Mirrors the FX cache pattern in fx-service.ts (fx_rates table +
//     getRateToUsd lookup ladder). Both surfaces work the same way:
//       cache hit → return; cache miss → API → INSERT → return.
//   - In-memory map per request collapses repeat calls within the same
//     batch (`fetchMultipleQuotes` already de-dupes via Set).

import { db, schema } from "@/db";
import { and, eq, inArray } from "drizzle-orm";
import { todayISO } from "@/lib/utils/date";

// FINLYNQ-201: the ETF-vs-stock classification no longer relies on a hardcoded
// ETF registry. The badge is driven by Yahoo's `quoteType`/`instrumentType`
// ('ETF') surfaced on each quote PLUS a user-settable `securities.asset_type`
// (the user override always wins). The old region/sector/top-holdings breakdown
// literals were dropped; the ETF X-Ray look-through data source is repopulated
// separately (FINLYNQ-202) and degrades to an empty breakdown until then.

const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance";

type QuoteResult = {
  symbol: string;
  price: number;
  currency: string;
  name: string;
  change: number;
  changePct: number;
  marketCap?: number;
  // FINLYNQ-92: Yahoo's `meta.previousClose`. Persisted in price_cache so the
  // change/changePct fields can be computed from a cached row on the next read
  // instead of being hardcoded to 0. Null on historical bars (no prior-day
  // reference) and on rows written before the 20260522 migration.
  previousClose?: number | null;
  // FINLYNQ-201: Yahoo's instrument classification (`meta.instrumentType` on the
  // chart API — "EQUITY" / "ETF" / "CRYPTOCURRENCY" / "MUTUALFUND" / "FUTURE" /
  // …). Used to badge ETFs without a hardcoded list. ONLY present on a LIVE
  // fetch — `price_cache` has no quoteType column, so a warm-cache QuoteResult
  // carries `quoteType = null` (callers fall back to the persisted/user
  // `securities.asset_type`, which is the durable source — see `isEtfQuoteType`).
  quoteType?: string | null;
};

/**
 * True iff a Yahoo instrument classification denotes an ETF. Case-insensitive,
 * null-safe. Yahoo's chart API reports this as `meta.instrumentType` ("ETF");
 * the quoteSummary API calls the same thing `quoteType` — accept both spellings.
 */
export function isEtfQuoteType(quoteType: string | null | undefined): boolean {
  return (quoteType ?? "").trim().toUpperCase() === "ETF";
}

// ── Quote-fetch timeout + negative cache ────────────────────────────────────
// A Yahoo symbol that returns no data (delisted/wrong/foreign ticker) is NEVER
// written to price_cache (writePriceCache only runs on success), so it was
// re-fetched on EVERY page load. Combined with fetchQuoteLive having no timeout,
// a single dead/slow ticker stalled the whole holdings valuation for ~10s on
// every dashboard / account-chart load (getHoldingsValueByAccount). Two guards:
//   1. AbortSignal.timeout caps any single Yahoo call.
//   2. An in-memory negative cache (per process) skips a known-bad symbol for a
//      while so it can't re-stall every request. Entries expire so a transient
//      Yahoo outage self-heals. Misses are logged so bad holding tickers surface.
const QUOTE_FETCH_TIMEOUT_MS = 4000;
const NEGATIVE_QUOTE_TTL_MS = 10 * 60 * 1000; // 10 min
const negativeQuoteCache = new Map<string, number>(); // symbol -> expiry epoch ms

function isQuoteNegativelyCached(symbol: string): boolean {
  const exp = negativeQuoteCache.get(symbol);
  if (exp == null) return false;
  if (Date.now() > exp) {
    negativeQuoteCache.delete(symbol);
    return false;
  }
  return true;
}

function markQuoteMiss(symbol: string, reason: string): void {
  negativeQuoteCache.set(symbol, Date.now() + NEGATIVE_QUOTE_TTL_MS);

  console.warn(
    `[price-service] no live quote for "${symbol}" (${reason}) — negative-cached for ${NEGATIVE_QUOTE_TTL_MS / 60000}m`,
  );
}

// FINLYNQ-92 follow-up: Yahoo's chart API OMITS `meta.previousClose` whenever
// the regular session is closed (weekends, exchange holidays, pre-/after-hours)
// — it only returns `meta.chartPreviousClose`. For a `range=1d` request the two
// values are identical during a session, so falling back to chartPreviousClose
// when previousClose is missing closes the closed-market gap without changing
// weekday/in-session behavior. Without this, every stock/ETF cache row written
// while the market is closed gets previous_close=NULL → deriveDayChange short-
// circuits to 0/0 for the whole calendar day (crypto is unaffected — it reads
// change data live from CoinGecko, bypassing price_cache).
export function resolvePreviousClose(
  meta: { previousClose?: number | null; chartPreviousClose?: number | null } | null | undefined,
): number | null {
  return meta?.previousClose ?? meta?.chartPreviousClose ?? null;
}

// FINLYNQ-92: derive change + changePct from price + previousClose. Returns
// 0/0 when previousClose is null OR zero (back-compat for pre-migration rows
// + safety against divide-by-zero on bad data).
export function deriveDayChange(price: number, previousClose: number | null | undefined): { change: number; changePct: number } {
  if (previousClose == null || previousClose === 0) {
    return { change: 0, changePct: 0 };
  }
  return {
    change: price - previousClose,
    changePct: ((price - previousClose) / previousClose) * 100,
  };
}

// Single-row cache lookup. Returns null on miss.
async function readPriceCache(symbol: string, date: string): Promise<QuoteResult | null> {
  const row = await db
    .select()
    .from(schema.priceCache)
    .where(and(eq(schema.priceCache.symbol, symbol), eq(schema.priceCache.date, date)))
    .get();
  if (!row) return null;
  const { change, changePct } = deriveDayChange(row.price, row.previousClose);
  return {
    symbol,
    price: row.price,
    currency: row.currency ?? "USD",
    name: symbol,
    change,
    changePct,
    previousClose: row.previousClose ?? null,
  };
}

// Bulk cache lookup. Returns a map of symbol → QuoteResult for hits.
async function readPriceCacheBulk(symbols: string[], date: string): Promise<Map<string, QuoteResult>> {
  if (symbols.length === 0) return new Map();
  const rows = await db
    .select()
    .from(schema.priceCache)
    .where(and(
      inArray(schema.priceCache.symbol, symbols),
      eq(schema.priceCache.date, date),
    ));
  const out = new Map<string, QuoteResult>();
  for (const r of rows) {
    const { change, changePct } = deriveDayChange(r.price, r.previousClose);
    out.set(r.symbol, {
      symbol: r.symbol,
      price: r.price,
      currency: r.currency ?? "USD",
      name: r.symbol,
      change,
      changePct,
      previousClose: r.previousClose ?? null,
    });
  }
  return out;
}

// Idempotent insert; ignores duplicate-key errors so concurrent callers
// don't race-fail. FINLYNQ-92: writes previousClose alongside price so the
// next cache-hit read can compute live day-change.
async function writePriceCache(
  symbol: string,
  date: string,
  price: number,
  currency: string,
  previousClose: number | null = null,
) {
  try {
    await db.insert(schema.priceCache).values({ symbol, date, price, currency, previousClose });
  } catch { /* duplicate-key is fine */ }
}

/**
 * Fetch a single live quote from Yahoo Finance — bypasses cache.
 * Most callers should prefer `fetchQuote` (cache-aware). The exception is name
 * resolution: `price_cache` has NO name column, so a warm `fetchQuote` hit
 * returns `name === symbol` — anything that actually needs the `shortName`
 * (e.g. the Add-security lookup) must call this LIVE path instead.
 */
export async function fetchQuoteLive(symbol: string): Promise<QuoteResult | null> {
  try {
    const res = await fetch(
      `${YAHOO_BASE}/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
      {
        headers: { "User-Agent": "Mozilla/5.0" },
        next: { revalidate: 300 },
        signal: AbortSignal.timeout(QUOTE_FETCH_TIMEOUT_MS),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data.chart?.result?.[0]?.meta;
    if (!meta) return null;

    const price = meta.regularMarketPrice ?? 0;
    const previousClose: number | null = resolvePreviousClose(meta);
    const { change, changePct } = deriveDayChange(price, previousClose);
    return {
      symbol,
      price,
      currency: meta.currency ?? "USD",
      name: meta.shortName ?? symbol,
      change,
      changePct,
      previousClose,
      // FINLYNQ-201: chart API exposes the instrument class as `instrumentType`
      // ("EQUITY"/"ETF"/…). Surface it so callers can badge ETFs + persist the
      // durable `securities.asset_type`.
      quoteType: (meta.instrumentType as string | undefined) ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Get today's quote, using the price_cache table as a server-side cache.
 * On hit: returns the cached row (no API call). On miss: fetches from
 * Yahoo, INSERTs into price_cache, returns. Today's row is reused for
 * the rest of the calendar day; tomorrow naturally falls through to a
 * new fetch under tomorrow's date.
 */
export async function fetchQuote(symbol: string): Promise<QuoteResult | null> {
  const today = todayISO();
  const cached = await readPriceCache(symbol, today);
  if (cached) return cached;
  if (isQuoteNegativelyCached(symbol)) return null;
  const live = await fetchQuoteLive(symbol);
  if (!live) {
    markQuoteMiss(symbol, "no data / timeout");
    return null;
  }
  await writePriceCache(symbol, today, live.price, live.currency, live.previousClose ?? null);
  return live;
}

/**
 * Bulk variant. Reads the cache in one query, fetches only the misses
 * from Yahoo (in batches of 5 for rate-limit politeness), and INSERTs
 * the new rows. Mirrors fx-service's batched cache-first lookup.
 */
export async function fetchMultipleQuotes(symbols: string[]): Promise<Map<string, QuoteResult>> {
  const unique = [...new Set(symbols.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const today = todayISO();
  const results = await readPriceCacheBulk(unique, today);
  // Skip cache hits AND symbols recently known to return no data — otherwise a
  // single dead/slow ticker re-stalls every load (it never lands in price_cache).
  const missing = unique.filter(s => !results.has(s) && !isQuoteNegativelyCached(s));
  if (missing.length === 0) return results;

  // Fetch misses in batches of 5 to avoid rate limiting.
  for (let i = 0; i < missing.length; i += 5) {
    const batch = missing.slice(i, i + 5);
    const quotes = await Promise.all(batch.map((s) => fetchQuoteLive(s)));
    for (let j = 0; j < batch.length; j++) {
      const q = quotes[j];
      if (!q) {
        markQuoteMiss(batch[j], "no data / timeout");
        continue;
      }
      results.set(q.symbol, q);
      await writePriceCache(q.symbol, today, q.price, q.currency, q.previousClose ?? null);
    }
  }
  return results;
}

/**
 * Fetch the close price on a specific historical date (or the most recent
 * trading day on/before it). Uses Yahoo's chart API with period1/period2
 * spanning the target date ± a small window to handle weekends + holidays.
 *
 * Cache-first: hits price_cache before any network call. Historical
 * prices are immutable, so a single fetch per (symbol, date) covers all
 * future calls forever.
 */
export async function fetchQuoteAtDate(symbol: string, date: string): Promise<QuoteResult | null> {
  const cached = await readPriceCache(symbol, date);
  if (cached) return cached;
  try {
    // Window: 7 days before to 1 day after the target so a weekend/holiday
    // target still lands on a real close. Yahoo returns the trading-day
    // closes inside the window — we pick the last one on/before `date`.
    const target = new Date(date + "T00:00:00Z");
    const windowStart = new Date(target.getTime() - 7 * 86400000);
    const windowEnd = new Date(target.getTime() + 86400000);
    const period1 = Math.floor(windowStart.getTime() / 1000);
    const period2 = Math.floor(windowEnd.getTime() / 1000);
    const url = `${YAHOO_BASE}/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      next: { revalidate: 86400 },
      signal: AbortSignal.timeout(QUOTE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data.chart?.result?.[0];
    if (!result) return null;
    const meta = result.meta ?? {};
    const timestamps: number[] = result.timestamp ?? [];
    const closes: (number | null)[] = result.indicators?.quote?.[0]?.close ?? [];
    if (timestamps.length === 0) return null;
    const targetEpoch = Math.floor(target.getTime() / 1000);
    let chosen: { ts: number; close: number } | null = null;
    for (let i = 0; i < timestamps.length; i++) {
      const c = closes[i];
      if (c == null) continue;
      if (timestamps[i] <= targetEpoch + 86400) {
        chosen = { ts: timestamps[i], close: c };
      }
    }
    if (!chosen) return null;
    const currency = meta.currency ?? "USD";
    // FINLYNQ-92: historical bars don't carry a meaningful "day change" — we'd
    // need the bar BEFORE `chosen` for that and we don't currently fetch it.
    // Writing null keeps the column honest; the day-change badge already
    // doesn't render for historical date queries.
    await writePriceCache(symbol, date, chosen.close, currency, null);
    return {
      symbol,
      price: chosen.close,
      currency,
      name: meta.shortName ?? symbol,
      change: 0,
      changePct: 0,
      previousClose: null,
    };
  } catch {
    return null;
  }
}

export async function fetchMultipleQuotesAtDate(
  symbols: string[],
  date: string,
): Promise<Map<string, QuoteResult>> {
  const unique = [...new Set(symbols.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const results = await readPriceCacheBulk(unique, date);
  const missing = unique.filter(s => !results.has(s));
  if (missing.length === 0) return results;
  for (let i = 0; i < missing.length; i += 5) {
    const batch = missing.slice(i, i + 5);
    const promises = batch.map((s) => fetchQuoteAtDate(s, date));
    const quotes = await Promise.all(promises);
    quotes.forEach((q) => {
      if (q) results.set(q.symbol, q);
    });
  }
  return results;
}

// Cache prices in DB
export async function cachePrice(symbol: string, price: number, currency: string) {
  const today = todayISO();
  const existing = await db
    .select()
    .from(schema.priceCache)
    .where(and(eq(schema.priceCache.symbol, symbol), eq(schema.priceCache.date, today)))
    .get();

  if (existing) {
    await db.update(schema.priceCache)
      .set({ price, currency })
      .where(eq(schema.priceCache.id, existing.id))
      ;
  } else {
    await db.insert(schema.priceCache).values({ symbol, date: today, price, currency });
  }
}

export async function getCachedPrice(symbol: string): Promise<{ price: number; currency: string; date: string } | null> {
  const row = await db
    .select()
    .from(schema.priceCache)
    .where(eq(schema.priceCache.symbol, symbol))
    .orderBy(schema.priceCache.date)
    .limit(1)
    .get();

  return row ? { price: row.price, currency: row.currency, date: row.date } : null;
}

// ── ETF X-Ray look-through (region / sector / constituents) ────────────────
// FINLYNQ-201: the hardcoded region / sector / top-holdings literals were
// removed. The ETF-vs-stock badge is now derived from Yahoo's `quoteType`
// ('ETF') + the user-settable `securities.asset_type` (see overview/route.ts +
// isEtfQuoteType). The breakdown DATA source for the ETF X-Ray (region /
// sector / top-holdings) is repopulated separately in FINLYNQ-202; until then
// every accessor returns "no data" and the X-Ray path degrades to an empty
// breakdown (NO crash) rather than reading a baked-in list.

// Constituent shape kept for the X-Ray API/route types; no data is bundled.
export type EtfConstituent = {
  ticker: string;
  name: string;
  weight: number; // percentage
  sector: string;
  country: string;
};

// ── ETF metadata accessors — graceful "no data" until FINLYNQ-202 repopulates ──

export function getEtfTopHoldings(
  _symbol: string,
): { fullName: string; totalHoldings: number; constituents: EtfConstituent[] } | null {
  return null;
}

export function getAvailableEtfSymbols(): string[] {
  return [];
}

export function getEtfRegionBreakdown(_symbol: string): Record<string, number> | null {
  return null;
}

export function getEtfSectorBreakdown(_symbol: string): Record<string, number> | null {
  return null;
}

/**
 * Aggregate portfolio region/sector exposure from the (now empty) ETF
 * breakdown source. Returns empty maps until the breakdown data is repopulated
 * (FINLYNQ-202). Kept so /api/prices keeps returning a stable shape.
 */
export function aggregatePortfolioExposure(
  holdings: { symbol: string; value: number }[],
): { regions: Record<string, number>; sectors: Record<string, number>; totalValue: number } {
  let totalValue = 0;
  for (const h of holdings) {
    if (!h.symbol) continue;
    totalValue += h.value;
  }
  return { regions: {}, sectors: {}, totalValue };
}
