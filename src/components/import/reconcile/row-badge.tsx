"use client";

/**
 * RowBadge — small status pill rendered next to each staged row in the
 * FilePane (right pane of the /import/pending two-pane UI, FINLYNQ-56).
 *
 * Mirrors the four reconcile_state values (unmatched / auto_suggested /
 * linked / skipped_duplicate) plus a synthetic "duplicate" badge for the
 * pre-existing dedup marker. The badge is purely visual — actions live on
 * the parent row's button group, not here.
 */

import { Badge } from "@/components/ui/badge";

export type ReconcileState =
  | "unmatched"
  | "auto_suggested"
  | "linked"
  | "skipped_duplicate";

export function RowBadge({
  state,
  linkedTransactionId,
}: {
  state: ReconcileState;
  linkedTransactionId?: number | null;
}) {
  switch (state) {
    case "linked":
      return (
        <Badge
          variant="outline"
          className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200"
          title={
            linkedTransactionId != null
              ? `Linked to tx #${linkedTransactionId}`
              : "Linked"
          }
        >
          linked
        </Badge>
      );
    case "auto_suggested":
      return (
        <Badge
          variant="outline"
          className="text-[10px] bg-sky-50 text-sky-700 border-sky-200"
        >
          suggested
        </Badge>
      );
    case "skipped_duplicate":
      return (
        <Badge
          variant="outline"
          className="text-[10px] bg-amber-50 text-amber-700 border-amber-200"
        >
          already imported
        </Badge>
      );
    case "unmatched":
    default:
      return null;
  }
}
