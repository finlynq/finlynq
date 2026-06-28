import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and, isNotNull, sql, ne, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { fetchMultipleQuotes, getEtfRegionBreakdown, getEtfSectorBreakdown, getEtfTopHoldings, isEtfQuoteType } from "@/lib/price-service";
import { getCryptoPrices, symbolToCoinGeckoId } from "@/lib/crypto-service";
import { getLatestFxRate, convertCurrency, getDisplayCurrency, getRate } from "@/lib/fx-service";
import { isMetalCurrency, isCryptoSymbol, isCurrencyCodeSymbol } from "@/lib/fx/supported-currencies";
import { requireAuth } from "@/lib/auth/require-auth";
import { getDEK } from "@/lib/crypto/dek-cache";
import { decryptNamedRows } from "@/lib/crypto/encrypted-columns";
import { clusterFromAssetType } from "@/lib/securities/canonical";
import { securitiesReadEnabledForUser } from "@/lib/securities/flag";
import { resolveDividendsCategoryId } from "@/lib/dividends-category";
import { cashLegSkipSql, dividendAttributionHoldingIdSql } from "@/lib/portfolio/aggregation-predicates";
import { aggregateMovers } from "@/lib/portfolio/top-movers";
import { todayISO } from "@/lib/utils/date";
import { round2 } from "@/lib/utils/number";
import { withOp } from "@/lib/diagnostics/op-context";

export function GET(request: NextRequest) {
  return withOp("GET /api/portfolio/overview", () => handleGet(request));
}

