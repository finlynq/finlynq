import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and, isNotNull, sql, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { fetchMultipleQuotes, aggregatePortfolioExposure, getEtfRegionBreakdown, getEtfSectorBreakdown, getEtfTopHoldings, getAvailableEtfSymbols, autoSeedEtfIfMissing } from "@/lib/price-service";
import { getCryptoPrices, symbolToCoinGeckoId } from "@/lib/crypto-service";
import { getLatestFxRate, convertCurrency, getDisplayCurrency, getRate } from "@/lib/fx-service";
import { isSupportedCurrency, isMetalCurrency } from "@/lib/fx/supported-currencies";
import { requireAuth } from "@/lib/auth/require-auth";
import { getDEK } from "@/lib/crypto/dek-cache";
import { decryptNamedRows } from "@/lib/crypto/encrypted-columns";
import { resolveDividendsCategoryId } from "@/lib/dividends-category";

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
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, sessionId } = auth.context;
  const dek = sessionId ? getDEK(sessionId) : null;
  const displayCurrency = await getDisplayCurrency(userId, request.nextUrl.searchParams.get("currency"));
  const todayDate = new Date().toISOString().split("T")[0];

  // Active currencies — used to recognize user-defined currency codes (XAU
  // etc.) as cash positions when they appear as a holding's symbol.
  const activeRow = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(and(eq(schema.settings.key, "active_currencies"), eq(schema.settings.userId, userId)))
    .limit(1);
  let activeCurrencies: string[] = [];
  if (activeRow[0]?.value) {
    try {
      const parsed = JSON.parse(activeRow[0].value);
      if (Array.isArray(parsed)) activeCurrencies = parsed.map((s: string) => s.toUpperCase());
    } catch { /* fall through */ }
  }
  const isCurrencyCodeSymbol = (sym: string | null | undefined): boolean => {
    if (!sym) return false;
    const s = sym.trim().toUpperCase();
    return /^[A-Z]{3,4}$/.test(s) && (isSupportedCurrency(s) || activeCurrencies.includes(s));
  };

  // 1. Get all holdings with account info. Stream D: pull the *_ct columns
  // alongside plaintext; decrypt in-memory before any name/symbol lookup.
  const rawHoldings = await db
    .select({
      id: schema.portfolioHoldings.id,
      accountId: schema.portfolioHoldings.accountId,
      accountName: schema.accounts.name,
      accountNameCt: schema.accounts.nameCt,
      name: schema.portfolioHoldings.name,
      nameCt: schema.portfolioHoldings.nameCt,
      symbol: schema.portfolioHoldings.symbol,
      symbolCt: schema.portfolioHoldings.symbolCt,
      currency: schema.portfolioHoldings.currency,
      isCrypto: schema.portfolioHoldings.isCrypto,
      note: schema.portfolioHoldings.note,
    })
    .from(schema.portfolioHoldings)
    .leftJoin(schema.accounts, eq(schema.portfolioHoldings.accountId, schema.accounts.id))
    .where(eq(schema.portfolioHoldings.userId, userId));
  const holdings = decryptNamedRows(rawHoldings, dek, {
    nameCt: "name",
    symbolCt: "symbol",
    accountNameCt: "accountName",
  });

  // 2. Classify holdings.
  //
  // Cash includes truly-empty-symbol rows AND rows whose symbol IS itself
  // a currency code (USD, CAD, EUR, XAU, …). Without the second branch,
  // a holding with symbol="CAD" was being looked up as a stock on Yahoo —
  // Yahoo happens to return data for some unrelated ticker named CAD,
  // surfaced as a fake "$95.88" price + Stocks badge in the UI.
  const cryptoHoldings = holdings.filter(h => {
    if (h.isCrypto === 1) return true;
    return h.symbol ? isCryptoSymbol(h.symbol) : false;
  });
  const nonCryptoWithSymbol = holdings.filter(h => {
    if (h.isCrypto === 1) return false;
    if (!h.symbol) return false;
    if (isCryptoSymbol(h.symbol)) return false;
    if (isCurrencyCodeSymbol(h.symbol)) return false; // cash, not a stock
    return true;
  });
  const cashHoldings = holdings.filter(h => {
    if (h.isCrypto === 1) return false;
    if (!h.symbol) return true;
    return isCurrencyCodeSymbol(h.symbol);
  });

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

  // 5. Get FX rates for currency conversion to the display currency.
  // Triangulates through USD via getRate() so any user currency works.
  // Also pre-populate metal-symbol rates (XAU/XAG/XPT/XPD) so the cash
  // branch can compute price = symbol→holding-currency cross-rate when
  // the symbol is a metal but the holding currency is something else
  // (e.g. XAU in a USD account).
  const currencies = new Set<string>(holdings.map(h => h.currency).filter(Boolean));
  for (const h of holdings) {
    if (h.symbol) {
      const symU = h.symbol.toUpperCase();
      if (isMetalCurrency(symU)) currencies.add(symU);
    }
  }
  const fxRates = new Map<string, number>();
  for (const cur of currencies) {
    fxRates.set(cur, await getRate(cur, displayCurrency, todayDate, userId));
  }

  // Cross-currency-cost-basis cache: rate(entered_currency → holding_currency,
  // today). Used to normalize cost basis to the holding's own currency before
  // computing P&L. Without this, a CAD cash position held in a USD account
  // (Fidelity-CAD style) sums cost basis in USD but market value in CAD —
  // subtracting the two yields a meaningless number.
  const crossRateCache = new Map<string, number>();
  const getCrossRate = async (from: string, to: string): Promise<number> => {
    if (from === to) return 1;
    const key = `${from}->${to}`;
    if (crossRateCache.has(key)) return crossRateCache.get(key)!;
    const r = await getRate(from, to, todayDate, userId);
    crossRateCache.set(key, r);
    return r;
  };

  // 6. Aggregate transaction metrics per holding via FK + entered_currency.
  // Phase 5 cutover (2026-04-29) eliminated the orphan-fallback decrypt loop:
  // every tx now has portfolio_holding_id, the legacy text column is NULL.

  type TxAgg = {
    totalBuyQty: number;
    totalBuyAmount: number;       // in HOLDING'S currency, after FX normalization
    totalSellQty: number;
    totalSellAmount: number;      // in HOLDING'S currency
    dividendsReceived: number;    // in HOLDING'S currency
    firstPurchaseDate: string | null;
  };

  // Per-bucket pre-aggregation. Each bucket = (holdingId, enteredCurrency).
  // The classifier groups buys/sells/divs and sums entered_amount within
  // its bucket; the FX hop into holding currency happens when we merge.
  type PerCurrencyBucket = {
    enteredCurrency: string;
    totalBuyQty: number;
    totalBuyAmountInEntered: number;
    totalSellQty: number;
    totalSellAmountInEntered: number;
    dividendsInEntered: number;
    firstPurchaseDate: string | null;
  };

  // SQL aggregation: JOIN through `holding_accounts` (Section G's join table)
  // so that aggregation is keyed on (holding_id, account_id, entered_currency)
  // rather than just (portfolio_holding_id, entered_currency). Today each
  // portfolio_holdings row maps to exactly one holding_accounts pairing
  // (is_primary=true), so the result set is identical — but once Section G's
  // table is consumed by writes too, a canonical position spanning multiple
  // accounts will produce one bucket per (holding, account) here, which the
  // post-enrichment byHolding regroup later collapses into the canonical row.
  //
  // CLAUDE.md "Portfolio aggregator" — qty>0 = buy regardless of amount
  // sign. ABS(amount) covers Finlynq-native (amt<0+qty>0) and WP convention
  // (amt>0+qty>0). entered_amount uses ABS so cost basis stays positive.
  // COALESCE handles un-backfilled rows where entered_* are still NULL.
  //
  // Issue #84: dividends are classified by category_id (the user's "Dividends"
  // category), not by the legacy `qty=0 AND amount>0` heuristic. The heuristic
  // silently dropped dividend reinvestments (qty>0, amt<0) and withholding-tax
  // entries (qty=0, amt<0). When the user has no Dividends category, the
  // dividendsCategoryId is null and the CASE short-circuits to 0.
  //
  // Issue #96 (multi-currency trade pair): when a buy row (qty>0) has a
  // non-null `trade_link_id`, LEFT JOIN to its cash-leg sibling (same
  // user, same trade_link_id, qty=0 or NULL, different id). The cash
  // leg's `entered_amount` (in `entered_currency`) is the broker's actual
  // settlement at IBKR's FX rate; the stock leg's amount is the same trade
  // re-priced at Finlynq's live rate, which under-counts the spread. Use
  // the cash leg's value as the buy's cost basis when present; fall back
  // to the stock leg's own amount otherwise (legacy data, single-currency
  // trades). Buckets group on the *effective* entered_currency — for a
  // paired buy that's the cash leg's currency, for everything else (sells,
  // dividends, unpaired buys) it's the row's own currency. CLAUDE.md
  // "Portfolio aggregator" — qty>0 = buy regardless of amount sign;
  // preserved here.
  const dividendsCategoryId = await resolveDividendsCategoryId(db, userId, dek);
  // Issue #96: aliased self-join to the cash-leg sibling. Cash leg is
  // identified by (same user, same trade_link_id, qty=0 or NULL, different
  // id). When matched on a buy row (qty>0), we use the cash leg's
  // entered_amount + entered_currency as cost basis instead of the stock
  // leg's own values. The LEFT JOIN means rows without a cash-leg sibling
  // (legacy / single-currency / non-buy rows) keep their existing behavior.
  const cashLeg = alias(schema.transactions, "cash");
  const isPairedBuy = sql<boolean>`(COALESCE(${schema.transactions.quantity}, 0) > 0 AND ${cashLeg.id} IS NOT NULL)`;
  const effectiveEnteredCurrency = sql<string>`
    CASE
      WHEN ${isPairedBuy} THEN COALESCE(${cashLeg.enteredCurrency}, ${cashLeg.currency})
      ELSE COALESCE(${schema.transactions.enteredCurrency}, ${schema.transactions.currency})
    END
  `;
  const effectiveBuyAmount = sql<number>`
    CASE
      WHEN ${isPairedBuy}
        THEN ABS(COALESCE(${cashLeg.enteredAmount}, ${cashLeg.amount}))
      ELSE ABS(COALESCE(${schema.transactions.enteredAmount}, ${schema.transactions.amount}))
    END
  `;
  const fkAggRows = await db
    .select({
      portfolioHoldingId: schema.transactions.portfolioHoldingId,
      enteredCurrency: effectiveEnteredCurrency,
      totalBuyQty: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${schema.transactions.quantity}, 0) > 0 THEN ${schema.transactions.quantity} ELSE 0 END), 0)::float8`,
      totalBuyAmountInEntered: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${schema.transactions.quantity}, 0) > 0 THEN ${effectiveBuyAmount} ELSE 0 END), 0)::float8`,
      totalSellQty: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${schema.transactions.quantity}, 0) < 0 THEN ABS(${schema.transactions.quantity}) ELSE 0 END), 0)::float8`,
      totalSellAmountInEntered: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${schema.transactions.quantity}, 0) < 0 THEN ABS(COALESCE(${schema.transactions.enteredAmount}, ${schema.transactions.amount})) ELSE 0 END), 0)::float8`,
      dividendsInEntered: dividendsCategoryId !== null
        ? sql<number>`COALESCE(SUM(CASE WHEN ${schema.transactions.categoryId} = ${dividendsCategoryId} THEN COALESCE(${schema.transactions.enteredAmount}, ${schema.transactions.amount}) ELSE 0 END), 0)::float8`
        : sql<number>`0::float8`,
      firstPurchaseDate: sql<string | null>`MIN(CASE WHEN COALESCE(${schema.transactions.quantity}, 0) > 0 THEN ${schema.transactions.date} END)`,
    })
    .from(schema.transactions)
    .innerJoin(
      schema.holdingAccounts,
      and(
        eq(schema.holdingAccounts.holdingId, schema.transactions.portfolioHoldingId),
        eq(schema.holdingAccounts.accountId, schema.transactions.accountId),
        eq(schema.holdingAccounts.userId, userId),
      ),
    )
    .leftJoin(
      cashLeg,
      and(
        eq(cashLeg.userId, userId),
        isNotNull(cashLeg.tradeLinkId),
        isNotNull(schema.transactions.tradeLinkId),
        eq(cashLeg.tradeLinkId, schema.transactions.tradeLinkId),
        ne(cashLeg.id, schema.transactions.id),
        eq(sql`COALESCE(${cashLeg.quantity}, 0)`, 0),
      ),
    )
    .where(and(
      eq(schema.transactions.userId, userId),
      isNotNull(schema.transactions.portfolioHoldingId),
    ))
    .groupBy(
      schema.transactions.portfolioHoldingId,
      effectiveEnteredCurrency,
    );

  const bucketsById = new Map<number, PerCurrencyBucket[]>();
  for (const r of fkAggRows) {
    if (r.portfolioHoldingId == null) continue;
    const arr = bucketsById.get(r.portfolioHoldingId) ?? [];
    arr.push({
      enteredCurrency: String(r.enteredCurrency || "").toUpperCase() || displayCurrency,
      totalBuyQty: Number(r.totalBuyQty),
      totalBuyAmountInEntered: Number(r.totalBuyAmountInEntered),
      totalSellQty: Number(r.totalSellQty),
      totalSellAmountInEntered: Number(r.totalSellAmountInEntered),
      dividendsInEntered: Number(r.dividendsInEntered),
      firstPurchaseDate: r.firstPurchaseDate,
    });
    bucketsById.set(r.portfolioHoldingId, arr);
  }

  // Collapse per-holding buckets into a TxAgg expressed in the holding's
  // own currency. Cross-currency buckets are converted via today's FX
  // rate. Same-currency buckets pass through directly.
  const aggInHoldingCurrency = async (
    buckets: PerCurrencyBucket[],
    holdingCurrency: string,
  ): Promise<TxAgg> => {
    const out: TxAgg = {
      totalBuyQty: 0,
      totalBuyAmount: 0,
      totalSellQty: 0,
      totalSellAmount: 0,
      dividendsReceived: 0,
      firstPurchaseDate: null,
    };
    for (const b of buckets) {
      const fx = await getCrossRate(b.enteredCurrency, holdingCurrency);
      out.totalBuyQty += b.totalBuyQty;
      out.totalBuyAmount += b.totalBuyAmountInEntered * fx;
      out.totalSellQty += b.totalSellQty;
      out.totalSellAmount += b.totalSellAmountInEntered * fx;
      out.dividendsReceived += b.dividendsInEntered * fx;
      if (b.firstPurchaseDate) {
        if (!out.firstPurchaseDate || b.firstPurchaseDate < out.firstPurchaseDate) {
          out.firstPurchaseDate = b.firstPurchaseDate;
        }
      }
    }
    return out;
  };

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
  // Compute derived metrics from a TxAgg → TxMetrics.
  const toMetrics = (a: TxAgg): TxMetrics => {
    const buyQty = a.totalBuyQty;
    const buyAmt = a.totalBuyAmount;
    const sellQty = a.totalSellQty;
    const sellAmt = a.totalSellAmount;
    const divs = a.dividendsReceived;
    const avgCost = buyQty > 0 ? buyAmt / buyQty : null;
    const remainingQty = buyQty - sellQty;
    const costBasis = avgCost !== null && remainingQty > 0 ? remainingQty * avgCost : null;
    const realizedGain = avgCost !== null ? sellAmt - (sellQty * avgCost) : 0;
    const fpDate = a.firstPurchaseDate ?? null;
    const daysHeld = fpDate
      ? Math.floor((today.getTime() - new Date(fpDate).getTime()) / 86400000)
      : null;
    return {
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
    };
  };

  // Pre-compute the quote currency for each holding — the currency that
  // marketValue (price × quantity) will be in once we enrich. Cost basis
  // MUST be normalized to this currency so unrealizedGain = marketValue −
  // costBasis is dimensionally consistent. Crypto's quote is "CAD" (the
  // crypto-service quirk); cash uses the symbol; stocks use Yahoo's q.currency.
  const quoteCurrencyById = new Map<number, string>();
  for (const h of holdings) {
    const isCryptoH = h.isCrypto === 1 || (h.symbol ? isCryptoSymbol(h.symbol) : false);
    const symbolIsCurrencyH = isCurrencyCodeSymbol(h.symbol);
    let qc = h.currency;
    if (isCryptoH) qc = "CAD";
    else if (symbolIsCurrencyH && h.symbol) {
      const symU = h.symbol.toUpperCase();
      // Metals (XAU/XAG/XPT/XPD) are tradeable units priced in the holding's
      // currency, not unit currencies — quote them in h.currency so 6.9 oz
      // shows as USD 32,287, not XAU 6.90. Fiat-cash positions (USD cash in
      // a CAD account, etc.) keep the symbol as quote so the user sees the
      // actual currency they hold.
      qc = isMetalCurrency(symU) ? h.currency : symU;
    }
    else if (h.symbol) {
      const q = quotes.get(h.symbol);
      if (q?.currency) qc = q.currency;
    }
    quoteCurrencyById.set(h.id, qc);
  }

  // Backfill fxRates with any quote currencies not already covered (crypto
  // returns "CAD" even when h.currency is USD; Yahoo may return a quote
  // currency that doesn't match the holding's row currency).
  for (const qc of new Set(quoteCurrencyById.values())) {
    if (qc && !fxRates.has(qc)) {
      fxRates.set(qc, await getRate(qc, displayCurrency, todayDate, userId));
    }
  }

  // Reduce per-currency buckets into a single TxMetrics keyed by holding id.
  // Cost basis normalized to the holding's quote currency via FX before
  // summing — fixes the cross-currency P&L bug for cash-as-currency
  // positions.
  const metricsByHoldingId = new Map<number, TxMetrics>();
  for (const h of holdings) {
    const fkBuckets = bucketsById.get(h.id);
    if (!fkBuckets) continue;
    const targetCcy = quoteCurrencyById.get(h.id) ?? h.currency;
    const fkAgg = await aggInHoldingCurrency(fkBuckets, targetCcy);
    metricsByHoldingId.set(h.id, toMetrics(fkAgg));
  }

  // 6c. Auto-seed any ETF symbols not yet in the shared ETF database
  for (const h of nonCryptoWithSymbol) {
    if (h.symbol) autoSeedEtfIfMissing(h.symbol);
  }

  // 7. Build enriched holdings
  type AssetType = "etf" | "stock" | "crypto" | "cash";

  const enrichedHoldings = holdings.map(h => {
    const isCrypto = h.isCrypto === 1 || (h.symbol ? isCryptoSymbol(h.symbol) : false);
    const symbolIsCurrency = isCurrencyCodeSymbol(h.symbol);
    const isEtf = h.symbol && !symbolIsCurrency ? (getEtfRegionBreakdown(h.symbol) !== null) : false;

    let assetType: AssetType = "cash";
    if (isCrypto) assetType = "crypto";
    else if (!h.symbol || symbolIsCurrency) assetType = "cash";
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
    } else if (h.symbol && !symbolIsCurrency) {
      // Stocks/ETFs only — currency-code symbols skip Yahoo to avoid
      // matching unrelated tickers (Yahoo has stocks under CAD, USD, etc.).
      const q = quotes.get(h.symbol);
      if (q) {
        price = q.price;
        change = q.change;
        changePct = q.changePct ? Math.round(q.changePct * 100) / 100 : null;
        quoteCurrency = q.currency;
      }
    }

    // Get quantity and cost metrics from transactions. FK-keyed lookup —
    // independent of holding name, so renames don't orphan transactions.
    const txData = metricsByHoldingId.get(h.id) ?? null;
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
    let marketValueDisplay: number | null = null;
    if (price !== null && quantity !== null && quantity !== 0) {
      marketValue = price * quantity;
      const fxRate = fxRates.get(quoteCurrency ?? h.currency) ?? 1;
      marketValueDisplay = convertCurrency(marketValue, fxRate);
    } else if (price === null && (symbolIsCurrency || !h.symbol) && h.isCrypto !== 1 && quantity !== null && quantity !== 0) {
      // Cash position: either no symbol OR symbol is itself a currency code
      // (USD, CAD, XAU, …). The price = 1 in the holding's own currency
      // (one CAD is one CAD), AND the value converted to the display
      // currency = quantity × FX-rate(holding-currency → display-currency).
      // The "Price" column should show "$1.00 CAD" not "US$95.88" — so
      // quoteCurrency is the holding's own currency, not the display target.
      //
      // Exception: a metal symbol (XAU/XAG/XPT/XPD) on a holding whose
      // currency is something else means the symbol is a tradeable unit
      // priced in h.currency. Compute price as the cross-rate so e.g. 6.9
      // oz of gold in a USD account shows as $4679/oz × 6.9 = $32,287 USD,
      // not "1.00 XAU × 6.90 = 6.90 XAU".
      const symU = h.symbol ? h.symbol.toUpperCase() : null;
      const ccU = h.currency.toUpperCase();
      if (symU && isMetalCurrency(symU) && symU !== ccU) {
        const symInDisplay = fxRates.get(symU) ?? 0;
        const ccInDisplay = fxRates.get(h.currency) ?? 0;
        if (symInDisplay > 0 && ccInDisplay > 0) {
          const priceInHoldingCcy = symInDisplay / ccInDisplay;
          price = priceInHoldingCcy;
          quoteCurrency = h.currency;
          marketValue = quantity * priceInHoldingCcy; // in h.currency
          marketValueDisplay = quantity * symInDisplay; // in displayCurrency
        }
      } else {
        const cashCurrency = symbolIsCurrency ? h.symbol!.toUpperCase() : h.currency;
        const fxRate = fxRates.get(cashCurrency) ?? 1;
        price = 1;
        quoteCurrency = cashCurrency;
        marketValue = quantity; // in cashCurrency
        marketValueDisplay = quantity * fxRate; // in displayCurrency despite the legacy field name
      }
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
    const unrealizedGainDisplay = unrealizedGain !== null ? convertCurrency(unrealizedGain, fxRate) : null;

    // Total return: unrealized + realized + dividends
    const totalReturn = unrealizedGain !== null || realizedGain !== null || dividendsReceived !== null
      ? ((unrealizedGain ?? 0) + (realizedGain ?? 0) + (dividendsReceived ?? 0))
      : null;
    const totalReturnDisplay = totalReturn !== null ? convertCurrency(totalReturn, fxRate) : null;
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
      marketValueDisplay,
      unrealizedGain,
      unrealizedGainPct,
      unrealizedGainDisplay,
      realizedGain,
      dividendsReceived,
      totalReturn,
      totalReturnDisplay,
      totalReturnPct,
      firstPurchaseDate,
      daysHeld,
    };
  });

  // 8. Compute summaries
  const totalValueDisplay = enrichedHoldings.reduce((s, h) => s + (h.marketValueDisplay ?? 0), 0);
  const hasQuantityData = enrichedHoldings.some(h => h.quantity !== null && h.quantity !== 0);

  // Day change: weighted sum of changePct across holdings with known values
  const holdingsWithChange = enrichedHoldings.filter(h => h.changePct !== null && h.marketValueDisplay !== null);
  const totalDayChangeDisplay = holdingsWithChange.reduce((s, h) => {
    const fxRate = fxRates.get(h.quoteCurrency ?? h.currency) ?? 1;
    const changeAmt = (h.change ?? 0) * (h.quantity ?? 1);
    return s + convertCurrency(changeAmt, fxRate);
  }, 0);
  const totalDayChangePct = totalValueDisplay > 0
    ? (totalDayChangeDisplay / (totalValueDisplay - totalDayChangeDisplay)) * 100
    : 0;

  // Investment P&L summaries
  const holdingsWithMetrics = enrichedHoldings.filter(h => h.quantity !== null && h.quantity !== 0);
  const totalCostBasisDisplay = holdingsWithMetrics.reduce((s, h) => {
    if (h.totalCostBasis === null) return s;
    const fxRate = fxRates.get(h.quoteCurrency ?? h.currency) ?? 1;
    return s + convertCurrency(h.totalCostBasis, fxRate);
  }, 0);
  const totalUnrealizedGainDisplay = holdingsWithMetrics.reduce((s, h) => s + (h.unrealizedGainDisplay ?? 0), 0);
  const totalUnrealizedGainPct = totalCostBasisDisplay > 0
    ? (totalUnrealizedGainDisplay / totalCostBasisDisplay) * 100
    : 0;
  const totalRealizedGainDisplay = holdingsWithMetrics.reduce((s, h) => {
    if (h.realizedGain === null) return s;
    const fxRate = fxRates.get(h.quoteCurrency ?? h.currency) ?? 1;
    return s + convertCurrency(h.realizedGain, fxRate);
  }, 0);
  const totalDividendsDisplay = holdingsWithMetrics.reduce((s, h) => {
    if (h.dividendsReceived === null) return s;
    const fxRate = fxRates.get(h.quoteCurrency ?? h.currency) ?? 1;
    return s + convertCurrency(h.dividendsReceived, fxRate);
  }, 0);
  const totalReturnDisplay = totalUnrealizedGainDisplay + totalRealizedGainDisplay + totalDividendsDisplay;
  const lifetimeCostBasisDisplay = holdingsWithMetrics.reduce((s, h) => {
    if (h.lifetimeCostBasis === null) return s;
    const fxRate = fxRates.get(h.quoteCurrency ?? h.currency) ?? 1;
    return s + convertCurrency(h.lifetimeCostBasis, fxRate);
  }, 0);
  const totalReturnPct = lifetimeCostBasisDisplay > 0 ? (totalReturnDisplay / lifetimeCostBasisDisplay) * 100 : 0;

  // Asset type breakdown
  const byType: Record<AssetType, { count: number; value: number }> = {
    etf: { count: 0, value: 0 },
    stock: { count: 0, value: 0 },
    crypto: { count: 0, value: 0 },
    cash: { count: 0, value: 0 },
  };
  for (const h of enrichedHoldings) {
    byType[h.assetType].count++;
    byType[h.assetType].value += h.marketValueDisplay ?? 0;
  }

  // By-account breakdown
  const byAccount = new Map<string, { count: number; value: number }>();
  for (const h of enrichedHoldings) {
    const acc = h.accountName;
    const existing = byAccount.get(acc) ?? { count: 0, value: 0 };
    existing.count++;
    existing.value += h.marketValueDisplay ?? 0;
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
    const value = h.marketValueDisplay ?? 0;
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
      effectiveValueDisplay: Math.round(s.effectiveWeight * 100) / 100,
      effectiveWeight: etfTotalValue > 0
        ? Math.round((s.effectiveWeight / etfTotalValue) * 1000) / 10
        : 0,
    }))
    .sort((a, b) => b.effectiveWeight - a.effectiveWeight);

  // Add "Other / Remaining" bucket so weights sum to 100%
  const namedTotalPct = namedStocks.reduce((s, x) => s + x.effectiveWeight, 0);
  const remainingPct = Math.round((100 - namedTotalPct) * 10) / 10;
  const remainingValueDisplay = etfTotalValue > 0
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
          effectiveValueDisplay: remainingValueDisplay,
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
    pctOfPortfolio: totalValueDisplay > 0 && h.marketValueDisplay != null
      ? Math.round((h.marketValueDisplay / totalValueDisplay) * 10000) / 100
      : null,
  }));

  // 11. By-holding aggregation — same financial position pooled across the
  // accounts that hold it. Issue #25 (Section F) interim path (a):
  // re-group `enrichedHoldings` by canonical key post-enrichment. The
  // SQL-side join through `holding_accounts` (path (b)) is a follow-up;
  // until canonical-name backfill ships, key on (assetType, symbol/currency)
  // so user-edited free-text names don't fragment the same ticker into
  // multiple rows.
  type ByHoldingKey = { key: string; symbol: string | null; name: string };
  const canonicalKey = (h: typeof enrichedHoldings[number]): ByHoldingKey => {
    if (h.assetType === "crypto" && h.symbol) {
      // Decision (issue #25, 2026-05-01): preserve the FULL crypto symbol.
      // BTC-ETH is a distinct holding from BTC; do NOT collapse on `-`.
      const sym = h.symbol.toUpperCase();
      return { key: `crypto:${sym}`, symbol: sym, name: sym };
    }
    if (h.assetType === "stock" || h.assetType === "etf") {
      if (h.symbol) {
        const sym = h.symbol.toUpperCase();
        return { key: `eq:${sym}`, symbol: sym, name: sym };
      }
    }
    if (h.assetType === "cash") {
      if (h.symbol) {
        const symU = h.symbol.toUpperCase();
        // Metal sleeves (XAU/XAG/XPT/XPD) are universal regardless of the
        // account's holding currency — XAU in a CAD account and XAU in a
        // USD account hold the same ounces of gold.
        if (isMetalCurrency(symU)) {
          return { key: `metal:${symU}`, symbol: symU, name: symU };
        }
        // Currency-code symbol → cash sleeve in that currency.
        return { key: `cash:${symU}`, symbol: symU, name: `Cash ${symU}` };
      }
      // No symbol → cash in the holding's own row currency.
      const cur = h.currency.toUpperCase();
      return { key: `cash:${cur}`, symbol: cur, name: `Cash ${cur}` };
    }
    // User-defined fallback (no symbol, non-cash) — fragment by name. After
    // the canonicalization helper has run for this user, these rows still
    // collapse on (lowercased) free-text name within a user's portfolio.
    return { key: `custom:${(h.name || "?").trim().toLowerCase()}`, symbol: null, name: h.name || "?" };
  };

  type ByHoldingAccum = {
    key: string;
    symbol: string | null;
    name: string;
    assetType: AssetType;
    totalQty: number;
    costBasisDisplay: number;
    lifetimeCostBasisDisplay: number;
    marketValueDisplay: number;
    unrealizedGainDisplay: number;
    realizedGainDisplay: number;
    dividendsDisplay: number;
    accountIds: Set<number>;
    image: string | null;
    quoteCurrency: string | null;
  };

  const byHoldingMap = new Map<string, ByHoldingAccum>();
  for (const h of enrichedHoldings) {
    const ck = canonicalKey(h);
    let acc = byHoldingMap.get(ck.key);
    if (!acc) {
      acc = {
        key: ck.key,
        symbol: ck.symbol,
        name: ck.name,
        assetType: h.assetType,
        totalQty: 0,
        costBasisDisplay: 0,
        lifetimeCostBasisDisplay: 0,
        marketValueDisplay: 0,
        unrealizedGainDisplay: 0,
        realizedGainDisplay: 0,
        dividendsDisplay: 0,
        accountIds: new Set<number>(),
        image: h.image ?? null,
        quoteCurrency: h.quoteCurrency,
      };
      byHoldingMap.set(ck.key, acc);
    }
    if (h.accountId != null) acc.accountIds.add(h.accountId);
    if (h.quantity != null) acc.totalQty += h.quantity;
    acc.marketValueDisplay += h.marketValueDisplay ?? 0;
    acc.unrealizedGainDisplay += h.unrealizedGainDisplay ?? 0;

    // FX hop into displayCurrency for cost basis / realized / dividends —
    // the per-row totalCostBasis / realizedGain / dividendsReceived live in
    // the holding's quote currency. Reuse the same fxRates map the per-row
    // path uses so the rollup matches summary totals to within rounding.
    const fxRate = fxRates.get(h.quoteCurrency ?? h.currency) ?? 1;
    if (h.totalCostBasis != null) acc.costBasisDisplay += h.totalCostBasis * fxRate;
    if (h.lifetimeCostBasis != null) acc.lifetimeCostBasisDisplay += h.lifetimeCostBasis * fxRate;
    if (h.realizedGain != null) acc.realizedGainDisplay += h.realizedGain * fxRate;
    if (h.dividendsReceived != null) acc.dividendsDisplay += h.dividendsReceived * fxRate;
  }

  const byHolding = Array.from(byHoldingMap.values()).map(a => {
    // Avg cost across accounts is qty-weighted: Σ(costBasis_acct) / Σ(qty_acct).
    // Avoids the simple-mean bug when one account holds 10× more shares.
    const avgCostDisplay = a.totalQty > 0 && a.costBasisDisplay > 0
      ? a.costBasisDisplay / a.totalQty
      : null;
    const unrealizedPct = a.costBasisDisplay > 0
      ? (a.unrealizedGainDisplay / a.costBasisDisplay) * 100
      : null;
    const totalReturnDisplay = a.unrealizedGainDisplay + a.realizedGainDisplay + a.dividendsDisplay;
    const totalReturnPct = a.lifetimeCostBasisDisplay > 0
      ? (totalReturnDisplay / a.lifetimeCostBasisDisplay) * 100
      : null;
    const pctOfPortfolio = totalValueDisplay > 0
      ? Math.round((a.marketValueDisplay / totalValueDisplay) * 10000) / 100
      : null;
    return {
      key: a.key,
      symbol: a.symbol,
      name: a.name,
      assetType: a.assetType,
      totalQty: Math.round(a.totalQty * 1e6) / 1e6,
      avgCostDisplay: avgCostDisplay != null ? Math.round(avgCostDisplay * 10000) / 10000 : null,
      costBasisDisplay: Math.round(a.costBasisDisplay * 100) / 100,
      marketValueDisplay: Math.round(a.marketValueDisplay * 100) / 100,
      unrealizedGainDisplay: Math.round(a.unrealizedGainDisplay * 100) / 100,
      unrealizedGainPct: unrealizedPct != null ? Math.round(unrealizedPct * 100) / 100 : null,
      realizedGainDisplay: Math.round(a.realizedGainDisplay * 100) / 100,
      dividendsDisplay: Math.round(a.dividendsDisplay * 100) / 100,
      totalReturnDisplay: Math.round(totalReturnDisplay * 100) / 100,
      totalReturnPct: totalReturnPct != null ? Math.round(totalReturnPct * 100) / 100 : null,
      pctOfPortfolio,
      accountCount: a.accountIds.size,
      image: a.image,
    };
  }).sort((a, b) => b.marketValueDisplay - a.marketValueDisplay);

  return NextResponse.json({
    holdings: holdingsWithPct,
    byHolding,
    // Currency the totals + marketValueDisplay field are denominated in. The
    // field name kept its legacy "CAD" suffix for compat; the value is in
    // displayCurrency. Format with this on the client to avoid mislabeling.
    displayCurrency,
    summary: {
      totalHoldings: holdings.length,
      totalAccounts: byAccount.size,
      totalValueDisplay: Math.round(totalValueDisplay * 100) / 100,
      dayChangeDisplay: Math.round(totalDayChangeDisplay * 100) / 100,
      dayChangePct: Math.round(totalDayChangePct * 100) / 100,
      hasQuantityData,
      // Investment P&L
      totalCostBasisDisplay: Math.round(totalCostBasisDisplay * 100) / 100,
      totalUnrealizedGainDisplay: Math.round(totalUnrealizedGainDisplay * 100) / 100,
      totalUnrealizedGainPct: Math.round(totalUnrealizedGainPct * 100) / 100,
      totalRealizedGainDisplay: Math.round(totalRealizedGainDisplay * 100) / 100,
      totalDividendsDisplay: Math.round(totalDividendsDisplay * 100) / 100,
      totalReturnDisplay: Math.round(totalReturnDisplay * 100) / 100,
      totalReturnPct: Math.round(totalReturnPct * 100) / 100,
    },
    byType,
    byAccount: Object.fromEntries(byAccount),
    etfXray: {
      etfCount: etfHoldings.length,
      etfTotalValueDisplay: Math.round(etfTotalValue * 100) / 100,
      etfs: etfDetails,
      regions: regionExposure,
      sectors: sectorExposure,
      aggregatedStocks,
    },
    topGainers,
    topLosers,
  });
}
