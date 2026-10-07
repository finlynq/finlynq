/**
 * GET /api/securities/lookup?symbol=AAPL[&crypto=1] — best-effort ticker → name.
 *
 * Powers the "Add security" dialog's auto-fill so the user doesn't have to type
 * the name + currency. Crypto-aware:
 *   - crypto (the `crypto=1` flag OR a symbol CoinGecko recognizes) → resolves
 *     the coin's name via CoinGecko (e.g. BTC → "Bitcoin"), currency USD.
 *   - otherwise → Yahoo quote (`shortName` + quote currency).
 * Returns `isCrypto` so the dialog can auto-tick the crypto box for known coins.
 *
 * Purely advisory — on a miss / timeout it returns { found:false } and the user
 * fills the fields manually (dev's price caches are cold so live fetches can
 * time out; that's expected and non-blocking).
 *
 * Auth: requireAuth (no DEK — only the public quote/crypto services).
 */

import { apiHandler } from "@/lib/api-handler";
import { fetchQuoteLive } from "@/lib/price-service";
import { symbolToCoinGeckoId, getCryptoPrice } from "@/lib/crypto-service";
import { isIsin, normalizeIsin } from "@/lib/securities/isin";
import { resolveIsin } from "@/lib/securities/isin-resolve";

export const GET = apiHandler(
  { auth: "auth", fallbackMessage: "Lookup failed" },
  async ({ request }) => {
    const symbol = (request.nextUrl.searchParams.get("symbol") ?? "").trim();
    if (!symbol) return { found: false, isCrypto: false };
    const wantCrypto = request.nextUrl.searchParams.get("crypto") === "1";

    // An ISIN (GH #365): resolve to the Yahoo symbol and describe THAT. The
    // dialog swaps `symbol` into its Ticker field, since an ISIN never prices.
    if (isIsin(symbol)) {
      const isin = normalizeIsin(symbol);
      const match = await resolveIsin(isin);
      if (!match) return { found: false, isCrypto: false, resolvedFromIsin: null, isinNotFound: true };
      const quote = await fetchQuoteLive(match.symbol).catch(() => null);
      return {
        found: !!quote,
        name: match.name,
        currency: quote?.currency ?? null,
        isCrypto: false,
        symbol: match.symbol,
        resolvedFromIsin: isin,
      };
    }

    // Crypto path — requested OR a symbol CoinGecko knows (BTC, ETH, …).
    const cgId = symbolToCoinGeckoId(symbol);
    if (wantCrypto || cgId) {
      if (cgId) {
        const coin = await getCryptoPrice(cgId).catch(() => null);
        if (coin) {
          const name = coin.name && coin.name.toUpperCase() !== symbol.toUpperCase() ? coin.name : null;
          return { found: true, name, currency: "USD", isCrypto: true };
        }
      }
      // crypto requested but unknown coin — still crypto, no name to offer.
      return { found: false, isCrypto: true };
    }

    // Stock / ETF path (Yahoo). Must be the LIVE fetch — a cache-aware
    // `fetchQuote` would return name=symbol on a warm cache (price_cache has no
    // name column), which we'd discard as "no name". Live always carries the
    // `shortName`. `fetchQuoteLive` falls back to name=symbol only when Yahoo
    // itself has no shortName.
    const quote = await fetchQuoteLive(symbol).catch(() => null);
    if (!quote) return { found: false, isCrypto: false };
    const name =
      quote.name && quote.name.trim().toUpperCase() !== symbol.toUpperCase()
        ? quote.name.trim()
        : null;
    return { found: true, name, currency: quote.currency ?? null, isCrypto: false };
  },
);
