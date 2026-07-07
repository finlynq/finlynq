/**
 * Admin server-health diagnostics — /admin/system.
 *
 * One GET that answers "what is the CPU doing, and WHY":
 *   - system   : OS + process CPU/load/mem/disk + a rolling history (sampler in
 *                [src/lib/admin/system-metrics.ts]).
 *   - db       : live `pg_stat_activity` — active/long-running queries + conn
 *                counts. This is the reason-finder (it's how the snapshot
 *                rebuild that drives the CPU bursts is visible).
 *   - snapshots: portfolio_snapshots row totals, heaviest users, and stale
 *                `portfolio_snapshot_dirty` markers (each chart load re-heals).
 *   - rebuilds : in-flight / recent snapshot rebuilds from the HMR-safe registry.
 *   - api      : a summary of the outbound market-data log (full table lives at
 *                /admin/api-log).
 *
 * Hand-rolls `requireAdmin` + the managed-mode postgres-dialect guard, mirroring
 * the other /api/admin/* routes. Read-only; no DEK (nothing decrypted here).
 */

import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, getDialect } from "@/db";
import { normalizeDbRows } from "@/lib/db-utils";
import { requireAdmin } from "@/lib/auth/require-admin";
import { getSystemMetrics } from "@/lib/admin/system-metrics";
import { getAllRebuildProgress, getCashRebuildsInFlight } from "@/lib/portfolio/snapshots/rebuild";
import { getOutboundLog, getOutboundLogMeta } from "@/lib/market-fetch";
import { getEnvName } from "@/lib/diagnostics/env";

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
function isoOf(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v ?? "");
}

