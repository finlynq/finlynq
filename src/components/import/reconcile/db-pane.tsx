"use client";

/**
 * DbPane — left pane of the /import/pending two-pane UI (FINLYNQ-56).
 * Renders existing `transactions` rows for the currently-selected account
 * within the ±7-day window around the staged batch's date range. The
 * parent fetches via `GET /api/transactions/reconciliation` and passes
 * the rows in.
 *
 * Each row surfaces:
 *   - a "linked to staged #X" indicator when some staged row's
 *     `linked_transaction_id` references it (back-reference),
 *   - a "flagged" badge when `transaction_reconciliation_flags` carries a
 *     `missing_from_statement` row,
 *   - amount + decoded payee + decoded category name.
 *
 * Phase 2 scope: read-only. Phase 3 adds the per-row action group (link
 * mode + flag-missing toggle).
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
  id: number;
  date: string;
  amount: number;
  currency: string;
  payee: string | null;
  category: string | null;
  note: string | null;
  txType: "E" | "I" | "R" | "T" | null;
  linkedStagedRowId: string | null;
  reconciliationFlag: { kind: string; note: string | null } | null;
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
          No transactions in the ±7-day window for this account.
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
