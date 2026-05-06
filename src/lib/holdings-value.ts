/**
 * Compute current market value of portfolio holdings grouped by account.
 *
 * Returns a map of accountId -> { value, costBasis, currency } where value
 * and costBasis are in the account's native currency. Callers that display
 * balances in a different currency should apply their own FX conversion
 * downstream.
 *
 * costBasis = Σ(remainingQty × avgCost) per holding, in the account currency.
 * Mirrors the per-holding metric computation in /api/portfolio/overview.
 */

import { db, schema } from "@/db";
import { and, eq, isNotNull, lte, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { fetchMultipleQuotes, fetchMultipleQuotesAtDate } from "@/lib/price-service";
import { getCryptoPrices, symbolToCoinGeckoId } from "@/lib/crypto-service";
import { getLatestFxRate, getRate } from "@/lib/fx-service";
import { isSupportedCurrency, isMetalCurrency } from "@/lib/fx/supported-currencies";
import { decryptNamedRows } from "@/lib/crypto/encrypted-columns";

function todayISO(): string {
  return new Date().toISOString().split("T")[0];
}

const CRYPTO_SYMBOLS = new Set([
  "BTC", "ETH", "SOL", "ADA", "XRP", "DOGE", "AAVE", "ATOM", "AVAX",
  "CRV", "FTM", "HBAR", "LINK", "LTC", "MATIC", "POL", "DOT", "XLM",
  "UNI", "YFI", "SNX", "BNB", "SHIB", "ARB", "OP", "APT", "SUI",
  "NEAR", "FIL", "ICP", "ALGO", "XTZ", "EOS", "SAND", "MANA", "AXS", "S",
]);

function isCrypto(symbol: string | null): boolean {
  if (!symbol) return false;
  return CRYPTO_SYMBOLS.has(symbol.toUpperCase().split("-")[0]);
}

// A holding whose symbol IS a currency code (CAD, USD, EUR, XAU, …)
// represents a foreign-cash position, NOT a stock. Yahoo would return
// data for unrelated tickers ("CAD" → Cadiz Inc on NASDAQ) that inflate
// market value by 100×+. Mirrors the same check in /api/portfolio/overview.
function isCurrencyCodeSymbol(sym: string | null | undefined): boolean {
  if (!sym) return false;
  const s = sym.trim().toUpperCase();
  return /^[A-Z]{3,4}$/.test(s) && isSupportedCurrency(s);
}

export type AccountHoldingsValue = {
  accountId: number;
  value: number;       // current market value in account currency
  costBasis: number;   // remaining cost basis in account currency
  currency: string;    // account currency
};

export type HoldingsValueOpts = {
  /**
   * Compute the snapshot as of this date (ISO YYYY-MM-DD). Transactions
   * are filtered to date <= asOfDate; prices and FX use that date's rate.
   * Defaults to today, preserving the original behavior.
   */
  asOfDate?: string;
};

export async function getHoldingsValueByAccount(
  userId: string,
  dek?: Buffer | null,
  opts?: HoldingsValueOpts,
): Promise<Map<number, AccountHoldingsValue>> {
  const asOfDate = opts?.asOfDate ?? todayISO();
  const isToday = asOfDate >= todayISO();
  // Stream D Phase 4 — plaintext name/symbol dropped; ciphertext only.
  const rawHoldings = await db
    .select({
      id: schema.portfolioHoldings.id,
      accountId: schema.portfolioHoldings.accountId,
      nameCt: schema.portfolioHoldings.nameCt,
      symbolCt: schema.portfolioHoldings.symbolCt,
      currency: schema.portfolioHoldings.currency,
      isCrypto: schema.portfolioHoldings.isCrypto,
      accountCurrency: schema.accounts.currency,
    })
    .from(schema.portfolioHoldings)
    .leftJoin(schema.accounts, eq(schema.portfolioHoldings.accountId, schema.accounts.id))
    .where(eq(schema.portfolioHoldings.userId, userId));

  if (rawHoldings.length === 0) return new Map();

  // Stream D Phase 4 — plaintext columns dropped, decrypt the ciphertext.
  // Without this, the symbol-keyed price lookup misses.
  const holdings = decryptNamedRows(rawHoldings, dek ?? null, {
    nameCt: "name",
    symbolCt: "symbol",
  }) as Array<typeof rawHoldings[number] & { name: string | null; symbol: string | null }>;

  // Aggregate remaining quantity AND cost-basis components per (holding,
  // account) via the integer FK + JOIN through `holding_accounts`. Today
  // each portfolio_holdings row maps to exactly one holding_accounts
  // pairing (is_primary=true), so the result is identical to grouping by
  // portfolio_holding_id alone — but the JOIN is forward-compatible with
  // Section G's many-to-many shape. CLAUDE.md "Portfolio aggregator":
  // qty>0 = buy regardless of amount sign. ABS(amount) for cost basis so
  // both Finlynq-native (amt<0+qty>0) and WP convention (amt>0+qty>0)
  // yield positive cost.
  //
  // Issue #96: LEFT JOIN to the cash-leg sibling for multi-currency trade
  // pairs. When a buy row (qty>0) has a paired cash leg (same trade_link_id,
  // qty=0), use the cash leg's `entered_amount`/`amount` instead of the
  // stock leg's amount (which is the same trade re-priced at Finlynq's
  // live FX rate and under-counts the broker's spread).
  //
  // Issue #129: per-currency bucketing. SELECT `entered_amount` +
  // `entered_currency` (and `cash.entered_amount`/`cash.entered_currency`
  // for paired buys) so cross-currency holdings (e.g. USD ETF inside CAD
  // brokerage) sum cost basis in the *entered* currency. The post-query
  // loop then FX-normalizes each bucket into the holding currency before
  // computing avg cost. The legacy "approximation that transaction
  // amounts == account currency" produced inflated cost-basis numbers
  // for every cross-currency holding.
  const cashLeg = alias(schema.transactions, "cash");
  const isPairedBuy = sql<boolean>`(COALESCE(${schema.transactions.quantity}, 0) > 0 AND ${cashLeg.id} IS NOT NULL)`;
  // Mirror the REST overview's effectiveBuyAmount / effectiveEnteredCurrency
  // pattern so cash-leg substitution composes with per-currency bucketing.
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
      delta: sql<number>`COALESCE(SUM(
        CASE
          WHEN COALESCE(${schema.transactions.quantity}, 0) > 0 THEN ${schema.transactions.quantity}
          WHEN COALESCE(${schema.transactions.quantity}, 0) < 0 THEN ${schema.transactions.quantity}
          ELSE 0
        END
      ), 0)::float8`,
      totalBuyQty: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${schema.transactions.quantity}, 0) > 0 THEN ${schema.transactions.quantity} ELSE 0 END), 0)::float8`,
      totalBuyAmountInEntered: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${schema.transactions.quantity}, 0) > 0 THEN ${effectiveBuyAmount} ELSE 0 END), 0)::float8`,
      totalSellQty: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${schema.transactions.quantity}, 0) < 0 THEN ABS(${schema.transactions.quantity}) ELSE 0 END), 0)::float8`,
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
      lte(schema.transactions.date, asOfDate),
    ))
    .groupBy(schema.transactions.portfolioHoldingId, effectiveEnteredCurrency);

  const qtyByHoldingId = new Map<number, number>();
  // Per-currency cost buckets per holding. Each entry is the SUM of buy/sell
  // amounts in its own `enteredCurrency`. Collapsed into holding-currency
  // cost basis via the FX cache below.
  type CostBucket = { enteredCurrency: string; buyQty: number; buyAmountInEntered: number; sellQty: number };
  const costBucketsByHoldingId = new Map<number, CostBucket[]>();
  for (const r of fkAggRows) {
    if (r.portfolioHoldingId == null) continue;
    const delta = Number(r.delta);
    qtyByHoldingId.set(
      r.portfolioHoldingId,
      (qtyByHoldingId.get(r.portfolioHoldingId) ?? 0) + delta,
    );
    const arr = costBucketsByHoldingId.get(r.portfolioHoldingId) ?? [];
    arr.push({
      enteredCurrency: String(r.enteredCurrency || "").toUpperCase(),
      buyQty: Number(r.totalBuyQty),
      buyAmountInEntered: Number(r.totalBuyAmountInEntered),
      sellQty: Number(r.totalSellQty),
    });
    costBucketsByHoldingId.set(r.portfolioHoldingId, arr);
  }

  // Price lookups — exclude currency-code symbols (CAD, USD, …) since
  // Yahoo returns unrelated stock data for those tickers. For asOfDate
  // == today use the regular live-quote endpoint; for past dates use
  // the historical chart endpoint.
  const stockSymbols = holdings
    .filter(h => h.symbol && !isCrypto(h.symbol) && h.isCrypto !== 1 && !isCurrencyCodeSymbol(h.symbol))
    .map(h => h.symbol!);
  const quotes = stockSymbols.length > 0
    ? (isToday
        ? await fetchMultipleQuotes(stockSymbols)
        : await fetchMultipleQuotesAtDate(stockSymbols, asOfDate))
    : new Map();

  const cgIds: string[] = [];
  for (const h of holdings) {
    if (h.isCrypto === 1 || isCrypto(h.symbol)) {
      const base = (h.symbol ?? "").toUpperCase().split("-")[0];
      const cg = symbolToCoinGeckoId(base);
      if (cg && !cgIds.includes(cg)) cgIds.push(cg);
    }
  }
  const cryptoPrices = cgIds.length > 0 ? await getCryptoPrices(cgIds) : [];
  const cryptoByUpperSymbol = new Map(cryptoPrices.map(p => [p.symbol.toUpperCase(), p]));

  // Accumulate market value per accountId, converting holding currency -> account currency via FX
  // Historical FX uses getRate(from, to, asOfDate) which triangulates via
  // USD using fx_rates cache + Yahoo backfill for missing dates.
  const out = new Map<number, AccountHoldingsValue>();
  const fxCache = new Map<string, number>();
  const getFx = async (from: string, to: string): Promise<number> => {
    if (from === to) return 1;
    const key = `${from}->${to}`;
    if (fxCache.has(key)) return fxCache.get(key)!;
    const rate = isToday
      ? await getLatestFxRate(from, to, userId)
      : await getRate(from, to, asOfDate, userId);
    fxCache.set(key, rate);
    return rate;
  };

  for (const h of holdings) {
    if (h.accountId == null) continue;
    const qty = qtyByHoldingId.get(h.id) ?? 0;
    if (qty <= 0) continue;

    const accountCurrency = h.accountCurrency ?? h.currency;
    let price: number | null = null;
    let priceCurrency: string = h.currency;

    if (h.symbol && isCurrencyCodeSymbol(h.symbol)) {
      // Symbol IS a currency code (CAD, USD, XAU, …) — foreign-cash or
      // metal position. For fiat-cash, price=1 in the symbol's currency
      // and the FX hop later converts to the account's currency.
      // For metals priced in a different currency (e.g. XAU in a USD
      // account), price = cross-rate so the value lands in h.currency,
      // mirroring the per-holding logic in /api/portfolio/overview.
      const symU = h.symbol.toUpperCase();
      if (isMetalCurrency(symU) && symU !== h.currency.toUpperCase()) {
        const rate = await getFx(symU, h.currency);
        if (rate > 0) {
          price = rate;
          priceCurrency = h.currency;
        } else {
          price = 1;
          priceCurrency = symU;
        }
      } else {
        price = 1;
        priceCurrency = symU;
      }
    } else if (h.symbol) {
      // Symbol-priced holding (stock, ETF, crypto).
      if (h.isCrypto === 1 || isCrypto(h.symbol)) {
        const cp = cryptoByUpperSymbol.get(h.symbol.toUpperCase().split("-")[0]);
        if (cp) {
          price = cp.price;
          // crypto-service returns CAD prices
          priceCurrency = "CAD";
        }
      } else {
        const q = quotes.get(h.symbol);
        if (q) {
          price = q.price;
          priceCurrency = q.currency ?? h.currency;
        }
      }
      if (price == null) continue;
    } else {
      // No symbol — treat as a currency-denominated cash position.
      // 1 unit = 1 unit of h.currency, so price=1 and the FX hop converts
      // from h.currency to the account's currency. Skips when both are
      // equal (FX rate=1 → just adds qty as-is).
      price = 1;
      priceCurrency = h.currency;
    }

    const fx = await getFx(priceCurrency, accountCurrency);
    const valueInAccountCcy = qty * price * fx;

    // Cost basis per holding: avg-cost (in HOLDING currency) × remaining
    // qty, then converted to account currency. Falls back to current
    // market value when no buy transactions exist (e.g. holdings imported
    // from a snapshot with quantity but no buy legs) — sets unrealized G/L
    // to 0 rather than fabricating a gain.
    //
    // Issue #129: per-currency bucketing. Each bucket carries
    // `buyAmountInEntered` in its own currency. FX-normalize each bucket
    // into the holding currency, sum, then divide by total buy qty. For a
    // USD ETF in a CAD account, the entered_amount is in USD — without the
    // hop the previous "transaction amount = account currency" approximation
    // produced a CAD figure mislabeled as USD/holding-ccy and inflated the
    // cost basis (and the unrealized P&L) for every cross-currency holding.
    const buckets = costBucketsByHoldingId.get(h.id) ?? [];
    let totalBuyQty = 0;
    let totalBuyAmountInHoldingCcy = 0;
    for (const b of buckets) {
      totalBuyQty += b.buyQty;
      const enteredCcy = b.enteredCurrency || h.currency;
      const fxToHoldingCcy = await getFx(enteredCcy, h.currency);
      totalBuyAmountInHoldingCcy += b.buyAmountInEntered * fxToHoldingCcy;
    }
    const avgCostInHoldingCcy = totalBuyQty > 0 ? totalBuyAmountInHoldingCcy / totalBuyQty : null;
    let costBasisInAccountCcy: number;
    if (avgCostInHoldingCcy != null) {
      const costBasisInHoldingCcy = qty * avgCostInHoldingCcy;
      const fxHoldingToAccount = await getFx(h.currency, accountCurrency);
      costBasisInAccountCcy = costBasisInHoldingCcy * fxHoldingToAccount;
    } else {
      costBasisInAccountCcy = valueInAccountCcy;
    }

    const existing = out.get(h.accountId);
    if (existing) {
      existing.value += valueInAccountCcy;
      existing.costBasis += costBasisInAccountCcy;
    } else {
      out.set(h.accountId, {
        accountId: h.accountId,
        value: valueInAccountCcy,
        costBasis: costBasisInAccountCcy,
        currency: accountCurrency,
      });
    }
  }

  return out;
}
