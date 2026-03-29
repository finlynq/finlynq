import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { getCryptoPrices, symbolToCoinGeckoId } from "@/lib/crypto-service";

export async function GET() {
  try {
    // Get all crypto holdings (isCrypto = 1 or detected by symbol pattern)
    const allHoldings = db
      .select({
        id: schema.portfolioHoldings.id,
        accountId: schema.portfolioHoldings.accountId,
        accountName: schema.accounts.name,
        name: schema.portfolioHoldings.name,
        symbol: schema.portfolioHoldings.symbol,
        currency: schema.portfolioHoldings.currency,
        isCrypto: schema.portfolioHoldings.isCrypto,
        note: schema.portfolioHoldings.note,
      })
      .from(schema.portfolioHoldings)
      .leftJoin(schema.accounts, eq(schema.portfolioHoldings.accountId, schema.accounts.id))
      .all();

    // Filter to crypto holdings
    const CRYPTO_SYMBOLS = new Set([
      "BTC", "ETH", "SOL", "ADA", "XRP", "DOGE", "AAVE", "ATOM", "AVAX",
      "CRV", "FTM", "HBAR", "LINK", "LTC", "MATIC", "POL", "DOT", "XLM",
      "UNI", "YFI", "SNX", "BNB", "SHIB", "ARB", "OP", "APT", "SUI",
      "NEAR", "FIL", "ICP", "ALGO", "XTZ", "EOS", "SAND", "MANA", "AXS", "S",
    ]);

    const cryptoHoldings = allHoldings.filter((h) => {
      if (h.isCrypto === 1) return true;
      if (!h.symbol) return false;
      const base = h.symbol.toUpperCase().split("-")[0];
      return CRYPTO_SYMBOLS.has(base);
    });

    // Fetch prices from CoinGecko
    const coinGeckoIds: string[] = [];
    const symbolToId = new Map<string, string>();
    for (const h of cryptoHoldings) {
      if (!h.symbol) continue;
      const base = h.symbol.toUpperCase().split("-")[0];
      const cgId = symbolToCoinGeckoId(base);
      if (cgId && !symbolToId.has(base)) {
        symbolToId.set(base, cgId);
        coinGeckoIds.push(cgId);
      }
    }

    const prices = await getCryptoPrices(coinGeckoIds);
    const priceMap = new Map(prices.map((p) => [p.symbol.toUpperCase(), p]));

    // Enrich holdings with price data
    const enriched = cryptoHoldings.map((h) => {
      const base = h.symbol?.toUpperCase().split("-")[0] ?? "";
      const priceData = priceMap.get(base);
      return {
        ...h,
        price: priceData?.price ?? null,
        change24h: priceData?.change24h ?? null,
        changePct24h: priceData?.changePct24h ?? null,
        marketCap: priceData?.marketCap ?? null,
        image: priceData?.image ?? null,
      };
    });

    return NextResponse.json(enriched);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch crypto holdings";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, symbol, accountId, currency, note } = body;

    if (!name || !symbol) {
      return NextResponse.json({ error: "Name and symbol are required" }, { status: 400 });
    }

    const holding = db
      .insert(schema.portfolioHoldings)
      .values({
        name,
        symbol: symbol.toUpperCase(),
        accountId: accountId ?? null,
        currency: currency ?? "CAD",
        isCrypto: 1,
        note: note ?? "",
      })
      .returning()
      .get();

    return NextResponse.json(holding);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to create crypto holding";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
