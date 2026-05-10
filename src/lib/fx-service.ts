// Multi-currency FX engine — canonical USD model with triangulation.
//
// Storage: every rate is stored as `rate_to_usd` (1 unit of currency = N USD).
// Cross-rates are derived: getRate(EUR, CAD) = rate_to_usd[EUR] / rate_to_usd[CAD].
//
// Lookup priority inside getRateToUsd:
//   1. USD itself → 1.0 (short-circuit)
//   2. Most-specific user override (fx_overrides) for (currency, date)
//   3. fx_rates row for (currency, date)
//   4. Yahoo Finance fetch for `<CCY>USD=X` at that date — INSERT into fx_rates on success
//   5. Most-recent fx_rates row for `currency` (last effective rate; weekends/holidays/future)
//   6. Hardcoded fallback constants (only USD pairs we ship out of the box)
//   7. Return 1 with source='fallback' so the caller decides 503 vs write
//
// Crypto (BTC, ETH, USDC, USDT) routes through CoinGecko via crypto-service.ts.

import { db, schema } from "@/db";
import { and, eq, desc, gte, lte, isNull, or, sql } from "drizzle-orm";
import {
  SUPPORTED_CURRENCIES,
  isCryptoCurrency,
  isMetalCurrency,
} from "@/lib/fx/supported-currencies";

export type RateSource = "yahoo" | "coingecko" | "stooq" | "override" | "stale" | "fallback";
export type RateLookup = { rate: number; source: RateSource; effectiveDate: string };

// Issue #231: per-leg source collapse for triangulated pairs. When `get_fx_rate`
// or `convert_amount` resolves a cross-rate it queries two legs (from→USD and
// to→USD); we want the top-level `source` to surface the worst leg so a caller
// inspecting a "yahoo" response isn't unknowingly using a stale fallback under
// the hood. Ranking (lower = better, higher = surfaced):
//   live (yahoo / coingecko / stooq)  <  override (positive label)  <  stale  <  fallback
// `override` is the *positive* label only when EVERY leg is overridden — one
// override + one stale degrades to "stale". When every leg is the same live
// provider, that provider's name is preserved.
const SOURCE_RANK: Record<RateSource, number> = {
  yahoo: 0,
  coingecko: 0,
  stooq: 0,
  override: 1,
  stale: 2,
  fallback: 3,
};

export function collapseLegSources(
  legs: ReadonlyArray<{ source: RateSource }>
): RateSource {
  if (legs.length === 0) return "fallback";
  // Pick the worst-ranked source.
  let worst: RateSource = legs[0].source;
  for (let i = 1; i < legs.length; i++) {
    if (SOURCE_RANK[legs[i].source] > SOURCE_RANK[worst]) worst = legs[i].source;
  }
  // Special case: keep a positive provider label ("yahoo"/"coingecko"/"stooq")
  // only when every leg uses that exact provider. Mixed live providers collapse
  // to the first leg's label arbitrarily; if any leg is degraded the worst-rank
  // pick already wins.
  if (SOURCE_RANK[worst] === 0) {
    const first = legs[0].source;
    return legs.every((l) => l.source === first) ? first : worst;
  }
  return worst;
}

// Currency + date validation helpers for the MCP tool boundary.
// IMPORTANT: do NOT call validateDate from inside getRateToUsdDetailed/getRate.
// `convertToAccountCurrency` (write paths) legitimately resolves rates for
// future-dated transactions and the `settleFutureFxRates` cron re-locks them
// when the date arrives. Future-date hard-rejects belong on the public MCP
// tool wrappers (`get_fx_rate`, `set_fx_override`, `convert_amount`), not in
// the engine. (Issue #206 — historical rates + cache poisoning.)
const SUPPORTED_CURRENCY_SET = new Set<string>(SUPPORTED_CURRENCIES);
const FALLBACK_CURRENCY_SET = new Set<string>(); // populated below after FALLBACK_RATE_TO_USD definition

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FX_MIN_DATE = "1970-01-01";

