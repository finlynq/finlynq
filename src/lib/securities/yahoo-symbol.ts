/**
 * Ticker-notation translation: how the user (or their brokerage statement)
 * spells a symbol → how Yahoo Finance spells it.
 *
 * Pure + data-only (no imports), so it is safe from a client component or a
 * server route alike. Distinct from [ticker-advisories.ts](./ticker-advisories.ts):
 * an advisory is a per-ticker DATA problem needing a human decision (the asset
 * genuinely moved to a different ticker); this is a mechanical NOTATION
 * difference for the same listing, so it can be applied silently at fetch time.
 *
 * Two rules, both confirmed live against Yahoo's chart API (2026-07-25):
 *
 *   1. US class shares use a DASH, not a dot. `BRK.B` 404s ("No data found,
 *      symbol may be delisted"); `BRK-B` returns 494.93 USD. This is the
 *      notation every brokerage statement prints, so it is what users type —
 *      and it silently produced permanently unpriceable holdings (zero
 *      `price_cache` rows, ever).
 *
 *   2. Warrants: NYSE/Google print a trailing `+` (Google Finance shows
 *      "NYSE: GME+"), Yahoo uses a `-WT` suffix. `GME+` 404s; `GME-WT` returns
 *      1.76 USD — matching Google's after-hours 1.76 for GME+ exactly.
 *      Confirmed on a second independent NYSE warrant, `IONQ-WT`.
 *
 * Yahoo's own search API canNOT resolve either form (`BRK.B` returns options
 * chains, `GME+` returns unrelated tickers), so an explicit mapping is the only
 * option.
 *
 * DELIBERATELY NARROW — the dot rule matches ONLY a single trailing A/B/C.
 * Every other dot is a Yahoo EXCHANGE suffix that must be preserved exactly:
 * `V3AA.L` (London), `SHOP.TO` (Toronto), `.AX`, `.DE`, `.PA`. Widening this to
 * "any single letter" would break `.L` and take every London listing offline.
 */

/** Trailing `.A` / `.B` / `.C` — US class shares. Anything longer is an exchange suffix. */
const CLASS_SHARE_SUFFIX = /^(.+)\.([ABC])$/i;

/**
 * Translate a user-facing ticker into the symbol Yahoo expects. Returns the
 * input unchanged when no rule applies — including for crypto (`BTC-USD`), FX
 * (`VNDUSD=X`), futures (`GC=F`), indices (`^GSPC`), and every non-US listing.
 *
 * Callers should keep using the ORIGINAL symbol for `price_cache` keys, the
 * negative cache, and display; only the outbound URL is translated.
 */
export function toYahooSymbol(symbol: string): string {
  const s = symbol.trim();
  if (!s) return s;

  // Warrants: "GME+" → "GME-WT".
  if (s.endsWith("+")) return `${s.slice(0, -1)}-WT`;

  // Class shares: "BRK.B" → "BRK-B". Note this only fires on a suffix, so the
  // Canadian mid-string form ("CTC.A.TO" → Yahoo's "CTC-A.TO") is NOT handled;
  // that listing stays unpriceable until someone asks for it.
  const classShare = CLASS_SHARE_SUFFIX.exec(s);
  if (classShare) return `${classShare[1]}-${classShare[2].toUpperCase()}`;

  return s;
}
