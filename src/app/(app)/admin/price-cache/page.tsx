"use client";

/**
 * /admin/price-cache — operator-only inspector for the two server-side
 * market-data caches: `price_cache` (stock/ETF/crypto daily closes) and
 * `fx_rates` (USD-anchored FX rates). Read-only; gated by the admin API
 * (requireAdmin + managed-mode) and hidden from the nav for non-admins.
 *
 * Each row shows a derived freshness state from the SAME pure
 * `isPriceCacheRowStale` the read path uses (FINLYNQ-204): a TODAY-dated row
 * past the 30-min TTL is "Stale" (lazily re-fetched on next read); historical
 * rows are "Cached" (immutable, never re-fetched). This is the surface used to
 * confirm whether a snapshot rebuild re-fetches history (it shouldn't) vs only
 * refreshes today's leg.
 */

import { formatRateNumber } from "@/lib/fx/rate-view";
import { useFxRatesInverted } from "@/components/currency-provider";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataTable, type DataTableColumn, type SortDir } from "@/components/ui/data-table";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Database, RefreshCw, ChevronLeft, ChevronRight, Trash2 } from "lucide-react";

type Tab = "price" | "fx";

interface PriceRow {
  id: number;
  symbol: string;
  date: string;
  price: number;
  currency: string;
  previousClose: number | null;
  fetchedAt: string;
  stale: boolean;
}
interface FxRow {
  id: number;
  currency: string;
  date: string;
  rateToUsd: number;
  source: string;
  fetchedAt: string;
  stale: boolean;
}
type Row = PriceRow | FxRow;

interface Summary {
  totalRows: number;
  distinctKeys: number;
  firstDate: string | null;
  lastDate: string | null;
  todayRows: number;
  staleTodayRows: number;
}
interface ApiResponse {
  table: Tab;
  today: string;
  total: number;
  limit: number;
  offset: number;
  rows: Row[];
  summary: Summary;
}

const LIMITS = [100, 200, 500, 1000];

function fmtNum(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}
function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "";
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function Freshness({ row, today }: { row: Row; today: string }) {
  if (row.date !== today) {
    return (
      <Badge variant="outline" className="text-[10px] bg-muted text-muted-foreground">
        Cached
      </Badge>
    );
  }
  return row.stale ? (
    <Badge variant="outline" className="text-[10px] bg-amber-500/15 text-amber-600 border-amber-500/30">
      Stale
    </Badge>
  ) : (
    <Badge variant="outline" className="text-[10px] bg-emerald-500/15 text-emerald-600 border-emerald-500/30">
      Fresh
    </Badge>
  );
}

function FetchedAtCell({ iso }: { iso: string }) {
  return (
    <span className="whitespace-nowrap">
      {fmtDateTime(iso)}
      <span className="ml-1.5 text-muted-foreground">({ago(iso)})</span>
    </span>
  );
}

