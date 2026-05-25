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
  /**
   * End-of-day balance for this row's date, computed from the latest
   * bank_daily_balances anchor + cumulative sum of intervening amounts.
   * Same value appears on every row of a given date (server-side); the
   * pane renders it only on the FIRST row of each day in display order
   * to reduce noise (the "one balance per day" rule the user picked).
   * Null when the account has no anchor at all yet.
   */
  runningBalance?: number | null;
  /**
   * The actual loaded anchor for this row's date, when one exists in
   * `bank_daily_balances`. Surfaced alongside `runningBalance` so the
   * user can see "what the bank told us" vs "what we computed" on the
   * same row. Null when no anchor exists for this date.
   */
  anchorBalance?: number | null;
  anchorSource?: string | null;
}

export function DbPane({
  rows,
  loading,
  rowActions,
  header,
  onRowClick,
  highlightedBankIds,
}: {
  rows: DbTransactionRow[];
  loading: boolean;
  rowActions?: (row: DbTransactionRow) => React.ReactNode;
  header?: React.ReactNode;
  /** Click anywhere on a row body (not the action button / checkbox) —
   *  drives the cross-pane highlight UX (plan #5 Phase 3). */
  onRowClick?: (bankId: string) => void;
  /** Bank ids currently highlighted by a click-through. */
  highlightedBankIds?: ReadonlySet<string>;
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

  // 2026-05-24 — "one balance per day" rule: show balances only on the
  // FIRST row of each day in display order (rows are sorted newest-first
  // server-side). Tracked independently per column so a date with only a
  // calculated value still renders something on the first row of the day.
  //
  // 2026-05-22 — TWO separate columns: "Calculated" (runningBalance,
  // computed from the latest anchor walking transactions) vs "Loaded"
  // (anchorBalance, the bank's reported value for the exact date). Headers
  // always render; cells show "—" when the value is null. Side-by-side
  // visibility lets the user spot mismatches at a glance — the system's
  // running sum vs the bank's own report.
  const calcShownForDate = new Set<string>();
  const loadedShownForDate = new Set<string>();
  const dayFirstSeenForCalc = new Set<string>();
  const dayFirstSeenForLoaded = new Set<string>();

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
              <TableHead
                className="text-right"
                title="System's running balance — derived by walking bank rows from the latest loaded anchor"
              >
                Calculated
              </TableHead>
              <TableHead
                className="text-right"
                title="Bank's reported balance — the actual value loaded from a statement anchor for that exact date"
              >
                Loaded
              </TableHead>
              {rowActions && <TableHead className="w-32 text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const dimmed = r.linkedStagedRowId != null ? "opacity-70" : "";
              // Calculated column — first row of the day shows the value
              // when one is computed, otherwise "—" so the column still
              // signals where balances will appear.
              const showCalc =
                r.runningBalance != null && !calcShownForDate.has(r.date);
              if (showCalc) calcShownForDate.add(r.date);
              const isFirstOfDayCalcEmpty =
                r.runningBalance == null && !dayFirstSeenForCalc.has(r.date);
              if (isFirstOfDayCalcEmpty) dayFirstSeenForCalc.add(r.date);
              // Loaded column — same pattern: value or "—" on first of day.
              const showLoaded =
                r.anchorBalance != null && !loadedShownForDate.has(r.date);
              if (showLoaded) loadedShownForDate.add(r.date);
              const isFirstOfDayLoadedEmpty =
                r.anchorBalance == null && !dayFirstSeenForLoaded.has(r.date);
              if (isFirstOfDayLoadedEmpty) dayFirstSeenForLoaded.add(r.date);
              const highlighted = highlightedBankIds?.has(r.id) ?? false;
              const highlightClass = highlighted
                ? "bg-sky-500/10 outline outline-2 outline-sky-500/40"
                : "";
              const clickable = onRowClick != null;
              return (
                <TableRow
                  key={r.id}
                  className={`${dimmed} ${highlightClass} ${clickable ? "cursor-pointer" : ""}`}
                  onClick={
                    clickable
                      ? (e) => {
                          // Defensive: rowActions render buttons (Pick / Flag /
                          // unflag) inside this row. Suppress the row-click
                          // when the target is inside any interactive child.
                          const target = e.target as HTMLElement;
                          if (target.closest("button")) return;
                          if (target.closest("input")) return;
                          onRowClick?.(r.id);
                        }
                      : undefined
                  }
                >
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
                  <TableCell
                    className="text-right font-mono text-xs"
                    title={
                      showCalc
                        ? `Calculated end-of-day balance for ${r.date} (anchor + transactions)`
                        : isFirstOfDayCalcEmpty
                          ? "No anchor loaded yet — calculated balance can't be derived"
                          : undefined
                    }
                  >
                    {showCalc && r.runningBalance != null
                      ? formatCurrency(r.runningBalance, r.currency || "CAD")
                      : isFirstOfDayCalcEmpty
                        ? <span className="text-muted-foreground">—</span>
                        : ""}
                  </TableCell>
                  <TableCell
                    className="text-right font-mono text-xs"
                    title={
                      showLoaded && r.anchorBalance != null
                        ? `Bank-reported balance for ${r.date}${r.anchorSource ? ` (${r.anchorSource})` : ""}`
                        : isFirstOfDayLoadedEmpty
                          ? "No bank-reported anchor for this date"
                          : undefined
                    }
                  >
                    {showLoaded && r.anchorBalance != null
                      ? formatCurrency(r.anchorBalance, r.currency || "CAD")
                      : isFirstOfDayLoadedEmpty
                        ? <span className="text-muted-foreground">—</span>
                        : ""}
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
