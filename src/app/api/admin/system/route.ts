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

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
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
  const [activeRes, connRes, snapRes, topUsersRes, dirtyRes] = await Promise.all([
    db.execute(sql`
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
      ORDER BY query_start ASC NULLS LAST
      LIMIT 40
    `),
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
      SELECT user_id, count(*)::int AS rows
      FROM portfolio_snapshots
      GROUP BY user_id
      ORDER BY rows DESC
      LIMIT 8
    `),
    db.execute(sql`
      SELECT user_id,
             marked_at,
             EXTRACT(EPOCH FROM (now() - marked_at)) * 1000 AS age_ms
      FROM portfolio_snapshot_dirty
      ORDER BY marked_at ASC
      LIMIT 25
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
    rows: num(r.rows),
  }));
  const dirtyMarkers = normalizeDbRows(dirtyRes).map((r) => ({
    userId: (r.user_id as string) ?? "",
    markedAt: r.marked_at instanceof Date ? r.marked_at.toISOString() : String(r.marked_at),
    ageMs: Math.round(num(r.age_ms)),
  }));

  // --- Snapshot rebuilds (in-flight / recent) from the registry ---
  const rebuilds = getAllRebuildProgress().map((p) => ({
    userId: p.userId,
    running: p.running,
    daysProcessed: p.daysProcessed,
    totalDays: p.totalDays,
    startedAt: p.startedAt,
    finishedAt: p.finishedAt,
    error: p.error,
    lastResult: p.lastResult,
  }));
  const cashRebuildsInFlight = getCashRebuildsInFlight();

  // --- Outbound API summary (full log at /admin/api-log) ---
  const apiLog = getOutboundLog();
  const apiMeta = getOutboundLogMeta();
  const apiErrors = apiLog.filter((c) => !c.ok).length;
  const apiLastAt = apiLog[0]?.at ?? null;

  return NextResponse.json({
    system,
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
    cashRebuildsInFlight,
    api: {
      count: apiMeta.count,
      cap: apiMeta.cap,
      errors: apiErrors,
      lastAt: apiLastAt,
    },
  });
}
