"use client";

/**
 * ImportOverview (GH #422, 2026-11-20) — the first page of /import.
 *
 * Shows which accounts have something waiting, the same picture the dashboard
 * Action Center gives: bank rows not yet recorded (all modes) and statement
 * files still in staging (manual review). Open one to work on it, or review
 * every Auto-pilot and Approve-each account in one list.
 *
 * Manual-review accounts are deliberately not merged into the combined list:
 * their work (match each statement line against the ledger) stays per account.
 *
 * Reads GET /api/reconcile/summary (archived and hidden accounts excluded
 * server-side). Bespoke fetch per the FINLYNQ-118 money-page pattern.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { CheckCircle2, ChevronRight, Layers, RefreshCw } from "lucide-react";
import type { ReconcileSummaryApiRow } from "./reconcile-summary-panel";

export const MODE_LABELS: Record<string, string> = {
  auto: "Auto-pilot",
  approve: "Approve each",
  manual: "Manual review",
};

/** Rows needing work, busiest first. Pure, for tests. */
export function accountsNeedingAttention(rows: ReconcileSummaryApiRow[]): ReconcileSummaryApiRow[] {
  return rows
    .filter((r) => r.pendingCount > 0 || (r.pendingFiles ?? 0) > 0)
    .sort((a, b) => b.pendingCount + (b.pendingFiles ?? 0) - (a.pendingCount + (a.pendingFiles ?? 0)));
}

/** Auto-pilot and Approve-each accounts with bank rows waiting: what "All accounts" lists. */
export function combinedQueueAccounts(rows: ReconcileSummaryApiRow[]): ReconcileSummaryApiRow[] {
  return accountsNeedingAttention(rows).filter(
    (r) => (r.mode === "auto" || r.mode === "approve") && r.pendingCount > 0,
  );
}

export function useReconcileSummary(reloadKey?: number) {
  const [rows, setRows] = useState<ReconcileSummaryApiRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
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
  useEffect(() => {
    void load();
  }, [load, reloadKey]);
  return { rows, error, loading, reload: load };
}

function pendingLabel(r: ReconcileSummaryApiRow): string {
  const parts: string[] = [];
  if (r.pendingCount > 0) {
    parts.push(`${r.pendingCount} row${r.pendingCount === 1 ? "" : "s"} to record`);
  }
  const files = r.pendingFiles ?? 0;
  if (files > 0) parts.push(`${files} statement file${files === 1 ? "" : "s"} to review`);
  return parts.join(" · ");
}

export function ImportOverview({
  onOpenAccount,
  onOpenAll,
  reloadKey,
}: {
  onOpenAccount: (accountId: number) => void;
  onOpenAll: () => void;
  reloadKey?: number;
}) {
  const { rows, error, loading, reload } = useReconcileSummary(reloadKey);
  const attention = rows ? accountsNeedingAttention(rows) : [];
  const combined = rows ? combinedQueueAccounts(rows) : [];
  const combinedRows = combined.reduce((s, r) => s + r.pendingCount, 0);

  return (
    <div className="rounded-xl border bg-card p-4 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-base font-semibold">What needs attention</h2>
          <p className="text-sm text-muted-foreground">
            Accounts with imported rows not yet recorded, or statement files still waiting for review.
          </p>
        </div>
        <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => void reload()} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">Couldn&apos;t load your accounts: {error}</p>}

      {rows && combined.length > 0 && (
        <button
          type="button"
          onClick={onOpenAll}
          className="w-full flex items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-left hover:bg-primary/10 transition-colors"
        >
          <span className="flex items-center gap-3">
            <Layers className="h-5 w-5 text-primary shrink-0" />
            <span>
              <span className="block text-sm font-medium">Review all Auto-pilot and Approve-each accounts</span>
              <span className="block text-xs text-muted-foreground">
                {combinedRows} row{combinedRows === 1 ? "" : "s"} across {combined.length} account
                {combined.length === 1 ? "" : "s"}, in one list
              </span>
            </span>
          </span>
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
        </button>
      )}

      {rows && attention.length === 0 && !error && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          Nothing waiting. Every account is up to date.
        </div>
      )}

      {attention.length > 0 && (
        <div className="rounded-lg border divide-y">
          {attention.map((r) => (
            <div key={r.accountId} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{r.accountName}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {MODE_LABELS[r.mode ?? "manual"]} · {pendingLabel(r)}
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={() => onOpenAccount(r.accountId)}>
                Open
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
