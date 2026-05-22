"use client";

/**
 * BankPane — left pane of the standalone /reconcile UI.
 *
 * Fork of `pf-app/src/components/import/reconcile/db-pane.tsx` (2026-05-23).
 * The two surfaces are diverging — the reconcile page needs:
 *   - per-row "Create transaction" action for bank-only rows,
 *   - per-row "Unlink" action for linked rows,
 *   - reconcile-specific status pills (linked_primary / suggested_* / bank_only)
 *     that don't make sense on /import/pending.
 *
 * Keeping a fork (~150 LOC) is cleaner than piling reconcile props onto the
 * import variant. The `DbTransactionRow` shape from db-pane is re-exported
 * here as `BankRow` with the reconcile-relevant additions (linkType,
 * suggestedStrategy) so downstream consumers stay typed.
 */

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Plus, Unlink } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { MatchPill, type ReconcileBadgeVariant } from "./match-pill";

export interface BankRow {
  /** `bank_transactions.id` — UUID. Stable React key. */
  id: string;
  date: string;
  amount: number;
  currency: string;
  payee: string | null;
  /** Match status — drives the visible pill. */
  status: ReconcileBadgeVariant;
  /** When linked, the system-side transaction id. */
  linkedTransactionId: number | null;
  /** When suggested, the candidate transaction id. */
  suggestedTransactionId: number | null;
  /** How many statements have included this row. */
  seenCount: number;
  /** Pre-resolved category id from the rule engine; piped through to
   *  the MaterializeDialog as the default category pick. null when no
   *  rule matched the bank row's payee. */
  suggestedCategoryId: number | null;
  /** Bank row's account id — used by the dialog as the default account. */
  accountId: number;
}

export function BankPane({
  rows,
  loading,
  onMaterialize,
  onUnlink,
  busyBankId,
}: {
  rows: BankRow[];
  loading: boolean;
  onMaterialize: (bankId: string) => void;
  onUnlink: (bankId: string, transactionId: number) => void;
  /** Disable buttons on this row while a mutation is in flight. */
  busyBankId: string | null;
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
        No bank-ledger entries for this account yet.
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
              <TableHead className="w-40 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const dimmed =
                r.status === "linked_primary" || r.status === "linked_extra"
                  ? "opacity-70"
                  : "";
              const busy = busyBankId === r.id;
              return (
                <TableRow key={r.id} className={dimmed}>
                  <TableCell className="font-mono text-xs">{r.date}</TableCell>
                  <TableCell className="text-xs truncate max-w-[220px]">
                    {r.payee || (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    <div className="flex items-center gap-1 flex-wrap">
                      <MatchPill
                        variant={r.status}
                        title={
                          r.linkedTransactionId != null
                            ? `Linked to tx #${r.linkedTransactionId}`
                            : r.suggestedTransactionId != null
                              ? `Suggested match: tx #${r.suggestedTransactionId}`
                              : r.status === "bank_only" && r.seenCount > 1
                                ? `Seen in ${r.seenCount} statements`
                                : undefined
                        }
                      />
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {formatCurrency(r.amount, r.currency || "CAD")}
                  </TableCell>
                  <TableCell className="text-right">
                    {r.status === "bank_only" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => onMaterialize(r.id)}
                        className="h-7 text-xs"
                      >
                        <Plus className="h-3 w-3 mr-1" />
                        Create
                      </Button>
                    ) : r.status === "linked_primary" ||
                      r.status === "linked_extra" ? (
                      r.linkedTransactionId != null && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            onUnlink(r.id, r.linkedTransactionId!)
                          }
                          className="h-7 text-xs text-muted-foreground hover:text-foreground"
                        >
                          <Unlink className="h-3 w-3 mr-1" />
                          Unlink
                        </Button>
                      )
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
