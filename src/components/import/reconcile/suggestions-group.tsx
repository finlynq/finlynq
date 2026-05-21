"use client";

/**
 * SuggestionsGroup — pinned at the top of the FilePane (right pane of
 * /import/pending two-pane UI, FINLYNQ-56). Renders one card per
 * (staged, db) candidate pair the server-side auto-matcher surfaced on
 * the GET staged-detail response.
 *
 * Accept ⇒ PATCH the staged row to reconcile_state='linked' +
 * linked_transaction_id. Reject ⇒ hide locally (client state only; no
 * persist) — matches sub-item FINLYNQ-71 verbatim. The page's `rejected`
 * Set persists for the lifetime of the page state but not across reloads.
 *
 * Multi-candidate cases render as separate accept/reject pairs (per the
 * matcher's "surface all, let the user pick" decision); the user picks
 * one and the others naturally fall out of the list when their staged
 * row flips to 'linked'.
 */

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Check, X } from "lucide-react";
import { formatCurrency } from "@/lib/currency";

export interface SuggestionDisplay {
  stagedRowId: string;
  transactionId: number;
  confidence: "exact" | "fuzzy";
  stagedPayee: string | null;
  stagedDate: string;
  stagedAmount: number;
  stagedCurrency: string;
  dbPayee: string | null;
  dbDate: string;
  dbAmount: number;
  dbCurrency: string;
}

export function SuggestionsGroup({
  suggestions,
  onAccept,
  onReject,
  busyId,
}: {
  suggestions: SuggestionDisplay[];
  onAccept: (s: SuggestionDisplay) => void;
  onReject: (s: SuggestionDisplay) => void;
  /** Composite "stagedRowId:transactionId" key for the suggestion
   *  currently being PATCHed. The card disables its buttons while in
   *  flight so a double-click can't double-fire. */
  busyId: string | null;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div className="border-b bg-sky-50/40 p-3 space-y-2">
      <div className="text-xs font-semibold uppercase tracking-wide text-sky-900">
        Suggested matches ({suggestions.length})
      </div>
      <div className="space-y-1.5">
        {suggestions.map((s) => {
          const key = `${s.stagedRowId}:${s.transactionId}`;
          const busy = busyId === key;
          return (
            <div
              key={key}
              className="flex items-center gap-2 text-xs bg-card rounded border px-2 py-1.5"
            >
              <Badge
                variant="outline"
                className={
                  s.confidence === "exact"
                    ? "text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200"
                    : "text-[10px] bg-amber-50 text-amber-700 border-amber-200"
                }
              >
                {s.confidence}
              </Badge>
              <div className="flex-1 min-w-0 truncate">
                <span className="font-medium">
                  {s.stagedPayee || "—"}
                </span>
                <span className="text-muted-foreground"> on </span>
                <span className="font-mono">{s.stagedDate}</span>
                <span className="text-muted-foreground"> · </span>
                <span className="font-mono">
                  {formatCurrency(s.stagedAmount, s.stagedCurrency)}
                </span>
                <span className="text-muted-foreground"> ↔ </span>
                <span className="text-muted-foreground">
                  existing tx #{s.transactionId} ({s.dbPayee || "—"}{" "}
                  · {s.dbDate}{" "}
                  · {formatCurrency(s.dbAmount, s.dbCurrency)})
                </span>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onAccept(s)}
                disabled={busy}
                className="h-7 px-2"
              >
                <Check className="h-3.5 w-3.5 mr-1" />
                Link
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onReject(s)}
                disabled={busy}
                className="h-7 px-2 text-muted-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
