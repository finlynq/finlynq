// Crypto price service using CoinGecko free API (no API key required)
// Caches prices in priceCache table with "CRYPTO:" prefix

import { db, schema } from "@/db";
import { and, eq, inArray } from "drizzle-orm";
import { todayISO } from "@/lib/utils/date";
// FINLYNQ-204: share the stock path's 30-min today-row TTL + staleness predicate
// so crypto VALUATIONS (dashboard / net-worth / getHoldingsValueByAccount) refresh
// intraday instead of freezing at the first cache fill of the UTC day. (The
// overview's *displayed* crypto day-change already reads CoinGecko live.)
import { isPriceCacheRowStale, fetchYahooDailyCloses } from "@/lib/price-service";

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";

// CoinGecko's free tier only serves ~365 days of daily history. A historical
// valuation for a date OLDER than this can never be satisfied by a market_chart
// fetch — the request just re-returns the same trailing 365-day window and
// covers nothing new — so calling it for old dates is pure waste (it was firing
// one doomed CoinGecko request per old date per coin during a multi-year
// snapshot rebuild). `isWithinCryptoHistoryWindow` gates that call; out-of-window
// dates fall straight through to the cache-first spot-price approximation.
export const CRYPTO_FREE_HISTORY_DAYS = 365;

/**
 * True iff `date` is recent enough that CoinGecko's free market_chart history can
 * still cover it (within the last `maxDays`). Pure + null-safe for unit-testing.
 * A strict `<` keeps us off the exact-365 boundary, where CoinGecko sometimes
 * returns slightly fewer than `days` bars and the oldest day would miss anyway.
 */
export function isWithinCryptoHistoryWindow(
  date: string,
  today: string,
  maxDays: number = CRYPTO_FREE_HISTORY_DAYS,
): boolean {
  const dMs = Date.parse(`${date}T00:00:00Z`);
  const tMs = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(dMs) || !Number.isFinite(tMs)) return false;
  const ageDays = Math.floor((tMs - dMs) / 86_400_000);
  return ageDays < maxDays;
}

// Yahoo serves crypto daily history (back to ~2014 for the majors) via
// "<SYMBOL>-USD" tickers — the SAME chart endpoint + windowed machinery the
// stock path uses, no API key. We use it as the >365-day history tier (beyond
// CoinGecko's free window). Most coins map to "<SYM>-USD"; add an override only
// where Yahoo's ticker differs from the holding's symbol.
const YAHOO_CRYPTO_TICKER_OVERRIDES: Record<string, string> = {
  // POL / MATIC are both listed on Yahoo as POL-USD / MATIC-USD; FTM-USD and
  // S-USD likewise resolve under their own symbols — so no override needed yet.
};

/** Base crypto symbol → Yahoo crypto ticker (e.g. BTC → BTC-USD). Pure. */
export function cryptoSymbolToYahooTicker(symbol: string): string {
  const base = (symbol ?? "").toUpperCase().split("-")[0];
  return YAHOO_CRYPTO_TICKER_OVERRIDES[base] ?? `${base}-USD`;
}

// Backfill one coin's daily USD history from Yahoo (>365-day tier) into
// price_cache under "CRYPTO:<SYMBOL>". One chart call covers [fromDate, today],
// so a multi-year rebuild that walks oldest-first makes ~1 Yahoo call per coin
// (later days hit cache). Crypto trades 24/7, so Yahoo returns a close for every
// calendar day — no forward-fill needed. Idempotent: inserts only missing dates
// (historical bars are immutable). Yahoo misses are negative-cached inside
// fetchYahooDailyCloses, so a coin Yahoo lacks isn't re-hit per old date.
async function fetchCryptoHistoryFromYahooToCache(symbol: string, fromDate: string): Promise<void> {
  const ticker = cryptoSymbolToYahooTicker(symbol);
  const bars = await fetchYahooDailyCloses(ticker, fromDate, todayISO());
  if (bars.length === 0) return;
  try {
    const cacheSymbol = `CRYPTO:${symbol.toUpperCase()}`;
    const dates = bars.map((b) => b.date);
    const existing = await db
      .select({ date: schema.priceCache.date })
      .from(schema.priceCache)
      .where(and(eq(schema.priceCache.symbol, cacheSymbol), inArray(schema.priceCache.date, dates)));
    const have = new Set(existing.map((r) => r.date));
    const rows = bars
      .filter((b) => !have.has(b.date))
      .map((b) => ({ symbol: cacheSymbol, date: b.date, price: b.close, currency: "USD", previousClose: null }));
    if (rows.length > 0) await db.insert(schema.priceCache).values(rows);
  } catch {
    // Best-effort cache fill — a failure just degrades to the spot approximation.
  }
}

