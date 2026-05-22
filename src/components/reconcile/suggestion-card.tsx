"use client";

/**
 * SuggestionCard — single accept/reject card for a (transaction, bank row)
 * pair surfaced by the reconcile match engine.
 *
 * Visual style intentionally mirrors `pf-app/src/components/import/reconcile/
 * suggestions-group.tsx` (sky-tinted panel, dual-column comparison, Check/X
 * buttons) so the two surfaces feel of-a-piece. The shape diverges enough
 * that wrapping the existing component would be uglier than copying the
 * 60 lines of layout:
 *
 *   - Existing surface: staged-row → tx, confidence is `exact|fuzzy` only.
 *   - Reconcile surface: tx → bank, strategy is `exact_hash|fuzzy`, carries
 *     a numeric score + reason string for the fuzzy case.
 *
 * Accept persists the link via POST /api/reconcile/links; reject is local-only
 * (per-page Set of rejected pairs), matching the existing surface's
 * non-persistence pattern.
 */

import { Button } from "@/components/ui/button";
import { Check, X } from "lucide-react";
import { formatCurrency } from "@/lib/currency";

export interface SuggestionDisplay {
  transactionId: number;
  bankTransactionId: string;
  strategy: "exact_hash" | "fuzzy";
  score: number;
  reason: string;
  daysOff: number;
  amountDeltaAbs: number;
  txDate: string;
  txAmount: number;
  txCurrency: string;
  txPayee: string | null;
  bankDate: string;
  bankAmount: number;
  bankCurrency: string;
  bankPayee: string | null;
}

export function SuggestionCard({
  suggestion,
  onAccept,
  onReject,
  busy,
}: {
  suggestion: SuggestionDisplay;
  onAccept: (s: SuggestionDisplay) => void;
  onReject: (s: SuggestionDisplay) => void;
  busy: boolean;
}) {
  const isExact = suggestion.strategy === "exact_hash";
  return (
    <div className="border-b bg-sky-50/40 p-3 space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-semibold uppercase tracking-wide text-sky-900">
          {isExact ? "Exact match" : "Fuzzy match"}
        </span>
        <span className="text-sky-700/80">
          {isExact
            ? "import_hash match"
            : `score ${suggestion.score.toFixed(2)} · ${suggestion.reason}`}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 text-xs">
        <div className="space-y-0.5">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Transaction
          </div>
          <div className="font-mono">{suggestion.txDate}</div>
          <div className="truncate">
            {suggestion.txPayee || (
              <span className="text-muted-foreground">—</span>
            )}
          </div>
          <div className="font-mono">
            {formatCurrency(suggestion.txAmount, suggestion.txCurrency)}
          </div>
        </div>
        <div className="space-y-0.5">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Bank row
          </div>
          <div className="font-mono">{suggestion.bankDate}</div>
          <div className="truncate">
            {suggestion.bankPayee || (
              <span className="text-muted-foreground">—</span>
            )}
          </div>
          <div className="font-mono">
            {formatCurrency(suggestion.bankAmount, suggestion.bankCurrency)}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 justify-end">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => onReject(suggestion)}
          className="h-7 text-xs text-muted-foreground hover:text-foreground"
        >
          <X className="h-3 w-3 mr-1" />
          Reject
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => onAccept(suggestion)}
          className="h-7 text-xs bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100"
        >
          <Check className="h-3 w-3 mr-1" />
          Accept
        </Button>
      </div>
    </div>
  );
}
