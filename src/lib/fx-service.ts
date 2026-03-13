// Feature 5: Multi-Currency FX Engine

import { db, schema } from "@/db";
import { and, eq, desc } from "drizzle-orm";

export async function fetchFxRate(from: string, to: string): Promise<number | null> {
  if (from === to) return 1;
  try {
    // Use Yahoo Finance for FX
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

  // Check cache first
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

  // Fetch fresh rate
  const rate = await fetchFxRate(from, to);
  if (rate !== null) {
    db.insert(schema.fxRates)
      .values({ date: today, fromCurrency: from, toCurrency: to, rate })
      .run();
    return rate;
  }

  // Fallback to cached or default
  if (cached) return cached.rate;

  // Last resort defaults
  if (from === "USD" && to === "CAD") return 1.36;
  if (from === "CAD" && to === "USD") return 0.735;
  return 1;
}

export function convertCurrency(amount: number, rate: number): number {
  return Math.round(amount * rate * 100) / 100;
}

export async function getConsolidatedBalances(
  balances: { currency: string; balance: number }[],
  targetCurrency: string
): Promise<{ original: number; converted: number; currency: string; rate: number }[]> {
  const results = [];
  for (const b of balances) {
    const rate = await getLatestFxRate(b.currency, targetCurrency);
    results.push({
      original: b.balance,
      converted: convertCurrency(b.balance, rate),
      currency: b.currency,
      rate,
    });
  }
  return results;
}
