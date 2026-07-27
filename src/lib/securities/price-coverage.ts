/**
 * "Have we EVER priced this security?" — the detection behind the `unpriced`
 * ticker advisory (ticker-advisories.ts).
 *
 * `price_cache` is only ever written on a SUCCESSFUL provider fetch
 * (`writePriceCache` / `cacheCryptoPrice` run after the response parses), so a
 * held, auto-priced ticker with ZERO rows for its cache key has never once been
 * priced. That's a durable signal — unlike the in-process negative quote cache
 * in price-service.ts, which is per-process, expires after 10 minutes, and is
 * invisible to any request that isn't the one that just failed.
 *
 * The cache is global (not per-user): rows are keyed on the raw symbol, so a
 * ticker another user already priced counts as priced here too. That's correct
 * — the question is "can our providers price this symbol", not "has THIS user
 * loaded it yet" — and it leaks nothing (a hit only proves some row exists for
 * a public ticker; no user, quantity, or account is involved).
 *
 * Deliberately conservative — every exclusion in `isPriceCoverageCandidate`
 * exists to keep a false "we can't price this" off a security that is priced
 * fine through a different path.
 */

import { inArray } from "drizzle-orm";

import { db, schema } from "@/db";
import { isCryptoSymbol, isCurrencyCodeSymbol } from "@/lib/fx/supported-currencies";

export interface PriceCoverageCandidate {
  id: number;
  symbol: string | null;
  isCash: boolean;
  isCrypto: boolean;
  priceSource: string | null;
  /** How many accounts hold this security (0 = catalog-only entry). */
  heldIn: number;
  /** When the security row was created — drives the new-security grace period. */
  createdAt: Date | string | null;
}

/**
 * How long after creation a security is exempt from the check.
 *
 * Nothing records "we attempted to price this", so an empty cache means either
 * "the providers rejected it" OR "nothing has asked yet" — a brand-new security
 * has no row until the next page that prices holdings (dashboard, portfolio
 * overview, account charts) runs. Those fire on essentially any app load, so
 * the gap is normally seconds; an hour is a generous margin that keeps a
 * just-added VALID ticker from being announced as unpriceable.
 */
export const NEW_SECURITY_GRACE_MS = 60 * 60 * 1000;

/** True once `createdAt` is old enough for an empty cache to mean something. */
export function isPastGracePeriod(
  createdAt: Date | string | null | undefined,
  now: number = Date.now(),
  graceMs: number = NEW_SECURITY_GRACE_MS,
): boolean {
  if (createdAt == null) return true; // no stamp → treat as long-standing
  const ms = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
  if (Number.isNaN(ms)) return true;
  return now - ms > graceMs;
}

/**
 * The `price_cache` key a security's prices are written under. Crypto lives in
 * its own namespace (`CRYPTO:<SYM>`, upper-cased) — see crypto-service.ts;
 * everything else is cached under the symbol verbatim (price-service.ts writes
 * `writePriceCache(symbol, …)` with the holding's own string).
 *
 * MUST mirror those two writers — a drifted key here reads as "never priced"
 * for a perfectly healthy ticker.
 */
export function priceCacheKeyFor(symbol: string, isCrypto: boolean): string {
  const s = symbol.trim();
  return isCrypto || isCryptoSymbol(s) ? `CRYPTO:${s.toUpperCase()}` : s;
}

/**
 * Whether "has this ever been priced?" is even a meaningful question for a
 * security. Each `false` branch is a security that legitimately has no
 * `price_cache` row:
 *
 *  - no symbol / cash sleeve → valued at face, never quoted;
 *  - `price_source = 'manual'` → deliberately excluded from the providers and
 *    valued off `custom_security_prices`, so an empty cache is the POINT;
 *  - held in no account → a catalog-only entry nothing has ever asked to price;
 *  - a currency-code symbol (USD, EUR, XAU, …) → priced through fx-service
 *    (metals via front-month futures), which writes `fx_rates`, not
 *    `price_cache`. Same exclusion the portfolio aggregators apply before
 *    calling Yahoo (`isCurrencyCodeSymbol`);
 *  - created within the grace period → nothing has had a chance to price it.
 */
export function isPriceCoverageCandidate(c: PriceCoverageCandidate, now: number = Date.now()): boolean {
  const sym = c.symbol?.trim();
  if (!sym) return false;
  if (c.isCash) return false;
  if ((c.priceSource ?? "auto") !== "auto") return false;
  if (c.heldIn <= 0) return false;
  if (isCurrencyCodeSymbol(sym)) return false;
  if (!isPastGracePeriod(c.createdAt, now)) return false;
  return true;
}

/**
 * Ids of the securities that have never been priced. Non-candidates are never
 * included. One indexed `IN` over `price_cache.symbol`; best-effort — on any
 * DB error it returns an EMPTY set, i.e. "flag nothing", so a failed probe can
 * never fabricate a warning on a healthy ticker.
 *
 * Both the verbatim key and its upper-cased form are probed: cache rows are
 * written with whatever casing the holding carries, and a security renamed to a
 * different casing must not read as unpriced.
 */
export async function findNeverPricedSecurityIds(
  candidates: PriceCoverageCandidate[],
): Promise<Set<number>> {
  const keyById = new Map<number, string>();
  for (const c of candidates) {
    if (!isPriceCoverageCandidate(c)) continue;
    keyById.set(c.id, priceCacheKeyFor(c.symbol!, c.isCrypto));
  }
  if (keyById.size === 0) return new Set();

  const probe = new Set<string>();
  for (const key of keyById.values()) {
    probe.add(key);
    probe.add(key.toUpperCase());
  }

  try {
    const rows = await db
      .select({ symbol: schema.priceCache.symbol })
      .from(schema.priceCache)
      .where(inArray(schema.priceCache.symbol, [...probe]))
      .groupBy(schema.priceCache.symbol);
    const priced = new Set(rows.map((r) => r.symbol.toUpperCase()));
    const out = new Set<number>();
    for (const [id, key] of keyById) {
      if (!priced.has(key.toUpperCase())) out.add(id);
    }
    return out;
  } catch {
    return new Set();
  }
}
