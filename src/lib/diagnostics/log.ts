/**
 * Persistent diagnostics log (admin-only, /admin/diagnostics).
 *
 * Unlike the in-memory `marketFetch` / system-metrics ring buffers (which reset
 * on every deploy/restart), this writes to the `diagnostics_log` TABLE so the
 * last N slow queries + errors survive restarts. It captures:
 *   - slow_query     — any DB query that took >= SLOW_QUERY_MS (default 2000ms)
 *   - db_error       — any DB query that threw (SQLSTATE in `code`)
 *   - api_error      — API route 5xx errors (hooked into logServerError)
 *   - outbound_error — Yahoo/CoinGecko fetch timeouts + provider 5xx (marketFetch)
 *
 * Capture is the WHOLE point, so every recorder is fire-and-forget and NEVER
 * throws — a logging failure must not break the request it's observing. The
 * table is global/plaintext (no user_id, no DEK) and trimmed to the newest
 * DIAGNOSTICS_CAP rows. Free-text (SQL text, error messages, URLs) is run through
 * the same `scrubSensitive` PII/secret scrubber the server log file uses.
 *
 * IMPORTANT — no static `@/db` import here: this module is imported by the DB
 * adapter (`instrumentPool`), so a static import of `@/db` would form an import
 * cycle. All DB access is `await import("@/db")` inside the functions.
 */

import { sql } from "drizzle-orm";
import { scrubSensitive } from "@/lib/server-logger";
import { currentOp } from "./op-context";
import { getEnvName } from "./env";

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** A DB query at/above this duration (ms) is logged as a slow query. */
export const SLOW_QUERY_MS = envInt("PF_SLOW_QUERY_MS", 2000);
/** Keep only the newest this-many rows; older rows are trimmed opportunistically. */
export const DIAGNOSTICS_CAP = envInt("PF_DIAGNOSTICS_CAP", 5000);

const DETAIL_MAX = 1000;
const MESSAGE_MAX = 1000;
const TRIM_EVERY = 200; // run the trim DELETE once per this-many inserts

export type DiagnosticKind = "slow_query" | "db_error" | "api_error" | "outbound_error";

interface DiagnosticEntry {
  kind: DiagnosticKind;
  durationMs?: number | null;
  source?: string | null;
  op?: string | null;
  detail?: string | null;
  message?: string | null;
  code?: string | null;
  meta?: Record<string, unknown> | null;
}

