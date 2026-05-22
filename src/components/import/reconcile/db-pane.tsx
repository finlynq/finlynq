"use client";

/**
 * DbPane — left pane of the /import/pending two-pane UI.
 *
 * Renders the user's continuous bank-side ledger (`bank_transactions`) for
 * the currently-selected account. Powered by `GET /api/import/bank-ledger`
 * (2026-05-22 two-ledger refactor) — previously this pane showed live
 * `transactions` in a ±7-day window via /api/transactions/reconciliation;
 * post-refactor we show the full bank-side history so the user sees
 * "continuous statement from the bank side" alongside the new upload on
 * the right.
 *
 * Each row surfaces:
 *   - the linked system-side transaction's id when present (rendered as
 *     "Matches #X"); bank-only rows whose transaction was deleted display
 *     without it,
 *   - a "linked to staged #X" indicator when the current upload's staged
 *     row was manually linked to this bank row's system-side transaction,
 *   - a "flagged" badge when `transaction_reconciliation_flags` carries a
 *     `missing_from_statement` row,
 *   - amount + decoded payee + decoded category name (when linked tx).
 */

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/currency";

export interface DbTransactionRow {
  /**
   * Unique row identifier. Post the two-ledger refactor (2026-05-22) this
   * is the `bank_transactions.id` UUID — bank-side rows are the source of
   * truth for the pane. Pre-refactor consumers that key on a numeric
   * transactions.id should use `linkedTransactionId` instead.
   */
  id: string;
  /** UUID of the bank-ledger row this entry came from. Always present. */
  bankTransactionId: string;
  /**
   * `transactions.id` of the live system-side transaction linked to this
   * bank row. NULL when the bank ledger has the row but no transaction
   * currently references it (user deleted the transaction after approval).
   */
  linkedTransactionId: number | null;
  date: string;
  amount: number;
  currency: string;
  payee: string | null;
  category: string | null;
  note: string | null;
  txType: "E" | "I" | "R" | "T" | null;
  linkedStagedRowId: string | null;
  reconciliationFlag: { kind: string; note: string | null } | null;
  /** How many statements have included this row. Bumped on every re-import. */
  seenCount?: number;
}

export function DbPane({
  rows,
  loading,
  rowActions,
  header,
}: {
  rows: DbTransactionRow[];
  loading: boolean;
  rowActions?: (row: DbTransactionRow) => React.ReactNode;
  header?: React.ReactNode;
}) {
  if (loading) {
    return (
      <>
        {header}
        <p className="p-6 text-sm text-muted-foreground text-center">
          Loading…
        </p>
      </>
    );
  }

  if (rows.length === 0) {
    return (
      <>
        {header}
        <p className="p-6 text-sm text-muted-foreground text-center">
          No bank-ledger entries for this account yet.
        </p>
      </>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {header}
      <div className="flex-1 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Payee</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              {rowActions && <TableHead className="w-32 text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const dimmed = r.linkedStagedRowId != null ? "opacity-70" : "";
              return (
                <TableRow key={r.id} className={dimmed}>
                  <TableCell className="font-mono text-xs">{r.date}</TableCell>
                  <TableCell className="text-xs truncate max-w-[220px]">
                    {r.payee || (
                      <span className="text-muted-foreground">—</span>
                    )}
                    {r.category && (
                      <span className="text-muted-foreground"> · {r.category}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    <div className="flex items-center gap-1 flex-wrap">
                      {r.txType === "R" ? (
                        <Badge variant="outline" className="text-[10px]">
                          Transfer
                        </Badge>
                      ) : r.txType === "I" ? (
                        <Badge
                          variant="outline"
                          className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200"
                        >
                          Income
                        </Badge>
                      ) : r.txType === "T" ? (
                        <Badge variant="outline" className="text-[10px]">
                          True-up
                        </Badge>
                      ) : r.txType === "E" ? (
                        <Badge variant="outline" className="text-[10px]">
                          Expense
                        </Badge>
                      ) : null}
                      {r.linkedStagedRowId != null && (
                        <Badge
                          variant="outline"
                          className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200"
                          title={`Linked to staged row ${r.linkedStagedRowId}`}
                        >
                          linked
                        </Badge>
                      )}
                      {r.reconciliationFlag && (
                        <Badge
                          variant="outline"
                          className="text-[10px] bg-rose-50 text-rose-700 border-rose-200"
                          title={r.reconciliationFlag.note ?? undefined}
                        >
                          missing from statement
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {formatCurrency(r.amount, r.currency || "CAD")}
                  </TableCell>
                  {rowActions && (
                    <TableCell className="text-right">{rowActions(r)}</TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
