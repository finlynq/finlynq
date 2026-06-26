"use client";

/**
 * /admin/system — operator-only "Server Health" view.
 *
 * Answers "what is the CPU doing, and WHY" in one place:
 *   - System health  : load avg, system + process CPU%, memory, disk, uptime,
 *                      plus a rolling CPU history sparkline (the box is bursty,
 *                      so a current-only gauge hides spikes).
 *   - Active queries : live pg_stat_activity — the reason-finder (this is how a
 *                      snapshot rebuild churning the CPU shows up).
 *   - Snapshot work  : in-flight / recent rebuilds, stale dirty markers, and the
 *                      heaviest users by snapshot-row count.
 *   - Outbound API   : summary card linking to the full /admin/api-log.
 *
 * Data is admin-gated by /api/admin/system. In-memory history (resets on deploy).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  Server,
  Cpu,
  Database,
  Activity,
  RefreshCw,
  Clock,
  AlertTriangle,
  ExternalLink,
  History,
  Gauge,
} from "lucide-react";

interface SysSample {
  at: number;
  load1: number;
  cpuPct: number;
  procCpuPct: number;
  memUsedMb: number;
  memTotalMb: number;
  rssMb: number;
}
interface SystemMetrics {
  at: number;
  hostname: string;
  platform: string;
  nodeVersion: string;
  cores: number;
  loadavg: [number, number, number];
  cpuPct: number;
  procCpuPct: number;
  memTotalMb: number;
  memUsedMb: number;
  memFreeMb: number;
  rssMb: number;
  osUptimeS: number;
  procUptimeS: number;
  disk: { totalGb: number; usedGb: number; freeGb: number; usedPct: number } | null;
  history: SysSample[];
}
interface ActiveQuery {
  pid: number;
  state: string | null;
  waitEventType: string | null;
  user: string | null;
  runtimeMs: number;
  query: string;
}
interface Rebuild {
  userId: string;
  running: boolean;
  daysProcessed: number;
  totalDays: number;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  lastResult: { daysProcessed: number; gapsFilledDays: number } | null;
}
interface Hist24 {
  at: string;
  cpuAvg: number;
  cpuMax: number;
  load1: number;
}
interface TopOp {
  op: string;
  count: number;
  totalMs: number;
  slowCount: number;
  errorCount: number;
}
interface ApiResponse {
  env: string;
  system: SystemMetrics;
  history24h: Hist24[];
  topOps: TopOp[];
  db: { activeQueries: ActiveQuery[]; connCounts: { state: string; count: number }[] };
  snapshots: {
    total: number;
    cash: number;
    inv: number;
    latest: string | null;
    topUsers: { userId: string; rows: number }[];
    dirtyMarkers: { userId: string; markedAt: string; ageMs: number }[];
  };
  rebuilds: Rebuild[];
  cashRebuildsInFlight: string[];
  api: { count: number; cap: number; errors: number; lastAt: string | null };
}

const POLL_MS = 5000;

function pctColor(p: number): string {
  if (p >= 85) return "text-rose-600";
  if (p >= 60) return "text-amber-600";
  return "text-emerald-600";
}
function barColor(p: number): string {
  if (p >= 85) return "bg-rose-500";
  if (p >= 60) return "bg-amber-500";
  return "bg-emerald-500";
}
function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
function fmtUptime(sec: number): string {
  return fmtDuration(sec * 1000);
}
function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}
function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)}m`;
  return `${(m / 60).toFixed(1)}h`;
}
function hourLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** CSP-safe inline-SVG sparkline (presentation attributes, no style=). */
function MiniSpark({ values, max, stroke }: { values: number[]; max: number; stroke: string }) {
  const W = 240;
  const H = 36;
  if (values.length < 2) {
    return <div className="text-xs text-muted-foreground">collecting…</div>;
  }
  const n = values.length;
  const top = Math.max(max, 1);
  const pts = values
    .map((v, i) => {
      const x = (i / (n - 1)) * W;
      const y = H - Math.max(0, Math.min(1, v / top)) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const areaPts = `0,${H} ${pts} ${W},${H}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-9 w-full" aria-hidden>
      <polygon points={areaPts} fill={stroke} fillOpacity={0.12} />
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth={1.5} />
    </svg>
  );
}

/** Durable 24h CPU chart: avg (filled red) + peak (amber line), 0-100%. */
function History24Chart({ points }: { points: Hist24[] }) {
  const W = 800;
  const H = 90;
  if (points.length < 2) {
    return (
      <div className="py-6 text-center text-xs text-muted-foreground">
        Collecting 24h history… (a durable sample is stored ~every minute)
      </div>
    );
  }
  const n = points.length;
  const xy = (v: number, i: number) => {
    const x = (i / (n - 1)) * W;
    const y = H - Math.max(0, Math.min(1, v / 100)) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  };
  const avgPts = points.map((p, i) => xy(p.cpuAvg, i)).join(" ");
  const maxPts = points.map((p, i) => xy(p.cpuMax, i)).join(" ");
  const area = `0,${H} ${avgPts} ${W},${H}`;
  const peak = Math.max(...points.map((p) => p.cpuMax));
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-24 w-full text-muted-foreground" aria-hidden>
        {[25, 50, 75].map((gp) => (
          <line
            key={gp}
            x1={0}
            x2={W}
            y1={H - (gp / 100) * H}
            y2={H - (gp / 100) * H}
            stroke="currentColor"
            strokeOpacity={0.1}
            strokeWidth={1}
          />
        ))}
        <polygon points={area} fill="#ef4444" fillOpacity={0.1} />
        <polyline points={maxPts} fill="none" stroke="#f59e0b" strokeWidth={1} strokeOpacity={0.7} />
        <polyline points={avgPts} fill="none" stroke="#ef4444" strokeWidth={1.5} />
      </svg>
      <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{hourLabel(points[0].at)}</span>
        <span className="flex items-center gap-3">
          <span className="text-rose-500">● avg</span>
          <span className="text-amber-500">● peak</span>
          <span>24h peak {peak.toFixed(0)}%</span>
        </span>
        <span>now</span>
      </div>
    </div>
  );
}

function Bar({ pct, label, value }: { pct: number; label: string; value: string }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-semibold tabular-nums">{value}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          ref={(el) => {
            if (el) el.style.width = `${clamped}%`;
          }}
          className={`h-full rounded-full ${barColor(pct)}`}
        />
      </div>
    </div>
  );
}

export default function AdminSystemPage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/system", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
    if (auto) timer.current = setInterval(() => void load(), POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [auto, load]);

  const sys = data?.system;
  const cpuHistory = useMemo(() => (sys?.history ?? []).map((h) => h.cpuPct), [sys]);
  const procHistory = useMemo(() => (sys?.history ?? []).map((h) => h.procCpuPct), [sys]);
  const loadHistory = useMemo(() => (sys?.history ?? []).map((h) => h.load1), [sys]);

  const queryColumns = useMemo<DataTableColumn<ActiveQuery>[]>(
    () => [
      { key: "pid", header: "PID", align: "right", accessor: (r) => r.pid },
      {
        key: "runtimeMs",
        header: "Running",
        align: "right",
        accessor: (r) => r.runtimeMs,
        render: (r) => (
          <span className={r.runtimeMs > 5000 ? "font-semibold text-amber-600" : ""}>
            {fmtDuration(r.runtimeMs)}
          </span>
        ),
      },
      {
        key: "state",
        header: "State",
        accessor: (r) => r.state ?? "",
        filter: "select",
        render: (r) => (
          <Badge variant="outline" className="text-[10px]">
            {r.state ?? "—"}
          </Badge>
        ),
      },
      {
        key: "waitEventType",
        header: "Wait",
        accessor: (r) => r.waitEventType ?? "",
        render: (r) => <span className="text-muted-foreground">{r.waitEventType ?? "—"}</span>,
      },
      {
        key: "query",
        header: "Query",
        accessor: (r) => r.query,
        filter: "text",
        render: (r) => (
          <span className="font-mono text-xs break-all text-muted-foreground" title={r.query}>
            {r.query || "—"}
          </span>
        ),
      },
    ],
    [],
  );

  const topOpColumns = useMemo<DataTableColumn<TopOp>[]>(
    () => [
      {
        key: "op",
        header: "Operation",
        accessor: (r) => r.op,
        filter: "text",
        render: (r) => <span className="font-mono text-xs">{r.op}</span>,
      },
      {
        key: "count",
        header: "Calls",
        align: "right",
        accessor: (r) => r.count,
        render: (r) => <span className="tabular-nums">{r.count.toLocaleString()}</span>,
      },
      {
        key: "totalMs",
        header: "Total time",
        align: "right",
        accessor: (r) => r.totalMs,
        render: (r) => <span className="font-semibold tabular-nums">{fmtMs(r.totalMs)}</span>,
      },
      {
        key: "avg",
        header: "Avg",
        align: "right",
        accessor: (r) => (r.count ? r.totalMs / r.count : 0),
        render: (r) => (
          <span className="tabular-nums text-muted-foreground">
            {fmtMs(r.count ? r.totalMs / r.count : 0)}
          </span>
        ),
      },
      {
        key: "slowCount",
        header: "Slow",
        align: "right",
        accessor: (r) => r.slowCount,
        render: (r) =>
          r.slowCount ? (
            <span className="text-amber-600">{r.slowCount.toLocaleString()}</span>
          ) : (
            <span className="text-muted-foreground">0</span>
          ),
      },
      {
        key: "errorCount",
        header: "Errors",
        align: "right",
        accessor: (r) => r.errorCount,
        render: (r) =>
          r.errorCount ? (
            <span className="text-rose-600">{r.errorCount.toLocaleString()}</span>
          ) : (
            <span className="text-muted-foreground">0</span>
          ),
      },
    ],
    [],
  );

  return (
    <div className="max-w-7xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Server className="h-5 w-5 text-primary" />
            <h1 className="text-2xl font-bold tracking-tight">Server Health</h1>
            {data?.env && (
              <Badge variant="outline" className="ml-1 uppercase">
                {data.env}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Live CPU / memory / disk, active database queries, and snapshot-rebuild activity. CPU /
            memory / disk are <span className="font-medium text-foreground">the whole VPS</span> (prod
            and dev share this box); database queries, snapshots and rebuilds are{" "}
            <span className="font-medium text-foreground">this environment only</span>.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={auto}
              onChange={(e) => setAuto(e.target.checked)}
              className="h-3.5 w-3.5 accent-primary"
            />
            Auto-refresh
          </label>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`mr-1.5 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <Card className="border-rose-200 bg-rose-50/30">
          <CardContent className="py-3 text-sm text-rose-700">{error}</CardContent>
        </Card>
      )}

      {sys && (
        <>
          {/* System health */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Cpu className="h-4 w-4 text-primary" /> System
                <Badge variant="outline" className="text-[10px] font-normal">
                  whole VPS
                </Badge>
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  {sys.hostname} · {sys.cores} cores · node {sys.nodeVersion} · up{" "}
                  {fmtUptime(sys.osUptimeS)}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    Load avg (1 / 5 / 15m)
                  </div>
                  <div className="mt-0.5 font-mono text-lg tabular-nums">
                    <span className={pctColor((sys.loadavg[0] / sys.cores) * 100)}>
                      {sys.loadavg[0].toFixed(2)}
                    </span>{" "}
                    / {sys.loadavg[1].toFixed(2)} / {sys.loadavg[2].toFixed(2)}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {((sys.loadavg[0] / sys.cores) * 100).toFixed(0)}% of {sys.cores} cores
                  </div>
                  <div className="mt-2">
                    <MiniSpark values={loadHistory} max={sys.cores} stroke="#6366f1" />
                  </div>
                </div>

                <div>
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    System CPU
                  </div>
                  <div className={`mt-0.5 text-2xl font-bold tabular-nums ${pctColor(sys.cpuPct)}`}>
                    {sys.cpuPct.toFixed(0)}%
                  </div>
                  <div className="mt-2">
                    <MiniSpark values={cpuHistory} max={100} stroke="#ef4444" />
                  </div>
                </div>

                <div>
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    App process CPU
                  </div>
                  <div className="mt-0.5 text-2xl font-bold tabular-nums">
                    {sys.procCpuPct.toFixed(0)}%
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    RSS {(sys.rssMb / 1024).toFixed(2)} GB · % of one core
                  </div>
                  <div className="mt-2">
                    <MiniSpark values={procHistory} max={100} stroke="#f59e0b" />
                  </div>
                </div>

                <div className="space-y-4">
                  <Bar
                    pct={sys.memTotalMb > 0 ? (sys.memUsedMb / sys.memTotalMb) * 100 : 0}
                    label="Memory"
                    value={`${(sys.memUsedMb / 1024).toFixed(1)} / ${(sys.memTotalMb / 1024).toFixed(1)} GB`}
                  />
                  {sys.disk && (
                    <Bar
                      pct={sys.disk.usedPct}
                      label="Disk"
                      value={`${sys.disk.usedGb} / ${sys.disk.totalGb} GB (${sys.disk.usedPct}%)`}
                    />
                  )}
                </div>
              </div>

              {/* Durable 24h CPU history (survives restarts) */}
              <div>
                <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                  <History className="h-3.5 w-3.5" /> System CPU · last 24h (whole VPS)
                </div>
                <History24Chart points={data?.history24h ?? []} />
              </div>
            </CardContent>
          </Card>

          {/* Top operations (24h) — where time goes / where to focus */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Gauge className="h-4 w-4 text-primary" /> Top operations · last 24h
                <Badge variant="outline" className="text-[10px] font-normal">
                  this env
                </Badge>
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  what consumed time — routes, rebuilds, jobs (ranked by total wall-clock)
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto p-2">
              <DataTable<TopOp>
                columns={topOpColumns}
                rows={data?.topOps ?? []}
                rowKey={(r) => r.op}
                emptyState={
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    {loading
                      ? "Loading…"
                      : "No operations recorded in the last 24h yet (rollup builds as traffic flows)."}
                  </p>
                }
              />
            </CardContent>
          </Card>

          {/* Active DB queries */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Database className="h-4 w-4 text-primary" /> Active database queries
                <Badge variant="outline" className="text-[10px] font-normal">
                  this env
                </Badge>
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  {data?.db.activeQueries.length ?? 0} active
                  {data?.db.connCounts.length
                    ? ` · ${data.db.connCounts.map((c) => `${c.count} ${c.state}`).join(", ")}`
                    : ""}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto p-2">
              <DataTable<ActiveQuery>
                columns={queryColumns}
                rows={data?.db.activeQueries ?? []}
                rowKey={(r) => r.pid}
                emptyState={
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    {loading ? "Loading…" : "No active queries right now — the database is idle."}
                  </p>
                }
              />
            </CardContent>
          </Card>

          {/* Snapshot rebuild activity */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <History className="h-4 w-4 text-primary" /> Snapshot rebuild activity
                <Badge variant="outline" className="text-[10px] font-normal">
                  this env
                </Badge>
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  {data?.snapshots.total.toLocaleString() ?? 0} rows (
                  {data?.snapshots.cash.toLocaleString() ?? 0} cash ·{" "}
                  {data?.snapshots.inv.toLocaleString() ?? 0} investment)
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              {/* In-flight / recent rebuilds */}
              <div>
                <div className="mb-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
                  Rebuilds (this server process)
                </div>
                {data && data.rebuilds.length === 0 && data.cashRebuildsInFlight.length === 0 ? (
                  <p className="text-muted-foreground">No rebuilds have run since the last restart.</p>
                ) : (
                  <div className="space-y-1.5">
                    {data?.rebuilds.map((r) => (
                      <div
                        key={r.userId}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-1.5"
                      >
                        {r.running ? (
                          <Badge className="bg-amber-500/15 text-amber-700">running</Badge>
                        ) : r.error ? (
                          <Badge className="bg-rose-500/15 text-rose-700">error</Badge>
                        ) : (
                          <Badge variant="outline">done</Badge>
                        )}
                        <span className="font-mono text-xs" title={r.userId}>
                          {shortId(r.userId)}
                        </span>
                        {r.running ? (
                          <span className="tabular-nums text-muted-foreground">
                            day {r.daysProcessed}/{r.totalDays || "?"}
                          </span>
                        ) : r.lastResult ? (
                          <span className="text-muted-foreground">
                            rebuilt {r.lastResult.daysProcessed} days
                          </span>
                        ) : null}
                        {r.error && <span className="text-rose-600">{r.error}</span>}
                      </div>
                    ))}
                    {data?.cashRebuildsInFlight.map((u) => (
                      <div
                        key={`cash-${u}`}
                        className="flex items-center gap-3 rounded-md border px-3 py-1.5"
                      >
                        <Badge className="bg-amber-500/15 text-amber-700">cash running</Badge>
                        <span className="font-mono text-xs" title={u}>
                          {shortId(u)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Stale dirty markers */}
              {data && data.snapshots.dirtyMarkers.length > 0 && (
                <div>
                  <div className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
                    <AlertTriangle className="h-3.5 w-3.5" /> Dirty markers (trigger a rebuild on next
                    chart load)
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {data.snapshots.dirtyMarkers.map((m) => (
                      <Badge
                        key={m.userId}
                        variant="outline"
                        className={m.ageMs > 86400000 ? "border-amber-400 text-amber-700" : ""}
                        title={`${m.userId} · marked ${m.markedAt}`}
                      >
                        {shortId(m.userId)} · {fmtDuration(m.ageMs)} old
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* Heaviest users */}
              {data && data.snapshots.topUsers.length > 0 && (
                <div>
                  <div className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
                    <Clock className="h-3.5 w-3.5" /> Heaviest users by snapshot rows (cost of a
                    rebuild)
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {data.snapshots.topUsers.map((u) => (
                      <Badge key={u.userId} variant="outline" title={u.userId}>
                        {shortId(u.userId)} · {u.rows.toLocaleString()}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Outbound API summary */}
          <Card>
            <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 py-4 text-sm">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-primary" />
                <span className="font-medium">Outbound market-data API</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  Buffered
                </span>
                <span className="font-semibold tabular-nums">
                  {data?.api.count.toLocaleString() ?? 0} / {data?.api.cap.toLocaleString() ?? 0}
                </span>
              </div>
              <div className="flex flex-col">
                <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  Errors / timeouts
                </span>
                <span
                  className={`font-semibold tabular-nums ${(data?.api.errors ?? 0) > 0 ? "text-rose-600" : ""}`}
                >
                  {data?.api.errors.toLocaleString() ?? 0}
                </span>
              </div>
              <Link
                href="/admin/api-log"
                className="ml-auto inline-flex items-center gap-1.5 text-primary hover:underline"
              >
                Full API log <ExternalLink className="h-3.5 w-3.5" />
              </Link>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
