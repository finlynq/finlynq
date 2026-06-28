"use client";

/**
 * TransactionTable (FINLYNQ-111 Phase 2).
 *
 * The transactions list table — header (sort + per-column filter + drag-reorder)
 * + body (per-column cell render switch). Extracted verbatim from
 * transactions/page.tsx; all state + handlers are threaded as props, so
 * behaviour (rendering, selection, sort/filter, drag) is unchanged.
 */

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatDate } from "@/lib/currency";
import { formatAccountLabel } from "@/lib/account-label";
import { labelForSource } from "@/lib/tx-source";
import { Trash2, Pencil, Receipt, Scissors, Link2, ArrowUp, ArrowDown } from "lucide-react";
import {
  COLUMN_LABELS as SHARED_COLUMN_LABELS,
  TOGGLEABLE_COLUMN_IDS as SHARED_TOGGLEABLE_COLUMN_IDS,
  FILTER_COLUMN_TYPES,
  isSortableColumnId,
  type ColumnId,
  type SortableColumnId,
} from "@/lib/transactions/columns";
import { ColumnFilterPopover } from "./column-filter-popover";
import { SplitBadge } from "./split-badge";
import type { Transaction, Account, Category, ColFilterShape, SortPref, ColumnPref } from "../_types";

const COLUMN_LABELS = SHARED_COLUMN_LABELS;
const TOGGLEABLE_COLUMNS = new Set<ColumnId>(SHARED_TOGGLEABLE_COLUMN_IDS);

const categoryColorMap: Record<string, string> = {
  income: "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  expense: "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300",
  transfer: "border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-700 dark:bg-sky-950 dark:text-sky-300",
  investment: "border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-700 dark:bg-violet-950 dark:text-violet-300",
};

function getCategoryBadgeClass(categoryType: string): string {
  const key = categoryType?.toLowerCase() ?? "";
  return categoryColorMap[key] ?? "border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300";
}

function TableSkeleton() {
  return (
    <div className="p-4 space-y-3">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <div className="h-4 w-20 rounded bg-muted animate-pulse" />
          <div className="h-4 w-24 rounded bg-muted animate-pulse" />
          <div className="h-5 w-16 rounded-full bg-muted animate-pulse" />
          <div className="h-4 w-28 rounded bg-muted animate-pulse" />
          <div className="h-4 w-32 rounded bg-muted animate-pulse flex-1" />
          <div className="h-4 w-20 rounded bg-muted animate-pulse ml-auto" />
          <div className="h-6 w-14 rounded bg-muted animate-pulse" />
        </div>
      ))}
    </div>
  );
}

