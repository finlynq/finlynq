/**
 * Per-ticker pricing advisories — tickers whose live/historical price data is
 * missing or unreliable from our market-data providers (Yahoo / CoinGecko),
 * paired with the recommended fix.
 *
 * Pure + data-only (no imports), so it can be used from a client component or a
 * server route alike.
 *
 * TWO sources, resolved by `resolveTickerAdvisory`:
 *
 *  1. `curated` — the hand-maintained `ADVISORIES` map below. A symbol lands
 *     here only when we've confirmed the provider can't price it AND there's a
 *     concrete alternative ticker for the SAME asset, so the UI can offer a
 *     one-click "Change to <suggested>". Seeded with POL (Polygon): the network
 *     migrated MATIC → POL 1:1 (Sept 2024), but Yahoo carries the price history
 *     only under the old `MATIC` ticker — `POL-USD` returns no closes — so a
 *     holding tracked as POL can't be priced historically (the snapshot rebuild
 *     keeps retrying and failing). The fix is to track it as MATIC, which both
 *     CoinGecko and Yahoo fully support.
 *
 *  2. `unpriced` — DETECTED at read time: a held, auto-priced ticker that has
 *     never produced a single `price_cache` row (see price-coverage.ts). This
 *     catches the case a curated map structurally cannot: a symbol the USER
 *     invented, which no registry can ever enumerate. Prod hit this with
 *     `AMZN401K` — an Amazon-in-a-401k position tracked under a made-up ticker.
 *     Yahoo 404s it forever (re-tried every 10 min once the in-process negative
 *     cache expires) while the holding silently shows no price and the user is
 *     told nothing. There's no replacement ticker to suggest here, so the
 *     advisory points at the two real fixes instead: correct the symbol, or
 *     switch the security to manual pricing.
 */

/** Where an advisory came from — drives which fix the UI offers. */
export type TickerAdvisoryKind = "curated" | "unpriced";

export interface TickerAdvisory {
  /** The affected ticker (always compared uppercased). */
  symbol: string;
  /** Recommended replacement ticker for the same asset, if any. */
  suggestedSymbol?: string;
  /** One-line, user-facing explanation + the suggested action. */
  message: string;
  /** `curated` = known symbol with a named replacement; `unpriced` = detected. */
  kind: TickerAdvisoryKind;
}

const ADVISORIES: Record<string, Omit<TickerAdvisory, "kind">> = {
  POL: {
    symbol: "POL",
    suggestedSymbol: "MATIC",
    message:
      "Polygon renamed MATIC to POL, but price history is only available under the MATIC ticker — POL prices may be missing or stale. Change this holding's ticker to MATIC (same asset, 1:1) for full pricing.",
  },
};

/**
 * Curated-registry lookup only. Returns null for a ticker that isn't in the
 * hand-maintained map — including one we've DETECTED as unpriceable. Prefer
 * `resolveTickerAdvisory`, which folds in the detected case too.
 */
export function getTickerAdvisory(symbol: string | null | undefined): TickerAdvisory | null {
  if (!symbol) return null;
  const hit = ADVISORIES[symbol.trim().toUpperCase()];
  return hit ? { ...hit, kind: "curated" } : null;
}

/**
 * Advisory for a ticker we've never managed to price. No `suggestedSymbol` —
 * the symbol is unknown to the provider, so there is nothing to suggest; the
 * caller offers "fix the symbol" / "price it manually" instead.
 */
export function unpricedTickerAdvisory(symbol: string): TickerAdvisory {
  const s = symbol.trim();
  return {
    symbol: s,
    kind: "unpriced",
    message: `We've never been able to fetch a price for ${s} — our market-data providers don't recognize this ticker. Check the symbol is correct, or switch this security to manual pricing and enter your own prices.`,
  };
}

/**
 * The advisory to show for a ticker, or null when it's fully supported.
 * A curated entry always wins: it names a concrete replacement, which is more
 * actionable than the generic "we can't price this" message.
 */
export function resolveTickerAdvisory(
  symbol: string | null | undefined,
  opts?: { neverPriced?: boolean },
): TickerAdvisory | null {
  const curated = getTickerAdvisory(symbol);
  if (curated) return curated;
  const s = symbol?.trim();
  if (opts?.neverPriced && s) return unpricedTickerAdvisory(s);
  return null;
}
