/**
 * GET /api/portfolio/symbol-info?symbol=AAPL
 *
 * Inspects a symbol and reports what kind of holding it represents, so the
 * Edit Holding dialog can auto-fill the holding's currency:
 *
 *   - Stock/ETF (Yahoo recognizes it): returns price-currency from Yahoo
 *   - Currency code (matches an active fiat or crypto code): cash position
 *   - Crypto symbol (CoinGecko): treats as crypto (priced in USD via CoinGecko)
 *   - Unknown: caller falls back to the account's currency
 *
 * Lightweight — no DEK needed, just runs lookups against price/crypto services.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { fetchQuote } from "@/lib/price-service";
import { symbolToCoinGeckoId } from "@/lib/crypto-service";
import {
  isSupportedCurrency,
  isCryptoCurrency,
  currencyLabel,
  SUPPORTED_FIAT_CURRENCIES,
} from "@/lib/fx/supported-currencies";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";

export type SymbolInfo = {
  symbol: string;
  /** What sort of holding the symbol denotes */
  kind: "stock" | "etf" | "crypto" | "currency" | "unknown";
  /** Holding's price currency. null when unknown — caller defaults to account currency */
  currency: string | null;
  /** Friendly label for the field (e.g. "AAPL — Apple in USD") */
  label: string;
  /** True if the user almost certainly wants isCrypto=1 */
  isCrypto: boolean;
  /** Live spot price (when available) — diagnostic only, the dialog doesn't store it */
  price?: number;
  /** Where the info came from */
  source: "yahoo" | "coingecko" | "currency-list" | "active-currencies" | "none";
};

/**
 * Stock-style (Yahoo) symbols look like AAPL, VCN.TO, BRK-B, MSFT.
 * Currency codes are 3-4 capital letters. We use ordering to disambiguate
 * — a ticker that's also a currency code (rare; e.g. "BTC", "ETH") is
 * treated as crypto first since the holding is typically a coin position
 * rather than a cash position. The dialog's "Currency" override lets the
 * user correct this if they meant the latter.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  const raw = (request.nextUrl.searchParams.get("symbol") ?? "").trim();
  if (!raw) {
    return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
  }
  const symbol = raw.toUpperCase();

  // 1. Crypto via CoinGecko? (BTC, ETH, SOL, ...)
  const cgId = symbolToCoinGeckoId(symbol);
  if (cgId) {
    return NextResponse.json<SymbolInfo>({
      symbol,
      kind: "crypto",
      // CoinGecko reports prices in USD by convention — that's the price currency
      currency: "USD",
      label: `${symbol} — crypto, priced in USD`,
      isCrypto: true,
      source: "coingecko",
    });
  }

  // 2. Currency code (cash position)? Check supported list AND user's
  //    active list (so a user-added custom code like XAU is recognized).
  if (isSupportedCurrency(symbol)) {
    const isCrypto = isCryptoCurrency(symbol);
    return NextResponse.json<SymbolInfo>({
      symbol,
      kind: "currency",
      currency: symbol,
      label: `${symbol} — ${currencyLabel(symbol)} (cash position)`,
      isCrypto,
      source: "currency-list",
    });
  }
  // Active list (user-added custom currencies like XAU)
  const active = await readActiveCurrencies(auth.context.userId);
  if (active.includes(symbol)) {
    return NextResponse.json<SymbolInfo>({
      symbol,
      kind: "currency",
      currency: symbol,
      label: `${symbol} — custom cash position`,
      isCrypto: false,
      source: "active-currencies",
    });
  }

  // 3. Stock/ETF via Yahoo?
  if (/^[A-Z][A-Z0-9.\-]{0,14}$/.test(symbol)) {
    const quote = await fetchQuote(symbol);
    if (quote && quote.price > 0) {
      return NextResponse.json<SymbolInfo>({
        symbol,
        kind: "stock", // could be etf — Yahoo doesn't easily distinguish in this endpoint
        currency: quote.currency || null,
        label: quote.currency
          ? `${symbol} — priced in ${quote.currency}`
          : `${symbol} — recognized`,
        isCrypto: false,
        price: quote.price,
        source: "yahoo",
      });
    }
  }

  // 4. Unknown — caller falls back to account currency
  return NextResponse.json<SymbolInfo>({
    symbol,
    kind: "unknown",
    currency: null,
    label: `${symbol} — not recognized; will use the account's currency`,
    isCrypto: false,
    source: "none",
  });
}

async function readActiveCurrencies(userId: string): Promise<string[]> {
  const row = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(
      and(
        eq(schema.settings.key, "active_currencies"),
        eq(schema.settings.userId, userId)
      )
    )
    .limit(1);
  if (!row[0]?.value) return [];
  try {
    const parsed = JSON.parse(row[0].value);
    if (Array.isArray(parsed)) return parsed.map((s: string) => s.toUpperCase());
  } catch { /* fall through */ }
  return [];
}

// Re-export the supported currency list at this path so the dialog can
// suggest cash-position symbols without bundling another module path.
export const __SUPPORTED_FIAT_CURRENCIES = SUPPORTED_FIAT_CURRENCIES;
