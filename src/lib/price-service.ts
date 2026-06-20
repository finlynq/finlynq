// Feature 2: Live Portfolio Prices
// Uses Yahoo Finance v8 API (no API key needed)
//
// Cache architecture:
//   - All Yahoo quote calls go through `price_cache` (table) keyed on
//     (symbol, date). Today's price is cached under date=today and reused,
//     but only for PRICE_CACHE_TODAY_TTL_MS (30 min) — a today-dated row older
//     than that is STALE and lazily re-fetched on read (FINLYNQ-204), so
//     intraday day-change tracks within 30 min instead of freezing at the first
//     cache fill of the UTC day. Historical prices (date != today) are cached
//     forever (immutable) and never re-fetched. The cache is populated on first
//     miss.
//   - Mirrors the FX cache pattern in fx-service.ts (fx_rates table +
//     getRateToUsd lookup ladder). Both surfaces work the same way:
//       cache hit → return; cache miss → API → INSERT → return.
//   - In-memory map per request collapses repeat calls within the same
//     batch (`fetchMultipleQuotes` already de-dupes via Set).

import { db, schema } from "@/db";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
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

// ── Intraday TTL for "today's" cache row (FINLYNQ-204) ──────────────────────
// A price_cache row dated todayISO() is reused as a cache hit only for this long;
// past the TTL it's treated as stale and lazily re-fetched on read so the
// Portfolio day-change tracks intraday (and converges to the official close
// within 30 min of the close) instead of freezing at the first cache fill of the
// UTC day. Historical rows (date != today) are immutable — never stale. Shared
// with crypto-service.ts so both quote paths use one source of truth.
export const PRICE_CACHE_TODAY_TTL_MS = 30 * 60 * 1000; // 30 min

/**
 * Decide whether a cached row should be treated as stale (and re-fetched live).
 * Pure + null-safe so it's unit-testable without a DB. A row is stale ONLY when
 * it is dated `today` (intraday) AND was last fetched more than the TTL ago.
 * Historical rows (date != today) are immutable and never stale, regardless of
 * `fetchedAt` (which may even be null on a legacy/pre-migration row).
 */
export function isPriceCacheRowStale(
  rowDate: string,
  fetchedAt: Date | string | number | null | undefined,
  today: string,
  now: number = Date.now(),
  ttlMs: number = PRICE_CACHE_TODAY_TTL_MS,
): boolean {
  if (rowDate !== today) return false; // historical → immutable, never stale
  if (fetchedAt == null) return true; // today-row with no stamp → refresh
  const stampMs = fetchedAt instanceof Date ? fetchedAt.getTime() : new Date(fetchedAt).getTime();
  if (Number.isNaN(stampMs)) return true; // unparseable stamp → refresh
  return now - stampMs > ttlMs;
}

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

// A cache hit, plus whether it's a stale today-row that should be re-fetched
// live (FINLYNQ-204). On a stale hit the `quote` is still the LAST-known value
// so callers can fall back to it if the live re-fetch fails (retain-on-failure).
type CacheHit = { quote: QuoteResult; stale: boolean };

// Single-row cache lookup. Returns null on a true miss; on a hit reports whether
// the today-row is stale (older than the TTL) so the fetch path can refresh it.
async function readPriceCache(symbol: string, date: string): Promise<CacheHit | null> {
  const row = await db
    .select()
    .from(schema.priceCache)
    .where(and(eq(schema.priceCache.symbol, symbol), eq(schema.priceCache.date, date)))
    .get();
  if (!row) return null;
  const { change, changePct } = deriveDayChange(row.price, row.previousClose);
  return {
    quote: {
      symbol,
      price: row.price,
      currency: row.currency ?? "USD",
      name: symbol,
      change,
      changePct,
      previousClose: row.previousClose ?? null,
    },
    stale: isPriceCacheRowStale(row.date, row.fetchedAt, date),
  };
}