export type CryptoPrice = {
  id: string;
  symbol: string;
  name: string;
  price: number;
  /**
   * Currency `price` (and the rich fields) are denominated in. Crypto is cached
   * and fetched in USD — the canonical anchor matching `fx_rates.rate_to_usd` —
   * and converted to any display/account currency by the caller via the FX
   * service. (Legacy `price_cache` rows may still be "CAD"; reads carry the
   * row's own currency through so they convert correctly during the transition.)
   */
  currency: string;
  change24h: number;
  changePct24h: number;
  marketCap: number;
  image?: string;
};

export type CryptoHistoryPoint = {
  date: string;
  price: number;
};

export type CryptoSearchResult = {
  id: string;
  name: string;
  symbol: string;
  marketCapRank: number | null;
};

async function coinGeckoFetch(endpoint: string): Promise<Response> {
  return fetch(`${COINGECKO_BASE}${endpoint}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0",
    },
    next: { revalidate: 300 },
  });
}

export async function getCryptoPrice(coinId: string): Promise<CryptoPrice | null> {
  try {
    const res = await coinGeckoFetch(
      `/coins/${coinId}?localization=false&tickers=false&community_data=false&developer_data=false`
    );
    if (!res.ok) return null;
    const data = await res.json();

    const price: CryptoPrice = {
      id: data.id,
      symbol: (data.symbol ?? "").toUpperCase(),
      name: data.name ?? coinId,
      price: data.market_data?.current_price?.usd ?? data.market_data?.current_price?.cad ?? 0,
      currency: "USD",
      change24h: data.market_data?.price_change_24h ?? 0,
      changePct24h: data.market_data?.price_change_percentage_24h ?? 0,
      marketCap: data.market_data?.market_cap?.usd ?? data.market_data?.market_cap?.cad ?? 0,
      image: data.image?.small,
    };

    // Cache the price in USD (converted to any display currency via fx_rates).
    await cacheCryptoPrice(price.symbol, price.price, "USD");

    return price;
  } catch {
    return null;
  }
}

export async function getCryptoPrices(coinIds: string[]): Promise<CryptoPrice[]> {
  if (coinIds.length === 0) return [];

  try {
    const ids = coinIds.join(",");
    const res = await coinGeckoFetch(
      `/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&sparkline=false&price_change_percentage=24h`
    );
    if (!res.ok) return [];
    const data = await res.json();

    const prices: CryptoPrice[] = (data as Array<Record<string, unknown>>).map((coin) => ({
      id: coin.id as string,
      symbol: ((coin.symbol as string) ?? "").toUpperCase(),
      name: (coin.name as string) ?? "",
      price: (coin.current_price as number) ?? 0,
      currency: "USD",
      change24h: (coin.price_change_24h as number) ?? 0,
      changePct24h: (coin.price_change_percentage_24h as number) ?? 0,
      marketCap: (coin.market_cap as number) ?? 0,
      image: coin.image as string | undefined,
    }));

    // Cache all prices in USD (converted to any display currency via fx_rates).
    for (const p of prices) {
      await cacheCryptoPrice(p.symbol, p.price, "USD");
    }

    return prices;
  } catch {
    return [];
  }
}

// Bulk cache lookup for crypto spot prices on a single date. Returns a map of
// "CRYPTO:<SYMBOL>" -> { price, currency } for the rows that exist. Mirrors
// price-service's readPriceCacheBulk (the stock equivalent). Crypto is cached in
// USD (see cacheCryptoPrice / vs_currency=usd); the row's own currency is carried
// through so any legacy CAD rows still convert correctly during the transition.
async function readCryptoCacheBulk(
  symbols: string[],
  date: string,
): Promise<Map<string, { price: number; currency: string; stale: boolean }>> {
  const out = new Map<string, { price: number; currency: string; stale: boolean }>();
  if (symbols.length === 0) return out;
  const cacheSymbols = [...new Set(symbols.map((s) => `CRYPTO:${s.toUpperCase()}`))];
  try {
    const rows = await db
      .select()
      .from(schema.priceCache)
      .where(and(inArray(schema.priceCache.symbol, cacheSymbols), eq(schema.priceCache.date, date)));
    for (const r of rows) {
      // Keep the FIRST row per symbol (duplicate (symbol,date) rows are possible
      // — non-unique index). FINLYNQ-204: stamp staleness for today-rows; a
      // historical date is never stale (isPriceCacheRowStale guards date != today).
      if (out.has(r.symbol)) continue;
      out.set(r.symbol, {
        price: r.price,
        currency: r.currency ?? "USD",
        stale: isPriceCacheRowStale(r.date, r.fetchedAt, date),
      });
    }
  } catch {
    // A cache-read failure degrades to "all misses" -> live fetch below.
  }
  return out;
}

// Pure partition: given the requested (coinId, symbol) pairs and the set of
// "CRYPTO:<SYMBOL>" keys present in today's cache, decide which come from cache
// (hits) vs need a live CoinGecko fetch (misses). De-dupes by coinId (keeping
// the first symbol seen) and normalizes symbols to upper-case so the cache key
// format matches cacheCryptoPrice. Exported for unit testing.
export function splitCryptoCacheHits(
  coins: Array<{ coinId: string; symbol: string }>,
  cachedSymbolKeys: Set<string>,
): { hits: Array<{ coinId: string; symbol: string }>; misses: Array<{ coinId: string; symbol: string }> } {
  const uniq = new Map<string, string>(); // coinId -> SYMBOL (upper)
  for (const c of coins) {
    if (!c.coinId || !c.symbol) continue;
    if (!uniq.has(c.coinId)) uniq.set(c.coinId, c.symbol.toUpperCase());
  }
  const hits: Array<{ coinId: string; symbol: string }> = [];
  const misses: Array<{ coinId: string; symbol: string }> = [];
  for (const [coinId, symbol] of uniq) {
    if (cachedSymbolKeys.has(`CRYPTO:${symbol}`)) hits.push({ coinId, symbol });
    else misses.push({ coinId, symbol });
  }
  return { hits, misses };
}

/**
 * Cache-first spot prices for VALUATION (price only). The crypto analogue of
 * price-service's `fetchMultipleQuotes`: read price_cache for today in one
 * query, fetch only the misses live (which also writes the cache), and merge.
 *
 * On a cache HIT the rich fields (change24h, changePct24h, marketCap, image)
 * are NOT reconstructed — they aren't stored in price_cache, so a hit returns
 * `price` with those fields zeroed/undefined (same lossiness as the stock cache
 * path). Callers that need rich display data (the /portfolio/overview and
 * /portfolio/crypto pages) must keep using `getCryptoPrices` (live). Use THIS
 * for the snapshot-rebuild / net-worth-history loop so a ~200-day rebuild makes
 * ~1 CoinGecko call instead of ~200 (and re-runs hit cache).
 *
 * Each entry passes BOTH the CoinGecko coin id and the holding's base symbol so
 * the returned `symbol` matches what symbol-keyed callers look up by, even when
 * CoinGecko's returned symbol differs (e.g. MATIC vs POL share matic-network).
 */
export async function getCryptoSpotPrices(
  coins: Array<{ coinId: string; symbol: string }>,
): Promise<CryptoPrice[]> {
  if (coins.length === 0) return [];
  const today = todayISO();
  const symbols = coins.filter((c) => c.coinId && c.symbol).map((c) => c.symbol);
  const cacheMap = await readCryptoCacheBulk(symbols, today);
  // FINLYNQ-204: only FRESH today-rows count as hits; a stale today-row (>30 min)
  // is routed to `misses` so it re-fetches live (it remains in `cacheMap` as a
  // retain-on-failure fallback below). Mirrors the stock path.
  const freshKeys = new Set(
    [...cacheMap.entries()].filter(([, v]) => !v.stale).map(([k]) => k),
  );
  const { hits, misses } = splitCryptoCacheHits(coins, freshKeys);

  const out: CryptoPrice[] = [];
  for (const h of hits) {
    const row = cacheMap.get(`CRYPTO:${h.symbol}`);
    if (!row) continue; // defensive — splitCryptoCacheHits keyed off the same set
    out.push({
      id: h.coinId,
      symbol: h.symbol,
      name: h.symbol,
      price: row.price,
      currency: row.currency,
      change24h: 0,
      changePct24h: 0,
      marketCap: 0,
      image: undefined,
    });
  }

  if (misses.length > 0) {
    // Live fetch for the misses (true misses + stale today-rows); getCryptoPrices()
    // also writes price_cache (UPDATE-in-place stamps fetched_at), so the next call
    // within the TTL hits the cache instead.
    const live = await getCryptoPrices(misses.map((m) => m.coinId));
    const liveById = new Map(live.map((p) => [p.id, p]));
    for (const m of misses) {
      const lp = liveById.get(m.coinId);
      if (lp) {
        // Re-key to the CALLER's symbol so downstream symbol-keyed lookups resolve
        // even when CoinGecko returns a different symbol for the same coin id.
        out.push({ ...lp, symbol: m.symbol });
        continue;
      }
      // FINLYNQ-204 retain-on-failure: live fetch returned nothing for this coin.
      // If we had a stale today-row, keep serving its last-known price rather than
      // dropping the holding (its fetched_at is left untouched → re-tries next read).
      const stale = cacheMap.get(`CRYPTO:${m.symbol}`);
      if (stale) {
        out.push({
          id: m.coinId,
          symbol: m.symbol,
          name: m.symbol,
          price: stale.price,
          currency: stale.currency,
          change24h: 0,
          changePct24h: 0,
          marketCap: 0,
          image: undefined,
        });
      }
    }
  }

  return out;
}

// Pure: collapse CoinGecko's `market_chart.prices` ([ms, price] pairs at hourly
// or daily granularity) into one price per calendar day, keeping the LAST point
// seen for each day (the latest in-day quote ≈ that day's close). Skips `today`
// and any future date — the live spot path owns today's row, and writing a
// near-live bar there would shadow the true current price. Exported for testing.
export function bucketDailyCryptoPrices(
  prices: Array<[number, number]>,
  today: string,
): Map<string, number> {
  const byDate = new Map<string, number>();
  for (const point of prices) {
    if (!Array.isArray(point)) continue;
    const [tsMs, price] = point;
    if (typeof tsMs !== "number" || typeof price !== "number") continue;
    const d = new Date(tsMs).toISOString().split("T")[0];
    if (d >= today) continue; // today/future belong to the live path
    byDate.set(d, price); // later entry for the same day overwrites → last wins
  }
  return byDate;
}

// Fetch daily historical prices for one coin covering [fromDate, today] in a
// SINGLE CoinGecko call (`market_chart?days=N`) and bulk-write the strictly-past
// days into price_cache under "CRYPTO:<SYMBOL>". Idempotent: only inserts dates
// not already cached (historical bars are immutable), so a re-run is a no-op.
// Free-tier historical data is limited to ~365 days, so `days` is capped there;
// dates older than that simply stay uncached and the caller falls back to the
// live spot price (same approximation as before historical pricing existed).
async function fetchCryptoHistoryToCache(coinId: string, symbol: string, fromDate: string): Promise<void> {
  const today = todayISO();
  const spanMs = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`);
  if (!(spanMs > 0)) return; // fromDate is today or in the future — nothing historical to fetch
  const days = Math.min(365, Math.ceil(spanMs / 86400000) + 1);
  try {
    const res = await coinGeckoFetch(`/coins/${coinId}/market_chart?vs_currency=usd&days=${days}`);
    if (!res.ok) return;
    const data = await res.json();
    const byDate = bucketDailyCryptoPrices((data.prices ?? []) as Array<[number, number]>, today);
    if (byDate.size === 0) return;

    const cacheSymbol = `CRYPTO:${symbol.toUpperCase()}`;
    const dates = [...byDate.keys()];
    // Only insert dates not already cached — historical bars never change, and
    // this also avoids duplicating rows on the (non-unique) (symbol, date) index.
    const existing = await db
      .select({ date: schema.priceCache.date })
      .from(schema.priceCache)
      .where(and(eq(schema.priceCache.symbol, cacheSymbol), inArray(schema.priceCache.date, dates)));
    const have = new Set(existing.map((r) => r.date));
    const rows = dates
      .filter((d) => !have.has(d))
      .map((date) => ({ symbol: cacheSymbol, date, price: byDate.get(date)!, currency: "USD", previousClose: null }));
    if (rows.length > 0) await db.insert(schema.priceCache).values(rows);
  } catch {
    // Network/parse failure → leave the cache as-is; the caller degrades to the
    // live spot price for any date it couldn't fill.
  }
}

