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
import { and, eq, isNotNull, lte, sql } from "drizzle-orm";
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
  const rawHoldings = await db
    .select({
      id: schema.portfolioHoldings.id,
      accountId: schema.portfolioHoldings.accountId,
      name: schema.portfolioHoldings.name,
      nameCt: schema.portfolioHoldings.nameCt,
      symbol: schema.portfolioHoldings.symbol,
      symbolCt: schema.portfolioHoldings.symbolCt,
      currency: schema.portfolioHoldings.currency,
      isCrypto: schema.portfolioHoldings.isCrypto,
      accountCurrency: schema.accounts.currency,
    })
    .from(schema.portfolioHoldings)
    .leftJoin(schema.accounts, eq(schema.portfolioHoldings.accountId, schema.accounts.id))
    .where(eq(schema.portfolioHoldings.userId, userId));

  if (rawHoldings.length === 0) return new Map();

  // Decrypt name + symbol — both are NULL plaintext on prod for Stream-D-
  // encrypted rows. Without this, the symbol-keyed price lookup misses.
  const holdings = decryptNamedRows(rawHoldings, dek ?? null, {
    nameCt: "name",
    symbolCt: "symbol",
  });

  // Aggregate remaining quantity AND cost-basis components per holding via
  // the integer FK. SQL-side GROUP BY runs on plaintext metadata — no
  // per-row decryption. qty>0 contributes (Finlynq-native amt<0+qty>0 and
  // WP convention amt>0+qty>0 are both buys); qty<0 contributes (already
  // negative, sells); qty=0 is a dividend for share-count purposes.
  // Mirrors /api/portfolio/overview's CASE. ABS(amount) for cost basis so
  // both amt-sign conventions yield positive cost.
  const fkAggRows = await db
    .select({
      portfolioHoldingId: schema.transactions.portfolioHoldingId,
      delta: sql<number>`COALESCE(SUM(
        CASE
          WHEN COALESCE(${schema.transactions.quantity}, 0) > 0 THEN ${schema.transactions.quantity}
          WHEN COALESCE(${schema.transactions.quantity}, 0) < 0 THEN ${schema.transactions.quantity}
          ELSE 0
        END
      ), 0)::float8`,
      totalBuyQty: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${schema.transactions.quantity}, 0) > 0 THEN ${schema.transactions.quantity} ELSE 0 END), 0)::float8`,
      totalBuyAmount: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${schema.transactions.quantity}, 0) > 0 THEN ABS(${schema.transactions.amount}) ELSE 0 END), 0)::float8`,
      totalSellQty: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${schema.transactions.quantity}, 0) < 0 THEN ABS(${schema.transactions.quantity}) ELSE 0 END), 0)::float8`,
    })
    .from(schema.transactions)
    .where(and(
      eq(schema.transactions.userId, userId),
      isNotNull(schema.transactions.portfolioHoldingId),
      lte(schema.transactions.date, asOfDate),
    ))
    .groupBy(schema.transactions.portfolioHoldingId);

  const qtyByHoldingId = new Map<number, number>();
  type CostAgg = { buyQty: number; buyAmount: number; sellQty: number };
  const costAggByHoldingId = new Map<number, CostAgg>();
  for (const r of fkAggRows) {
    if (r.portfolioHoldingId == null) continue;
    qtyByHoldingId.set(r.portfolioHoldingId, Number(r.delta));
    costAggByHoldingId.set(r.portfolioHoldingId, {
      buyQty: Number(r.totalBuyQty),
      buyAmount: Number(r.totalBuyAmount),
      sellQty: Number(r.totalSellQty),
    });
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

    // Cost basis per holding: avg-cost × remaining qty, in transaction
    // currency, then converted to account currency. Falls back to current
    // market value when no buy transactions exist (e.g. holdings imported
    // from a snapshot with quantity but no buy legs) — sets unrealized G/L
    // to 0 rather than fabricating a gain.
    const fkAgg = costAggByHoldingId.get(h.id);
    const buyQty = fkAgg?.buyQty ?? 0;
    const buyAmount = fkAgg?.buyAmount ?? 0;
    const avgCostInTxCcy = buyQty > 0 ? buyAmount / buyQty : null;
    let costBasisInAccountCcy: number;
    if (avgCostInTxCcy != null) {
      // Transaction amounts are stored in account currency for the row's
      // account, so no FX hop needed when the holding lives in the same
      // account. (Cross-currency holdings would need entered_currency
      // handling; the portfolio overview's per-currency bucket logic
      // covers that — for the dashboard balance number we accept the
      // approximation that transaction amounts == account currency.)
      costBasisInAccountCcy = qty * avgCostInTxCcy;
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
