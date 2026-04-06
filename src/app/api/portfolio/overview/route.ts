import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, sql, and, isNotNull } from "drizzle-orm";
import { fetchMultipleQuotes, aggregatePortfolioExposure, getEtfRegionBreakdown, getEtfSectorBreakdown, getEtfTopHoldings, getAvailableEtfSymbols, autoSeedEtfIfMissing } from "@/lib/price-service";
import { getCryptoPrices, symbolToCoinGeckoId } from "@/lib/crypto-service";
import { getLatestFxRate, convertCurrency } from "@/lib/fx-service";
import { requireAuth } from "@/lib/auth/require-auth";

const CRYPTO_SYMBOLS = new Set([
  "BTC", "ETH", "SOL", "ADA", "XRP", "DOGE", "AAVE", "ATOM", "AVAX",
  "CRV", "FTM", "HBAR", "LINK", "LTC", "MATIC", "POL", "DOT", "XLM",
  "UNI", "YFI", "SNX", "BNB", "SHIB", "ARB", "OP", "APT", "SUI",
  "NEAR", "FIL", "ICP", "ALGO", "XTZ", "EOS", "SAND", "MANA", "AXS", "S",
]);

function isCryptoSymbol(symbol: string): boolean {
  const base = symbol.toUpperCase().split("-")[0];
  return CRYPTO_SYMBOLS.has(base);
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  // 1. Get all holdings with account info
  const holdings = await db
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
    .where(eq(schema.portfolioHoldings.userId, userId))
    .orderBy(schema.accounts.name, schema.portfolioHoldings.name)
    .all();

  // 2. Classify holdings
  const cryptoHoldings = holdings.filter(h => {
    if (h.isCrypto === 1) return true;
    return h.symbol ? isCryptoSymbol(h.symbol) : false;
  });
  const nonCryptoWithSymbol = holdings.filter(h => {
    if (h.isCrypto === 1) return false;
    if (!h.symbol) return false;
    return !isCryptoSymbol(h.symbol);
  });
  const cashHoldings = holdings.filter(h => !h.symbol && h.isCrypto !== 1);

  // 3. Fetch stock/ETF prices from Yahoo Finance
  const stockSymbols = nonCryptoWithSymbol.map(h => h.symbol!);
  const quotes = await fetchMultipleQuotes(stockSymbols);

  // 4. Fetch crypto prices from CoinGecko
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
  const cryptoPrices = await getCryptoPrices(coinGeckoIds);
  const cryptoPriceMap = new Map(cryptoPrices.map(p => [p.symbol.toUpperCase(), p]));

  // 5. Get FX rates for currency conversion to CAD
  const currencies = [...new Set(holdings.map(h => h.currency))];
  const fxRates = new Map<string, number>();
  for (const cur of currencies) {
    fxRates.set(cur, await getLatestFxRate(cur, "CAD", userId));
  }

  // 6. Get transaction-based quantities for each holding
  const txQuantities = await db
    .select({
      portfolioHolding: schema.transactions.portfolioHolding,
      totalQty: sql<number>`COALESCE(SUM(${schema.transactions.quantity}), 0)`,
      totalAmount: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)`,
    })
    .from(schema.transactions)
    .where(and(isNotNull(schema.transactions.portfolioHolding), eq(schema.transactions.userId, userId)))
    .groupBy(schema.transactions.portfolioHolding)
    .all();

  const qtyMap = new Map<string, { qty: number; costBasis: number }>();
  for (const t of txQuantities) {
    if (t.portfolioHolding) {
      qtyMap.set(t.portfolioHolding, {
        qty: t.totalQty,
        costBasis: Math.abs(t.totalAmount),
      });
    }
  }

  // 6b. Auto-seed any ETF symbols not yet in the shared ETF database
  for (const h of nonCryptoWithSymbol) {
    if (h.symbol) autoSeedEtfIfMissing(h.symbol);
  }

  // 7. Build enriched holdings
  type AssetType = "etf" | "stock" | "crypto" | "cash";

  const enrichedHoldings = holdings.map(h => {
    const isCrypto = h.isCrypto === 1 || (h.symbol ? isCryptoSymbol(h.symbol) : false);
    const isEtf = h.symbol ? (getEtfRegionBreakdown(h.symbol) !== null) : false;

    let assetType: AssetType = "cash";
    if (isCrypto) assetType = "crypto";
    else if (!h.symbol) assetType = "cash";
    else if (isEtf) assetType = "etf";
    else assetType = "stock";

    let price: number | null = null;
    let change: number | null = null;
    let changePct: number | null = null;
    let quoteCurrency: string | null = null;
    let marketCap: number | null = null;
    let image: string | null = null;

    if (isCrypto && h.symbol) {
      const base = h.symbol.toUpperCase().split("-")[0];
      const cp = cryptoPriceMap.get(base);
      if (cp) {
        price = cp.price;
        change = cp.change24h;
        changePct = cp.changePct24h;
        marketCap = cp.marketCap;
        image = cp.image ?? null;
        quoteCurrency = "CAD";
      }
    } else if (h.symbol) {
      const q = quotes.get(h.symbol);
      if (q) {
        price = q.price;
        change = q.change;
        changePct = q.changePct ? Math.round(q.changePct * 100) / 100 : null;
        quoteCurrency = q.currency;
      }
    }

    // Get quantity from transactions
    const txData = h.name ? qtyMap.get(h.name) : null;
    const quantity = txData?.qty ?? null;
    const costBasis = txData?.costBasis ?? null;

    // Calculate market value
    let marketValue: number | null = null;
    let marketValueCAD: number | null = null;
    if (price !== null && quantity !== null && quantity !== 0) {
      marketValue = price * quantity;
      const fxRate = fxRates.get(quoteCurrency ?? h.currency) ?? 1;
      marketValueCAD = convertCurrency(marketValue, fxRate);
    } else if (price !== null) {
      // No quantity data — just show the price as informational
      marketValue = price;
      const fxRate = fxRates.get(quoteCurrency ?? h.currency) ?? 1;
      marketValueCAD = convertCurrency(price, fxRate);
    }

    return {
      id: h.id,
      accountId: h.accountId,
      accountName: h.accountName ?? "Unknown",
      name: h.name,
      symbol: h.symbol,
      currency: h.currency,
      assetType,
      price,
      change,
      changePct,
      quoteCurrency,
      marketCap,
      image,
      quantity,
      costBasis,
      marketValue,
      marketValueCAD,
    };
  });

  // 8. Compute summaries
  const totalValueCAD = enrichedHoldings.reduce((s, h) => s + (h.marketValueCAD ?? 0), 0);
  const hasQuantityData = enrichedHoldings.some(h => h.quantity !== null && h.quantity !== 0);

  // Day change: weighted sum of changePct across holdings with known values
  const holdingsWithChange = enrichedHoldings.filter(h => h.changePct !== null && h.marketValueCAD !== null);
  const totalDayChangeCAD = holdingsWithChange.reduce((s, h) => {
    const fxRate = fxRates.get(h.quoteCurrency ?? h.currency) ?? 1;
    const changeAmt = (h.change ?? 0) * (h.quantity ?? 1);
    return s + convertCurrency(changeAmt, fxRate);
  }, 0);
  const totalDayChangePct = totalValueCAD > 0
    ? (totalDayChangeCAD / (totalValueCAD - totalDayChangeCAD)) * 100
    : 0;

  // Asset type breakdown
  const byType: Record<AssetType, { count: number; value: number }> = {
    etf: { count: 0, value: 0 },
    stock: { count: 0, value: 0 },
    crypto: { count: 0, value: 0 },
    cash: { count: 0, value: 0 },
  };
  for (const h of enrichedHoldings) {
    byType[h.assetType].count++;
    byType[h.assetType].value += h.marketValueCAD ?? 0;
  }

  // By-account breakdown
  const byAccount = new Map<string, { count: number; value: number }>();
  for (const h of enrichedHoldings) {
    const acc = h.accountName;
    const existing = byAccount.get(acc) ?? { count: 0, value: 0 };
    existing.count++;
    existing.value += h.marketValueCAD ?? 0;
    byAccount.set(acc, existing);
  }

  // 9. ETF X-Ray: region, sector, and stock-level look-through
  const etfHoldings = enrichedHoldings.filter(h => h.assetType === "etf" && h.symbol);
  const regionExposure: Record<string, number> = {};
  const sectorExposure: Record<string, number> = {};
  let etfTotalValue = 0;

  // Track per-ETF info for the combined view
  const etfDetails: {
    symbol: string;
    name: string;
    account: string;
    fullName: string;
    totalHoldings: number;
    valueCAD: number;
    weightPct: number;
  }[] = [];

  // Aggregated stock-level look-through
  const stockExposure = new Map<string, {
    ticker: string;
    name: string;
    sector: string;
    country: string;
    effectiveWeight: number; // weighted % across all ETFs
    contributingEtfs: { symbol: string; weight: number }[];
  }>();

  for (const h of etfHoldings) {
    const value = h.marketValueCAD ?? 0;
    etfTotalValue += value;

    const regions = getEtfRegionBreakdown(h.symbol!);
    if (regions) {
      for (const [region, pct] of Object.entries(regions)) {
        regionExposure[region] = (regionExposure[region] ?? 0) + (value * pct) / 100;
      }
    }
    const sectors = getEtfSectorBreakdown(h.symbol!);
    if (sectors) {
      for (const [sector, pct] of Object.entries(sectors)) {
        sectorExposure[sector] = (sectorExposure[sector] ?? 0) + (value * pct) / 100;
      }
    }

    // Stock-level constituents
    const topHoldings = getEtfTopHoldings(h.symbol!);
    if (topHoldings) {
      etfDetails.push({
        symbol: h.symbol!,
        name: h.name,
        account: h.accountName,
        fullName: topHoldings.fullName,
        totalHoldings: topHoldings.totalHoldings,
        valueCAD: value,
        weightPct: 0, // filled after we know total
      });

      for (const c of topHoldings.constituents) {
        const existing = stockExposure.get(c.ticker);
        // effectiveWeight = (ETF value / total ETF value) * stock weight in ETF
        const etfContrib = value * c.weight / 100;
        if (existing) {
          existing.effectiveWeight += etfContrib;
          existing.contributingEtfs.push({ symbol: h.symbol!, weight: c.weight });
        } else {
          stockExposure.set(c.ticker, {
            ticker: c.ticker,
            name: c.name,
            sector: c.sector,
            country: c.country,
            effectiveWeight: etfContrib,
            contributingEtfs: [{ symbol: h.symbol!, weight: c.weight }],
          });
        }
      }
    }
  }

  // Convert region/sector to percentages
  if (etfTotalValue > 0) {
    for (const k of Object.keys(regionExposure)) {
      regionExposure[k] = Math.round((regionExposure[k] / etfTotalValue) * 1000) / 10;
    }
    for (const k of Object.keys(sectorExposure)) {
      sectorExposure[k] = Math.round((sectorExposure[k] / etfTotalValue) * 1000) / 10;
    }
    // Fill ETF weight percentages
    for (const d of etfDetails) {
      d.weightPct = Math.round((d.valueCAD / etfTotalValue) * 1000) / 10;
    }
  }

  // Convert stock exposure to percentages and sort by effective weight
  const namedStocks = Array.from(stockExposure.values())
    .map(s => ({
      ...s,
      effectiveValueCAD: Math.round(s.effectiveWeight * 100) / 100,
      effectiveWeight: etfTotalValue > 0
        ? Math.round((s.effectiveWeight / etfTotalValue) * 1000) / 10
        : 0,
    }))
    .sort((a, b) => b.effectiveWeight - a.effectiveWeight);

  // Add "Other / Remaining" bucket so weights sum to 100%
  const namedTotalPct = namedStocks.reduce((s, x) => s + x.effectiveWeight, 0);
  const remainingPct = Math.round((100 - namedTotalPct) * 10) / 10;
  const remainingValueCAD = etfTotalValue > 0
    ? Math.round((etfTotalValue * remainingPct / 100) * 100) / 100
    : 0;

  const aggregatedStocks = remainingPct > 0.1
    ? [
        ...namedStocks,
        {
          ticker: "OTHER",
          name: "Other / Remaining Holdings",
          sector: "Other",
          country: "Various",
          effectiveWeight: remainingPct,
          effectiveValueCAD: remainingValueCAD,
          contributingEtfs: [] as { symbol: string; weight: number }[],
        },
      ]
    : namedStocks;

  // 10. Gainers & losers (top movers by changePct)
  const movers = enrichedHoldings
    .filter(h => h.changePct !== null && h.symbol)
    .sort((a, b) => Math.abs(b.changePct!) - Math.abs(a.changePct!));
  const topGainers = movers.filter(h => (h.changePct ?? 0) > 0).slice(0, 5);
  const topLosers = movers.filter(h => (h.changePct ?? 0) < 0).slice(0, 5);

  return NextResponse.json({
    holdings: enrichedHoldings,
    summary: {
      totalHoldings: holdings.length,
      totalAccounts: byAccount.size,
      totalValueCAD: Math.round(totalValueCAD * 100) / 100,
      dayChangeCAD: Math.round(totalDayChangeCAD * 100) / 100,
      dayChangePct: Math.round(totalDayChangePct * 100) / 100,
      hasQuantityData,
    },
    byType,
    byAccount: Object.fromEntries(byAccount),
    etfXray: {
      etfCount: etfHoldings.length,
      etfTotalValueCAD: Math.round(etfTotalValue * 100) / 100,
      etfs: etfDetails,
      regions: regionExposure,
      sectors: sectorExposure,
      aggregatedStocks,
    },
    topGainers,
    topLosers,
  });
}