/**
 * Historical spot prices for VALUATION as of a past date. The crypto analogue of
 * price-service's `fetchMultipleQuotesAtDate`: read price_cache for `date` first;
 * for misses, fetch the whole [date, today] window per coin in ONE CoinGecko call
 * (bulk-cached, immutable), then re-read. Because the snapshot rebuild walks
 * OLDEST-first, the oldest day's fetch populates the entire window and every later
 * day is a pure cache hit — so a multi-day rebuild makes ~1 historical call per coin.
 *
 * Same price-only shape as getCryptoSpotPrices (rich fields zeroed). For `date >=`
 * today this delegates to the live getCryptoSpotPrices. Any date the history fetch
 * can't cover (older than the free-tier ~365-day limit, or an API failure) falls
 * back to the live spot price — never worse than valuing crypto at the current price
 * (the behavior before historical pricing existed).
 */
export async function getCryptoPricesAtDate(
  coins: Array<{ coinId: string; symbol: string }>,
  date: string,
): Promise<CryptoPrice[]> {
  if (coins.length === 0) return [];
  const today = todayISO();
  if (date >= today) return getCryptoSpotPrices(coins); // today/future → live

  // Dedup by coinId, keep the first symbol seen (upper-cased to match the cache key).
  const uniq = new Map<string, string>();
  for (const c of coins) {
    if (!c.coinId || !c.symbol) continue;
    if (!uniq.has(c.coinId)) uniq.set(c.coinId, c.symbol.toUpperCase());
  }
  if (uniq.size === 0) return [];
  const symbols = [...uniq.values()];

  // 1. Cache-read for the historical date.
  let cacheMap = await readCryptoCacheBulk(symbols, date);

  // 2. For misses, backfill history per coin and re-read. Two tiers by age:
  //    - WITHIN CoinGecko's free ~365-day window → CoinGecko market_chart
  //      (crypto-native, vs_currency=usd).
  //    - OLDER than that → Yahoo "<SYM>-USD" daily history (covers back to
  //      ~2014), so old dates get REAL historical prices instead of degrading to
  //      today's spot. (Calling CoinGecko for >365d is pointless — it only
  //      returns the trailing 365 days — so we never do.)
  //    Both write USD rows under "CRYPTO:<SYM>"; anything neither tier can fill
  //    falls through to the spot approximation in step 3 (negative-cached so a
  //    hopeless ticker isn't re-hit per old date).
  const missing = [...uniq].filter(([, sym]) => !cacheMap.has(`CRYPTO:${sym}`));
  if (missing.length > 0) {
    const withinWindow = isWithinCryptoHistoryWindow(date, today);
    for (const [coinId, sym] of missing) {
      if (withinWindow) {
        await fetchCryptoHistoryToCache(coinId, sym, date);
      } else {
        await fetchCryptoHistoryFromYahooToCache(sym, date);
      }
    }
    cacheMap = await readCryptoCacheBulk(symbols, date);
  }

  const out: CryptoPrice[] = [];
  const stillMissing: Array<{ coinId: string; symbol: string }> = [];
  for (const [coinId, sym] of uniq) {
    const row = cacheMap.get(`CRYPTO:${sym}`);
    if (row) {
      out.push({ id: coinId, symbol: sym, name: sym, price: row.price, currency: row.currency, change24h: 0, changePct24h: 0, marketCap: 0, image: undefined });
    } else {
      stillMissing.push({ coinId, symbol: sym });
    }
  }

  // 3. Anything NEITHER tier could fill (a coin Yahoo also lacks, or an API
  //    failure) degrades to the cache-first spot price so we never drop a holding
  //    from a historical snapshot. The spot path reads today's cached row first,
  //    so this is ~1 call per coin, not one per day.
  if (stillMissing.length > 0) {
    const spot = await getCryptoSpotPrices(stillMissing);
    const spotById = new Map(spot.map((p) => [p.id, p]));
    for (const m of stillMissing) {
      const sp = spotById.get(m.coinId);
      if (sp) out.push({ ...sp, symbol: m.symbol });
    }
  }

  return out;
}

