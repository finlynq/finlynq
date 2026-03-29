// Feature 5: Multi-Currency FX Engine

import { db, schema } from "@/db";
import { and, eq, desc, sql } from "drizzle-orm";

export async function fetchFxRate(from: string, to: string): Promise<number | null> {
  if (from === to) return 1;
  try {
    const symbol = `${from}${to}=X`;
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`,
      { headers: { "User-Agent": "Mozilla/5.0" }, next: { revalidate: 3600 } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const rate = data.chart?.result?.[0]?.meta?.regularMarketPrice;
    return rate ?? null;
  } catch {
    return null;
  }
}

export async function getLatestFxRate(from: string, to: string): Promise<number> {
  if (from === to) return 1;

  const cached = db
    .select()
    .from(schema.fxRates)
    .where(
      and(eq(schema.fxRates.fromCurrency, from), eq(schema.fxRates.toCurrency, to))
    )
    .orderBy(desc(schema.fxRates.date))
    .limit(1)
    .get();

  const today = new Date().toISOString().split("T")[0];
  if (cached && cached.date === today) return cached.rate;

  const rate = await fetchFxRate(from, to);
  if (rate !== null) {
    db.insert(schema.fxRates)
      .values({ date: today, fromCurrency: from, toCurrency: to, rate })
      .run();
    return rate;
  }

  if (cached) return cached.rate;

  // Last resort defaults for common pairs
  const defaults: Record<string, number> = {
    "USD:CAD": 1.36, "CAD:USD": 0.735,
    "EUR:USD": 1.08, "USD:EUR": 0.926,
    "GBP:USD": 1.27, "USD:GBP": 0.787,
    "EUR:CAD": 1.47, "CAD:EUR": 0.68,
    "GBP:CAD": 1.73, "CAD:GBP": 0.578,
    "EUR:GBP": 0.85, "GBP:EUR": 1.176,
  };
  return defaults[`${from}:${to}`] ?? 1;
}

export function convertCurrency(amount: number, rate: number): number {
  return Math.round(amount * rate * 100) / 100;
}

export async function getConsolidatedBalances(
  balances: { currency: string; balance: number }[],
  targetCurrency: string
): Promise<{ original: number; converted: number; currency: string; rate: number }[]> {
  const rateCache = new Map<string, number>();
  const results = [];
  for (const b of balances) {
    const key = `${b.currency}:${targetCurrency}`;
    if (!rateCache.has(key)) {
      rateCache.set(key, await getLatestFxRate(b.currency, targetCurrency));
    }
    const rate = rateCache.get(key)!;
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
export function getActiveCurrencies(): string[] {
  const accountCurrencies = db
    .select({ currency: schema.accounts.currency })
    .from(schema.accounts)
    .groupBy(schema.accounts.currency)
    .all()
    .map((r) => r.currency);

  const txnCurrencies = db
    .select({ currency: schema.transactions.currency })
    .from(schema.transactions)
    .groupBy(schema.transactions.currency)
    .all()
    .map((r) => r.currency);

  return [...new Set([...accountCurrencies, ...txnCurrencies])];
}

/**
 * Build all needed currency pairs from active currencies to a target display currency.
 */
export function getActiveCurrencyPairs(displayCurrency: string): Array<{ from: string; to: string }> {
  const currencies = getActiveCurrencies();
  const pairs: Array<{ from: string; to: string }> = [];
  for (const c of currencies) {
    if (c !== displayCurrency) {
      pairs.push({ from: c, to: displayCurrency });
    }
  }
  return pairs;
}

/**
 * Refresh FX rates for all active currency pairs. Returns a rate map for immediate use.
 */
export async function refreshAllRates(
  displayCurrency: string
): Promise<Map<string, number>> {
  const pairs = getActiveCurrencyPairs(displayCurrency);
  const rateMap = new Map<string, number>();
  rateMap.set(displayCurrency, 1);

  for (const { from, to } of pairs) {
    const rate = await getLatestFxRate(from, to);
    rateMap.set(from, rate);
  }
  return rateMap;
}

/**
 * Build a rate map for converting any active currency to the target.
 * Uses cached rates where available (no network calls for fresh data).
 */
export async function getRateMap(targetCurrency: string): Promise<Map<string, number>> {
  return refreshAllRates(targetCurrency);
}

/**
 * Convert an amount from one currency to the target using a pre-built rate map.
 */
export function convertWithRateMap(
  amount: number,
  fromCurrency: string,
  rateMap: Map<string, number>
): number {
  const rate = rateMap.get(fromCurrency) ?? 1;
  return convertCurrency(amount, rate);
}
