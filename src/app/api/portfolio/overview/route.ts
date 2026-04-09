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
    const base = String(h.symbol).toUpperCase().split("-")[0];
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

  // 6. Get detailed transaction metrics per holding (average cost method)
  const txDetails = await db
    .select({
      portfolioHolding: schema.transactions.portfolioHolding,
      // Buys: negative amounts, positive quantity
      totalBuyQty: sql<number>`COALESCE(SUM(CASE WHEN ${schema.transactions.amount} < 0 THEN ${schema.transactions.quantity} ELSE 0 END), 0)`,
      totalBuyAmount: sql<number>`COALESCE(SUM(CASE WHEN ${schema.transactions.amount} < 0 THEN ABS(${schema.transactions.amount}) ELSE 0 END), 0)`,
      // Sells: positive amounts, negative quantity
      totalSellQty: sql<number>`COALESCE(SUM(CASE WHEN ${schema.transactions.amount} > 0 AND ${schema.transactions.quantity} < 0 THEN ABS(${schema.transactions.quantity}) ELSE 0 END), 0)`,
      totalSellAmount: sql<number>`COALESCE(SUM(CASE WHEN ${schema.transactions.amount} > 0 AND ${schema.transactions.quantity} < 0 THEN ${schema.transactions.amount} ELSE 0 END), 0)`,
      // Dividends: positive amounts with zero/null quantity
      dividendsReceived: sql<number>`COALESCE(SUM(CASE WHEN ${schema.transactions.amount} > 0 AND (${schema.transactions.quantity} = 0 OR ${schema.transactions.quantity} IS NULL) THEN ${schema.transactions.amount} ELSE 0 END), 0)`,
      // Date tracking
      firstPurchaseDate: sql<string>`MIN(CASE WHEN ${schema.transactions.amount} < 0 THEN ${schema.transactions.date} ELSE NULL END)`,
    })
    .from(schema.transactions)
    .where(and(isNotNull(schema.transactions.portfolioHolding), eq(schema.transactions.userId, userId)))
    .groupBy(schema.transactions.portfolioHolding)
    .all();

  type TxMetrics = {
    qty: number;
    totalBuyQty: number;
    totalBuyAmount: number;
    totalSellQty: number;
    totalSellAmount: number;
    avgCostPerShare: number | null;
    totalCostBasis: number | null;   // remaining cost basis
    lifetimeCostBasis: number;       // total ever invested
    realizedGain: number;
    dividendsReceived: number;
    firstPurchaseDate: string | null;
    daysHeld: number | null;
  };

  const today = new Date();
  const qtyMap = new Map<string, TxMetrics>();
  for (const t of txDetails) {
    if (!t.portfolioHolding) continue;
    const buyQty = Number(t.totalBuyQty);
    const buyAmt = Number(t.totalBuyAmount);
    const sellQty = Number(t.totalSellQty);
    const sellAmt = Number(t.totalSellAmount);
    const divs = Number(t.dividendsReceived);

    const avgCost = buyQty > 0 ? buyAmt / buyQty : null;
    const remainingQty = buyQty - sellQty;
    const costBasis = avgCost !== null && remainingQty > 0 ? remainingQty * avgCost : null;
    const realizedGain = avgCost !== null ? sellAmt - (sellQty * avgCost) : 0;

    const fpDate = t.firstPurchaseDate ?? null;
    const daysHeld = fpDate
      ? Math.floor((today.getTime() - new Date(fpDate).getTime()) / 86400000)
      : null;

    qtyMap.set(t.portfolioHolding, {
      qty: remainingQty,
      totalBuyQty: buyQty,
      totalBuyAmount: buyAmt,
      totalSellQty: sellQty,
      totalSellAmount: sellAmt,
      avgCostPerShare: avgCost,
      totalCostBasis: costBasis,
      lifetimeCostBasis: buyAmt,
      realizedGain,
      dividendsReceived: divs,
      firstPurchaseDate: fpDate,
      daysHeld,
    });
  }

  // 6b. Add synthetic entries for investment transactions whose portfolioHolding
  //     name doesn't match any registered portfolioHoldings entry (quantity != 0)
  const registeredNames = new Set(holdings.map((h) => h.name));
  const orphanSymbols: string[] = [];
  for (const t of txDetails) {
    const totalQty = (t.totalBuyQty ?? 0) - (t.totalSellQty ?? 0);
    if (t.portfolioHolding && !registeredNames.has(t.portfolioHolding) && totalQty !== 0) {
      orphanSymbols.push(t.portfolioHolding);
      registeredNames.add(t.portfolioHolding);
    }
  }
  // Fetch prices for orphan symbols separately
  const orphanQuotes = orphanSymbols.length > 0 ? await fetchMultipleQuotes(orphanSymbols) : new Map();

  // 6c. Auto-seed any ETF symbols not yet in the shared ETF database
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
      const base = String(h.symbol).toUpperCase().split("-")[0];
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

    // Get quantity and cost metrics from transactions
    const txData = h.name ? qtyMap.get(h.name) : null;
    const quantity = txData?.qty ?? null;
    const avgCostPerShare = txData?.avgCostPerShare ?? null;
    const totalCostBasis = txData?.totalCostBasis ?? null;
    const lifetimeCostBasis = txData?.lifetimeCostBasis ?? null;
    const realizedGain = txData?.realizedGain ?? null;
    const dividendsReceived = txData?.dividendsReceived ?? null;
    const firstPurchaseDate = txData?.firstPurchaseDate ?? null;
    const daysHeld = txData?.daysHeld ?? null;

    // Calculate market value
    let marketValue: number | null = null;
    let marketValueCAD: number | null = null;
    if (price !== null && quantity !== null && quantity !== 0) {
      marketValue = price * quantity;
      const fxRate = fxRates.get(quoteCurrency ?? h.currency) ?? 1;
      marketValueCAD = convertCurrency(marketValue, fxRate);
    } else if (price !== null && !quantity) {
      // No quantity data — show price as informational only
      marketValue = price;
      const fxRate = fxRates.get(quoteCurrency ?? h.currency) ?? 1;
      marketValueCAD = convertCurrency(price, fxRate);
    }

    // Compute unrealized gain using remaining cost basis
    const fxRate = fxRates.get(quoteCurrency ?? h.currency) ?? 1;
    let unrealizedGain: number | null = null;
    let unrealizedGainPct: number | null = null;
    if (marketValue !== null && totalCostBasis !== null && quantity !== null && quantity !== 0) {
      unrealizedGain = marketValue - totalCostBasis;
      unrealizedGainPct = totalCostBasis > 0 ? (unrealizedGain / totalCostBasis) * 100 : null;
    }

    // CAD-converted unrealized for summaries
    const unrealizedGainCAD = unrealizedGain !== null ? convertCurrency(unrealizedGain, fxRate) : null;

    // Total return: unrealized + realized + dividends
    const totalReturn = unrealizedGain !== null || realizedGain !== null || dividendsReceived !== null
      ? ((unrealizedGain ?? 0) + (realizedGain ?? 0) + (dividendsReceived ?? 0))
      : null;
    const totalReturnCAD = totalReturn !== null ? convertCurrency(totalReturn, fxRate) : null;
    const totalReturnPct = totalReturn !== null && lifetimeCostBasis !== null && lifetimeCostBasis > 0
      ? (totalReturn / lifetimeCostBasis) * 100
      : null;

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
      avgCostPerShare,
      totalCostBasis,
      lifetimeCostBasis,
      marketValue,
      marketValueCAD,
      unrealizedGain,
      unrealizedGainPct,
      unrealizedGainCAD,
      realizedGain,
      dividendsReceived,
      totalReturn,
      totalReturnCAD,
      totalReturnPct,
      firstPurchaseDate,
      daysHeld,
    };
  });

  // 7b. Append orphan holdings (transaction-based, not in portfolioHoldings table)
  for (const sym of orphanSymbols) {
    const txData = qtyMap.get(sym);
    if (!txData || txData.qty === 0) continue;
    const isCrypto = isCryptoSymbol(sym);
    const oq = orphanQuotes.get(sym);
    const price = oq?.price ?? null;
    const change = oq?.change ?? null;
    const changePct = oq?.changePct ? Math.round(oq.changePct * 100) / 100 : null;
    const quoteCurrency = oq?.currency ?? "CAD";
    const isEtf = getEtfRegionBreakdown(sym) !== null;
    const assetType: AssetType = isCrypto ? "crypto" : isEtf ? "etf" : "stock";
    const fxRate = fxRates.get(quoteCurrency) ?? 1;
    let marketValue: number | null = null;
    let marketValueCAD: number | null = null;
    if (price !== null && txData.qty !== 0) {
      marketValue = price * txData.qty;
      marketValueCAD = convertCurrency(marketValue, fxRate);
    }
    const unrealizedGain = marketValue !== null && txData.totalCostBasis !== null && txData.qty !== 0
      ? marketValue - txData.totalCostBasis
      : null;
    const unrealizedGainPct = unrealizedGain !== null && txData.totalCostBasis !== null && txData.totalCostBasis > 0
      ? (unrealizedGain / txData.totalCostBasis) * 100
      : null;
    const unrealizedGainCAD = unrealizedGain !== null ? convertCurrency(unrealizedGain, fxRate) : null;
    const totalReturn = unrealizedGain !== null || txData.realizedGain !== 0 || txData.dividendsReceived !== 0
      ? (unrealizedGain ?? 0) + txData.realizedGain + txData.dividendsReceived
      : null;
    const totalReturnCAD = totalReturn !== null ? convertCurrency(totalReturn, fxRate) : null;
    const totalReturnPct = totalReturn !== null && txData.lifetimeCostBasis > 0
      ? (totalReturn / txData.lifetimeCostBasis) * 100
      : null;
    enrichedHoldings.push({
      id: -1,
      accountId: null,
      accountName: "Auto-detected",
      name: sym,
      symbol: sym,
      currency: "CAD",
      assetType,
      price,
      change,
      changePct,
      quoteCurrency,
      marketCap: null,
      image: null,
      quantity: txData.qty,
      avgCostPerShare: txData.avgCostPerShare,
      totalCostBasis: txData.totalCostBasis,
      lifetimeCostBasis: txData.lifetimeCostBasis,
      marketValue,
      marketValueCAD,
      unrealizedGain,
      unrealizedGainPct,
      unrealizedGainCAD,
      realizedGain: txData.realizedGain,
      dividendsReceived: txData.dividendsReceived,
      totalReturn,
      totalReturnCAD,
      totalReturnPct,
      firstPurchaseDate: txData.firstPurchaseDate,
      daysHeld: txData.daysHeld,
    });
  }

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

  // Investment P&L summaries
  const holdingsWithMetrics = enrichedHoldings.filter(h => h.quantity !== null && h.quantity !== 0);
  const totalCostBasisCAD = holdingsWithMetrics.reduce((s, h) => {
    if (h.totalCostBasis === null) return s;
    const fxRate = fxRates.get(h.quoteCurrency ?? h.currency) ?? 1;
    return s + convertCurrency(h.totalCostBasis, fxRate);
  }, 0);
  const totalUnrealizedGainCAD = holdingsWithMetrics.reduce((s, h) => s + (h.unrealizedGainCAD ?? 0), 0);
  const totalUnrealizedGainPct = totalCostBasisCAD > 0
    ? (totalUnrealizedGainCAD / totalCostBasisCAD) * 100
    : 0;
  const totalRealizedGainCAD = holdingsWithMetrics.reduce((s, h) => {
    if (h.realizedGain === null) return s;
    const fxRate = fxRates.get(h.quoteCurrency ?? h.currency) ?? 1;
    return s + convertCurrency(h.realizedGain, fxRate);
  }, 0);
  const totalDividendsCAD = holdingsWithMetrics.reduce((s, h) => {
    if (h.dividendsReceived === null) return s;
    const fxRate = fxRates.get(h.quoteCurrency ?? h.currency) ?? 1;
    return s + convertCurrency(h.dividendsReceived, fxRate);
  }, 0);
  const totalReturnCAD = totalUnrealizedGainCAD + totalRealizedGainCAD + totalDividendsCAD;
  const lifetimeCostBasisCAD = holdingsWithMetrics.reduce((s, h) => {
    if (h.lifetimeCostBasis === null) return s;
    const fxRate = fxRates.get(h.quoteCurrency ?? h.currency) ?? 1;
    return s + convertCurrency(h.lifetimeCostBasis, fxRate);
  }, 0);
  const totalReturnPct = lifetimeCostBasisCAD > 0 ? (totalReturnCAD / lifetimeCostBasisCAD) * 100 : 0;

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

  // Add pctOfPortfolio to each holding
  const holdingsWithPct = enrichedHoldings.map(h => ({
    ...h,
    pctOfPortfolio: totalValueCAD > 0 && h.marketValueCAD != null
      ? Math.round((h.marketValueCAD / totalValueCAD) * 10000) / 100
      : null,
  }));

  return NextResponse.json({
    holdings: holdingsWithPct,
    summary: {
      totalHoldings: holdings.length,
      totalAccounts: byAccount.size,
      totalValueCAD: Math.round(totalValueCAD * 100) / 100,
      dayChangeCAD: Math.round(totalDayChangeCAD * 100) / 100,
      dayChangePct: Math.round(totalDayChangePct * 100) / 100,
      hasQuantityData,
      // Investment P&L
      totalCostBasisCAD: Math.round(totalCostBasisCAD * 100) / 100,
      totalUnrealizedGainCAD: Math.round(totalUnrealizedGainCAD * 100) / 100,
      totalUnrealizedGainPct: Math.round(totalUnrealizedGainPct * 100) / 100,
      totalRealizedGainCAD: Math.round(totalRealizedGainCAD * 100) / 100,
      totalDividendsCAD: Math.round(totalDividendsCAD * 100) / 100,
      totalReturnCAD: Math.round(totalReturnCAD * 100) / 100,
      totalReturnPct: Math.round(totalReturnPct * 100) / 100,
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