export async function searchCrypto(query: string): Promise<CryptoSearchResult[]> {
  try {
    const res = await coinGeckoFetch(`/search?query=${encodeURIComponent(query)}`);
    if (!res.ok) return [];
    const data = await res.json();

    return ((data.coins ?? []) as Array<Record<string, unknown>>)
      .slice(0, 10)
      .map((coin) => ({
        id: coin.id as string,
        name: coin.name as string,
        symbol: ((coin.symbol as string) ?? "").toUpperCase(),
        marketCapRank: (coin.market_cap_rank as number) ?? null,
      }));
  } catch {
    return [];
  }
}

export async function getCryptoHistory(
  coinId: string,
  days: number = 30
): Promise<CryptoHistoryPoint[]> {
  try {
    const res = await coinGeckoFetch(
      `/coins/${coinId}/market_chart?vs_currency=usd&days=${days}`
    );
    if (!res.ok) return [];
    const data = await res.json();

    const prices: [number, number][] = data.prices ?? [];
    return prices.map(([timestamp, price]) => ({
      date: new Date(timestamp).toISOString().split("T")[0],
      price: Math.round(price * 100) / 100,
    }));
  } catch {
    return [];
  }
}

// Cache crypto price with "CRYPTO:" prefix
async function cacheCryptoPrice(symbol: string, price: number, currency: string) {
  const cacheSymbol = `CRYPTO:${symbol}`;
  const today = todayISO();

  try {
    const existing = await db
      .select()
      .from(schema.priceCache)
      .where(
        and(
          eq(schema.priceCache.symbol, cacheSymbol),
          eq(schema.priceCache.date, today)
        )
      )
      .get();

    if (existing) {
      // FINLYNQ-204: stamp fetched_at on refresh so today's crypto row resets the
      // 30-min intraday TTL (parity with the stock writePriceCache UPDATE path).
      await db.update(schema.priceCache)
        .set({ price, currency, fetchedAt: new Date() })
        .where(eq(schema.priceCache.id, existing.id))
        ;
    } else {
      await db.insert(schema.priceCache)
        .values({ symbol: cacheSymbol, date: today, price, currency })
        ;
    }
  } catch {
    // Silently fail cache writes
  }
}

