"use client";

/**
 * Recent Uploads panel — Phase 4 of import-modes refactor (2026-05-25).
 *
 * Per [plan/import-modes-simplified-detailed.md](../../../../plan/import-modes-simplified-detailed.md).
 *
 * Lists the most recent `bank_upload_batches` rows for the active account so
 * the user can undo an upload that landed bad rows (typo'd CSV, wrong
 * account binding, etc.). Each row has a "Delete batch" action that
 * cascades through bank_transactions + bank_daily_balances. If any bank
 * row in the batch is already linked to a `transactions` row (materialized
 * via /reconcile), the server replies with `requiresConfirmation: true`
 * and the panel surfaces a follow-up modal asking whether to also delete
 * those transactions or keep them as bank-lineage-NULL orphans.
 *
 * Data flow:
 *   GET /api/import/uploads?accountId=X  → list of batches
 *   DELETE /api/import/uploads/[batchId] → undo a batch (with optional
 *                                          { deleteLinkedTransactions: true })
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Trash2, RefreshCcw, ChevronDown, ChevronRight } from "lucide-react";

interface BatchRow {
  id: string;
  accountId: number;
  source: "upload" | "email" | "connector";
  mode: "simplified" | "detailed";
  filename: string | null;
  uploadedAt: string;
  rowCount: number;
  anchorCount: number;
  currentRowCount: number;
  hasLinkedTransactions: boolean;
}

interface ConfirmState {
  batch: BatchRow;
  bankRowCount: number;
  linkedTransactionCount: number;
  anchorCount: number;
}

export function RecentUploadsPanel({
  accountId,
  onChange,
}: {
  accountId: number | null;
  onChange?: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const load = useCallback(async () => {
    if (accountId == null) {
      setBatches([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/import/uploads?accountId=${accountId}&limit=20`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as BatchRow[];
      setBatches(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load recent uploads");
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const deleteBatch = useCallback(
    async (batchId: string, deleteLinkedTransactions = false) => {
      setDeletingId(batchId);
      try {
        const res = await fetch(`/api/import/uploads/${batchId}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deleteLinkedTransactions }),
        });
        if (res.status === 409) {
          const body = await res.json();
          // Server is asking for confirmation. Surface the modal.
          const batch = batches.find((b) => b.id === batchId);
          if (batch) {
            setConfirm({
              batch,
              bankRowCount: body.bankRowCount ?? 0,
              linkedTransactionCount: body.linkedTransactionCount ?? 0,
              anchorCount: body.anchorCount ?? 0,
            });
          }
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        // Success — refresh list + notify parent so /reconcile re-fetches.
        setConfirm(null);
        await load();
        onChange?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to delete batch");
      } finally {
        setDeletingId(null);
      }
    },
    [batches, load, onChange],
  );

  if (accountId == null) return null;

  return (
    <div className="rounded-md border bg-card text-card-foreground">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/40"
      >
        <span className="flex items-center gap-2">
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          Recent uploads
          {batches.length > 0 && (
            <span className="text-xs text-muted-foreground font-normal">
              ({batches.length})
            </span>
          )}
        </span>
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            void load();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              void load();
            }
          }}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
        >
          <RefreshCcw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          {loading ? "Loading…" : "Refresh"}
        </span>
      </button>

      {!collapsed && (
        <div className="border-t">
          {error && (
            <div className="px-4 py-2 text-xs text-rose-600 bg-rose-50">{error}</div>
          )}
          {batches.length === 0 && !loading && (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              No uploads yet for this account.
            </div>
          )}
          {batches.length > 0 && (
            <ul className="divide-y">
              {batches.map((b) => {
                const dt = new Date(b.uploadedAt);
                const dateLabel = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")} ${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
                return (
                  <li
                    key={b.id}
                    className="flex items-center justify-between gap-4 px-4 py-3 text-sm"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground">
                          {dateLabel}
                        </span>
                        <span className="inline-block rounded border border-border bg-muted/40 px-1.5 py-0 text-[10px] uppercase">
                          {b.mode}
                        </span>
                        <span className="inline-block rounded border border-border bg-muted/40 px-1.5 py-0 text-[10px] uppercase">
                          {b.source}
                        </span>
                        {b.hasLinkedTransactions && (
                          <span className="inline-block rounded border border-amber-200 bg-amber-50 px-1.5 py-0 text-[10px] text-amber-800">
                            has linked tx
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-xs">
                        {b.filename ?? "(no filename)"}{" "}
                        <span className="text-muted-foreground">
                          · {b.currentRowCount}/{b.rowCount} rows
                          {b.anchorCount > 0 && ` · ${b.anchorCount} anchor${b.anchorCount === 1 ? "" : "s"}`}
                        </span>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-rose-700 hover:text-rose-800 hover:bg-rose-50"
                      onClick={() => void deleteBatch(b.id, false)}
                      disabled={deletingId === b.id}
                    >
                      <Trash2 className="h-4 w-4 mr-1.5" />
                      {deletingId === b.id ? "Deleting…" : "Delete batch"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* Confirmation modal for batches with linked transactions. */}
      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-md rounded-lg border bg-card p-5 shadow-lg">
            <h3 className="text-base font-semibold">Delete batch with linked transactions?</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              This batch has <strong>{confirm.bankRowCount}</strong> bank-ledger row{confirm.bankRowCount === 1 ? "" : "s"},
              of which <strong>{confirm.linkedTransactionCount}</strong> {confirm.linkedTransactionCount === 1 ? "is" : "are"} already linked
              to {confirm.linkedTransactionCount === 1 ? "a transaction" : "transactions"} in your ledger
              {confirm.anchorCount > 0 && `, plus ${confirm.anchorCount} balance anchor${confirm.anchorCount === 1 ? "" : "s"}`}.
            </p>
            <p className="mt-3 text-sm text-muted-foreground">
              How do you want to handle the linked {confirm.linkedTransactionCount === 1 ? "transaction" : "transactions"}?
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <Button
                onClick={() => void deleteBatch(confirm.batch.id, true)}
                disabled={deletingId === confirm.batch.id}
                className="bg-rose-700 hover:bg-rose-800 text-white"
              >
                Delete all (bank rows + transactions)
              </Button>
              <Button
                variant="outline"
                onClick={() => void deleteBatch(confirm.batch.id, false)}
                disabled={deletingId === confirm.batch.id}
              >
                Keep transactions (drop bank lineage)
              </Button>
              <Button
                variant="ghost"
                onClick={() => setConfirm(null)}
                disabled={deletingId === confirm.batch.id}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
