/**
 * ISIN → Yahoo symbol (GH #365). Server-only (outbound fetch).
 *
 * Yahoo's search endpoint resolves ISINs to its own symbols — exchange-listed
 * shares (`INE002A01018` → `RELIANCE.NS`) and, importantly, mutual funds that
 * have no exchange ticker at all (`INF209K01YN0` → `0P0000XVYH.BO`). Those
 * symbols price through the normal chart endpoint, so once resolved an ISIN
 * holding is an ordinary auto-priced holding.
 *
 * Results are cached in-process (HMR-safe on globalThis, like the other
 * market caches): an ISIN's listing almost never changes, so a hit is kept a
 * day and a miss an hour.
 */
import { marketFetch } from "@/lib/market-fetch";
import { isIsin, normalizeIsin } from "./isin";

const SEARCH_URL = "https://query2.finance.yahoo.com/v1/finance/search";
const TIMEOUT_MS = 4000;
const HIT_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 60 * 1000;
/** Quote types a holding can be; anything else (news, futures…) is skipped. */
const HOLDABLE = new Set(["EQUITY", "ETF", "MUTUALFUND"]);

export type IsinMatch = { symbol: string; name: string | null; quoteType: string; exchange: string | null };

type Entry = { value: IsinMatch | null; expires: number };
const g = globalThis as unknown as { __pfIsinCache?: Map<string, Entry> };
const cache = (g.__pfIsinCache ??= new Map<string, Entry>());

/** Pick the holdable quote Yahoo ranks first. Exported for tests. */
export function pickIsinQuote(quotes: unknown): IsinMatch | null {
  if (!Array.isArray(quotes)) return null;
  for (const q of quotes as Array<Record<string, unknown>>) {
    const symbol = typeof q.symbol === "string" ? q.symbol.trim() : "";
    const quoteType = typeof q.quoteType === "string" ? q.quoteType : "";
    if (!symbol || !HOLDABLE.has(quoteType)) continue;
    const name = [q.longname, q.shortname].find((n) => typeof n === "string" && n.trim() && n !== symbol);
    return {
      symbol,
      name: typeof name === "string" ? name.trim() : null,
      quoteType,
      exchange: typeof q.exchange === "string" ? q.exchange : null,
    };
  }
  return null;
}

/** Resolve an ISIN, or null when it isn't one or Yahoo has no holdable match. */
export async function resolveIsin(raw: string): Promise<IsinMatch | null> {
  if (!isIsin(raw)) return null;
  const isin = normalizeIsin(raw);
  const hit = cache.get(isin);
  if (hit && hit.expires > Date.now()) return hit.value;

  try {
    const res = await marketFetch(`${SEARCH_URL}?q=${encodeURIComponent(isin)}&quotesCount=5&newsCount=0`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null; // transient: don't cache
    const match = pickIsinQuote((await res.json())?.quotes);
    cache.set(isin, { value: match, expires: Date.now() + (match ? HIT_TTL_MS : MISS_TTL_MS) });
    return match;
  } catch {
    return null; // timeout / network: don't cache
  }
}

/**
 * The symbol to store for what the user typed: an ISIN that resolves becomes
 * its Yahoo symbol; anything else comes back unchanged (trimmed).
 */
export async function resolveTickerInput(raw: string): Promise<{ symbol: string; resolvedFromIsin: string | null; name: string | null }> {
  const trimmed = raw.trim();
  const match = await resolveIsin(trimmed);
  return match
    ? { symbol: match.symbol, resolvedFromIsin: normalizeIsin(trimmed), name: match.name }
    : { symbol: trimmed, resolvedFromIsin: null, name: null };
}