export function TransactionTable({
  loading,
  txns,
  columnPrefs,
  accounts,
  categories,
  selected,
  allSelected,
  draggingCol,
  sortPref,
  filters,
  setFilters,
  setPage,
  toggleAll,
  toggleOne,
  cycleSort,
  findColFilter,
  setColFilter,
  onColDragStart,
  onColDragOver,
  onColDragEnd,
  startEdit,
  openSplitDialog,
  confirmDelete,
}: {
  loading: boolean;
  txns: Transaction[];
  columnPrefs: ColumnPref[];
  accounts: Account[];
  categories: Category[];
  selected: Set<number>;
  allSelected: boolean;
  draggingCol: ColumnId | null;
  sortPref: SortPref;
  filters: { tag: string } & Record<string, string>;
  setFilters: (f: Record<string, string>) => void;
  setPage: (p: number) => void;
  toggleAll: () => void;
  toggleOne: (id: number) => void;
  cycleSort: (columnId: SortableColumnId) => void;
  findColFilter: (columnId: ColumnId) => ColFilterShape | undefined;
  setColFilter: (filter: ColFilterShape | null, columnId: ColumnId) => void;
  onColDragStart: (id: ColumnId) => (e: React.DragEvent<HTMLTableCellElement>) => void;
  onColDragOver: (id: ColumnId) => (e: React.DragEvent<HTMLTableCellElement>) => void;
  onColDragEnd: () => void;
  startEdit: (t: Transaction) => void;
  openSplitDialog: (t: Transaction) => void;
  confirmDelete: (t: Transaction) => void;
}) {
  if (loading) return <TableSkeleton />;
  if (txns.length === 0) {
    return (
      <EmptyState
        icon={Receipt}
        title="No transactions yet"
        description="Add your first transaction or import bank statements to get started."
        action={{ label: "Import data", href: "/import" }}
      />
    );
  }
  return (
    <div className="overflow-x-auto">
    <Table>
      <TableHeader>
        <TableRow>
          {columnPrefs.filter((c) => c.visible).map((c) => {
            const isDraggable = TOGGLEABLE_COLUMNS.has(c.id);
            const isAmount = c.id === "amount" || c.id === "quantity";
            const widthClass =
              c.id === "select" ? "w-10" :
              c.id === "actions" ? "w-24" :
              "";
            const isDragging = draggingCol === c.id;
            const sortable = isSortableColumnId(c.id);
            const filterType = FILTER_COLUMN_TYPES[c.id];
            const activeFilter = findColFilter(c.id);
            const sortActive = sortPref.columnId === c.id ? sortPref.direction : null;
            return (
              <TableHead
                key={c.id}
                className={`${widthClass} ${isAmount ? "text-right" : ""} ${isDraggable ? "select-none" : ""} ${isDragging ? "opacity-50" : ""}`}
                draggable={isDraggable}
                onDragStart={isDraggable ? onColDragStart(c.id) : undefined}
                onDragOver={isDraggable ? onColDragOver(c.id) : undefined}
                onDragEnd={isDraggable ? onColDragEnd : undefined}
              >
                {c.id === "select" ? (
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    className="h-4 w-4 rounded border-input cursor-pointer"
                    title="Select all"
                  />
                ) : c.id === "actions" ? (
                  ""
                ) : (
                  <div className={`flex items-center gap-1 ${isAmount ? "justify-end" : ""}`}>
                    {sortable ? (
                      <button
                        type="button"
                        onClick={() => cycleSort(c.id as SortableColumnId)}
                        className="inline-flex items-center gap-0.5 hover:text-foreground transition-colors"
                        title="Click to sort"
                      >
                        <span>{COLUMN_LABELS[c.id]}</span>
                        {sortActive === "asc" && <ArrowUp className="h-3 w-3 text-primary" />}
                        {sortActive === "desc" && <ArrowDown className="h-3 w-3 text-primary" />}
                      </button>
                    ) : (
                      <span>{COLUMN_LABELS[c.id]}</span>
                    )}
                    {filterType && (
                      <ColumnFilterPopover
                        columnId={c.id}
                        filterType={filterType}
                        activeFilter={activeFilter}
                        onChange={(f) => setColFilter(f, c.id)}
                        accounts={accounts}
                        categories={categories}
                      />
                    )}
                  </div>
                )}
              </TableHead>
            );
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {txns.map((t) => (
          <TableRow key={t.id} className={`hover:bg-muted/30 ${selected.has(t.id) ? "bg-primary/5" : ""}`}>
            {columnPrefs.filter((c) => c.visible).map((c) => {
              switch (c.id) {
                case "select":
                  return (
                    <TableCell key={c.id}>
                      <input
                        type="checkbox"
                        checked={selected.has(t.id)}
                        onChange={() => toggleOne(t.id)}
                        className="h-4 w-4 rounded border-input cursor-pointer"
                      />
                    </TableCell>
                  );
                case "date":
                  return (
                    <TableCell key={c.id} className="text-sm">{formatDate(t.date)}</TableCell>
                  );
                case "account":
                  return (
                    <TableCell key={c.id} className="text-sm">
                      {formatAccountLabel({ name: t.accountName, alias: t.accountAlias, type: t.accountType })}
                    </TableCell>
                  );
                case "accountType":
                  return (
                    <TableCell key={c.id} className="text-sm text-muted-foreground">
                      {t.accountType || "-"}
                    </TableCell>
                  );
                case "accountName":
                  return (
                    <TableCell key={c.id} className="text-sm">{t.accountName || "-"}</TableCell>
                  );
                case "accountAlias":
                  return (
                    <TableCell key={c.id} className="text-sm text-muted-foreground">
                      {t.accountAlias || "-"}
                    </TableCell>
                  );
                case "category":
                  return (
                    <TableCell key={c.id} className="text-sm">
                      <span className="flex items-center gap-1">
                        {t.categoryName && (
                          <Badge variant="outline" className={`text-xs ${getCategoryBadgeClass(t.categoryType)}`}>{t.categoryName}</Badge>
                        )}
                        <SplitBadge transactionId={t.id} />
                        {t.linkId && (
                          <Link2 className="h-3 w-3 text-sky-500 shrink-0" aria-label="Linked transaction" />
                        )}
                      </span>
                    </TableCell>
                  );
                case "payee":
                  return (
                    <TableCell key={c.id} className="text-sm">{t.payee || "-"}</TableCell>
                  );
                case "portfolio":
                  return (
                    <TableCell key={c.id} className="text-sm text-muted-foreground">
                      {t.portfolioHolding || "-"}
                    </TableCell>
                  );
                case "portfolioTicker":
                  return (
                    <TableCell key={c.id} className="text-sm font-mono text-muted-foreground">
                      {t.portfolioHoldingSymbol || "-"}
                    </TableCell>
                  );
                case "note":
                  return (
                    <TableCell key={c.id} className="text-sm text-muted-foreground max-w-60">
                      {t.note ? <span className="truncate block">{t.note}</span> : <span>-</span>}
                    </TableCell>
                  );
                case "tags":
                  return (
                    <TableCell key={c.id} className="text-sm text-muted-foreground">
                      {t.tags ? (
                        <div className="flex flex-wrap gap-1">
                          {t.tags.split(",").map((rawTag) => rawTag.trim()).filter(Boolean).map((tagValue) => (
                            <button
                              key={tagValue}
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setFilters({ ...filters, tag: tagValue });
                                setPage(0);
                              }}
                              className="inline-flex items-center rounded-md border border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300 px-1.5 py-0 text-[10px] font-mono hover:border-sky-400 hover:bg-sky-100 dark:hover:bg-sky-900 transition-colors"
                              title={`Filter by tag: ${tagValue}`}
                            >
                              {tagValue}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <span>-</span>
                      )}
                    </TableCell>
                  );
                case "quantity":
                  return (
                    <TableCell key={c.id} className="text-right font-mono text-xs text-muted-foreground">
                      {t.quantity != null && t.quantity !== 0
                        ? t.quantity.toLocaleString("en-CA", {
                            minimumFractionDigits: 0,
                            maximumFractionDigits: t.quantity % 1 === 0 ? 0 : 4,
                          })
                        : "-"}
                    </TableCell>
                  );
                case "amount": {
                  // Show the entered side (what the user typed); fall
                  // back to amount/currency on legacy rows. When the
                  // settlement currency differs, append a muted
                  // converted label so both the trade and settlement
                  // are visible.
                  const enteredAmt = t.enteredAmount ?? t.amount;
                  const enteredCcy = t.enteredCurrency ?? t.currency;
                  const showSecondary = enteredCcy !== t.currency;
                  return (
                    <TableCell key={c.id} className={`text-right font-mono text-sm font-semibold ${t.amount >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                      <div className="flex flex-col items-end">
                        <span>{formatCurrency(enteredAmt, enteredCcy)}</span>
                        {showSecondary && (
                          <span className="text-[10px] font-normal text-muted-foreground">
                            → {formatCurrency(t.amount, t.currency)}
                          </span>
                        )}
                      </div>
                    </TableCell>
                  );
                }
                case "createdAt":
                  return (
                    <TableCell key={c.id} className="text-sm text-muted-foreground whitespace-nowrap">
                      {t.createdAt ? formatDate(t.createdAt.split("T")[0]) : "-"}
                    </TableCell>
                  );
                case "updatedAt":
                  return (
                    <TableCell key={c.id} className="text-sm text-muted-foreground whitespace-nowrap">
                      {t.updatedAt ? formatDate(t.updatedAt.split("T")[0]) : "-"}
                    </TableCell>
                  );
                case "source":
                  return (
                    <TableCell key={c.id} className="text-sm">
                      {t.source ? (
                        <Badge variant="outline" className="text-[10px]">
                          {labelForSource(t.source)}
                        </Badge>
                      ) : (
                        "-"
                      )}
                    </TableCell>
                  );
                case "kind": {
                  // Phase 2 canonicalization tag — surfaces what the
                  // /settings/backfill coverage dashboard reads from.
                  // Empty = not yet canonicalized (legacy/pre-Phase-2
                  // or pre-backfill). A coloured pill means the row
                  // has a portfolio-op shape the lot engine recognizes.
                  // `opening_balance` (violet) is distinct from `buy`
                  // (amber) so users can tell carried-in positions
                  // from regular buys at a glance.
                  //
                  // Solid border = row is coverage-canonical
                  // (PAIRLESS kind OR trade_link_id OR link_id).
                  // Dashed border = kind is set but the row is still
                  // coverage-pending (needs a pair / is missing
                  // canonical shape). Mirror of
                  // PAIRLESS_CANONICAL_KINDS in
                  // src/lib/portfolio/backfill/types.ts — keep in
                  // sync with the coverage SQL predicate.
                  const PAIRLESS_KINDS = new Set([
                    "dividend",
                    "interest",
                    "portfolio_income",
                    "portfolio_expense",
                    "opening_balance",
                    "balance_adjustment",
                  ]);
                  const isCanonical =
                    !!t.kind &&
                    (PAIRLESS_KINDS.has(t.kind) ||
                      t.tradeLinkId != null ||
                      t.linkId != null);
                  // Badge already renders `border` (1px). Add
                  // `border-dashed` for pending rows; default solid
                  // for canonical rows.
                  const borderStyle = isCanonical ? "" : "border-dashed";
                  return (
                    <TableCell key={c.id} className="text-sm">
                      {t.kind ? (
                        <Badge
                          variant="outline"
                          className={`text-[10px] ${borderStyle} ${
                            /_cash_leg$/.test(t.kind)
                              ? "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                              : t.kind === "dividend" || t.kind === "interest"
                                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                                : t.kind === "opening_balance"
                                  ? "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300"
                                  : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                          }`}
                          title={
                            isCanonical
                              ? t.kind
                              : `${t.kind} — pending canonicalization, visit /settings/backfill`
                          }
                        >
                          {t.kind}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground/50">—</span>
                      )}
                    </TableCell>
                  );
                }
                case "canonical": {
                  // 2026-06-09 — companion to the `kind` column.
                  // Mirrors the predicate the /settings/backfill
                  // coverage dashboard uses to count canonical vs
                  // pending vs not-yet-classified rows. Keep this
                  // PAIRLESS set in sync with PAIRLESS_CANONICAL_KINDS
                  // in src/lib/portfolio/backfill/types.ts and with
                  // the duplicate set above in the `kind` case —
                  // ideally hoist to module scope on next touch.
                  const PAIRLESS_KINDS = new Set([
                    "dividend",
                    "interest",
                    "portfolio_income",
                    "portfolio_expense",
                    "opening_balance",
                    "balance_adjustment",
                  ]);
                  const status: "canonical" | "pending" | "none" =
                    t.kind == null
                      ? "none"
                      : PAIRLESS_KINDS.has(t.kind) ||
                          t.tradeLinkId != null ||
                          t.linkId != null
                        ? "canonical"
                        : "pending";
                  return (
                    <TableCell key={c.id} className="text-sm">
                      {status === "canonical" ? (
                        <Badge
                          variant="outline"
                          className="text-[10px] border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                          title="Row has a canonical Phase-2 shape — kind set AND (pair-less kind OR trade_link_id OR link_id)."
                        >
                          canonical
                        </Badge>
                      ) : status === "pending" ? (
                        <Badge
                          variant="outline"
                          className="text-[10px] border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 border-dashed"
                          title={`Kind is '${t.kind}' but row lacks the canonical pair shape — visit /settings/backfill to canonicalize.`}
                        >
                          pending
                        </Badge>
                      ) : (
                        <span
                          className="text-muted-foreground/50"
                          title="No kind set — row predates Phase-2 portfolio ops or has no portfolio-op classification."
                        >
                          —
                        </span>
                      )}
                    </TableCell>
                  );
                }
                case "actions":
                  return (
                    <TableCell key={c.id}>
                      <div className="flex gap-0.5">
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => startEdit(t)} title="Edit">
                          <Pencil className="h-3 w-3" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-violet-500" onClick={() => openSplitDialog(t)} title="Split">
                          <Scissors className="h-3 w-3" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => confirmDelete(t)} title="Delete">
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </TableCell>
                  );
              }
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
    </div>
  );
}
