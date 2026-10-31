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
 *     here only when we've confirmed the provider can't price it AND we know
 *     WHY, so the message can say what to do instead of the generic "check the
 *     symbol". Two shapes:
 *       - with `suggestedSymbol`: the SAME shares now trade under another
 *         ticker (a rename, or a notation Yahoo wants spelled differently), so
 *         the UI can offer a one-click "Change to <suggested>". Seeded with POL
 *         (Polygon): the network migrated MATIC → POL 1:1 (Sept 2024), but
 *         Yahoo carries the price history only under the old `MATIC` ticker —
 *         `POL-USD` returns no closes. The 2026-10-31 batch adds the renamed
 *         US listings prod kept 404-ing every 10 minutes (SQ, VIAC, HCP) and
 *         two Hong Kong codes entered without the `.HK` suffix.
 *       - WITHOUT `suggestedSymbol`: the position was converted at a share
 *         RATIO (SWN → 0.0867 EXE), so swapping the ticker alone would misstate
 *         the holding. The message names the successor and the ratio, and the
 *         UI falls back to "Fix symbol" / "Use manual price" so a human decides.
 *     EVERY replacement is checked live against Yahoo before it is added, and
 *     nothing that 404s goes in (COG's successor CTRA 404'd on 2026-10-31, so
 *     COG stays on the detected advisory). A replacement can also go STALE the
 *     other way: PARA — Paramount's 2022–2025 ticker — now belongs to a
 *     different company on Yahoo, so VIAC points at PSKY, not PARA.
 *
 *  2. `unpriced` — DETECTED at read time: a held, auto-priced ticker that has
 *     never produced a single `price_cache` row (see price-coverage.ts). This
 *     catches the case a curated map structurally cannot: a symbol the USER
 *     invented, which no registry can ever enumerate. Prod hit this with
 *     `AMZN401K` — an Amazon-in-a-401k position tracked under a made-up ticker.
 *     Yahoo 404s it forever (re-tried on an escalating back-off, 10 min → 24 h,
 *     once the in-process negative cache expires — see negative-quote-cache.ts)
 *     while the holding silently shows no price and the user is told nothing.
 *     There's no replacement ticker to suggest here, so the advisory points at
 *     the two real fixes instead: correct the symbol, or switch the security to
 *     manual pricing. Delisted names with no successor (WE, MULN, AMRS, IRNT,
 *     HIL, CPE, …) deliberately stay on this advisory.
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

  // ── Renamed US listings (verified live 2026-10-31). Yahoo serves the full
  // history under the NEW ticker and 404s the old one forever; the shares are
  // the same, so a ticker change is the whole fix.
  SQ: {
    symbol: "SQ",
    suggestedSymbol: "XYZ",
    message:
      "Block (formerly Square) changed its ticker from SQ to XYZ in January 2025 — SQ no longer prices. Change this holding's ticker to XYZ (same shares) for live and historical pricing.",
  },
  VIAC: {
    symbol: "VIAC",
    suggestedSymbol: "PSKY",
    message:
      "ViacomCBS became Paramount Global (PARA, 2022) and then Paramount Skydance (PSKY, August 2025) — VIAC no longer prices, and PARA now belongs to a different company. Change this holding's ticker to PSKY (one PSKY share per share, unless you took the cash election in the merger).",
  },
  HCP: {
    symbol: "HCP",
    suggestedSymbol: "DOC",
    message:
      "Healthpeak Properties changed its ticker from HCP to PEAK (2019) and then to DOC (2024) — HCP no longer prices. Change this holding's ticker to DOC (same shares) for live and historical pricing.",
  },

  // ── Hong Kong stock codes: Yahoo wants `<code>.HK` with no leading zero.
  // A bare number is ambiguous across exchanges, so this stays a per-ticker
  // suggestion the user confirms rather than a toYahooSymbol() rewrite.
  "03690": {
    symbol: "03690",
    suggestedSymbol: "3690.HK",
    message:
      "Hong Kong tickers need the .HK suffix and no leading zero — Yahoo doesn't recognize 03690. Change this holding's ticker to 3690.HK (Meituan, same shares).",
  },
  "9633": {
    symbol: "9633",
    suggestedSymbol: "9633.HK",
    message:
      "Hong Kong tickers need the .HK suffix — Yahoo doesn't recognize a bare 9633. Change this holding's ticker to 9633.HK (Nongfu Spring, same shares).",
  },

  // ── Acquired at a share RATIO. No `suggestedSymbol` on purpose: the one-click
  // ticker swap would keep the SWN quantity and overstate the position ~11x.
  SWN: {
    symbol: "SWN",
    message:
      "Southwestern Energy was acquired by Chesapeake (now Expand Energy, EXE) in October 2024 at 0.0867 EXE shares per SWN share — SWN no longer prices. Record the conversion (sell SWN, buy 0.0867 EXE per SWN share), or fix the symbol to EXE and adjust the quantity to match; changing the ticker alone would overstate the position about 11 times.",
  },
};

/** Every ticker in the curated registry, as keyed (for consistency tests). */
export function curatedAdvisorySymbols(): string[] {
  return Object.keys(ADVISORIES);
}

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
 * A curated entry always wins: it names a concrete replacement (or the exact
 * conversion the user has to record), which is more actionable than the
 * generic "we can't price this" message.
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
