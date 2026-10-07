/**
 * LIVE market-data fetches must bypass Next's fetch data cache.
 *
 * Next's `next: { revalidate: N }` is stale-while-revalidate: past the window
 * it hands the caller the PREVIOUS body and refreshes in the background, so
 * every price / rate we persisted was one fetch-generation old (measured on
 * prod 2026-07-29: yesterday's close stored as today's price). It saved no
 * calls — our own caches outlive any window we'd set.
 *
 * The fix was documented in CLAUDE.md on 2026-07-29 but sat uncommitted in a
 * stash until 2026-10-07, and nothing noticed: the docs said one thing, the
 * code another. This gate is what makes that drift visible. The two
 * HISTORICAL bar fetches keep `revalidate: 86400` — closed bars are
 * immutable, so a one-generation-old body is harmless there.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const read = (rel: string) => readFileSync(path.resolve(__dirname, "..", rel), "utf8");

/** The source of one function, from its signature to the next top-level declaration. */
function functionBody(src: string, signature: RegExp): string {
  const start = src.search(signature);
  expect(start, `function matching ${signature} not found`).toBeGreaterThan(-1);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n(export )?(async )?function /);
  const body = next === -1 ? rest : rest.slice(0, next);
  // Strip comments: the fix's own explanation quotes `next: { revalidate: N }`.
  return body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const LIVE_SITES: Array<[string, RegExp]> = [
  ["src/lib/price-service.ts", /export async function fetchQuoteLive\(/],
  ["src/lib/crypto-service.ts", /async function coinGeckoFetch\(/],
  ["src/lib/fx-service.ts", /async function fetchYahooChartRateToUsd\(/],
];

describe("live market-data fetches", () => {
  it.each(LIVE_SITES)("%s %s uses cache: no-store, never next.revalidate", (file, sig) => {
    const body = functionBody(read(file), sig);
    expect(body).toMatch(/cache:\s*"no-store"/);
    expect(body).not.toMatch(/next:\s*\{\s*revalidate/);
  });

  it("historical bar fetches keep their 24h revalidate", () => {
    const src = read("src/lib/price-service.ts");
    expect(src.match(/next:\s*\{\s*revalidate:\s*86400\s*\}/g)?.length ?? 0).toBe(2);
  });
});
