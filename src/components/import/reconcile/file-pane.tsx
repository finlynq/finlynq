"use client";

/**
 * FilePane — right pane of the /import/pending two-pane UI (FINLYNQ-56).
 * Renders staged rows (file-side, from `staged_transactions`) for the
 * currently-selected account, with the existing per-row inline editor
 * exposed via expansion and the new RowBadge surfacing reconcile_state.
 *
 * Phase 2 scope: read-only (selection + expand + edit only). Phase 3
 * adds the link/unlink/skip action group + suggestions integration.
 *
 * Selection (approve queue) and expansion (editor visibility) are owned
 * by the parent — this component just renders + emits events.
 */

import { Fragment } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import {
  StagedRowEditor,
  type StagedEditableRow,
  type AccountOption,
  type HoldingOption,
} from "@/components/staging/staged-row-editor";
import { RowBadge, type ReconcileState } from "./row-badge";

const RowFragment = Fragment;

export interface FilePaneProps {
  stagedImportId: string;
  rows: StagedEditableRow[];
  selected: Set<string>;
  expanded: Set<string>;
  accounts: AccountOption[];
  holdings: HoldingOption[];
  onToggleSelect: (rowId: string) => void;
  onToggleExpand: (rowId: string) => void;
  onRowUpdated: (updated: StagedEditableRow) => void;
  /** Phase 3 — optional right-side action column per row. */
  rowActions?: (row: StagedEditableRow) => React.ReactNode;
  /** Phase 3 — optional pinned content rendered above the table (the
   *  auto-match SuggestionsGroup). Composes cleanly with empty state. */
  header?: React.ReactNode;
  /**
   * 2026-05-24 — bank balance anchors parsed from the uploaded file's
   * Balance column. Map of YYYY-MM-DD → balance value. When non-empty,
   * the pane renders a Balance column showing the file's stated balance
   * on the FIRST row of each day in display order. Empty map = no
   * column rendered.
   */
  anchorsByDate?: Map<string, number>;
}

export function FilePane({
  stagedImportId,
  rows,
  selected,
  expanded,
  accounts,
  holdings,
  onToggleSelect,
  onToggleExpand,
  onRowUpdated,
  rowActions,
  header,
  anchorsByDate,
}: FilePaneProps) {
  if (rows.length === 0) {
    return (
      <>
        {header}
        <p className="p-6 text-sm text-muted-foreground text-center">
          No staged rows for this account.
        </p>
      </>
    );
  }

  // 2026-05-24 — "one balance per day" rule. Track which dates have
  // already had a balance cell rendered (rows are sorted newest-first
  // by the server, so the FIRST row of each day in display order is
  // the most recent transaction of that day).
  const balanceShownForDate = new Set<string>();
  const hasAnyAnchor = (anchorsByDate?.size ?? 0) > 0;
  // colSpan for the expanded editor row must cover every header column.
  // Columns: checkbox (1) + chevron (2) + Date (3) + Payee (4) + Type (5)
  //          + Amount (6) [+ Balance (7)] [+ Actions (last)]
  const editorColSpan = 6 + (hasAnyAnchor ? 1 : 0) + (rowActions ? 1 : 0);

  return (
    <div className="flex flex-col h-full">
      {header}
      <div className="flex-1 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <input
                  type="checkbox"
                  checked={
                    rows.length > 0 &&
                    rows.every((r) => selected.has(r.id))
                  }
                  onChange={() => {
                    const everySelected = rows.every((r) => selected.has(r.id));
                    if (everySelected) {
                      rows.forEach((r) => onToggleSelect(r.id));
                    } else {
                      rows.filter((r) => !selected.has(r.id)).forEach((r) => onToggleSelect(r.id));
                    }
                  }}
                  aria-label="Select all visible rows"
                />
              </TableHead>
              <TableHead className="w-8" />
              <TableHead>Date</TableHead>
              <TableHead>Payee</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              {hasAnyAnchor && (
                <TableHead className="text-right">Balance</TableHead>
              )}
              {rowActions && <TableHead className="w-32 text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const isExpanded = expanded.has(r.id);
              const dimmed =
                r.reconcileState === "skipped_duplicate"
                  ? "opacity-60 line-through"
                  : r.isDuplicate || r.reconcileState === "linked"
                    ? "opacity-60"
                    : "";
              const dayBalance = hasAnyAnchor ? anchorsByDate?.get(r.date) : undefined;
              const showBalance =
                hasAnyAnchor &&
                dayBalance !== undefined &&
                !balanceShownForDate.has(r.date);
              if (showBalance) balanceShownForDate.add(r.date);
              return (
                <RowFragment key={r.id}>
                  <TableRow className={dimmed}>
                    <TableCell>
                      <input
                        type="checkbox"
                        checked={selected.has(r.id)}
                        onChange={() => onToggleSelect(r.id)}
                        aria-label={`Select row ${r.rowIndex}`}
                      />
                    </TableCell>
                    <TableCell>
                      <button
                        type="button"
                        onClick={() => onToggleExpand(r.id)}
                        aria-label={isExpanded ? "Collapse row editor" : "Edit row"}
                        className="text-muted-foreground hover:text-foreground p-1 -m-1"
                      >
                        {isExpanded ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </TableCell>
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
                        ) : (
                          <Badge variant="outline" className="text-[10px]">
                            Expense
                          </Badge>
                        )}
                        {r.isDuplicate && r.reconcileState !== "skipped_duplicate" && (
                          <Badge variant="outline" className="text-[10px]">
                            dupe
                          </Badge>
                        )}
                        <RowBadge
                          state={r.reconcileState as ReconcileState}
                          linkedTransactionId={r.linkedTransactionId ?? null}
                        />
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {formatCurrency(r.amount, r.currency || "CAD")}
                    </TableCell>
                    {hasAnyAnchor && (
                      <TableCell
                        className="text-right font-mono text-xs"
                        title={
                          showBalance
                            ? `Bank-stated balance from file on ${r.date}`
                            : undefined
                        }
                      >
                        {showBalance && dayBalance !== undefined
                          ? formatCurrency(dayBalance, r.currency || "CAD")
                          : ""}
                      </TableCell>
                    )}
                    {rowActions && (
                      <TableCell className="text-right">
                        {rowActions(r)}
                      </TableCell>
                    )}
                  </TableRow>
                  {isExpanded && (
                    <TableRow>
                      <TableCell colSpan={editorColSpan} className="p-0">
                        <StagedRowEditor
                          stagedImportId={stagedImportId}
                          row={r}
                          siblingRows={rows}
                          accounts={accounts}
                          holdings={holdings}
                          onUpdated={onRowUpdated}
                        />
                      </TableCell>
                    </TableRow>
                  )}
                </RowFragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