export function validateCurrencyCode(code: string): string {
  const c = (code ?? "").trim().toUpperCase();
  if (!c) throw new Error("currency required");
  if (!SUPPORTED_CURRENCY_SET.has(c) && !FALLBACK_CURRENCY_SET.has(c)) {
    throw new Error(`unknown currency: ${c}`);
  }
  return c;
}

export function validateFxDate(date: string): string {
  if (!date || !ISO_DATE_RE.test(date)) throw new Error("date must be YYYY-MM-DD");
  if (date < FX_MIN_DATE) throw new Error("date out of range (pre-1970)");
  // Use `todayISO()` declared below — function declarations are hoisted-equivalent
  // for `const` arrow assigned at module top-level via `function` form below; this
  // file uses an arrow `const`, so we inline the calculation to avoid TDZ.
  const today = new Date().toISOString().split("T")[0];
  if (date > today) throw new Error("future-dated FX rate not supported");
  return date;
}

// Hardcoded fallbacks — only used when we can't reach Yahoo and have nothing
// cached for this currency. Stored as <CCY> → USD.
const FALLBACK_RATE_TO_USD: Record<string, number> = {
  USD: 1,
  CAD: 0.735,   // 1 CAD ≈ 0.735 USD (USD/CAD ≈ 1.36)
  EUR: 1.08,
  GBP: 1.27,
  JPY: 0.0067,  // 1 JPY ≈ 0.0067 USD
  AUD: 0.66,
  CHF: 1.13,
  NZD: 0.61,
  CNY: 0.14,
  HKD: 0.128,
  SGD: 0.74,
  // Precious metals — rough 2026 spot levels, updated only when stooq is
  // unreachable AND nothing is cached AND no override exists.
  XAU: 4700,
  XAG: 75,
  XPT: 1000,
  XPD: 1000,
};

// Pull the hardcoded codes into the validator's allowlist too, so users on a
// self-hosted instance whose `SUPPORTED_CURRENCIES` happens to be missing one
// (rare — every fallback code is also in the supported list today) still hit
// the fallback path rather than `unknown currency`.
for (const k of Object.keys(FALLBACK_RATE_TO_USD)) FALLBACK_CURRENCY_SET.add(k);

const todayISO = (): string => new Date().toISOString().split("T")[0];

/**
 * Resolve the display currency for an API request.
 * Priority: explicit `?currency=` query param → user's `settings.display_currency` → "CAD".
 */
export async function getDisplayCurrency(
  userId: string,
  queryParam?: string | null
): Promise<string> {
  if (queryParam) {
    const trimmed = queryParam.trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(trimmed)) return trimmed;
  }
  const row = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(
      and(
        eq(schema.settings.key, "display_currency"),
        eq(schema.settings.userId, userId)
      )
    )
    .limit(1);
  return row[0]?.value ?? "CAD";
}

// ─── Yahoo Finance fetch ────────────────────────────────────────────────

