import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { fetchMultipleQuotes, cachePrice, aggregatePortfolioExposure } from "@/lib/price-service";
import { requireAuth } from "@/lib/auth/require-auth";
import { decryptNamedRows } from "@/lib/crypto/encrypted-columns";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  // Stream D Phase 4 — plaintext columns dropped; read ct + decrypt.
  const rawHoldings = await db
    .select({
      id: schema.portfolioHoldings.id,
      nameCt: schema.portfolioHoldings.nameCt,
      symbolCt: schema.portfolioHoldings.symbolCt,
      currency: schema.portfolioHoldings.currency,
      accountNameCt: schema.accounts.nameCt,
    })
    .from(schema.portfolioHoldings)
    .leftJoin(schema.accounts, eq(schema.portfolioHoldings.accountId, schema.accounts.id))
    .where(eq(schema.portfolioHoldings.userId, userId))
    .all();
  const holdings = decryptNamedRows(rawHoldings, auth.context.dek, {
    nameCt: "name",
    symbolCt: "symbol",
    accountNameCt: "accountName",
  }) as Array<typeof rawHoldings[number] & { name: string | null; symbol: string | null; accountName: string | null }>;

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
