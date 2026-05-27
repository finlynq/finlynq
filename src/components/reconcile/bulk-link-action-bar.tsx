"use client";

/**
 * BulkLinkActionBar — fixed footer on /reconcile (2026-05-27).
 *
 * Surfaced whenever the user has at least one row checked on EITHER
 * pane. The primary action — "Reconcile selected" — fires the cartesian
 * product of `(selected tx) × (selected bank)` against
 * `POST /api/reconcile/links/bulk`. Disabled until BOTH sides have at
 * least one selection (no useful link can be built with a single side).
 *
 * Also surfaces the sum on each side + the delta so the user can sanity-
 * check that the selection actually reconciles (e.g. 2 tx of -$300 + -$200
 * pair against 1 bank row of -$500, Δ $0). Delta is colored emerald when
 * it's exactly zero (the "perfect reconcile" signal) and amber otherwise.
 *
 * Stays mounted while idle (just hidden via the early-return) so
 * mounting a fresh component on every selection change isn't required.
 */

import { Button } from "@/components/ui/button";
import { Link as LinkIcon, X } from "lucide-react";
import { formatCurrency } from "@/lib/currency";

export function BulkLinkActionBar({
  txCount,
  bankCount,
  txSum,
  bankSum,
  currency,
  busy,
  onReconcile,
  onClear,
}: {
  txCount: number;
  bankCount: number;
  /** Sum of `transactions.amount` over the selected transaction rows. */
  txSum: number;
  /** Sum of `bank_transactions.amount` over the selected bank rows. */
  bankSum: number;
  /** Currency code for both sides (typically the account's currency on
   *  the per-account /reconcile view). */
  currency: string;
  busy: boolean;
  onReconcile: () => void;
  onClear: () => void;
}) {
  if (txCount === 0 && bankCount === 0) return null;
  const total = txCount * bankCount;
  const canReconcile = txCount > 0 && bankCount > 0 && total > 0;
  // Sign convention: both columns use the same sign (negative = outflow).
  // If the user picks rows that should reconcile, the sums on each side
  // should match — so Δ = txSum - bankSum is zero. Anything nonzero is a
  // hint that they're about to link an imbalanced selection.
  const delta = txSum - bankSum;
  // Round to the nearest cent before comparing so 0.000000001 floating-
  // point noise doesn't look like a real delta.
  const deltaCents = Math.round(delta * 100);
  const isBalanced = deltaCents === 0 && (txCount > 0 || bankCount > 0);
  const deltaClass = isBalanced
    ? "text-emerald-700 dark:text-emerald-400"
    : "text-amber-700 dark:text-amber-400";

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 w-fit max-w-[calc(100%-2rem)]">
      <div className="flex items-center gap-3 rounded-full border bg-card px-4 py-2 shadow-lg">
        <span className="text-sm whitespace-nowrap">
          <strong>{txCount}</strong> tx
          <span className="text-muted-foreground">
            {" "}
            ({formatCurrency(txSum, currency)})
          </span>
          <span className="text-muted-foreground"> × </span>
          <strong>{bankCount}</strong> bank
          <span className="text-muted-foreground">
            {" "}
            ({formatCurrency(bankSum, currency)})
          </span>
          <span className="text-muted-foreground">
            {" "}={" "}
            <strong>{total}</strong> link{total === 1 ? "" : "s"}
          </span>
          <span className="text-muted-foreground"> · Δ </span>
          <strong
            className={deltaClass}
            title={
              isBalanced
                ? "Balanced — the two sides sum to the same total"
                : "Imbalanced — the two sides don't sum to the same total"
            }
          >
            {formatCurrency(delta, currency)}
          </strong>
        </span>
        <Button
          size="sm"
          onClick={onReconcile}
          disabled={!canReconcile || busy}
          className="h-8"
          title={
            !canReconcile
              ? "Select at least one row on each side"
              : `Create ${total} link${total === 1 ? "" : "s"}`
          }
        >
          <LinkIcon className="h-3.5 w-3.5 mr-1.5" />
          {busy ? "Linking…" : "Reconcile selected"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onClear}
          disabled={busy}
          className="h-8"
          aria-label="Clear selection"
          title="Clear selection"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
