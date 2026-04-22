/**
 * Compute current market value of portfolio holdings grouped by account.
 *
 * Returns a map of accountId -> { value, currency } where value is in the
 * account's native currency. Callers that display balances in a different
 * currency should apply their own FX conversion downstream.
 */

import { db, schema } from "@/db";
import { and, eq, isNotNull } from "drizzle-orm";
import { fetchMultipleQuotes } from "@/lib/price-service";
import { getCryptoPrices, symbolToCoinGeckoId } from "@/lib/crypto-service";
import { getLatestFxRate } from "@/lib/fx-service";
import { decryptField } from "@/lib/crypto/envelope";

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

export type AccountHoldingsValue = { accountId: number; value: number; currency: string };

export async function getHoldingsValueByAccount(userId: string, dek?: Buffer | null): Promise<Map<number, AccountHoldingsValue>> {
  const holdings = await db
    .select({
      id: schema.portfolioHoldings.id,
      accountId: schema.portfolioHoldings.accountId,
      name: schema.portfolioHoldings.name,
      symbol: schema.portfolioHoldings.symbol,
      currency: schema.portfolioHoldings.currency,
      isCrypto: schema.portfolioHoldings.isCrypto,
      accountCurrency: schema.accounts.currency,
    })
    .from(schema.portfolioHoldings)
    .leftJoin(schema.accounts, eq(schema.portfolioHoldings.accountId, schema.accounts.id))
    .where(eq(schema.portfolioHoldings.userId, userId));

  if (holdings.length === 0) return new Map();

  // Aggregate remaining quantity per holding name. `portfolio_holding` may be
  // AES-GCM ciphertext (random IV per row), so we can't GROUP BY on it at the
  // SQL layer — fetch raw rows and aggregate in memory after decryption.
  const txRows = await db
    .select({
      portfolioHolding: schema.transactions.portfolioHolding,
      quantity: schema.transactions.quantity,
      amount: schema.transactions.amount,
    })
    .from(schema.transactions)
    .where(and(isNotNull(schema.transactions.portfolioHolding), eq(schema.transactions.userId, userId)));

  const qtyByHoldingName = new Map<string, number>();
  for (const r of txRows) {
    if (!r.portfolioHolding) continue;
    const name = dek ? (decryptField(dek, r.portfolioHolding) ?? "") : r.portfolioHolding;
    if (!name) continue;
    const qty = Number(r.quantity ?? 0);
    const delta =
      r.amount < 0 ? qty :
      r.amount > 0 && qty < 0 ? qty : // sell row: quantity is negative, delta already negative
      0;
    qtyByHoldingName.set(name, (qtyByHoldingName.get(name) ?? 0) + delta);
  }

  // Price lookups
  const stockSymbols = holdings.filter(h => h.symbol && !isCrypto(h.symbol) && h.isCrypto !== 1).map(h => h.symbol!);
  const quotes = stockSymbols.length > 0 ? await fetchMultipleQuotes(stockSymbols) : new Map();

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
  const out = new Map<number, AccountHoldingsValue>();
  const fxCache = new Map<string, number>();
  const getFx = async (from: string, to: string): Promise<number> => {
    if (from === to) return 1;
    const key = `${from}->${to}`;
    if (fxCache.has(key)) return fxCache.get(key)!;
    const rate = await getLatestFxRate(from, to, userId);
    fxCache.set(key, rate);
    return rate;
  };

  for (const h of holdings) {
    if (h.accountId == null) continue;
    const qty = qtyByHoldingName.get(h.name) ?? 0;
    if (qty <= 0 || !h.symbol) continue;

    let price: number | null = null;
    let priceCurrency: string = h.currency;

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

    const accountCurrency = h.accountCurrency ?? h.currency;
    const fx = await getFx(priceCurrency, accountCurrency);
    const valueInAccountCcy = qty * price * fx;

    const existing = out.get(h.accountId);
    if (existing) existing.value += valueInAccountCcy;
    else out.set(h.accountId, { accountId: h.accountId, value: valueInAccountCcy, currency: accountCurrency });
  }

  return out;
}
