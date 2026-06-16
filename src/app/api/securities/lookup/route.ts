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
import { fetchQuote } from "@/lib/price-service";
import { symbolToCoinGeckoId, getCryptoPrice } from "@/lib/crypto-service";

export const GET = apiHandler(
  { auth: "auth", fallbackMessage: "Lookup failed" },
  async ({ request }) => {
    const symbol = (request.nextUrl.searchParams.get("symbol") ?? "").trim();
    if (!symbol) return { found: false, isCrypto: false };
    const wantCrypto = request.nextUrl.searchParams.get("crypto") === "1";

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

    // Stock / ETF path (Yahoo). `fetchQuote` falls back to name=symbol when
    // there's no shortName — in that case there's no real description.
    const quote = await fetchQuote(symbol).catch(() => null);
    if (!quote) return { found: false, isCrypto: false };
    const name =
      quote.name && quote.name.trim().toUpperCase() !== symbol.toUpperCase()
        ? quote.name.trim()
        : null;
    return { found: true, name, currency: quote.currency ?? null, isCrypto: false };
  },
);