function normalizeSql(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
function trunc(s: string | null | undefined, max: number): string | null {
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

let sinceTrim = 0;
function maybeTrim(): void {
  sinceTrim += 1;
  if (sinceTrim < TRIM_EVERY) return;
  sinceTrim = 0;
  void trimOldest();
}

async function trimOldest(): Promise<void> {
  try {
    const { db } = await import("@/db");
    // Keep the newest DIAGNOSTICS_CAP ids; delete everything older. When the
    // table has <= cap rows the subselect is NULL and nothing is deleted.
    await db.execute(sql`
      DELETE FROM diagnostics_log
      WHERE id <= (SELECT id FROM diagnostics_log ORDER BY id DESC OFFSET ${DIAGNOSTICS_CAP} LIMIT 1)
    `);
  } catch {
    // best-effort
  }
}

/** Core fire-and-forget insert. Never throws. */
async function recordDiagnostic(entry: DiagnosticEntry): Promise<void> {
  try {
    const { db, schema } = await import("@/db");
    await db.insert(schema.diagnosticsLog).values({
      kind: entry.kind,
      durationMs: entry.durationMs ?? null,
      source: trunc(entry.source ?? null, 240),
      op: trunc(entry.op ?? null, 240),
      env: getEnvName(),
      detail: trunc(entry.detail ?? null, DETAIL_MAX),
      message: trunc(entry.message ?? null, MESSAGE_MAX),
      code: trunc(entry.code ?? null, 64),
      meta: entry.meta ?? null,
    });
    maybeTrim();
  } catch {
    // Logging must never break the observed request.
  }
}

export function recordSlowQuery(rawSql: string, ms: number, op?: string | null): void {
  void recordDiagnostic({
    kind: "slow_query",
    durationMs: Math.round(ms),
    source: "db",
    op: op ?? null,
    detail: scrubSensitive(normalizeSql(rawSql)),
  });
}

export function recordDbError(rawSql: string, ms: number, err: unknown, op?: string | null): void {
  const e = err as { message?: unknown; code?: unknown };
  const message = e?.message != null ? String(e.message) : String(err);
  void recordDiagnostic({
    kind: "db_error",
    durationMs: Math.round(ms),
    source: "db",
    op: op ?? null,
    detail: scrubSensitive(normalizeSql(rawSql)),
    message: scrubSensitive(message),
    code: e?.code != null ? String(e.code) : null,
  });
}

export function recordApiError(
  method: string,
  path: string,
  status: number,
  message: string,
  userId?: string,
): void {
  void recordDiagnostic({
    kind: "api_error",
    source: `${method} ${path}`,
    op: `${method} ${path}`,
    // logServerError already scrubs; double-scrub is idempotent + cheap.
    message: scrubSensitive(message),
    code: String(status),
    meta: userId ? { userId } : null,
  });
}

export function recordOutboundError(
  provider: string,
  url: string,
  status: number,
  ms: number,
  errMessage?: string,
): void {
  void recordDiagnostic({
    kind: "outbound_error",
    durationMs: Math.round(ms),
    source: provider,
    detail: scrubSensitive(url),
    message: errMessage ? scrubSensitive(errMessage) : null,
    code: String(status),
  });
}

// ─── Pool instrumentation ────────────────────────────────────────────────────
//
// Observe-only wrapper around the pg Pool. Drizzle runs normal queries through
// `pool.query` and transaction queries through a connected client's `query`, so
// we wrap BOTH. The wrapper only chains a `.then` for timing/error capture — it
// never alters the query, args, result, or rejection, so behaviour is identical.
//
// Recursion guard: our own diagnostics traffic (any SQL mentioning
// `diagnostics_log`) is passed straight through, untimed + unrecorded.

/* eslint-disable @typescript-eslint/no-explicit-any */

function sqlTextOf(args: any[]): string {
  const a0 = args[0];
  if (typeof a0 === "string") return a0;
  if (a0 && typeof a0 === "object" && typeof a0.text === "string") return a0.text;
  return "";
}

function observeQuery(orig: (...a: any[]) => any, args: any[]): any {
  // Callback form (last arg a function) → never wrap; pass straight through.
  if (typeof args[args.length - 1] === "function") return orig(...args);

  const text = sqlTextOf(args);
  if (!text || text.includes("diagnostics_log")) return orig(...args);

  // Attribute this query to the operation that triggered it (if any).
  const ctx = currentOp();
  const op = ctx?.op ?? null;

  const start = Date.now();
  let out: any;
  try {
    out = orig(...args);
  } catch (err) {
    recordDbError(text, Date.now() - start, err, op);
    throw err;
  }
  // Submittable / non-promise (Cursor, prepared statement) → return as-is.
  if (!out || typeof out.then !== "function") return out;

  return out.then(
    (res: unknown) => {
      const ms = Date.now() - start;
      if (ms >= SLOW_QUERY_MS) {
        if (ctx) ctx.slowQueries += 1;
        recordSlowQuery(text, ms, op);
      }
      return res;
    },
    (err: unknown) => {
      recordDbError(text, Date.now() - start, err, op);
      throw err;
    },
  );
}

function instrumentClient(client: any): void {
  if (!client || client.__pfInstrumented) return;
  client.__pfInstrumented = true;
  const origQuery = client.query.bind(client);
  client.query = (...args: any[]) => observeQuery(origQuery, args);
}

/**
 * Patch a pg.Pool so every query (and every transaction-client query) is timed
 * and error-captured into `diagnostics_log`. Idempotent. Called once from the
 * PostgresAdapter right after the pool is created.
 */
export function instrumentPool(pool: any): void {
  if (!pool || pool.__pfInstrumented) return;
  pool.__pfInstrumented = true;

  const origQuery = pool.query.bind(pool);
  pool.query = (...args: any[]) => observeQuery(origQuery, args);

  const origConnect = pool.connect.bind(pool);
  pool.connect = (...args: any[]) => {
    const ret = origConnect(...args);
    if (ret && typeof ret.then === "function") {
      return ret.then((client: any) => {
        instrumentClient(client);
        return client;
      });
    }
    return ret;
  };
}

/* eslint-enable @typescript-eslint/no-explicit-any */
