/**
 * Asks GitHub for Finlynq's latest release, for a self-hosted install's What's
 * New page (GH #471). SERVER ONLY.
 *
 * - Only called on a self-hosted install (the route checks).
 * - `PF_UPDATE_CHECK=false` (or 0/no/off) turns it off for offline or
 *   air-gapped installs: the page then shows only the notes in the build.
 * - One request per server process every 6 hours (1 hour after a failure),
 *   kept on globalThis so HMR doesn't repeat it; 5 s timeout; never throws.
 * - Sends nothing about the install: a plain GET with a generic user agent.
 */
import { parseLatestRelease, type LatestRelease } from "./whats-new";

const LATEST_URL = "https://api.github.com/repos/finlynq/finlynq/releases/latest";
const OK_TTL_MS = 6 * 60 * 60 * 1000;
const FAIL_TTL_MS = 60 * 60 * 1000;

type CacheEntry = { at: number; ttl: number; latest: LatestRelease | null };
const g = globalThis as unknown as {
  __pfLatestRelease?: CacheEntry;
  __pfLatestReleaseInFlight?: Promise<LatestRelease | null>;
};

export function updateCheckEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.PF_UPDATE_CHECK ?? "").trim().toLowerCase();
  return !(v === "false" || v === "0" || v === "no" || v === "off");
}

export async function getLatestRelease(now = Date.now(), fetcher: typeof fetch = fetch): Promise<LatestRelease | null> {
  const hit = g.__pfLatestRelease;
  if (hit && now - hit.at < hit.ttl) return hit.latest;
  if (g.__pfLatestReleaseInFlight) return g.__pfLatestReleaseInFlight;
  g.__pfLatestReleaseInFlight = (async () => {
    let latest: LatestRelease | null = null;
    try {
      const res = await fetcher(LATEST_URL, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "finlynq-self-hosted" },
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) latest = parseLatestRelease(await res.json());
    } catch {
      latest = null;
    }
    g.__pfLatestRelease = { at: now, ttl: latest ? OK_TTL_MS : FAIL_TTL_MS, latest };
    return latest;
  })();
  try {
    return await g.__pfLatestReleaseInFlight;
  } finally {
    g.__pfLatestReleaseInFlight = undefined;
  }
}

/** Tests only. */
export function _resetLatestReleaseCache() {
  g.__pfLatestRelease = undefined;
  g.__pfLatestReleaseInFlight = undefined;
}