async function fetchYahooRateToUsd(currency: string, date: string): Promise<number | null> {
  if (currency === "USD") return 1;
  try {
    // <CCY>USD=X gives 1 unit of <CCY> in USD directly.
    const symbol = `${currency}USD=X`;
    const today = todayISO();
    let url: string;
    let isHistorical = false;
    if (date >= today) {
      url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`;
    } else {
      // Issue #231: window is biased BACKWARDS from the requested date so a
      // weekend / exchange-holiday lookup resolves to the prior trading day's
      // close rather than missing the window entirely (which would fall
      // through to findNearestCached and serve today's spot as "stale").
      // 7d back covers the worst-case Christmas–New Year cluster (4 closed
      // days) plus a weekend; +1d forward absorbs a UTC timezone seam where
      // Yahoo's bar timestamp could land on the next calendar day.
      const reqMs = new Date(`${date}T00:00:00Z`).getTime();
      const start = Math.floor((reqMs - 86400_000 * 7) / 1000);
      const end = Math.floor((reqMs + 86400_000) / 1000);
      url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&period1=${start}&period2=${end}`;
      isHistorical = true;
    }
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data.chart?.result?.[0];
    if (!result) return null;
    if (isHistorical) {
      // Issue #206: meta.regularMarketPrice is TODAY's price even on a historical
      // chart payload; the actual historical close lives at indicators.quote[0].close[]
      // indexed by the timestamp[] array. Pick the latest close <= the requested date.
      const timestamps: unknown = result.timestamp;
      const closes: unknown = result.indicators?.quote?.[0]?.close;
      if (!Array.isArray(timestamps) || !Array.isArray(closes)) return null;
      const dateMs = new Date(`${date}T23:59:59Z`).getTime();
      let best: { ts: number; close: number } | null = null;
      for (let i = 0; i < timestamps.length; i++) {
        const ts = timestamps[i];
        const close = closes[i];
        if (typeof ts !== "number" || typeof close !== "number" || close <= 0) continue;
        const tsMs = ts * 1000;
        if (tsMs > dateMs) continue;
        if (!best || tsMs > best.ts) best = { ts: tsMs, close };
      }
      return best ? best.close : null;
    }
    // Latest branch — meta.regularMarketPrice is correct here.
    const rate = result.meta?.regularMarketPrice;
    return typeof rate === "number" && rate > 0 ? rate : null;
  } catch {
    return null;
  }
}

async function fetchCryptoRateToUsd(currency: string): Promise<number | null> {
  if (currency === "USDC" || currency === "USDT") return 1;
  try {
    const { getCryptoPrices, symbolToCoinGeckoId } = await import("@/lib/crypto-service");
    const id = symbolToCoinGeckoId(currency);
    if (!id) return null;
    const prices = await getCryptoPrices([id]);
    const match = prices.find((p) => p.id === id);
    return match && match.price > 0 ? match.price : null;
  } catch {
    return null;
  }
}

// Spot precious-metals rates from stooq.com. Yahoo's `<CCY>USD=X` pattern
// returns 404 for XAU/XAG/XPT/XPD; stooq serves them via a free unauthenticated
// CSV endpoint. Maps ISO 4217 metal codes to stooq's `xauusd` / `xagusd` /
// `xptusd` / `xpdusd` symbols.
async function fetchStooqMetalRateToUsd(currency: string, date: string): Promise<number | null> {
  const symbol = `${currency.toLowerCase()}usd`;
  const today = todayISO();
  try {
    if (date >= today) {
      // Latest close — column layout: Symbol,Date,Time,Open,High,Low,Close
      const url = `https://stooq.com/q/l/?s=${symbol}&f=sd2t2ohlc&h&e=csv`;
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        next: { revalidate: 3600 },
      });
      if (!res.ok) return null;
      const text = await res.text();
      const lines = text.trim().split(/\r?\n/);
      if (lines.length < 2) return null;
      const cols = lines[1].split(",");
      const close = Number(cols[6]);
      return Number.isFinite(close) && close > 0 ? close : null;
    }
    // Historical — 5-day window covering the requested date so weekend/holiday
    // gaps still resolve. Column layout: Date,Open,High,Low,Close,Volume.
    const reqMs = new Date(`${date}T00:00:00Z`).getTime();
    const fromIso = new Date(reqMs - 86400_000 * 4).toISOString().slice(0, 10);
    const d1 = fromIso.replaceAll("-", "");
    const d2 = date.replaceAll("-", "");
    const url = `https://stooq.com/q/d/l/?s=${symbol}&d1=${d1}&d2=${d2}&i=d`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const text = await res.text();
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return null;
    // Pick the latest row with date <= requested date.
    let best: { date: string; close: number } | null = null;
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      const rowDate = cols[0];
      const close = Number(cols[4]);
      if (!rowDate || !Number.isFinite(close) || close <= 0) continue;
      if (rowDate > date) continue;
      if (!best || rowDate > best.date) best = { date: rowDate, close };
    }
    return best ? best.close : null;
  } catch {
    return null;
  }
}

// ─── Override lookup ────────────────────────────────────────────────────