// Bulk cache lookup. Returns a map of symbol → CacheHit for hits (each carrying
// its own `stale` flag). A stale today-row is still returned (as a fallback) but
// the caller re-fetches it live and only overwrites on success.
async function readPriceCacheBulk(symbols: string[], date: string): Promise<Map<string, CacheHit>> {
  if (symbols.length === 0) return new Map();
  const rows = await db
    .select()
    .from(schema.priceCache)
    .where(and(
      inArray(schema.priceCache.symbol, symbols),
      eq(schema.priceCache.date, date),
    ));
  const out = new Map<string, CacheHit>();
  for (const r of rows) {
    // With duplicate (symbol, date) rows possible (non-unique index), keep the
    // FIRST row seen per symbol — deterministic and matches the single-row .get().
    if (out.has(r.symbol)) continue;
    const { change, changePct } = deriveDayChange(r.price, r.previousClose);
    out.set(r.symbol, {
      quote: {
        symbol: r.symbol,
        price: r.price,
        currency: r.currency ?? "USD",
        name: r.symbol,
        change,
        changePct,
        previousClose: r.previousClose ?? null,
      },
      stale: isPriceCacheRowStale(r.date, r.fetchedAt, date),
    });
  }
  return out;
}

// Write a fresh quote into price_cache. FINLYNQ-92: writes previousClose
// alongside price so the next cache-hit read can compute live day-change.
// FINLYNQ-204: if a row for (symbol, date) already exists this is a REFRESH —
// UPDATE it in place (price, currency, previousClose, fetched_at=now()) rather
// than inserting a second row. The (symbol, date) index is NON-unique and prod
// already has duplicate rows, so this is an explicit UPDATE ... WHERE symbol AND
// date (never an ON CONFLICT upsert); it touches every duplicate row for the key
// so a stale read can't survive on a sibling. On a true miss it inserts.
async function writePriceCache(
  symbol: string,
  date: string,
  price: number,
  currency: string,
  previousClose: number | null = null,
) {
  try {
    const updated = await db
      .update(schema.priceCache)
      .set({ price, currency, previousClose, fetchedAt: new Date() })
      .where(and(eq(schema.priceCache.symbol, symbol), eq(schema.priceCache.date, date)))
      .returning({ id: schema.priceCache.id });
    if (Array.isArray(updated) && updated.length > 0) return; // refreshed existing row(s)
    await db.insert(schema.priceCache).values({ symbol, date, price, currency, previousClose });
  } catch { /* duplicate-key / concurrent insert is fine */ }
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
  // Fresh today-row or any historical row → cache hit, no API call.
  if (cached && !cached.stale) return cached.quote;
  // A stale today-row is negatively-cached too → keep serving the stale value
  // (retain-on-failure) rather than re-stalling on a known-bad symbol.
  if (isQuoteNegativelyCached(symbol)) return cached ? cached.quote : null;
  const live = await fetchQuoteLive(symbol);
  if (!live) {
    markQuoteMiss(symbol, "no data / timeout");
    // FINLYNQ-204: a failed re-fetch of a stale today-row RETAINS the stale value
    // (its fetched_at is left untouched, so it re-tries on the next read) — never
    // blank a previously-priced holding. A true miss still returns null.
    return cached ? cached.quote : null;
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
  const hits = await readPriceCacheBulk(unique, today);

  // Seed results with EVERY cache hit — including stale today-rows — so a failed
  // live re-fetch keeps the last-known price (retain-on-failure) instead of
  // blanking the holding (FINLYNQ-204). Stale rows are overwritten below on a
  // successful live fetch.
  const results = new Map<string, QuoteResult>();
  for (const [sym, hit] of hits) results.set(sym, hit.quote);

  // Refetch set = (cache misses) ∪ (stale today-rows). Skip symbols recently
  // known to return no data — a single dead/slow ticker must not re-stall every
  // load (a stale row's last-known value already sits in `results` as fallback).
  const refetch = unique.filter((s) => {
    const hit = hits.get(s);
    const needs = !hit || hit.stale; // miss or stale-today
    return needs && !isQuoteNegativelyCached(s);
  });
  if (refetch.length === 0) return results;

  // Fetch in batches of 5 to avoid rate limiting.
  for (let i = 0; i < refetch.length; i += 5) {
    const batch = refetch.slice(i, i + 5);
    const quotes = await Promise.all(batch.map((s) => fetchQuoteLive(s)));
    for (let j = 0; j < batch.length; j++) {
      const q = quotes[j];
      if (!q) {
        markQuoteMiss(batch[j], "no data / timeout");
        // Stale today-row: leave the seeded last-known value in `results` and its
        // fetched_at untouched so it re-tries next read. True miss: stays absent.
        continue;
      }
      results.set(q.symbol, q);
      await writePriceCache(q.symbol, today, q.price, q.currency, q.previousClose ?? null);
    }
  }
  return results;
}

// ── Windowed historical caching (efficient cold-cache fill) ─────────────────
// A snapshot rebuild walks history one CALENDAR day at a time and prices every
// holding as-of each day. Caching only the single target date meant a cold
// cache forced ~1 Yahoo call PER (symbol, day) — tens of thousands of timeouts.
// Instead, one historical fetch already returns a whole WINDOW of daily closes,
// so we persist the entire window (forward-filled to one row per calendar day),
// turning the walk into ~1 Yahoo call per `HISTORICAL_WINDOW_FORWARD_DAYS` per
// symbol. Historical price rows are immutable, so over-caching is always safe.
const HISTORICAL_WINDOW_FORWARD_DAYS = 60;

/** Add `n` calendar days to a `YYYY-MM-DD` string (UTC, n may be negative). */
function addCalendarDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Forward-fill a sparse run of trading-day closes into one row PER CALENDAR DATE
 * across `[fillFrom, fillTo]` (inclusive). Each weekend/holiday inherits the most
 * recent close on/before it — matching `fetchQuoteAtDate`'s "close on the most
 * recent trading day on/before `date`" contract — so the day-by-day walk gets a
 * cache hit for every calendar day, not just trading days.
 *
 * Pure + deterministic (no DB, no clock) for unit-testing. Rules:
 *  - `bars` MUST be ascending by date and hold only real trading-day closes.
 *  - never emits a row for `today` or any future date (today's row is TTL-managed
 *    by the live quote path — writing it here would clobber that).
 *  - calendar days before the first bar are skipped (no known close yet).
 */
export function buildForwardFilledRows(
  symbol: string,
  currency: string,
  bars: Array<{ date: string; close: number }>,
  fillFrom: string,
  fillTo: string,
  today: string,
): Array<{ symbol: string; date: string; price: number; currency: string }> {
  if (bars.length === 0) return [];
  // Clamp the upper bound below today — historical rows only.
  const yesterday = addCalendarDays(today, -1);
  const upper = fillTo < yesterday ? fillTo : yesterday;
  if (upper < fillFrom) return [];
  const out: Array<{ symbol: string; date: string; price: number; currency: string }> = [];
  let bi = 0;
  let lastClose: number | null = null;
  for (let d = fillFrom; d <= upper; d = addCalendarDays(d, 1)) {
    while (bi < bars.length && bars[bi].date <= d) {
      lastClose = bars[bi].close;
      bi++;
    }
    if (lastClose == null) continue; // before the first known bar
    out.push({ symbol, date: d, price: lastClose, currency });
  }
  return out;
}

/**
 * Persist the full fetched window into `price_cache` (one row per calendar day,
 * forward-filled). Reads the existing rows in range ONCE and inserts only the
 * missing dates in a single multi-row INSERT — historical rows are immutable, so
 * an existing `(symbol, date)` is already correct and must not be duplicated
 * (the index is NON-unique). Best-effort: a cache-fill failure never breaks the
 * caller (a missed date just re-fetches later).
 */
async function cacheHistoricalWindow(
  symbol: string,
  currency: string,
  bars: Array<{ date: string; close: number }>,
  fillFrom: string,
  fillTo: string,
): Promise<void> {
  const rows = buildForwardFilledRows(symbol, currency, bars, fillFrom, fillTo, todayISO());
  if (rows.length === 0) return;
  try {
    const existing = await db
      .select({ date: schema.priceCache.date })
      .from(schema.priceCache)
      .where(
        and(
          eq(schema.priceCache.symbol, symbol),
          gte(schema.priceCache.date, rows[0].date),
          lte(schema.priceCache.date, rows[rows.length - 1].date),
        ),
      );
    const have = new Set(existing.map((r) => r.date));
    const missing = rows.filter((r) => !have.has(r.date));
    if (missing.length === 0) return;
    await db.insert(schema.priceCache).values(missing);
  } catch {
    /* concurrent insert / duplicate key is fine — cache fill is best-effort */
  }
}

/**
 * Fetch a Yahoo daily-close series for `symbol` from `fromDate` to NOW in a
 * single chart call, returning one `{ date, close }` per trading day (strictly
 * BEFORE `today` — today/future belong to the live path). No caching here — the
 * caller decides how/where to persist (e.g. crypto writes under "CRYPTO:<SYM>").
 *
 * Negative-cache aware: a symbol Yahoo can't serve (delisted/unknown ticker, or
 * a timeout) is skipped on subsequent calls for NEGATIVE_QUOTE_TTL_MS so a
 * multi-year crypto rebuild doesn't re-hit a hopeless ticker once per old date.
 * Returns [] on miss/empty (never throws). Closes are in the ticker's quote
 * currency (callers use `<SYM>-USD` tickers → USD).
 */
export async function fetchYahooDailyCloses(
  symbol: string,
  fromDate: string,
  today: string,
): Promise<Array<{ date: string; close: number }>> {
  if (isQuoteNegativelyCached(symbol)) return [];
  try {
    const period1 = Math.floor(Date.parse(`${fromDate}T00:00:00Z`) / 1000);
    const period2 = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(period1) || period1 >= period2) return [];
    const url = `${YAHOO_BASE}/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      next: { revalidate: 86400 },
      signal: AbortSignal.timeout(QUOTE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      markQuoteMiss(symbol, `chart http ${res.status}`);
      return [];
    }
    const data = await res.json();
    const result = data.chart?.result?.[0];
    const timestamps: number[] = result?.timestamp ?? [];
    const closes: (number | null)[] = result?.indicators?.quote?.[0]?.close ?? [];
    const out: Array<{ date: string; close: number }> = [];
    for (let i = 0; i < timestamps.length; i++) {
      const c = closes[i];
      if (c == null || !(c > 0)) continue;
      const d = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
      if (d >= today) continue; // today/future belong to the live path
      out.push({ date: d, close: c });
    }
    if (out.length === 0) {
      markQuoteMiss(symbol, "no historical closes");
      return [];
    }
    return out;
  } catch {
    markQuoteMiss(symbol, "chart timeout/error");
    return [];
  }
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
  // Historical rows are immutable (never stale), so any hit is returned as-is.
  if (cached) return cached.quote;
  try {
    // Window: 7 days BEFORE the target (so a weekend/holiday target still lands
    // on a real close) through HISTORICAL_WINDOW_FORWARD_DAYS AFTER it (capped at
    // now). The forward span is what makes a sequential day-walk efficient — one
    // fetch caches the next ~2 months, so the walk re-fetches only ~once per
    // window instead of once per day. We still pick the last close on/before
    // `date` as the returned value.
    const target = new Date(date + "T00:00:00Z");
    const windowStart = new Date(target.getTime() - 7 * 86400000);
    const windowEndMs = Math.min(
      target.getTime() + (HISTORICAL_WINDOW_FORWARD_DAYS + 1) * 86400000,
      Date.now(),
    );
    const period1 = Math.floor(windowStart.getTime() / 1000);
    const period2 = Math.floor(windowEndMs / 1000);
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
    // Collect every real trading-day close (ascending) so the whole window can be
    // persisted, while still tracking the last close on/before the target.
    const bars: Array<{ date: string; close: number }> = [];
    let chosen: { ts: number; close: number } | null = null;
    for (let i = 0; i < timestamps.length; i++) {
      const c = closes[i];
      if (c == null) continue;
      bars.push({ date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10), close: c });
      if (timestamps[i] <= targetEpoch + 86400) {
        chosen = { ts: timestamps[i], close: c };
      }
    }
    if (!chosen) return null;
    const currency = meta.currency ?? "USD";
    // Persist the FULL window (forward-filled to one row per calendar day) — not
    // just the target date — so the next ~2 months of the walk are cache hits.
    // FINLYNQ-92: historical bars carry no meaningful "day change" (we don't
    // fetch the prior bar), so previous_close stays null; the day-change badge
    // already doesn't render for historical date queries.
    await cacheHistoricalWindow(
      symbol,
      currency,
      bars,
      date,
      addCalendarDays(date, HISTORICAL_WINDOW_FORWARD_DAYS),
    );
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
  // Historical date → all hits are immutable (never stale); unwrap to QuoteResult.
  const hits = await readPriceCacheBulk(unique, date);
  const results = new Map<string, QuoteResult>();
  for (const [sym, hit] of hits) results.set(sym, hit.quote);
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
    // FINLYNQ-204: stamp fetched_at so a manual price write also marks today's
    // row fresh (resets the 30-min intraday TTL).
    await db.update(schema.priceCache)
      .set({ price, currency, fetchedAt: new Date() })
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
