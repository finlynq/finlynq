/**
 * FINLYNQ-176 — reallocation preview summary.
 *
 * Renders the human-readable consequences of proceeding with a lot-locked
 * edit/delete: how many dependent closures reallocate, whether a short lot
 * will open, and which calendar years' realized gains restate. Used inside
 * the transactions edit/delete confirm dialogs (warn-and-reallocate).
 *
 * Pure presentational — takes a `LotReallocationPreview` (from the
 * /api/transactions/lot-replan-preview dry-run) and renders an amber notice.
 */

"use client";

import { AlertTriangle } from "lucide-react";
import type { LotReallocationPreview } from "@/lib/portfolio/lots/types";

export function LotReallocationNotice({
  preview,
  loading,
}: {
  preview: LotReallocationPreview | null;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <p className="text-xs text-muted-foreground">Computing reallocation…</p>
    );
  }
  if (!preview) return null;

  const closureCount = preview.proposedClosures.length;
  const shortCount = preview.openedShortLots.length;
  const years = Object.keys(preview.realizedGainDeltaByYear).sort();

  return (
    <div className="rounded-md border border-amber-300/60 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-800/60 p-3 text-xs space-y-2">
      <p className="flex items-center gap-1.5 font-medium text-amber-900 dark:text-amber-200">
        <AlertTriangle className="h-3.5 w-3.5" />
        Proceeding will reallocate dependent transactions
      </p>
      <ul className="space-y-1 text-amber-900/90 dark:text-amber-200/90">
        <li>
          {preview.dependentCloseTxIds.length} dependent transaction
          {preview.dependentCloseTxIds.length === 1 ? "" : "s"} will be
          re-matched to other lots
          {closureCount > 0 ? ` (${closureCount} lot allocation${closureCount === 1 ? "" : "s"})` : ""}.
        </li>
        {shortCount > 0 && (
          <li>
            <strong>{shortCount} short position{shortCount === 1 ? "" : "s"}</strong>{" "}
            will be opened because there is not enough remaining inventory to
            cover the sale.
          </li>
        )}
        {years.length > 0 && (
          <li>
            Realized gains will be restated for:{" "}
            <strong>{years.join(", ")}</strong>.
          </li>
        )}
      </ul>
    </div>
  );
}