async function findOverride(
  currency: string,
  date: string,
  userId: string
): Promise<{ rate: number; effectiveDate: string } | null> {
  // Most-specific (smallest range) wins. Bounded rows beat open-ended.
  const rows = await db
    .select({
      rateToUsd: schema.fxOverrides.rateToUsd,
      dateFrom: schema.fxOverrides.dateFrom,
      dateTo: schema.fxOverrides.dateTo,
    })
    .from(schema.fxOverrides)
    .where(
      and(
        eq(schema.fxOverrides.userId, userId),
        eq(schema.fxOverrides.currency, currency),
        lte(schema.fxOverrides.dateFrom, date),
        or(
          isNull(schema.fxOverrides.dateTo),
          gte(schema.fxOverrides.dateTo, date)
        )
      )
    );
  if (rows.length === 0) return null;
  // Pick the most-specific: bounded > open-ended; smaller range > larger.
  rows.sort((a, b) => {
    const aBounded = a.dateTo != null;
    const bBounded = b.dateTo != null;
    if (aBounded !== bBounded) return aBounded ? -1 : 1;
    return a.dateFrom.localeCompare(b.dateFrom) * -1; // newer date_from first
  });
  return { rate: rows[0].rateToUsd, effectiveDate: rows[0].dateFrom };
}

// ─── Cache lookup + write ───────────────────────────────────────────────

async function findCached(
  currency: string,
  date: string
): Promise<{ rate: number; effectiveDate: string } | null> {
  const exact = await db
    .select({ rateToUsd: schema.fxRates.rateToUsd, date: schema.fxRates.date })
    .from(schema.fxRates)
    .where(and(eq(schema.fxRates.currency, currency), eq(schema.fxRates.date, date)))
    .limit(1);
  if (exact[0]) return { rate: exact[0].rateToUsd, effectiveDate: exact[0].date };
  return null;
}

async function findNearestCached(
  currency: string
): Promise<{ rate: number; effectiveDate: string } | null> {
  // Issue #206: restrict to date <= today so a poisoned future-dated row
  // (left over before the deploy or written through a path that bypasses
  // the gate below) can't outrank legitimate historical rows.
  const row = await db
    .select({ rateToUsd: schema.fxRates.rateToUsd, date: schema.fxRates.date })
    .from(schema.fxRates)
    .where(
      and(
        eq(schema.fxRates.currency, currency),
        lte(schema.fxRates.date, todayISO())
      )
    )
    .orderBy(desc(schema.fxRates.date))
    .limit(1);
  if (row[0]) return { rate: row[0].rateToUsd, effectiveDate: row[0].date };
  return null;
}

async function writeCached(
  currency: string,
  date: string,
  rate: number,
  source: "yahoo" | "coingecko" | "stooq" | "manual" | "fallback"
): Promise<void> {
  await db
    .insert(schema.fxRates)
    .values({ currency, date, rateToUsd: rate, source })
    .onConflictDoUpdate({
      target: [schema.fxRates.currency, schema.fxRates.date],
      set: { rateToUsd: rate, source, fetchedAt: new Date() },
    })
    .catch(() => {});
}

// ─── Core API ───────────────────────────────────────────────────────────

/**
 * Resolve the rate of 1 unit of `currency` in USD on `date`.
 * Returns the rate plus metadata about the source.
 */
