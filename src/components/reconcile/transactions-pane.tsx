"use client";

/**
 * TransactionsPane — right pane of the /reconcile UI.
 *
 * Renders the user's system-side `transactions` rows for the currently-
 * selected account, with reconcile status pills + an inline SuggestionCard
 * pinned to each tx that has a suggestion. Mirrors the layout pattern of
 * `pf-app/src/components/import/reconcile/file-pane.tsx` (the staged-side
 * right pane on /import/pending) without coupling to the staging shape.
 *
 * Per-row layout when a suggestion is present:
 *   ┌──────────────────────────────────────┐
 *   │ tx row · date · payee · amount       │
 *   ├──────────────────────────────────────┤
 *   │ SuggestionCard (sky-50)              │
 *   └──────────────────────────────────────┘
 *
 * For linked-via-extra rows we surface a "linked + extra link" badge but
 * don't render the SuggestionCard (the join already exists).
 */

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Fragment } from "react";
import { formatCurrency } from "@/lib/currency";
import { MatchPill, type ReconcileBadgeVariant } from "./match-pill";
import {
  SuggestionCard,
  type SuggestionDisplay,
} from "./suggestion-card";

export interface TxRow {
  /** `transactions.id`. */
  id: number;
  date: string;
  amount: number;
  currency: string;
  payee: string | null;
  category: string | null;
  status: ReconcileBadgeVariant;
  /** Bank id this tx is linked to (when status is linked_*). */
  linkedBankTransactionId: string | null;
  /** Inline suggestion for this tx, if any. */
  suggestion: SuggestionDisplay | null;
}

export function TransactionsPane({
  rows,
  loading,
  onAccept,
  onReject,
  busySuggestionKey,
}: {
  rows: TxRow[];
  loading: boolean;
  onAccept: (s: SuggestionDisplay) => void;
  onReject: (s: SuggestionDisplay) => void;
  /** Composite "txId:bankId" key for the suggestion in flight. */
  busySuggestionKey: string | null;
}) {
  if (loading) {
    return (
      <p className="p-6 text-sm text-muted-foreground text-center">
        Loading…
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="p-6 text-sm text-muted-foreground text-center">
        No transactions in this account yet.
      </p>
    );
  }
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Payee</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const suggestionKey = r.suggestion
                ? `${r.suggestion.transactionId}:${r.suggestion.bankTransactionId}`
                : null;
              const busy =
                suggestionKey != null && busySuggestionKey === suggestionKey;
              return (
                <Fragment key={r.id}>
                  <TableRow>
                    <TableCell className="font-mono text-xs">
                      {r.date}
                    </TableCell>
                    <TableCell className="text-xs truncate max-w-[220px]">
                      {r.payee || (
                        <span className="text-muted-foreground">—</span>
                      )}
                      {r.category && (
                        <span className="text-muted-foreground">
                          {" "}
                          · {r.category}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      <MatchPill
                        variant={r.status}
                        title={
                          r.linkedBankTransactionId != null
                            ? "Linked to a bank-ledger row"
                            : undefined
                        }
                      />
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {formatCurrency(r.amount, r.currency || "CAD")}
                    </TableCell>
                  </TableRow>
                  {r.suggestion && (
                    <TableRow>
                      <TableCell colSpan={4} className="p-0">
                        <SuggestionCard
                          suggestion={r.suggestion}
                          onAccept={onAccept}
                          onReject={onReject}
                          busy={busy}
                        />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
