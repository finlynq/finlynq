"use client";

/**
 * ReconcileSummaryPanel (FINLYNQ-147) — collapsible per-account "what's up to
 * date / what's stale" table for the /import surface. Reads GET
 * /api/reconcile/summary (figures derived from existing tables, no new column).
 *
 * Each row: account name, last import date, last reconciled date, pending
 * (unreconciled) bank-row count, and a quick "Open" link that selects that
 * account on /import. Archived and hidden accounts are excluded server-side
 * (FINLYNQ-184) — the API route filters them before returning.
 *
 * Bespoke fetch/useState/useEffect per the FINLYNQ-118 money-page pattern (no
 * SWR). Lazy: only fetches when first expanded.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";

export interface ReconcileSummaryApiRow {
  accountId: number;
  accountName: string;
  currency: string;
  lastImportAt: string | null;
  lastReconciledAt: string | null;
  pendingCount: number;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function ReconcileSummaryPanel({
  onOpenAccount,
  reloadKey,
}: {
  /** Select an account on the parent /import surface. */
  onOpenAccount: (accountId: number) => void;
  /** Bump to force a refetch (e.g. after an upload). */
  reloadKey?: number;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ReconcileSummaryApiRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/reconcile/summary");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRows(Array.isArray(data.rows) ? data.rows : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Lazy-load on first expand; refetch when reloadKey changes while open.
  useEffect(() => {
    if (open) void load();
  }, [open, reloadKey, load]);

  return (
    <div className="rounded-xl border bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 p-4 text-left"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          {open ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
          <span className="text-sm font-medium">Reconciliation summary</span>
          <span className="text-xs text-muted-foreground">
            last import &amp; reconcile per account
          </span>
        </div>
        {open && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              void load();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.stopPropagation();
                void load();
              }
            }}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </span>
        )}
      </button>

      {open && (
        <div className="border-t px-4 pb-4">
          {error && (
            <p className="py-3 text-sm text-rose-700 dark:text-rose-400">
              {error}
            </p>
          )}
          {!error && loading && !rows && (
            <p className="py-3 text-sm text-muted-foreground">Loading…</p>
          )}
          {!error && rows && rows.length === 0 && (
            <p className="py-3 text-sm text-muted-foreground">
              No accounts to summarize yet.
            </p>
          )}
          {!error && rows && rows.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Account</th>
                    <th className="py-2 pr-4 font-medium">Last import</th>
                    <th className="py-2 pr-4 font-medium">Last reconciled</th>
                    <th className="py-2 pr-4 font-medium text-right">Pending</th>
                    <th className="py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.accountId} className="border-t">
                      <td className="py-2 pr-4">
                        <span className="font-medium">{r.accountName}</span>
                        <span className="ml-1 text-xs text-muted-foreground">
                          {r.currency}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {fmtDate(r.lastImportAt)}
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {fmtDate(r.lastReconciledAt)}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {r.pendingCount > 0 ? (
                          <span className="font-medium text-amber-700 dark:text-amber-400">
                            {r.pendingCount}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </td>
                      <td className="py-2 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => onOpenAccount(r.accountId)}
                        >
                          Open
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