export async function getRateToUsdDetailed(
  currency: string,
  date: string,
  userId: string
): Promise<RateLookup> {
  const code = currency.trim().toUpperCase();
  if (code === "USD") return { rate: 1, source: "yahoo", effectiveDate: date };

  // 1. User override
  const override = await findOverride(code, date, userId);
  if (override) {
    return { rate: override.rate, source: "override", effectiveDate: override.effectiveDate };
  }

  // 2. Cached exact match
  const cached = await findCached(code, date);
  if (cached) return { rate: cached.rate, source: "yahoo", effectiveDate: cached.effectiveDate };

  // 3. Live fetch — Yahoo for fiat, CoinGecko for crypto, stooq for metals
  let fetched: number | null;
  let liveSource: "yahoo" | "coingecko" | "stooq";
  if (isCryptoCurrency(code)) {
    fetched = await fetchCryptoRateToUsd(code);
    liveSource = "coingecko";
  } else if (isMetalCurrency(code)) {
    fetched = await fetchStooqMetalRateToUsd(code, date);
    liveSource = "stooq";
  } else {
    fetched = await fetchYahooRateToUsd(code, date);
    liveSource = "yahoo";
  }
  if (fetched != null) {
    // Issue #206: never persist future-dated rates. They would outrank
    // legitimate historical rows in findNearestCached and serve as a stale
    // fallback for every subsequent historical lookup that misses an exact
    // match. The future-date branch above (date >= today) returns the
    // current spot price; the cron at src/lib/cron/settle-future-fx.ts
    // re-locks future-dated transaction rows when their date arrives.
    if (date <= todayISO()) {
      await writeCached(code, date, fetched, liveSource);
    }
    return { rate: fetched, source: liveSource, effectiveDate: date };
  }

  // 4. Nearest cached row for this currency (last effective rate — handles
  //    weekends/holidays AND future-dated entries until the date arrives).
  const nearest = await findNearestCached(code);
  if (nearest) return { rate: nearest.rate, source: "stale", effectiveDate: nearest.effectiveDate };

  // 5. Hardcoded fallback
  if (FALLBACK_RATE_TO_USD[code] != null) {
    return { rate: FALLBACK_RATE_TO_USD[code], source: "fallback", effectiveDate: date };
  }

  // 6. Total miss — caller decides whether to 409 / prompt for an override
  return { rate: 1, source: "fallback", effectiveDate: date };
}

export async function getRateToUsd(
  currency: string,
  date: string,
  userId: string
): Promise<number> {
  const lookup = await getRateToUsdDetailed(currency, date, userId);
  return lookup.rate;
}

/**
 * Cross-rate via triangulation. 1 unit of `from` in `to` on `date`.
 */
export async function getRate(
  from: string,
  to: string,
  date: string,
  userId: string
): Promise<number> {
  const fromCode = from.trim().toUpperCase();
  const toCode = to.trim().toUpperCase();
  if (fromCode === toCode) return 1;
  const [fromUsd, toUsd] = await Promise.all([
    getRateToUsd(fromCode, date, userId),
    getRateToUsd(toCode, date, userId),
  ]);
  if (toUsd === 0) return 0;
  return fromUsd / toUsd;
}

export async function getRateAtDate(
  from: string,
  to: string,
  date: string,
  userId: string
): Promise<number> {
  return getRate(from, to, date, userId);
}

/**
 * Bulk prewarm — populate the cache for all (currency, date) pairs needed
 * by an upcoming workload. Each unique currency is fetched at most once
 * per date. Used by import + dashboard prewarm so a 6,000-row CSV import
 * doesn't issue thousands of FX queries serially.
 */
export async function prewarmRates(
  currencies: string[],
  dates: string[],
  userId: string
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const work: Array<{ currency: string; date: string }> = [];
  const dedup = new Set<string>();
  for (const c of currencies) {
    const cc = c.trim().toUpperCase();
    if (cc === "USD") continue;
    for (const d of dates) {
      const key = `${cc}:${d}`;
      if (dedup.has(key)) continue;
      dedup.add(key);
      work.push({ currency: cc, date: d });
    }
  }
  // Concurrency limit so we don't hammer Yahoo
  const CONCURRENCY = 6;
  for (let i = 0; i < work.length; i += CONCURRENCY) {
    const slice = work.slice(i, i + CONCURRENCY);
    await Promise.all(
      slice.map(async ({ currency, date }) => {
        const rate = await getRateToUsd(currency, date, userId);
        out.set(`${currency}:${date}`, rate);
      })
    );
  }
  out.set(`USD:${dates[0] ?? todayISO()}`, 1);
  return out;
}

// ─── Legacy exports (callers that haven't been migrated yet) ────────────