export default function AdminPriceCachePage() {
  const { inverted: fxRatesInverted } = useFxRatesInverted();
  const [tab, setTab] = useState<Tab>("price");
  const [search, setSearch] = useState("");
  const [date, setDate] = useState("");
  const [todayOnly, setTodayOnly] = useState(false);
  const [staleOnly, setStaleOnly] = useState(false);
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>({ key: "fetchedAt", dir: "desc" });
  const [limit, setLimit] = useState(200);
  const [offset, setOffset] = useState(0);

  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Delete (admin cleanup): one row, or all rows matching the active filter.
  const [rowToDelete, setRowToDelete] = useState<Row | null>(null);
  const [rowDeleting, setRowDeleting] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qp = new URLSearchParams({ table: tab, limit: String(limit), offset: String(offset) });
      if (search.trim()) qp.set("search", search.trim());
      if (date.trim()) qp.set("date", date.trim());
      if (todayOnly) qp.set("todayOnly", "1");
      if (staleOnly) qp.set("staleOnly", "1");
      if (sort) {
        qp.set("sort", sort.key);
        qp.set("dir", sort.dir);
      }
      const res = await fetch(`/api/admin/price-cache?${qp.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [tab, search, date, todayOnly, staleOnly, sort, limit, offset]);

  useEffect(() => {
    load();
  }, [load]);

  function switchTab(next: Tab) {
    if (next === tab) return;
    setTab(next);
    setSearch("");
    setDate("");
    setTodayOnly(false);
    setStaleOnly(false);
    setSort({ key: "fetchedAt", dir: "desc" });
    setOffset(0);
  }

  // New filters/sort reset to page 1.
  function resetOffset() {
    setOffset(0);
  }

  async function confirmRowDelete() {
    if (!rowToDelete) return;
    setRowDeleting(true);
    try {
      const res = await fetch(`/api/admin/price-cache?table=${tab}&id=${rowToDelete.id}`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Delete failed");
      setRowToDelete(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setRowDeleting(false);
    }
  }

  async function confirmBulkDelete() {
    setBulkDeleting(true);
    try {
      const qp = new URLSearchParams({ table: tab, all: "1" });
      if (search.trim()) qp.set("search", search.trim());
      if (date.trim()) qp.set("date", date.trim());
      if (todayOnly) qp.set("todayOnly", "1");
      if (staleOnly) qp.set("staleOnly", "1");
      const res = await fetch(`/api/admin/price-cache?${qp.toString()}`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Delete failed");
      setBulkOpen(false);
      setOffset(0);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBulkDeleting(false);
    }
  }

  const filterActive = Boolean(search.trim() || date.trim() || todayOnly || staleOnly);

  const today = data?.today ?? "";

  const columns = useMemo<DataTableColumn<Row>[]>(() => {
    const fetchedCol: DataTableColumn<Row> = {
      key: "fetchedAt",
      header: "Fetched at",
      accessor: (r) => new Date(r.fetchedAt).getTime(),
      render: (r) => <FetchedAtCell iso={r.fetchedAt} />,
    };
    const freshCol: DataTableColumn<Row> = {
      key: "freshness",
      header: "Freshness",
      sortable: false,
      accessor: (r) => (r.date !== today ? 0 : r.stale ? 2 : 1),
      render: (r) => <Freshness row={r} today={today} />,
    };
    const dateCol: DataTableColumn<Row> = {
      key: "date",
      header: "Date",
      accessor: (r) => r.date,
      render: (r) => <span className={r.date === today ? "font-medium" : ""}>{r.date}</span>,
    };
    const actionsCol: DataTableColumn<Row> = {
      key: "actions",
      header: "",
      sortable: false,
      align: "right",
      accessor: () => null,
      render: (r) => (
        <button
          type="button"
          onClick={() => setRowToDelete(r)}
          title="Delete this cache row"
          className="inline-flex text-muted-foreground transition-colors hover:text-rose-600"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      ),
    };

    if (tab === "fx") {
      return [
        { key: "currency", header: "Currency", accessor: (r) => (r as FxRow).currency, className: "font-mono" },
        dateCol,
        // "Show rates inverted" view: units of the currency per 1 USD.
        fxRatesInverted
          ? {
              key: "rateToUsd",
              header: "Per 1 USD",
              align: "right",
              accessor: (r) => {
                const v = (r as FxRow).rateToUsd;
                return v > 0 ? 1 / v : 0;
              },
              render: (r) => formatRateNumber(1 / (r as FxRow).rateToUsd),
            }
          : { key: "rateToUsd", header: "Rate → USD", align: "right", accessor: (r) => (r as FxRow).rateToUsd, render: (r) => formatRateNumber((r as FxRow).rateToUsd) },
        { key: "source", header: "Source", accessor: (r) => (r as FxRow).source },
        fetchedCol,
        freshCol,
        actionsCol,
      ];
    }
    return [
      { key: "symbol", header: "Symbol", accessor: (r) => (r as PriceRow).symbol, className: "font-mono" },
      dateCol,
      { key: "price", header: "Price", align: "right", accessor: (r) => (r as PriceRow).price, render: (r) => fmtNum((r as PriceRow).price) },
      { key: "currency", header: "Ccy", accessor: (r) => (r as PriceRow).currency },
      { key: "previousClose", header: "Prev close", align: "right", accessor: (r) => (r as PriceRow).previousClose, render: (r) => fmtNum((r as PriceRow).previousClose) },
      fetchedCol,
      freshCol,
      actionsCol,
    ];
  }, [tab, today, fxRatesInverted]);

  const total = data?.total ?? 0;
  const showingFrom = total === 0 ? 0 : offset + 1;
  const showingTo = Math.min(offset + limit, total);
  const keyLabel = tab === "fx" ? "currency" : "symbol";

  return (
    <div className="max-w-7xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-primary" />
            <h1 className="text-2xl font-bold tracking-tight">Market-data cache</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            Read-only view of the server-side <code className="text-xs">price_cache</code> and{" "}
            <code className="text-xs">fx_rates</code> tables. Today-dated rows past the 30-min TTL show as{" "}
            <span className="text-amber-600">Stale</span> (re-fetched on next read); historical rows are{" "}
            <span className="text-muted-foreground">Cached</span> (immutable).
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1.5">
        {(["price", "fx"] as const).map((t) => (
          <button
            key={t}
            onClick={() => switchTab(t)}
            className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
              tab === t ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-muted"
            }`}
          >
            {t === "price" ? "Price cache" : "FX rates"}
          </button>
        ))}
      </div>

      {/* Summary */}
      {data && (
        <Card>
          <CardContent className="grid grid-cols-2 gap-x-6 gap-y-2 py-4 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Total rows" value={data.summary.totalRows.toLocaleString()} />
            <Stat label={tab === "fx" ? "Currencies" : "Symbols"} value={data.summary.distinctKeys.toLocaleString()} />
            <Stat label="First date" value={data.summary.firstDate ?? "—"} />
            <Stat label="Last date" value={data.summary.lastDate ?? "—"} />
            <Stat label="Today rows" value={data.summary.todayRows.toLocaleString()} />
            <Stat
              label="Stale today"
              value={data.summary.staleTodayRows.toLocaleString()}
              warn={data.summary.staleTodayRows > 0}
            />
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {tab === "fx" ? "Currency" : "Symbol"}
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              resetOffset();
            }}
            placeholder={tab === "fx" ? "e.g. CAD" : `e.g. VTI`}
            className="h-8 w-40 rounded-md border bg-background px-2 text-sm text-foreground"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Date (YYYY-MM-DD)
          <input
            type="text"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              resetOffset();
            }}
            placeholder="exact date"
            className="h-8 w-40 rounded-md border bg-background px-2 text-sm text-foreground"
          />
        </label>
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={todayOnly}
            onChange={(e) => {
              setTodayOnly(e.target.checked);
              resetOffset();
            }}
            className="h-3.5 w-3.5 accent-primary"
          />
          Today only
        </label>
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={staleOnly}
            onChange={(e) => {
              setStaleOnly(e.target.checked);
              resetOffset();
            }}
            className="h-3.5 w-3.5 accent-primary"
          />
          Stale today only
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Page size
          <select
            value={limit}
            onChange={(e) => {
              setLimit(Number(e.target.value));
              resetOffset();
            }}
            className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
          >
            {LIMITS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <Card className="border-rose-200 bg-rose-50/30">
          <CardContent className="py-3 text-sm text-rose-700">{error}</CardContent>
        </Card>
      )}

      {/* Rows */}
      <Card>
        <CardContent className="p-0">
          <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5 text-xs text-muted-foreground">
            <span>
              {loading && !data
                ? "Loading…"
                : `Showing ${showingFrom.toLocaleString()}–${showingTo.toLocaleString()} of ${total.toLocaleString()} matching rows (newest fetched first; sort + filter narrow the full set, not just this page)`}
            </span>
            <div className="flex items-center gap-1">
              {filterActive && total > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="mr-1 border-rose-300 text-rose-600 hover:bg-rose-50 hover:text-rose-700 dark:border-rose-900/60 dark:hover:bg-rose-950/30"
                  disabled={loading || bulkDeleting}
                  onClick={() => setBulkOpen(true)}
                >
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  Delete {total.toLocaleString()} matching
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={offset <= 0 || loading}
                onClick={() => setOffset(Math.max(0, offset - limit))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={showingTo >= total || loading}
                onClick={() => setOffset(offset + limit)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="overflow-x-auto p-2">
            <DataTable<Row>
              columns={columns}
              rows={data?.rows ?? []}
              rowKey={(r) => r.id}
              sort={sort}
              onSortChange={(s) => {
                setSort(s);
                resetOffset();
              }}
              emptyState={
                <p className="py-10 text-center text-sm text-muted-foreground">
                  {loading ? "Loading…" : `No ${keyLabel} rows match these filters.`}
                </p>
              }
            />
          </div>
        </CardContent>
      </Card>

      {/* Delete a single cache row */}
      <ConfirmDialog
        open={rowToDelete != null}
        onOpenChange={(o) => { if (!o) setRowToDelete(null); }}
        title="Delete cache row"
        description={
          rowToDelete
            ? `Delete the ${"symbol" in rowToDelete ? rowToDelete.symbol : rowToDelete.currency} row for ${rowToDelete.date}? A real price re-fetches on next read; a garbage row stays gone.`
            : ""
        }
        confirmLabel="Delete row"
        busyLabel="Deleting…"
        busy={rowDeleting}
        onConfirm={confirmRowDelete}
      />

      {/* Bulk delete every row matching the active filter */}
      <ConfirmDialog
        open={bulkOpen}
        onOpenChange={(o) => { if (!o) setBulkOpen(false); }}
        title="Delete matching rows"
        description={`Delete all ${total.toLocaleString()} ${tab === "fx" ? "fx_rates" : "price_cache"} rows matching the current filter? Real prices re-fetch on next read; garbage rows stay gone. This can't be undone.`}
        confirmLabel={`Delete ${total.toLocaleString()} rows`}
        busyLabel="Deleting…"
        busy={bulkDeleting}
        onConfirm={confirmBulkDelete}
      />
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={`text-sm font-semibold tabular-nums ${warn ? "text-amber-600" : ""}`}>{value}</span>
    </div>
  );
}
