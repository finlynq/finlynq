"use client";

/**
 * /admin/diagnostics — persistent slow-query + error log.
 *
 * Reads the `diagnostics_log` table (survives restarts, unlike /admin/api-log):
 * slow DB queries (>= the configured threshold), DB errors, API 5xx errors, and
 * outbound provider timeouts/5xx. Filter by kind + min duration; clear the table.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ScrollText, RefreshCw, Trash2 } from "lucide-react";

interface Row {
  id: number;
  at: string;
  kind: string;
  durationMs: number | null;
  source: string | null;
  op: string | null;
  env: string | null;
  detail: string | null;
  message: string | null;
  code: string | null;
}
interface ApiResponse {
  rows: Row[];
  summary: { kind: string; total: number; last24h: number }[];
  meta: { slowQueryMs: number; cap: number; returned: number; env: string };
}

const POLL_MS = 5000;

const KIND_LABEL: Record<string, string> = {
  slow_query: "Slow query",
  db_error: "DB error",
  api_error: "API error",
  outbound_error: "Outbound API",
};
function kindClass(kind: string): string {
  switch (kind) {
    case "slow_query":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-400";
    case "db_error":
    case "api_error":
      return "bg-rose-500/15 text-rose-700 dark:text-rose-400";
    case "outbound_error":
      return "bg-orange-500/15 text-orange-700 dark:text-orange-400";
    default:
      return "";
  }
}
function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function AdminDiagnosticsPage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);
  const [kind, setKind] = useState<string>("");
  const [minMs, setMinMs] = useState<string>("");
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (kind) params.set("kind", kind);
      if (minMs && Number(minMs) > 0) params.set("minMs", minMs);
      params.set("limit", "500");
      const res = await fetch(`/api/admin/diagnostics?${params.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [kind, minMs]);

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

  async function confirmClear() {
    setClearing(true);
    try {
      const res = await fetch("/api/admin/diagnostics", { method: "DELETE" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || "Clear failed");
      }
      setClearOpen(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Clear failed");
    } finally {
      setClearing(false);
    }
  }

  const rows = useMemo(() => data?.rows ?? [], [data]);

  const columns = useMemo<DataTableColumn<Row>[]>(
    () => [
      {
        key: "at",
        header: "Time",
        accessor: (r) => new Date(r.at).getTime(),
        render: (r) => (
          <span className="whitespace-nowrap" title={fmtTime(r.at)}>
            {ago(r.at)}
          </span>
        ),
      },
      {
        key: "kind",
        header: "Kind",
        accessor: (r) => r.kind,
        render: (r) => (
          <Badge className={`text-[10px] ${kindClass(r.kind)}`}>
            {KIND_LABEL[r.kind] ?? r.kind}
          </Badge>
        ),
      },
      {
        key: "durationMs",
        header: "ms",
        align: "right",
        accessor: (r) => r.durationMs ?? -1,
        render: (r) =>
          r.durationMs == null ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <span className={r.durationMs >= 2000 ? "font-semibold text-amber-600" : ""}>
              {r.durationMs.toLocaleString()}
            </span>
          ),
      },
      {
        key: "code",
        header: "Code",
        accessor: (r) => r.code ?? "",
        render: (r) => <span className="text-muted-foreground">{r.code ?? "—"}</span>,
      },
      {
        key: "op",
        header: "Operation",
        accessor: (r) => r.op ?? r.source ?? "",
        filter: "text",
        render: (r) => (
          <span className="text-xs" title={r.source ?? undefined}>
            {r.op ?? r.source ?? "—"}
          </span>
        ),
      },
      {
        key: "message",
        header: "Detail",
        accessor: (r) => r.message ?? r.detail ?? "",
        filter: "text",
        render: (r) => (
          <span
            className="font-mono text-xs break-all text-muted-foreground"
            title={[r.message, r.detail].filter(Boolean).join("\n")}
          >
            {r.message ?? r.detail ?? "—"}
          </span>
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
            <ScrollText className="h-5 w-5 text-primary" />
            <h1 className="text-2xl font-bold tracking-tight">Diagnostics log</h1>
            {data?.meta.env && (
              <Badge variant="outline" className="ml-1 uppercase">
                {data.meta.env}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Persistent log of slow queries (≥ {(data?.meta.slowQueryMs ?? 2000).toLocaleString()}ms),
            database errors, API 5xx errors, and outbound provider failures for{" "}
            <span className="font-medium text-foreground">this environment</span>. Survives restarts;
            kept to the newest {(data?.meta.cap ?? 5000).toLocaleString()} rows.
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
          <Button
            variant="outline"
            size="sm"
            className="border-rose-300 text-rose-600 hover:bg-rose-50 hover:text-rose-700 dark:border-rose-900/60 dark:hover:bg-rose-950/30"
            onClick={() => setClearOpen(true)}
            disabled={rows.length === 0 || clearing}
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            Clear
          </Button>
        </div>
      </div>

      {error && (
        <Card className="border-rose-200 bg-rose-50/30">
          <CardContent className="py-3 text-sm text-rose-700">{error}</CardContent>
        </Card>
      )}

      {/* Summary + filters */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3 py-4 text-sm">
          {(data?.summary ?? []).length === 0 && (
            <span className="text-muted-foreground">No entries recorded yet.</span>
          )}
          {(data?.summary ?? []).map((s) => (
            <div key={s.kind} className="flex flex-col">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                {KIND_LABEL[s.kind] ?? s.kind}
              </span>
              <span className="font-semibold tabular-nums">
                {s.total.toLocaleString()}
                <span className="ml-1 text-[11px] font-normal text-muted-foreground">
                  ({s.last24h.toLocaleString()} / 24h)
                </span>
              </span>
            </div>
          ))}

          <div className="ml-auto flex items-center gap-2">
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className="rounded-md border bg-background px-2 py-1 text-xs"
            >
              <option value="">All kinds</option>
              <option value="slow_query">Slow query</option>
              <option value="db_error">DB error</option>
              <option value="api_error">API error</option>
              <option value="outbound_error">Outbound API</option>
            </select>
            <input
              type="number"
              inputMode="numeric"
              placeholder="min ms"
              value={minMs}
              onChange={(e) => setMinMs(e.target.value)}
              className="w-24 rounded-md border bg-background px-2 py-1 text-xs"
            />
          </div>
        </CardContent>
      </Card>

      {/* Rows */}
      <Card>
        <CardContent className="overflow-x-auto p-2">
          <DataTable<Row>
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            rowClassName={(r) =>
              r.kind === "db_error" || r.kind === "api_error" ? "bg-rose-500/5" : undefined
            }
            emptyState={
              <p className="py-10 text-center text-sm text-muted-foreground">
                {loading ? "Loading…" : "No entries match — the log is clean."}
              </p>
            }
          />
        </CardContent>
      </Card>

      <ConfirmDialog
        open={clearOpen}
        onOpenChange={(o) => {
          if (!o) setClearOpen(false);
        }}
        title="Clear diagnostics log"
        description="Delete all diagnostics rows? This only clears the diagnostic history — it doesn't affect any user data."
        confirmLabel="Clear log"
        busyLabel="Clearing…"
        busy={clearing}
        onConfirm={confirmClear}
      />
    </div>
  );
}