/**
 * @deprecated Use `getRate` instead. This wrapper keeps the older
 * pair-based callers compiling.
 */
export async function getLatestFxRate(
  from: string,
  to: string,
  userId?: string
): Promise<number> {
  if (!userId) {
    // No userId = no overrides. Use a synthetic ID; the global cache + fallbacks
    // still resolve. This path is unusual — most callers do pass userId.
    return getRate(from, to, todayISO(), "00000000-0000-0000-0000-000000000000");
  }
  return getRate(from, to, todayISO(), userId);
}

export async function fetchFxRate(from: string, to: string): Promise<number | null> {
  if (from === to) return 1;
  const fromUsd = await fetchYahooRateToUsd(from.trim().toUpperCase(), todayISO());
  const toUsd = await fetchYahooRateToUsd(to.trim().toUpperCase(), todayISO());
  if (fromUsd == null || toUsd == null || toUsd === 0) return null;
  return fromUsd / toUsd;
}

export function convertCurrency(amount: number, rate: number): number {
  return Math.round(amount * rate * 100) / 100;
}

export async function getConsolidatedBalances(
  balances: { currency: string; balance: number }[],
  targetCurrency: string,
  userId?: string
): Promise<{ original: number; converted: number; currency: string; rate: number }[]> {
  const uid = userId ?? "00000000-0000-0000-0000-000000000000";
  const today = todayISO();
  const results: Array<{ original: number; converted: number; currency: string; rate: number }> = [];
  for (const b of balances) {
    const rate = await getRate(b.currency, targetCurrency, today, uid);
    results.push({
      original: b.balance,
      converted: convertCurrency(b.balance, rate),
      currency: b.currency,
      rate,
    });
  }
  return results;
}

/**
 * Discover all distinct currencies used across accounts and transactions.
 */
export async function getActiveCurrencies(): Promise<string[]> {
  const accountCurrencyRows = await db
    .select({ currency: schema.accounts.currency })
    .from(schema.accounts)
    .groupBy(schema.accounts.currency);
  const accountCurrencies = accountCurrencyRows.map((r) => r.currency);

  const txnCurrencyRows = await db
    .select({ currency: schema.transactions.currency })
    .from(schema.transactions)
    .groupBy(schema.transactions.currency);
  const txnCurrencies = txnCurrencyRows.map((r) => r.currency);

  return Array.from(new Set([...accountCurrencies, ...txnCurrencies]));
}

export async function getActiveCurrencyPairs(displayCurrency: string): Promise<Array<{ from: string; to: string }>> {
  const currencies = await getActiveCurrencies();
  const pairs: Array<{ from: string; to: string }> = [];
  for (const c of currencies) {
    if (c !== displayCurrency) pairs.push({ from: c, to: displayCurrency });
  }
  return pairs;
}

/**
 * Refresh / build a rate map for converting any active currency to the target.
 * The rate map is keyed by source currency; values are pre-computed
 * `from → target` cross-rates via triangulation through USD.
 */
export async function refreshAllRates(
  displayCurrency: string,
  userId?: string
): Promise<Map<string, number>> {
  return getRateMap(displayCurrency, userId);
}

export async function getRateMap(
  targetCurrency: string,
  userId?: string
): Promise<Map<string, number>> {
  const uid = userId ?? "00000000-0000-0000-0000-000000000000";
  const today = todayISO();
  const target = targetCurrency.trim().toUpperCase();
  const currencies = await getActiveCurrencies();
  const map = new Map<string, number>();
  map.set(target, 1);
  for (const c of currencies) {
    const code = c.trim().toUpperCase();
    if (code === target) continue;
    const rate = await getRate(code, target, today, uid);
    map.set(code, rate);
  }
  return map;
}

export function convertWithRateMap(
  amount: number,
  fromCurrency: string,
  rateMap: Map<string, number>
): number {
  const code = fromCurrency.trim().toUpperCase();
  const rate = rateMap.get(code) ?? 1;
  return convertCurrency(amount, rate);
}