export async function getCachedCryptoPrice(
  symbol: string
): Promise<{ price: number; currency: string; date: string } | null> {
  const cacheSymbol = `CRYPTO:${symbol.toUpperCase()}`;
  const row = await db
    .select()
    .from(schema.priceCache)
    .where(eq(schema.priceCache.symbol, cacheSymbol))
    .orderBy(schema.priceCache.date)
    .limit(1)
    .get();

  return row ? { price: row.price, currency: row.currency, date: row.date } : null;
}

// Map common symbols to CoinGecko IDs
const SYMBOL_TO_COINGECKO: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  ADA: "cardano",
  XRP: "ripple",
  DOGE: "dogecoin",
  DOT: "polkadot",
  LINK: "chainlink",
  AVAX: "avalanche-2",
  MATIC: "matic-network",
  POL: "matic-network",
  ATOM: "cosmos",
  UNI: "uniswap",
  LTC: "litecoin",
  NEAR: "near",
  FIL: "filecoin",
  ICP: "internet-computer",
  AAVE: "aave",
  ALGO: "algorand",
  XLM: "stellar",
  XTZ: "tezos",
  SAND: "the-sandbox",
  MANA: "decentraland",
  AXS: "axie-infinity",
  ARB: "arbitrum",
  OP: "optimism",
  APT: "aptos",
  SUI: "sui",
  BNB: "binancecoin",
  SHIB: "shiba-inu",
  CRV: "curve-dao-token",
  FTM: "fantom",
  HBAR: "hedera-hashgraph",
  SNX: "havven",
  YFI: "yearn-finance",
  EOS: "eos",
  S: "sonic-3",
};

export function symbolToCoinGeckoId(symbol: string): string | null {
  const upper = symbol.toUpperCase().split("-")[0]; // Handle BTC-CAD format
  return SYMBOL_TO_COINGECKO[upper] ?? null;
}