async function handleGet(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, sessionId } = auth.context;
  const dek = sessionId ? getDEK(sessionId, userId) : null;
  const displayCurrency = await getDisplayCurrency(userId, request.nextUrl.searchParams.get("currency"));
  const todayDate = todayISO();

  // Active currencies â€” used to recognize user-defined currency codes (XAU
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
  const symbolIsCash = (sym: string | null | undefined): boolean =>
    isCurrencyCodeSymbol(sym, activeCurrencies);

  // 1. Get all holdings with account info. Stream D Phase 4: plaintext
  // name/symbol/accountName columns dropped; read ciphertext only and
  // decrypt in-memory before any name/symbol lookup.
  //
  // FINLYNQ-194: LEFT JOIN `securities` via `portfolio_holdings.security_id`
  // and pull the security's own `name_ct`. This is the SINGLE source for the
  // display name across All Holdings + Top Movers + By Account once the
  // read-flip is on and the row is backfilled — a user rename in
  // /settings/investments (which writes `securities.name_ct`) then propagates
  // to every portfolio surface identically. Un-backfilled rows (security_id
  // null) / flag-off keep `securityName = null` and fall back to the legacy
  // canonicalKey/per-position-name path, so byHolding names + totals stay
  // byte-identical to today.
  const sec = alias(schema.securities, "sec");
  const rawHoldings = await db
    .select({
      id: schema.portfolioHoldings.id,
      accountId: schema.portfolioHoldings.accountId,
      accountNameCt: schema.accounts.nameCt,
      nameCt: schema.portfolioHoldings.nameCt,
      symbolCt: schema.portfolioHoldings.symbolCt,
      currency: schema.portfolioHoldings.currency,
      isCrypto: schema.portfolioHoldings.isCrypto,
      securityId: schema.portfolioHoldings.securityId,
      securityNameCt: sec.nameCt,
      // FINLYNQ-201: the security's stored asset_type — the durable, user-
      // settable ETF classification (user override > persisted Yahoo quoteType).
      // The cluster_key (NOT asset_type) is the grouping key, so this is purely
      // cosmetic and never re-clusters (canonical.ts).
      securityAssetType: sec.assetType,
      note: schema.portfolioHoldings.note,
    })
    .from(schema.portfolioHoldings)
    .leftJoin(schema.accounts, eq(schema.portfolioHoldings.accountId, schema.accounts.id))
    .leftJoin(sec, eq(schema.portfolioHoldings.securityId, sec.id))
    .where(eq(schema.portfolioHoldings.userId, userId));
  const holdings = decryptNamedRows(rawHoldings, dek, {
    nameCt: "name",
    symbolCt: "symbol",
    accountNameCt: "accountName",
    securityNameCt: "securityName",
  }) as Array<typeof rawHoldings[number] & { name: string | null; symbol: string | null; accountName: string | null; securityName: string | null }>;

  // 2. Classify holdings.
  //
  // Cash includes truly-empty-symbol rows AND rows whose symbol IS itself
  // a currency code (USD, CAD, EUR, XAU, â€¦). Without the second branch,
  // a holding with symbol="CAD" was being looked up as a stock on Yahoo â€”
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
    if (symbolIsCash(h.symbol)) return false; // cash, not a stock
    return true;
  });
  const cashHoldings = holdings.filter(h => {
    if (h.isCrypto === 1) return false;
    if (!h.symbol) return true;
    return symbolIsCash(h.symbol);
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
  // branch can compute price = symbolâ†’holding-currency cross-rate when
  // the symbol is a metal but the holding currency is something else
  // (e.g. XAU in a USD account).
  const currencies = new Set<string>(holdings.map(h => h.currency).filter(Boolean));
  for (const h of holdings) {
    if (h.symbol) {
      const symU = h.symbol.toUpperCase();
      if (isMetalCurrency(symU)) currencies.add(symU);
    }
  }
  // Crypto prices come back USD-based (legacy rows may be CAD) — make sure each
  // crypto price's own currency has a rate so the conversion below resolves even
  // when no holding is natively denominated in it.
  for (const cp of cryptoPrices) {
    if (cp.currency) currencies.add(cp.currency.toUpperCase());
  }
  const fxRates = new Map<string, number>();
  for (const cur of currencies) {
    fxRates.set(cur, await getRate(cur, displayCurrency, todayDate, userId));
  }

  // FINLYNQ-246: prior-trading-day rates (one calendar day back) for every
  // currency / metal symbol above, used to derive a DAY CHANGE for metals
  // (GC=F/SI=F/PL=F/PA=F front-month futures move daily) and foreign-currency
  // cash (the FX rate moves vs the display currency). getRate() at a past date
  // routes through fetchYahooMetalRateToUsd / the <CCY>USD=X chart, which bias
  // the lookup window backwards so a weekend/holiday resolves to the prior
  // trading day's close. Same-currency cash has rate 1 today and 1 prior, so
  // its day change stays 0 → "--" (correct), never fabricated.
  const prevDate = new Date(`${todayDate}T00:00:00Z`);
  prevDate.setUTCDate(prevDate.getUTCDate() - 1);
  const prevDateISO = prevDate.toISOString().split("T")[0];
  const prevFxRates = new Map<string, number>();
  for (const cur of currencies) {
    prevFxRates.set(cur, await getRate(cur, displayCurrency, prevDateISO, userId));
  }

  // Cross-currency-cost-basis cache: rate(entered_currency â†’ holding_currency,
  // today). Used to normalize cost basis to the holding's own currency before
  // computing P&L. Without this, a CAD cash position held in a USD account
  // (Fidelity-CAD style) sums cost basis in USD but market value in CAD â€”
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
    netQty: number;               // UNSKIPPED Σ(quantity) — position qty (see below)
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
    delta: number;                // UNSKIPPED Σ(quantity) in this bucket
    dividendsInEntered: number;
    firstPurchaseDate: string | null;
  };

  // SQL aggregation: JOIN through `holding_accounts` (Section G's join table)
  // so that aggregation is keyed on (holding_id, account_id, entered_currency)
  // rather than just (portfolio_holding_id, entered_currency). Today each
  // portfolio_holdings row maps to exactly one holding_accounts pairing
  // (is_primary=true), so the result set is identical â€” but once Section G's
  // table is consumed by writes too, a canonical position spanning multiple
  // accounts will produce one bucket per (holding, account) here, which the
  // post-enrichment byHolding regroup later collapses into the canonical row.
  //
  // CLAUDE.md "Portfolio aggregator" â€” qty>0 = buy regardless of amount
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
  // trades). Buckets group on the *effective* entered_currency â€” for a
  // paired buy that's the cash leg's currency, for everything else (sells,
  // dividends, unpaired buys) it's the row's own currency. CLAUDE.md
  // "Portfolio aggregator" â€” qty>0 = buy regardless of amount sign;
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
  // Issue #128 (Phase 2 update, 2026-05-26): exclude paired cash-leg rows from
  // BOTH the buy- and sell-side aggregations. Under the Phase 2 sign convention
  // (2026-05-25), `buy_cash_leg` / `sell_cash_leg` rows on the cash sleeve carry
  // non-zero amount + non-zero quantity, so the original predicate
  // `tradeLinkId IS NOT NULL AND amount = 0` no longer matches them. Without
  // this fix, the cash sleeve's realized-gain calc picks up phantom buys
  // (sell_cash_leg qty>0) and phantom sells (buy_cash_leg qty<0). The predicate
  // is a union of the explicit `kind` discriminator (Phase 2+) and the legacy
  // `amount=0` fallback for un-tagged pre-migration rows. FINLYNQ-106: this is
  // now the SHARED helper, identical to the one holdings-value.ts imports — so
  // the two SQL aggregators can no longer drift.
  const skipCashLeg = cashLegSkipSql({
    kind: schema.transactions.kind,
    tradeLinkId: schema.transactions.tradeLinkId,
    amount: schema.transactions.amount,
  });
  const fkAggRows = await db
    .select({
      portfolioHoldingId: schema.transactions.portfolioHoldingId,
      enteredCurrency: effectiveEnteredCurrency,
      totalBuyQty: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${schema.transactions.quantity}, 0) > 0 AND NOT ${skipCashLeg} THEN ${schema.transactions.quantity} ELSE 0 END), 0)::float8`,
      totalBuyAmountInEntered: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${schema.transactions.quantity}, 0) > 0 AND NOT ${skipCashLeg} THEN ${effectiveBuyAmount} ELSE 0 END), 0)::float8`,
      totalSellQty: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${schema.transactions.quantity}, 0) < 0 AND NOT ${skipCashLeg} THEN ABS(${schema.transactions.quantity}) ELSE 0 END), 0)::float8`,
      totalSellAmountInEntered: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${schema.transactions.quantity}, 0) < 0 AND NOT ${skipCashLeg} THEN ABS(COALESCE(${schema.transactions.enteredAmount}, ${schema.transactions.amount})) ELSE 0 END), 0)::float8`,
      // Position quantity is the UNSKIPPED net Σ(quantity). The #128/FINLYNQ-106
      // cash-leg skip above applies to the buy/sell (realized-gain) tallies
      // ONLY — NOT to position qty. A buy_cash_leg/sell_cash_leg lands on the
      // cash SLEEVE holding, so deriving qty from `buyQty - sellQty` (skip-aware)
      // drops the sleeve's own cash flows from its balance (showed Cash USD at
      // $700k when the true balance was $0). Mirrors holdings-value.ts `delta`.
      delta: sql<number>`COALESCE(SUM(${schema.transactions.quantity}), 0)::float8`,
      // FINLYNQ-173: dividends are NO LONGER tallied here (keyed by
      // portfolio_holding_id = cash sleeve). They are aggregated separately
      // below, keyed on COALESCE(related_holding_id, portfolio_holding_id) so
      // the paying security is credited and the cash sleeve shows 0. Keep the
      // field present (= 0) so the bucket shape / downstream merge is stable.
      dividendsInEntered: sql<number>`0::float8`,
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
      delta: Number(r.delta),
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
      netQty: 0,
      dividendsReceived: 0,
      firstPurchaseDate: null,
    };
    for (const b of buckets) {
      const fx = await getCrossRate(b.enteredCurrency, holdingCurrency);
      out.totalBuyQty += b.totalBuyQty;
      out.totalBuyAmount += b.totalBuyAmountInEntered * fx;
      out.totalSellQty += b.totalSellQty;
      out.totalSellAmount += b.totalSellAmountInEntered * fx;
      // Position qty is currency-agnostic (a share/unit count) — sum the raw
      // net deltas across buckets with NO FX conversion.
      out.netQty += b.delta;
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
  // Compute derived metrics from a TxAgg â†’ TxMetrics.
  const toMetrics = (a: TxAgg): TxMetrics => {
    const buyQty = a.totalBuyQty;
    const buyAmt = a.totalBuyAmount;
    const sellQty = a.totalSellQty;
    const sellAmt = a.totalSellAmount;
    const divs = a.dividendsReceived;
    const avgCost = buyQty > 0 ? buyAmt / buyQty : null;
    // Position qty = UNSKIPPED net Σ(quantity), NOT buyQty - sellQty (which is
    // skip-aware and drops a cash sleeve's own buy_cash_leg/sell_cash_leg). For
    // any non-cash-sleeve holding netQty == buyQty - sellQty, so this is a
    // strict no-op for stocks; it only corrects cash sleeves with trade legs.
    // avgCost / realizedGain stay on the skip-aware buy/sell tallies.
    const remainingQty = a.netQty;
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

  // Pre-compute the quote currency for each holding â€” the currency that
  // marketValue (price Ã— quantity) will be in once we enrich. Cost basis
  // MUST be normalized to this currency so unrealizedGain = marketValue âˆ’
  // costBasis is dimensionally consistent. Crypto's quote is "CAD" (the
  // crypto-service quirk); cash uses the symbol; stocks use Yahoo's q.currency.
  const quoteCurrencyById = new Map<number, string>();
  for (const h of holdings) {
    const isCryptoH = h.isCrypto === 1 || (h.symbol ? isCryptoSymbol(h.symbol) : false);
    const symbolIsCurrencyH = symbolIsCash(h.symbol);
    let qc = h.currency;
    if (isCryptoH) qc = "CAD";
    else if (symbolIsCurrencyH && h.symbol) {
      const symU = h.symbol.toUpperCase();
      // Metals (XAU/XAG/XPT/XPD) are tradeable units priced in the holding's
      // currency, not unit currencies â€” quote them in h.currency so 6.9 oz
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

  // FINLYNQ-173: dividend attribution. A dividend lands on the cash sleeve
  // (portfolio_holding_id) but carries related_holding_id = the paying
  // security. Aggregate dividends keyed on COALESCE(related_holding_id,
  // portfolio_holding_id) so the SECURITY is credited and the cash sleeve
  // shows 0 — a naive per-holding tally (the old fkAggRows path) piled every
  // ticker's dividend cash inflow onto the Cash sleeve's Dividends column and
  // Total Return. The grand total is preserved (the amount MOVES from cash to
  // the ticker). Amount stays in the row's own (paid) currency for the
  // currency-aware FX hop into each target holding's quote currency below.
  const dividendByHolding = new Map<number, { amount: number; currency: string }[]>();
  if (dividendsCategoryId !== null) {
    const divRows = await db
      .select({
        attributionHoldingId: dividendAttributionHoldingIdSql({
          relatedHoldingId: schema.transactions.relatedHoldingId,
          portfolioHoldingId: schema.transactions.portfolioHoldingId,
        }),
        enteredCurrency: sql<string>`COALESCE(${schema.transactions.enteredCurrency}, ${schema.transactions.currency})`,
        dividendsInEntered: sql<number>`COALESCE(SUM(COALESCE(${schema.transactions.enteredAmount}, ${schema.transactions.amount})), 0)::float8`,
      })
      .from(schema.transactions)
      .where(and(
        eq(schema.transactions.userId, userId),
        eq(schema.transactions.categoryId, dividendsCategoryId),
        isNotNull(schema.transactions.portfolioHoldingId),
      ))
      .groupBy(
        dividendAttributionHoldingIdSql({
          relatedHoldingId: schema.transactions.relatedHoldingId,
          portfolioHoldingId: schema.transactions.portfolioHoldingId,
        }),
        sql`COALESCE(${schema.transactions.enteredCurrency}, ${schema.transactions.currency})`,
      );
    for (const r of divRows) {
      if (r.attributionHoldingId == null) continue;
      const hid = Number(r.attributionHoldingId);
      const arr = dividendByHolding.get(hid) ?? [];
      arr.push({
        amount: Number(r.dividendsInEntered),
        currency: String(r.enteredCurrency || "").toUpperCase() || displayCurrency,
      });
      dividendByHolding.set(hid, arr);
    }
  }
  // Resolve the re-attributed dividend total for one holding, FX-converted
  // from each paid-currency slice into the holding's quote currency.
  const dividendsForHolding = async (holdingId: number, targetCcy: string): Promise<number> => {
    const slices = dividendByHolding.get(holdingId);
    if (!slices) return 0;
    let total = 0;
    for (const s of slices) {
      const fx = await getCrossRate(s.currency, targetCcy);
      total += s.amount * fx;
    }
    return total;
  };

  // Reduce per-currency buckets into a single TxMetrics keyed by holding id.
  // Cost basis normalized to the holding's quote currency via FX before
  // summing â€” fixes the cross-currency P&L bug for cash-as-currency
  // positions.
  const metricsByHoldingId = new Map<number, TxMetrics>();
  for (const h of holdings) {
    const targetCcy = quoteCurrencyById.get(h.id) ?? h.currency;
    const fkBuckets = bucketsById.get(h.id);
    // FINLYNQ-173: a holding may have re-attributed dividends even with no
    // buy/sell buckets of its own (rare). Build a zero TxAgg in that case so
    // the dividend still lands on the security's row.
    const fkAgg = fkBuckets
      ? await aggInHoldingCurrency(fkBuckets, targetCcy)
      : {
          totalBuyQty: 0, totalBuyAmount: 0, totalSellQty: 0, totalSellAmount: 0,
          netQty: 0, dividendsReceived: 0, firstPurchaseDate: null,
        } as TxAgg;
    const metrics = toMetrics(fkAgg);
    // Overlay the re-attributed dividend (fkAgg.dividendsReceived is now 0).
    metrics.dividendsReceived = await dividendsForHolding(h.id, targetCcy);
    if (fkBuckets || metrics.dividendsReceived !== 0) {
      metricsByHoldingId.set(h.id, metrics);
    }
  }

  // 7. Build enriched holdings
  type AssetType = "etf" | "stock" | "crypto" | "cash" | "metal";

  const enrichedHoldings = holdings.map(h => {
    const isCrypto = h.isCrypto === 1 || (h.symbol ? isCryptoSymbol(h.symbol) : false);
    const symbolIsCurrency = symbolIsCash(h.symbol);
    // FINLYNQ-201: ETF-vs-stock is no longer keyed on a hardcoded list.
    // Resolution order (durable, stable across warm/cold price_cache):
    //   1. user override / persisted Yahoo type — `securities.asset_type === 'etf'`
    //   2. live Yahoo `quoteType` ('ETF') on this fetch (null on a warm-cache hit)
    //   3. fallback → stock
    // (1) wins so a user choice + a previously-persisted Yahoo classification
    // survive a warm cache (when the live quoteType is unavailable). The persist
    // step below writes a fresh live 'ETF' back onto `securities.asset_type`.
    const userOrPersistedEtf = (h.securityAssetType ?? "").toLowerCase() === "etf";
    const liveEtf = h.symbol && !symbolIsCurrency ? isEtfQuoteType(quotes.get(h.symbol)?.quoteType) : false;
    const isEtf = h.symbol && !symbolIsCurrency ? (userOrPersistedEtf || liveEtf) : false;

    // Display asset-type — metals (XAU/XAG/XPT/XPD) get their OWN "metal" type
    // (not "cash") so the badge matches the Securities tab, whose stored
    // `asset_type` is "metal" (clusterFromAssetType). Order: crypto → metal →
    // cash (currency-code / no-symbol) → etf → stock.
    let assetType: AssetType = "cash";
    if (isCrypto) assetType = "crypto";
    else if (h.symbol && isMetalCurrency(h.symbol.toUpperCase())) assetType = "metal";
    else if (!h.symbol || symbolIsCurrency) assetType = "cash";
    else if (isEtf) assetType = "etf";
    else assetType = "stock";

    let price: number | null = null;
    let change: number | null = null;
    let changePct: number | null = null;
    // FINLYNQ-246: explicit display-currency day change for foreign cash, whose
    // day change is an FX-rate move (no native per-unit change). Set in the cash
    // branch and used to override the change×qty formula below; null otherwise.
    let cashFxDayChangeDisplay: number | null = null;
    let quoteCurrency: string | null = null;
    let marketCap: number | null = null;
    let image: string | null = null;
    // FINLYNQ-174: human-readable long name from the quote layer (Yahoo
    // `meta.shortName`). Only populated on a live fetch — on a warm
    // price_cache hit the quote `name` is just the symbol, which the
    // client-side `holdingDescription(...)` resolver treats as "no
    // description". Null for cash/metals/crypto/custom.
    let quoteName: string | null = null;

    if (isCrypto && h.symbol) {
      const base = String(h.symbol).toUpperCase().split("-")[0];
      const cp = cryptoPriceMap.get(base);
      if (cp) {
        price = cp.price;
        change = cp.change24h;
        changePct = cp.changePct24h;
        marketCap = cp.marketCap;
        image = cp.image ?? null;
        // USD-based (legacy rows may be CAD); carry the price's own currency so
        // the fxRates conversion below lands in the display currency correctly.
        quoteCurrency = cp.currency || "USD";
      }
    } else if (h.symbol && !symbolIsCurrency) {
      // Stocks/ETFs only â€” currency-code symbols skip Yahoo to avoid
      // matching unrelated tickers (Yahoo has stocks under CAD, USD, etc.).
      const q = quotes.get(h.symbol);
      if (q) {
        price = q.price;
        change = q.change;
        changePct = q.changePct ? Math.round(q.changePct * 100) / 100 : null;
        quoteCurrency = q.currency;
        // Surface the Yahoo long name when it's a real description, not the
        // symbol echoed back (cache-hit rows return name === symbol).
        if (q.name && q.name.trim().toUpperCase() !== h.symbol.toUpperCase()) {
          quoteName = q.name.trim();
        }
      }
    }

    // Get quantity and cost metrics from transactions. FK-keyed lookup â€”
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
      // (USD, CAD, XAU, â€¦). The price = 1 in the holding's own currency
      // (one CAD is one CAD), AND the value converted to the display
      // currency = quantity Ã— FX-rate(holding-currency â†’ display-currency).
      // The "Price" column should show "$1.00 CAD" not "US$95.88" â€” so
      // quoteCurrency is the holding's own currency, not the display target.
      //
      // Exception: a metal symbol (XAU/XAG/XPT/XPD) on a holding whose
      // currency is something else means the symbol is a tradeable unit
      // priced in h.currency. Compute price as the cross-rate so e.g. 6.9
      // oz of gold in a USD account shows as $4679/oz Ã— 6.9 = $32,287 USD,
      // not "1.00 XAU Ã— 6.90 = 6.90 XAU".
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
          // FINLYNQ-246: metals DO have a daily move — derive the per-unit day
          // change in the holding's own currency from the prior-trading-day
          // cross-rate (price_cache / fetchYahooMetalRateToUsd, one day back).
          // change/changePct are in quoteCurrency (= h.currency), so the
          // existing dayChangeDisplay formula (change × qty, FX-converted) and
          // the native rollup both pick them up correctly.
          const symInDisplayPrev = prevFxRates.get(symU) ?? 0;
          const ccInDisplayPrev = prevFxRates.get(h.currency) ?? 0;
          if (symInDisplayPrev > 0 && ccInDisplayPrev > 0) {
            const priceInHoldingCcyPrev = symInDisplayPrev / ccInDisplayPrev;
            if (priceInHoldingCcyPrev > 0) {
              change = priceInHoldingCcy - priceInHoldingCcyPrev;
              changePct = Math.round((change / priceInHoldingCcyPrev) * 100 * 100) / 100;
            }
          }
        }
      } else {
        const cashCurrency = symbolIsCurrency ? h.symbol!.toUpperCase() : h.currency;
        const fxRate = fxRates.get(cashCurrency) ?? 1;
        price = 1;
        quoteCurrency = cashCurrency;
        marketValue = quantity; // in cashCurrency
        marketValueDisplay = quantity * fxRate; // in displayCurrency despite the legacy field name
        // FINLYNQ-246: foreign-currency cash has a DISPLAY-currency day change
        // driven purely by the FX rate's day move vs the display currency
        // (1 USD is still 1 USD natively, so the NATIVE change is genuinely 0 —
        // keep `change` 0 so the native rollup shows 0, never a fake FX figure).
        // The display contribution is set EXPLICITLY below as dayChangeDisplay;
        // same-currency cash (rate 1 today and prior) stays 0 → "--".
        if (cashCurrency !== displayCurrency.toUpperCase()) {
          const prevRate = prevFxRates.get(cashCurrency) ?? 0;
          if (prevRate > 0 && fxRate > 0) {
            changePct = Math.round(((fxRate - prevRate) / prevRate) * 100 * 100) / 100;
            cashFxDayChangeDisplay = round2(quantity * (fxRate - prevRate));
          }
        }
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

    // Per-holding day-change in display currency = this holding's contribution
    // to summary.dayChangeDisplay (change-per-unit × qty, FX-converted). Null
    // when there's no live change to show (mirrors the holdingsWithChange
    // filter used for the portfolio total below).
    // FINLYNQ-246: foreign-currency cash carries its display day change in
    // cashFxDayChangeDisplay (FX-rate move × qty) since its NATIVE change is 0;
    // metals/equities/crypto use the change-per-unit × qty path. Same-currency
    // cash leaves both null → "--".
    const dayChangeDisplay = cashFxDayChangeDisplay !== null
      ? cashFxDayChangeDisplay
      : changePct !== null && marketValueDisplay !== null
        ? Math.round(convertCurrency((change ?? 0) * (quantity ?? 1), fxRate) * 100) / 100
        : null;

    return {
      id: h.id,
      securityId: h.securityId ?? null,
      // FINLYNQ-194: the decrypted `securities.name_ct` for this position's
      // security (null when un-backfilled / no security row / no DEK). The
      // single-source display-name resolver (`resolveSecurityName` below)
      // prefers this over the legacy canonicalKey/per-position name when the
      // read-flip is on.
      securityName: h.securityName ?? null,
      accountId: h.accountId,
      accountName: h.accountName ?? "Unknown",
      name: h.name,
      symbol: h.symbol,
      quoteName,
      currency: h.currency,
      assetType,
      price,
      change,
      changePct,
      dayChangeDisplay,
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

  // 7b. FINLYNQ-201: persist a freshly-resolved Yahoo ETF classification onto
  // `securities.asset_type` so the badge is DURABLE (stable across warm-cache
  // reads, when the live quoteType is unavailable). One-time promotion only:
  // we upgrade a security currently typed "stock" (the default for the eq:
  // bucket) → "etf". A non-"stock" stored type (a user override, or an already-
  // persisted "etf") is left untouched, so the USER OVERRIDE ALWAYS WINS.
  // asset_type is cosmetic (canonical.ts) — this NEVER changes cluster_key and
  // never re-clusters. Fire-and-forget; best-effort (no DEK needed).
  if (dek) {
    const promoteSecIds = new Set<number>();
    for (const h of nonCryptoWithSymbol) {
      if (h.securityId == null || !h.symbol) continue;
      if ((h.securityAssetType ?? "").toLowerCase() !== "stock") continue; // override/etf → leave
      if (isEtfQuoteType(quotes.get(h.symbol)?.quoteType)) promoteSecIds.add(h.securityId);
    }
    if (promoteSecIds.size > 0) {
      const ids = [...promoteSecIds];
      void (async () => {
        try {
          await db
            .update(schema.securities)
            .set({ assetType: "etf", updatedAt: sql`NOW()` })
            .where(
              and(
                eq(schema.securities.userId, userId),
                eq(schema.securities.assetType, "stock"),
                inArray(schema.securities.id, ids),
              ),
            );
        } catch {
          // best-effort durable badge — never block / fail the read.
        }
      })();
    }
  }

  // 8. Compute summaries
  const totalValueDisplay = enrichedHoldings.reduce((s, h) => s + (h.marketValueDisplay ?? 0), 0);
  const hasQuantityData = enrichedHoldings.some(h => h.quantity !== null && h.quantity !== 0);

  // Day change: sum the per-holding display-currency day-change contributions.
  // FINLYNQ-246: sum the already-computed per-row `dayChangeDisplay` (the single
  // source of truth) instead of re-deriving change×qty here. For equities/crypto
  // this is byte-identical to the old formula (dayChangeDisplay == the old
  // summand), but it ALSO folds in metals (real per-unit move) and
  // foreign-currency cash (FX-rate move, whose native change is 0), so the tile
  // reconciles exactly with the All-Holdings Day G/L column. Same-currency cash
  // stays null and contributes nothing.
  const holdingsWithChange = enrichedHoldings.filter(h => h.dayChangeDisplay !== null && h.marketValueDisplay !== null);
  const totalDayChangeDisplay = holdingsWithChange.reduce((s, h) => s + (h.dayChangeDisplay ?? 0), 0);
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
    metal: { count: 0, value: 0 },
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
        name: h.name ?? "",
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

  // Add pctOfPortfolio to each holding
  const holdingsWithPct = enrichedHoldings.map(h => ({
    ...h,
    pctOfPortfolio: totalValueDisplay > 0 && h.marketValueDisplay != null
      ? Math.round((h.marketValueDisplay / totalValueDisplay) * 10000) / 100
      : null,
  }));

  // 11. By-holding aggregation â€” same financial position pooled across the
  // accounts that hold it. Issue #25 (Section F) interim path (a):
  // re-group `enrichedHoldings` by canonical key post-enrichment. The
  // SQL-side join through `holding_accounts` (path (b)) is a follow-up;
  // until canonical-name backfill ships, key on (assetType, symbol/currency)
  // so user-edited free-text names don't fragment the same ticker into
  // multiple rows.
  type ByHoldingKey = { key: string; symbol: string | null; name: string };
  // Securities master (2026-06-16): the cluster logic is single-sourced in
  // src/lib/securities/canonical.ts (used by the write-side resolver + the
  // login backfill too) so grouping by `security_id` stays provably equivalent
  // to this legacy string key. `symbol` mirrors the legacy field (currency code
  // for cash, ticker otherwise).
  const canonicalKey = (h: typeof enrichedHoldings[number]): ByHoldingKey => {
    const c = clusterFromAssetType({
      // clusterFromAssetType takes the 4-value CanonicalAssetType and re-derives
      // "metal" from the symbol itself, so feed it "cash" for our display-only
      // "metal" type (a metal symbol + assetType "cash" → the metal cluster).
      assetType: h.assetType === "metal" ? "cash" : h.assetType,
      symbol: h.symbol,
      currency: h.currency,
      name: h.name,
    });
    return { key: c.legacyKey, symbol: c.symbolUpper ?? c.currencyCode, name: c.displayName };
  };
  // Phase D read-flip: when enabled for this user, bucket combined holdings on
  // the real `security_id` FK instead of the in-memory string. Rows still
  // missing a security_id (un-backfilled) fall back to the legacy key, so the
  // two paths converge. Display fields (key/symbol/image) still come from the
  // first member's canonicalKey; the display NAME is resolved by
  // `resolveSecurityName` below.
  const useSecurityGrouping = await securitiesReadEnabledForUser(userId);

  // FINLYNQ-194: single source of the display NAME. When the read-flip is on
  // AND the row is backfilled (security_id present) AND the security carries a
  // decrypted name, use `securities.name_ct` — so a rename/add in the
  // Securities catalog propagates to All Holdings + Top Movers identically to
  // By Account (which already tracks it via the copy-on-rename per-position
  // name). Otherwise return null, leaving the caller on the LEGACY
  // canonicalKey/per-position name path — keeping flag-off / un-backfilled rows
  // BYTE-IDENTICAL to today (names + byHolding totals; tc-3 parity invariant).
  const resolveSecurityName = (h: typeof enrichedHoldings[number]): string | null => {
    if (!useSecurityGrouping || h.securityId == null) return null;
    const nm = (h.securityName ?? "").trim();
    return nm.length > 0 ? nm : null;
  };

  // Single canonical bucket key, shared by the All-Holdings rollup (byHoldingMap)
  // AND the Top Movers aggregation (FINLYNQ-190) — there is exactly ONE grouping
  // path. Bucket on the real security_id FK when the read-flip is on and the row
  // is backfilled; otherwise the legacy canonicalKey string (un-backfilled rows
  // converge to the same key).
  const moverBucketKey = (h: typeof enrichedHoldings[number]): string =>
    useSecurityGrouping && h.securityId != null ? `sec:${h.securityId}` : canonicalKey(h).key;

  // 10. Gainers & losers (top movers by absolute dollar value change).
  // FINLYNQ-190: aggregate per-position holdings into ONE row per ticker
  // (canonical security key) BEFORE the top-5 slice — a ticker held across N
  // accounts must surface once. The consolidated day-change $ is the sum across
  // accounts; the % is a value-weighted aggregate (Σ day-change ÷ Σ prior-day
  // value), NOT one account's percent. Custom (no symbol) rows stay excluded by
  // aggregateMovers; cash sleeves are filtered out here (FINLYNQ-246 gave
  // foreign-currency cash a day change, but an FX-rate wiggle on "Cash USD" is
  // not an investment "mover"). Metals (XAU/…) DO surface as real movers. Rank
  // by absolute display-currency day-change (tie-break: symbol asc), cap at 5.
  const aggregatedMovers = aggregateMovers(
    enrichedHoldings.filter(h => h.assetType !== "cash"),
    moverBucketKey,
    // FINLYNQ-194: the canonical row's display name comes from the security
    // table when resolvable (read-flip on + backfilled), else the legacy
    // canonicalKey name. Top Movers thus inherits the SAME single-source name
    // as All Holdings — no name logic duplicated in top-movers.ts.
    (h) => {
      const ck = canonicalKey(h);
      return { key: ck.key, symbol: ck.symbol, name: resolveSecurityName(h) ?? ck.name };
    },
  ).sort((a, b) => {
    const diff = Math.abs(b.dayChangeDisplay) - Math.abs(a.dayChangeDisplay);
    if (diff !== 0) return diff;
    return (a.symbol ?? "").localeCompare(b.symbol ?? "");
  });
  const topGainers = aggregatedMovers.filter(m => m.dayChangeDisplay > 0).slice(0, 5);
  const topLosers = aggregatedMovers.filter(m => m.dayChangeDisplay < 0).slice(0, 5);

  type ByHoldingAccum = {
    key: string;
    symbol: string | null;
    name: string;
    // FINLYNQ-174: first non-null member quoteName (Yahoo long name).
    description: string | null;
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
    // Day change (this canonical row's contribution to summary.dayChange).
    // `dayChangeKnown` is true once any member has a live change so a row with
    // no quote shows "--" instead of a misleading +$0.00.
    dayChangeDisplay: number;
    dayChangeNative: number;
    dayChangeKnown: boolean;
    // Native-currency rollup — only meaningful when every member shares one
    // quote currency (true for a single ticker / cash sleeve). `nativeConsistent`
    // flips false on a currency mismatch, after which the native fields are
    // dropped (null) and the client falls back to display currency for the row.
    nativeCurrency: string | null;
    nativeConsistent: boolean;
    costBasisNative: number;
    marketValueNative: number;
    unrealizedGainNative: number;
    realizedGainNative: number;
    dividendsNative: number;
  };

  const byHoldingMap = new Map<string, ByHoldingAccum>();
  for (const h of enrichedHoldings) {
    const ck = canonicalKey(h);
    // FINLYNQ-194: single-source display name — the security row's name when
    // resolvable, else the legacy canonicalKey name. `null` on flag-off /
    // un-backfilled rows ⇒ legacy path ⇒ byte-identical to today.
    const secName = resolveSecurityName(h);
    // Same canonical bucket key as Top Movers (moverBucketKey). `acc.key` stays
    // the legacy canonicalKey string regardless (opaque React key / display id).
    const bucketKey = moverBucketKey(h);
    let acc = byHoldingMap.get(bucketKey);
    if (!acc) {
      acc = {
        key: ck.key,
        symbol: ck.symbol,
        name: secName ?? ck.name,
        // When the security name is the single source, seed `description` with
        // it too: the client's `holdingDescription` reads `description` as the
        // primary (quote-name) slot, so a USER RENAME wins over Yahoo's
        // quoteName. On the legacy path `description` stays null and is filled
        // from the first member's quoteName below (FINLYNQ-174, unchanged).
        description: secName,
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
        dayChangeDisplay: 0,
        dayChangeNative: 0,
        dayChangeKnown: false,
        nativeCurrency: (h.quoteCurrency ?? h.currency ?? "").toUpperCase() || null,
        nativeConsistent: true,
        costBasisNative: 0,
        marketValueNative: 0,
        unrealizedGainNative: 0,
        realizedGainNative: 0,
        dividendsNative: 0,
      };
      byHoldingMap.set(bucketKey, acc);
    }
    if (h.accountId != null) acc.accountIds.add(h.accountId);
    // FINLYNQ-174: carry the first member with a real quote long name up to
    // the canonical row (all members of an `eq:`/`crypto:` key share a
    // ticker, so any member's quoteName describes the whole row). When the
    // security name already seeded `description` (FINLYNQ-194), it stays — the
    // user rename wins over Yahoo quoteName.
    if (acc.description == null && h.quoteName) acc.description = h.quoteName;
    if (h.quantity != null) acc.totalQty += h.quantity;
    acc.marketValueDisplay += h.marketValueDisplay ?? 0;
    acc.unrealizedGainDisplay += h.unrealizedGainDisplay ?? 0;

    // FX hop into displayCurrency for cost basis / realized / dividends â€”
    // the per-row totalCostBasis / realizedGain / dividendsReceived live in
    // the holding's quote currency. Reuse the same fxRates map the per-row
    // path uses so the rollup matches summary totals to within rounding.
    const fxRate = fxRates.get(h.quoteCurrency ?? h.currency) ?? 1;
    if (h.totalCostBasis != null) acc.costBasisDisplay += h.totalCostBasis * fxRate;
    if (h.lifetimeCostBasis != null) acc.lifetimeCostBasisDisplay += h.lifetimeCostBasis * fxRate;
    if (h.realizedGain != null) acc.realizedGainDisplay += h.realizedGain * fxRate;
    if (h.dividendsReceived != null) acc.dividendsDisplay += h.dividendsReceived * fxRate;

    // Day change — sum the per-member display contribution (already FX-converted
    // + rounded server-side) and the native per-member contribution
    // (change-per-unit × qty, in the member's own quote currency).
    if (h.dayChangeDisplay !== null) {
      acc.dayChangeDisplay += h.dayChangeDisplay;
      acc.dayChangeNative += (h.change ?? 0) * (h.quantity ?? 0);
      acc.dayChangeKnown = true;
    }

    // Native-currency rollup. Members of one canonical key share a quote
    // currency (a single ticker → one Yahoo currency); a mismatch (defensive)
    // marks the row non-native so the client renders it in display currency.
    const memberCcy = (h.quoteCurrency ?? h.currency ?? "").toUpperCase();
    if (memberCcy && acc.nativeCurrency && memberCcy !== acc.nativeCurrency) acc.nativeConsistent = false;
    acc.marketValueNative += h.marketValue ?? 0;
    if (h.totalCostBasis != null) acc.costBasisNative += h.totalCostBasis;
    if (h.unrealizedGain != null) acc.unrealizedGainNative += h.unrealizedGain;
    if (h.realizedGain != null) acc.realizedGainNative += h.realizedGain;
    if (h.dividendsReceived != null) acc.dividendsNative += h.dividendsReceived;
  }

  const byHolding = Array.from(byHoldingMap.values()).map(a => {
    // Avg cost across accounts is qty-weighted: Î£(costBasis_acct) / Î£(qty_acct).
    // Avoids the simple-mean bug when one account holds 10Ã— more shares.
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
    // Current (blended) price = market value / qty, mirroring the qty-weighted
    // avg cost above. For a single ticker this equals the live quote; for cash
    // it's ~1.00. Shown next to Avg Cost.
    const currentPriceDisplay = a.totalQty !== 0 ? a.marketValueDisplay / a.totalQty : null;
    // Day-change %: this row's display contribution over its prior-day value
    // (= today's value − the change). Currency-independent ratio → used for both
    // display and native modes.
    const priorValueDisplay = a.marketValueDisplay - a.dayChangeDisplay;
    const dayChangePct = a.dayChangeKnown && priorValueDisplay !== 0
      ? (a.dayChangeDisplay / priorValueDisplay) * 100
      : null;
    // Native-currency fields — only when every member agreed on one quote
    // currency. Otherwise null ⇒ the client renders this row in display currency
    // even with the "Holding currency" toggle on. Unrealized %/return % are
    // ratios, so they're shared with the display path (FX cancels).
    const nativeCurrency = a.nativeConsistent ? a.nativeCurrency : null;
    const avgCostNative = nativeCurrency != null && a.totalQty > 0 && a.costBasisNative > 0
      ? a.costBasisNative / a.totalQty
      : null;
    const currentPriceNative = nativeCurrency != null && a.totalQty !== 0
      ? a.marketValueNative / a.totalQty
      : null;
    const totalReturnNative = a.unrealizedGainNative + a.realizedGainNative + a.dividendsNative;
    return {
      key: a.key,
      symbol: a.symbol,
      name: a.name,
      description: a.description,
      assetType: a.assetType,
      totalQty: Math.round(a.totalQty * 1e6) / 1e6,
      avgCostDisplay: avgCostDisplay != null ? Math.round(avgCostDisplay * 10000) / 10000 : null,
      currentPriceDisplay: currentPriceDisplay != null ? Math.round(currentPriceDisplay * 10000) / 10000 : null,
      costBasisDisplay: Math.round(a.costBasisDisplay * 100) / 100,
      marketValueDisplay: Math.round(a.marketValueDisplay * 100) / 100,
      unrealizedGainDisplay: Math.round(a.unrealizedGainDisplay * 100) / 100,
      unrealizedGainPct: unrealizedPct != null ? Math.round(unrealizedPct * 100) / 100 : null,
      realizedGainDisplay: Math.round(a.realizedGainDisplay * 100) / 100,
      dividendsDisplay: Math.round(a.dividendsDisplay * 100) / 100,
      totalReturnDisplay: Math.round(totalReturnDisplay * 100) / 100,
      totalReturnPct: totalReturnPct != null ? Math.round(totalReturnPct * 100) / 100 : null,
      dayChangeDisplay: a.dayChangeKnown ? Math.round(a.dayChangeDisplay * 100) / 100 : null,
      dayChangePct: dayChangePct != null ? Math.round(dayChangePct * 100) / 100 : null,
      // Native-currency rollup (null when members span currencies).
      nativeCurrency,
      avgCostNative: avgCostNative != null ? Math.round(avgCostNative * 10000) / 10000 : null,
      currentPriceNative: currentPriceNative != null ? Math.round(currentPriceNative * 10000) / 10000 : null,
      costBasisNative: nativeCurrency != null ? Math.round(a.costBasisNative * 100) / 100 : null,
      marketValueNative: nativeCurrency != null ? Math.round(a.marketValueNative * 100) / 100 : null,
      unrealizedGainNative: nativeCurrency != null ? Math.round(a.unrealizedGainNative * 100) / 100 : null,
      realizedGainNative: nativeCurrency != null ? Math.round(a.realizedGainNative * 100) / 100 : null,
      dividendsNative: nativeCurrency != null ? Math.round(a.dividendsNative * 100) / 100 : null,
      totalReturnNative: nativeCurrency != null ? Math.round(totalReturnNative * 100) / 100 : null,
      dayChangeNative: nativeCurrency != null && a.dayChangeKnown ? Math.round(a.dayChangeNative * 100) / 100 : null,
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
