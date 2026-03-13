// Feature 2: Live Portfolio Prices
// Feature 3: ETF Holdings Decomposition
// Uses Yahoo Finance v8 API (no API key needed)

import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";

const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance";

type QuoteResult = {
  symbol: string;
  price: number;
  currency: string;
  name: string;
  change: number;
  changePct: number;
  marketCap?: number;
};

export async function fetchQuote(symbol: string): Promise<QuoteResult | null> {
  try {
    const res = await fetch(
      `${YAHOO_BASE}/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
      { headers: { "User-Agent": "Mozilla/5.0" }, next: { revalidate: 300 } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data.chart?.result?.[0]?.meta;
    if (!meta) return null;

    return {
      symbol,
      price: meta.regularMarketPrice ?? 0,
      currency: meta.currency ?? "USD",
      name: meta.shortName ?? symbol,
      change: (meta.regularMarketPrice ?? 0) - (meta.previousClose ?? 0),
      changePct: meta.previousClose
        ? (((meta.regularMarketPrice ?? 0) - meta.previousClose) / meta.previousClose) * 100
        : 0,
    };
  } catch {
    return null;
  }
}

export async function fetchMultipleQuotes(symbols: string[]): Promise<Map<string, QuoteResult>> {
  const results = new Map<string, QuoteResult>();
  const unique = [...new Set(symbols.filter(Boolean))];

  // Fetch in batches of 5 to avoid rate limiting
  for (let i = 0; i < unique.length; i += 5) {
    const batch = unique.slice(i, i + 5);
    const promises = batch.map((s) => fetchQuote(s));
    const quotes = await Promise.all(promises);
    quotes.forEach((q) => {
      if (q) results.set(q.symbol, q);
    });
  }

  return results;
}

// Cache prices in DB
export async function cachePrice(symbol: string, price: number, currency: string) {
  const today = new Date().toISOString().split("T")[0];
  const existing = db
    .select()
    .from(schema.priceCache)
    .where(and(eq(schema.priceCache.symbol, symbol), eq(schema.priceCache.date, today)))
    .get();

  if (existing) {
    db.update(schema.priceCache)
      .set({ price, currency })
      .where(eq(schema.priceCache.id, existing.id))
      .run();
  } else {
    db.insert(schema.priceCache).values({ symbol, date: today, price, currency }).run();
  }
}

export function getCachedPrice(symbol: string): { price: number; currency: string; date: string } | null {
  const row = db
    .select()
    .from(schema.priceCache)
    .where(eq(schema.priceCache.symbol, symbol))
    .orderBy(schema.priceCache.date)
    .limit(1)
    .get();

  return row ? { price: row.price, currency: row.currency, date: row.date } : null;
}

// Feature 3: ETF Holdings Decomposition (simplified)
// In production, you'd use Morningstar API. Here we use known ETF compositions.
const ETF_REGIONS: Record<string, Record<string, number>> = {
  "VCN.TO": { Canada: 100 },
  "VUN.TO": { US: 100 },
  "VIU.TO": { Europe: 45, Japan: 25, Asia: 20, Other: 10 },
  "VWRA.L": { US: 60, Europe: 15, Japan: 7, Asia: 8, Canada: 3, Other: 7 },
  "VWRD.L": { US: 60, Europe: 15, Japan: 7, Asia: 8, Canada: 3, Other: 7 },
  "VUAA.L": { US: 100 },
  "VUSD.L": { US: 100 },
  "VHYD.L": { US: 35, Europe: 30, Asia: 20, Other: 15 },
  "VHYA.L": { US: 35, Europe: 30, Asia: 20, Other: 15 },
  "VHVE.L": { US: 65, Europe: 18, Japan: 8, Other: 9 },
  "VFEA.L": { Asia: 40, Other: 60 },
  "VJPA.L": { Japan: 100 },
  "VJPU.L": { Japan: 100 },
  "VNRA.L": { US: 85, Canada: 15 },
  "V3AA.L": { US: 55, Europe: 18, Japan: 8, Asia: 9, Other: 10 },
  "VAPU.L": { Asia: 60, Other: 40 },
  VTI: { US: 100 },
  "TPE.TO": { Europe: 40, Japan: 25, Asia: 20, Other: 15 },
  "TPU.TO": { US: 100 },
};

const ETF_SECTORS: Record<string, Record<string, number>> = {
  "VCN.TO": { Financials: 35, Energy: 15, Tech: 10, Materials: 10, Industrials: 10, Other: 20 },
  "VUN.TO": { Tech: 30, Healthcare: 13, Financials: 13, Consumer: 12, Industrials: 10, Other: 22 },
  "VUAA.L": { Tech: 30, Healthcare: 13, Financials: 13, Consumer: 12, Industrials: 10, Other: 22 },
  VTI: { Tech: 30, Healthcare: 13, Financials: 13, Consumer: 12, Industrials: 10, Other: 22 },
};

export function getEtfRegionBreakdown(symbol: string): Record<string, number> | null {
  return ETF_REGIONS[symbol] ?? null;
}

export function getEtfSectorBreakdown(symbol: string): Record<string, number> | null {
  return ETF_SECTORS[symbol] ?? null;
}

export function aggregatePortfolioExposure(
  holdings: { symbol: string; value: number }[]
): { regions: Record<string, number>; sectors: Record<string, number>; totalValue: number } {
  const regions: Record<string, number> = {};
  const sectors: Record<string, number> = {};
  let totalValue = 0;

  for (const h of holdings) {
    if (!h.symbol) continue;
    totalValue += h.value;

    const regionBreakdown = ETF_REGIONS[h.symbol];
    if (regionBreakdown) {
      for (const [region, pct] of Object.entries(regionBreakdown)) {
        regions[region] = (regions[region] ?? 0) + (h.value * pct) / 100;
      }
    }

    const sectorBreakdown = ETF_SECTORS[h.symbol];
    if (sectorBreakdown) {
      for (const [sector, pct] of Object.entries(sectorBreakdown)) {
        sectors[sector] = (sectors[sector] ?? 0) + (h.value * pct) / 100;
      }
    }
  }

  // Convert to percentages
  if (totalValue > 0) {
    for (const k of Object.keys(regions)) regions[k] = Math.round((regions[k] / totalValue) * 1000) / 10;
    for (const k of Object.keys(sectors)) sectors[k] = Math.round((sectors[k] / totalValue) * 1000) / 10;
  }

  return { regions, sectors, totalValue };
}
