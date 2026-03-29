import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import {
  getEtfTopHoldings,
  getEtfRegionBreakdown,
  getEtfSectorBreakdown,
  getAvailableEtfSymbols,
  type EtfConstituent,
} from "@/lib/price-service";
import { requireUnlock } from "@/lib/require-unlock";

export async function GET(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;

  const symbol = request.nextUrl.searchParams.get("symbol");

  // If no symbol, return all ETFs in portfolio with their breakdown availability
  if (!symbol) {
    const holdings = db
      .select({
        id: schema.portfolioHoldings.id,
        name: schema.portfolioHoldings.name,
        symbol: schema.portfolioHoldings.symbol,
        accountName: schema.accounts.name,
      })
      .from(schema.portfolioHoldings)
      .leftJoin(schema.accounts, eq(schema.portfolioHoldings.accountId, schema.accounts.id))
      .all();

    const availableSymbols = new Set(getAvailableEtfSymbols());

    const etfs = holdings
      .filter(h => h.symbol && availableSymbols.has(h.symbol))
      .map(h => {
        const topHoldings = getEtfTopHoldings(h.symbol!);
        return {
          symbol: h.symbol!,
          name: h.name,
          account: h.accountName,
          fullName: topHoldings?.fullName ?? h.name,
          totalHoldings: topHoldings?.totalHoldings ?? 0,
          hasBreakdown: true,
        };
      });

    // Deduplicate by symbol (same ETF may appear in multiple accounts)
    const seen = new Set<string>();
    const unique = etfs.filter(e => {
      if (seen.has(e.symbol)) return false;
      seen.add(e.symbol);
      return true;
    });

    return NextResponse.json({ etfs: unique });
  }

  // Return detailed breakdown for a specific ETF
  const topHoldings = getEtfTopHoldings(symbol);
  const regions = getEtfRegionBreakdown(symbol);
  const sectors = getEtfSectorBreakdown(symbol);

  if (!topHoldings) {
    return NextResponse.json(
      { error: `No breakdown data available for ${symbol}` },
      { status: 404 }
    );
  }

  // Aggregate by sector from constituents
  const constituentsBySector: Record<string, { count: number; weight: number; stocks: string[] }> = {};
  for (const c of topHoldings.constituents) {
    if (!constituentsBySector[c.sector]) {
      constituentsBySector[c.sector] = { count: 0, weight: 0, stocks: [] };
    }
    constituentsBySector[c.sector].count++;
    constituentsBySector[c.sector].weight += c.weight;
    constituentsBySector[c.sector].stocks.push(c.ticker);
  }

  // Aggregate by country from constituents
  const constituentsByCountry: Record<string, { count: number; weight: number }> = {};
  for (const c of topHoldings.constituents) {
    if (!constituentsByCountry[c.country]) {
      constituentsByCountry[c.country] = { count: 0, weight: 0 };
    }
    constituentsByCountry[c.country].count++;
    constituentsByCountry[c.country].weight += c.weight;
  }

  const topHoldingsWeight = topHoldings.constituents.reduce((s, c) => s + c.weight, 0);

  return NextResponse.json({
    symbol,
    fullName: topHoldings.fullName,
    totalHoldings: topHoldings.totalHoldings,
    topHoldingsWeight: Math.round(topHoldingsWeight * 10) / 10,
    constituents: topHoldings.constituents,
    constituentsBySector,
    constituentsByCountry,
    regions,
    sectors,
  });
}
