import { NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { fetchMultipleQuotes, cachePrice, aggregatePortfolioExposure } from "@/lib/price-service";

export async function GET() {
  // Get all holdings with symbols
  const holdings = db
    .select({
      id: schema.portfolioHoldings.id,
      name: schema.portfolioHoldings.name,
      symbol: schema.portfolioHoldings.symbol,
      currency: schema.portfolioHoldings.currency,
      accountName: schema.accounts.name,
    })
    .from(schema.portfolioHoldings)
    .leftJoin(schema.accounts, eq(schema.portfolioHoldings.accountId, schema.accounts.id))
    .all();

  const symbols = holdings.map((h) => h.symbol).filter(Boolean) as string[];
  const quotes = await fetchMultipleQuotes(symbols);

  // Cache prices
  for (const [symbol, quote] of quotes) {
    await cachePrice(symbol, quote.price, quote.currency);
  }

  // Build holdings with prices
  const holdingsWithPrices = holdings.map((h) => {
    const quote = h.symbol ? quotes.get(h.symbol) : null;
    return {
      ...h,
      price: quote?.price ?? null,
      change: quote?.change ?? null,
      changePct: quote?.changePct ? Math.round(quote.changePct * 100) / 100 : null,
      quoteCurrency: quote?.currency ?? null,
    };
  });

  // Calculate portfolio exposure
  const holdingsForExposure = holdingsWithPrices
    .filter((h) => h.symbol && h.price)
    .map((h) => ({ symbol: h.symbol!, value: h.price! }));
  const exposure = aggregatePortfolioExposure(holdingsForExposure);

  return NextResponse.json({ holdings: holdingsWithPrices, exposure });
}
