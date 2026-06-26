/**
 * Outbound market-data fetch logger + wrapper.
 *
 * Wraps the handful of `fetch` calls to external price/FX/crypto providers
 * (Yahoo Finance, CoinGecko) so every outbound call is recorded into an
 * in-memory ring buffer — surfaced ONLY to admins at /admin/api-log. The point
 * is diagnostic: see EXACTLY which upstream APIs an operation (e.g. a snapshot
 * rebuild) calls, even when the local price_cache is warm.
 *
 * In-memory + HMR-safe (lives on `globalThis`, like the rebuild-progress
 * registry): cheap (one array push per call, NO DB write), bounded (last
 * LOG_CAP entries), and cleared on restart/deploy. Not persisted — the workflow
 * is "Clear → reproduce → view". `marketFetch` is a drop-in for `fetch` (same
 * signature), so call sites just swap `fetch(` → `marketFetch(`.
 */

export interface OutboundCall {
  id: number;
  at: string; // ISO timestamp (call start)
  provider: string; // yahoo | coingecko | stooq | <host>
  method: string;
  url: string;
  status: number; // HTTP status, or 0 on network error / timeout
  ok: boolean;
  ms: number; // duration
  error?: string; // present when the fetch threw (timeout / network)
}

const LOG_CAP = 1000;

const g = globalThis as typeof globalThis & {
  __pfOutboundLog?: OutboundCall[];
  __pfOutboundSeq?: number;
};
function logBuf(): OutboundCall[] {
  if (!g.__pfOutboundLog) g.__pfOutboundLog = [];
  return g.__pfOutboundLog;
}
function nextSeq(): number {
  g.__pfOutboundSeq = (g.__pfOutboundSeq ?? 0) + 1;
  return g.__pfOutboundSeq;
}

function providerOf(url: string): string {
  try {
    const host = new URL(url).host;
    if (host.includes("yahoo")) return "yahoo";
    if (host.includes("coingecko")) return "coingecko";
    if (host.includes("stooq")) return "stooq";
    return host;
  } catch {
    return "?";
  }
}

function record(entry: Omit<OutboundCall, "id" | "provider">): void {
  const buf = logBuf();
  buf.push({ ...entry, id: nextSeq(), provider: providerOf(entry.url) });
  // Trim to the cap (keep the newest).
  if (buf.length > LOG_CAP) buf.splice(0, buf.length - LOG_CAP);
}

/**
 * Persist an outbound provider failure to the diagnostics_log table (best-effort,
 * dynamic-import to avoid eagerly loading the DB-backed diagnostics module here).
 * The in-memory ring buffer above keeps ALL calls; this persists only failures.
 */
function persistOutboundError(url: string, status: number, ms: number, message: string): void {
  void import("@/lib/diagnostics/log")
    .then((m) => m.recordOutboundError(providerOf(url), url, status, ms, message))
    .catch(() => {});
}

/** Newest-first snapshot of the outbound log (for the admin view). */
export function getOutboundLog(): OutboundCall[] {
  return [...logBuf()].reverse();
}

/** How many calls are currently buffered (and the cap). */
export function getOutboundLogMeta(): { count: number; cap: number } {
  return { count: logBuf().length, cap: LOG_CAP };
}

/** Clear the outbound log (admin action). Returns the count cleared. */
export function clearOutboundLog(): number {
  const buf = logBuf();
  const n = buf.length;
  buf.length = 0;
  return n;
}

/**
 * Drop-in replacement for `fetch` that records the outbound call (URL, method,
 * status, duration, errors) into the ring buffer, then returns the response
 * unchanged. Never swallows errors — a throw is recorded AND re-thrown.
 */
export async function marketFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;
  const method = (init?.method ?? "GET").toUpperCase();
  const startedAt = Date.now();
  const at = new Date(startedAt).toISOString();
  try {
    const res = await fetch(input, init);
    const ms = Date.now() - startedAt;
    record({ at, method, url, status: res.status, ok: res.ok, ms });
    // Persist genuine provider failures (5xx). Routine 4xx (e.g. Yahoo 404 for a
    // missing ticker) are expected/noisy and stay out of the diagnostics table.
    if (res.status >= 500) {
      void persistOutboundError(url, res.status, ms, `HTTP ${res.status}`);
    }
    return res;
  } catch (err) {
    const ms = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    record({ at, method, url, status: 0, ok: false, ms, error: message });
    // Network error / timeout — persist it (these are the V3AA.L / XAU stalls).
    void persistOutboundError(url, 0, ms, message);
    throw err;
  }
}
