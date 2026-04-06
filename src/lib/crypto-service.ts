// Crypto price service using CoinGecko free API (no API key required)
// Caches prices in priceCache table with "CRYPTO:" prefix

import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";

export type CryptoPrice = {
  id: string;
  symbol: string;
  name: string;
  price: number;
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
      price: data.market_data?.current_price?.cad ?? data.market_data?.current_price?.usd ?? 0,
      change24h: data.market_data?.price_change_24h ?? 0,
      changePct24h: data.market_data?.price_change_percentage_24h ?? 0,
      marketCap: data.market_data?.market_cap?.cad ?? data.market_data?.market_cap?.usd ?? 0,
      image: data.image?.small,
    };

    // Cache the price
    await cacheCryptoPrice(price.symbol, price.price, "CAD");

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
      `/coins/markets?vs_currency=cad&ids=${ids}&order=market_cap_desc&sparkline=false&price_change_percentage=24h`
    );
    if (!res.ok) return [];
    const data = await res.json();

    const prices: CryptoPrice[] = (data as Array<Record<string, unknown>>).map((coin) => ({
      id: coin.id as string,
      symbol: ((coin.symbol as string) ?? "").toUpperCase(),
      name: (coin.name as string) ?? "",
      price: (coin.current_price as number) ?? 0,
      change24h: (coin.price_change_24h as number) ?? 0,
      changePct24h: (coin.price_change_percentage_24h as number) ?? 0,
      marketCap: (coin.market_cap as number) ?? 0,
      image: coin.image as string | undefined,
    }));

    // Cache all prices
    for (const p of prices) {
      await cacheCryptoPrice(p.symbol, p.price, "CAD");
    }

    return prices;
  } catch {
    return [];
  }
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
      `/coins/${coinId}/market_chart?vs_currency=cad&days=${days}`
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
  const today = new Date().toISOString().split("T")[0];

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
      await db.update(schema.priceCache)
        .set({ price, currency })
        .where(eq(schema.priceCache.id, existing.id))
        .run();
    } else {
      await db.insert(schema.priceCache)
        .values({ symbol: cacheSymbol, date: today, price, currency })
        .run();
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