export async function GET(request: NextRequest) {
  if (getDialect() !== "postgres") {
    return NextResponse.json(
      { error: "Admin features are only available in managed mode." },
      { status: 403 },
    );
  }
  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;

  // --- System metrics (OS + process + rolling history) ---
  const system = await getSystemMetrics();

  // --- Live DB activity (same role sees its own app backends' query text) ---
  // Run the active-query probe FIRST + on its own, so the parallel stats queries
  // below aren't themselves captured as "active". Self-monitoring queries
  // (pg_stat_activity / the diagnostics tables) are filtered out by content.
  const activeRes = await db.execute(sql`
      SELECT pid,
             state,
             wait_event_type AS wait_event_type,
             usename,
             EXTRACT(EPOCH FROM (now() - query_start)) * 1000 AS runtime_ms,
             left(regexp_replace(query, '\\s+', ' ', 'g'), 220) AS query
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND backend_type = 'client backend'
        AND state IS DISTINCT FROM 'idle'
        AND query NOT ILIKE '%pg_stat_activity%'
        AND query NOT ILIKE '%diagnostics_log%'
        AND query NOT ILIKE '%op_rollup%'
        AND query NOT ILIKE '%system_metrics_sample%'
      ORDER BY query_start ASC NULLS LAST
      LIMIT 40
    `);

  const [connRes, snapRes, topUsersRes, dirtyRes, historyRes, topOpsRes] = await Promise.all([
    db.execute(sql`
      SELECT coalesce(state, 'unknown') AS state, count(*)::int AS c
      FROM pg_stat_activity
      WHERE datname = current_database()
      GROUP BY state
    `),
    db.execute(sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE source = 'cash')::int AS cash,
             count(*) FILTER (WHERE source <> 'cash')::int AS inv,
             max(snap_date) AS latest
      FROM portfolio_snapshots
    `),
    db.execute(sql`
      SELECT s.user_id, count(*)::int AS rows, u.username
      FROM portfolio_snapshots s
      LEFT JOIN users u ON u.id = s.user_id
      GROUP BY s.user_id, u.username
      ORDER BY rows DESC
      LIMIT 8
    `),
    db.execute(sql`
      SELECT d.user_id,
             d.marked_at,
             EXTRACT(EPOCH FROM (now() - d.marked_at)) * 1000 AS age_ms,
             u.username
      FROM portfolio_snapshot_dirty d
      LEFT JOIN users u ON u.id = d.user_id
      ORDER BY d.marked_at ASC
      LIMIT 25
    `),
    // Durable 24h CPU/load history, downsampled to 5-minute buckets (avg + peak).
    db.execute(sql`
      SELECT date_trunc('hour', at) + floor(extract(minute FROM at) / 5) * interval '5 minutes' AS bucket,
             avg(cpu_pct)::real AS cpu_avg,
             max(cpu_pct)::real AS cpu_max,
             avg(load1)::real AS load1
      FROM system_metrics_sample
      WHERE at > now() - interval '24 hours'
      GROUP BY bucket
      ORDER BY bucket ASC
    `),
    // Top operations by total wall-clock over the last 24h ("where to focus").
    db.execute(sql`
      SELECT op,
             sum(count)::bigint AS count,
             sum(total_ms)::bigint AS total_ms,
             sum(slow_count)::bigint AS slow_count,
             sum(error_count)::bigint AS error_count
      FROM op_rollup
      WHERE bucket > now() - interval '24 hours'
      GROUP BY op
      ORDER BY total_ms DESC
      LIMIT 30
    `),
  ]);

  const activeQueries = normalizeDbRows(activeRes).map((r) => ({
    pid: num(r.pid),
    state: (r.state as string) ?? null,
    waitEventType: (r.wait_event_type as string) ?? null,
    user: (r.usename as string) ?? null,
    runtimeMs: Math.round(num(r.runtime_ms)),
    query: (r.query as string) ?? "",
  }));

  const connCounts = normalizeDbRows(connRes).map((r) => ({
    state: (r.state as string) ?? "unknown",
    count: num(r.c),
  }));

  const snap = normalizeDbRows(snapRes)[0] ?? {};
  const topUsers = normalizeDbRows(topUsersRes).map((r) => ({
    userId: (r.user_id as string) ?? "",
    username: (r.username as string) ?? null,
    rows: num(r.rows),
  }));
  const dirtyMarkers = normalizeDbRows(dirtyRes).map((r) => ({
    userId: (r.user_id as string) ?? "",
    username: (r.username as string) ?? null,
    markedAt: r.marked_at instanceof Date ? r.marked_at.toISOString() : String(r.marked_at),
    ageMs: Math.round(num(r.age_ms)),
  }));

  // --- Durable 24h CPU history + top operations (Phase 2) ---
  const history24h = normalizeDbRows(historyRes).map((r) => ({
    at: isoOf(r.bucket),
    cpuAvg: Math.round(num(r.cpu_avg) * 10) / 10,
    cpuMax: Math.round(num(r.cpu_max) * 10) / 10,
    load1: Math.round(num(r.load1) * 100) / 100,
  }));
  const topOps = normalizeDbRows(topOpsRes).map((r) => ({
    op: (r.op as string) ?? "",
    count: num(r.count),
    totalMs: num(r.total_ms),
    slowCount: num(r.slow_count),
    errorCount: num(r.error_count),
  }));

  // --- Snapshot rebuilds (in-flight / recent) from the registry ---
  // The registry is keyed by userId only, so resolve usernames (plaintext) in
  // one lookup across every id we're about to display.
  const rebuildProgress = getAllRebuildProgress();
  const cashRebuildsInFlight = getCashRebuildsInFlight();
  const rebuildUserIds = Array.from(
    new Set([...rebuildProgress.map((p) => p.userId), ...cashRebuildsInFlight]),
  ).filter(Boolean);
  const usernameById = new Map<string, string>();
  if (rebuildUserIds.length > 0) {
    const nameRows = normalizeDbRows(
      await db.execute(
        // Drizzle expands a bare JS array into a comma-separated bind list
        // (`$1, $2`), which parses as a ROW — `ANY((…)::text[])` then throws
        // "cannot cast type record to text[]" (or "malformed array literal" for a
        // single id). Build an explicit ARRAY[...] so it binds as one text[]
        // (FINLYNQ-250, same class of bug as the reconcile.ts fix).
        sql`SELECT id, username FROM users WHERE id = ANY(ARRAY[${sql.join(
          rebuildUserIds.map((id) => sql`${id}`),
          sql`, `,
        )}]::text[])`,
      ),
    );
    for (const r of nameRows) {
      if (r.username) usernameById.set(r.id as string, r.username as string);
    }
  }
  const rebuilds = rebuildProgress.map((p) => ({
    userId: p.userId,
    username: usernameById.get(p.userId) ?? null,
    running: p.running,
    daysProcessed: p.daysProcessed,
    totalDays: p.totalDays,
    startedAt: p.startedAt,
    finishedAt: p.finishedAt,
    error: p.error,
    lastResult: p.lastResult,
  }));

  // --- Outbound API summary (full log at /admin/api-log) ---
  const apiLog = getOutboundLog();
  const apiMeta = getOutboundLogMeta();
  const apiErrors = apiLog.filter((c) => !c.ok).length;
  const apiLastAt = apiLog[0]?.at ?? null;

  return NextResponse.json({
    env: getEnvName(),
    system,
    history24h,
    topOps,
    db: {
      activeQueries,
      connCounts,
    },
    snapshots: {
      total: num(snap.total),
      cash: num(snap.cash),
      inv: num(snap.inv),
      latest: snap.latest ? String(snap.latest) : null,
      topUsers,
      dirtyMarkers,
    },
    rebuilds,
    cashRebuildsInFlight: cashRebuildsInFlight.map((userId) => ({
      userId,
      username: usernameById.get(userId) ?? null,
    })),
    api: {
      count: apiMeta.count,
      cap: apiMeta.cap,
      errors: apiErrors,
      lastAt: apiLastAt,
    },
  });
}
