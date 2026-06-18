"use client";

/**
 * DataTable (FINLYNQ-196) — the shared, descriptor-driven, sortable (+ optionally
 * filterable / column-hideable) table layout for the app's FLAT data tables.
 *
 * This is the ONE centrally-managed table code path. Before this existed, three
 * near-identical hand-rolled sort state machines lived in the admin-users,
 * securities, and portfolio-holdings tables (each with its own SortKey/SortDir +
 * comparator). New flat tables should render via this component, configured by a
 * column descriptor array — NOT a fresh fork. Collapsible / nested / two-pane /
 * reconcile-flow / static-marketing tables stay custom (see docs/ui-tables.md,
 * the Table Artifact Registry).
 *
 * Composes the presentational `ui/table.tsx` primitives (Table/TableHeader/…) —
 * it does NOT replace them. The descriptor philosophy mirrors `exportCsv`'s
 * `columns: { header, accessor }[]` (src/lib/csv-export.ts, FINLYNQ-144).
 *
 * Sort convention (2-state, applied consistently): the table starts UNSORTED
 * (natural `rows` order). First click on a sortable header sorts ascending;
 * subsequent clicks on the same header toggle asc ↔ desc. Clicking a different
 * header switches to that column, ascending. (Matches the existing securities /
 * admin / holdings tables — none of which had a 3rd "reset" click.)
 *
 * Null-safe comparators (load-bearing — decrypted name fields can be null; see
 * CLAUDE.md "String methods on decrypted-name fields must defend against null"):
 * string accessors compare via `(a ?? "").localeCompare(b ?? "")`; numeric
 * accessors via a null-safe numeric compare where null sorts as the smallest
 * value. Sortable headers carry `aria-sort` (mirrors the admin table's a11y).
 */

import * as React from "react";
import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type SortDir = "asc" | "desc";

export interface DataTableColumn<T> {
  /** Stable key — used for sort/filter/visibility state + React keys. */
  key: string;
  header: React.ReactNode;
  /** Value used for sorting AND filtering. Return null for "no value". */
  accessor: (row: T) => string | number | null;
  /** Optional custom cell. Defaults to the (stringified) accessor value. */
  render?: (row: T) => React.ReactNode;
  /** Default true. Set false for action columns (e.g. an "Open" button). */
  sortable?: boolean;
  /** "right" → right-aligned + tabular-nums (numbers / currency). */
  align?: "left" | "right";
  /**
   * Per-column header filter, client-side over `accessor`. "text" = substring
   * (case-insensitive); "select" = exact-match dropdown of distinct values.
   * Default/false = no filter. Opt-in per column.
   */
  filter?: "text" | "select" | false;
  /** When true, the column appears in the show/hide control. */
  hideable?: boolean;
  /** Start hidden (only meaningful with `hideable`). */
  defaultHidden?: boolean;
  /** Extra class on the column's `<td>`/`<th>`. */
  className?: string;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  /** Stable row key. */
  rowKey: (row: T) => string | number;
  /** Optional `<tr>` className per row. */
  rowClassName?: (row: T) => string | undefined;
  /** Rendered (in place of the table body) when there are zero source rows. */
  emptyState?: React.ReactNode;
  className?: string;

  // ── Controlled sort (optional). Uncontrolled by default. ──
  sort?: { key: string; dir: SortDir } | null;
  onSortChange?: (sort: { key: string; dir: SortDir } | null) => void;
}

function defaultCellValue(v: string | number | null): React.ReactNode {
  if (v == null) return "—";
  return String(v);
}

/**
 * Null-safe comparator over two accessor values. Strings via localeCompare;
 * numbers via subtraction; null is always the smallest. Mixed types fall back
 * to string compare. NEVER throws on null/undefined.
 */
function compareValues(
  a: string | number | null,
  b: string | number | null,
): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowClassName,
  emptyState,
  className,
  sort: controlledSort,
  onSortChange,
}: DataTableProps<T>) {
  // ── Sort state (uncontrolled unless `sort`/`onSortChange` provided). ──
  const [internalSort, setInternalSort] = React.useState<{
    key: string;
    dir: SortDir;
  } | null>(null);
  const sort = controlledSort !== undefined ? controlledSort : internalSort;
  const setSort = React.useCallback(
    (next: { key: string; dir: SortDir } | null) => {
      if (onSortChange) onSortChange(next);
      if (controlledSort === undefined) setInternalSort(next);
    },
    [onSortChange, controlledSort],
  );

  const handleHeaderClick = React.useCallback(
    (col: DataTableColumn<T>) => {
      if (col.sortable === false) return;
      setSort(
        sort && sort.key === col.key
          ? { key: col.key, dir: sort.dir === "asc" ? "desc" : "asc" }
          : { key: col.key, dir: "asc" },
      );
    },
    [sort, setSort],
  );

  // ── Per-column filter state (text/select), internal. ──
  const [filters, setFilters] = React.useState<Record<string, string>>({});
  const setFilter = React.useCallback((key: string, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }, []);
  const hasFilters = columns.some((c) => c.filter === "text" || c.filter === "select");

  // ── Column visibility state, internal. ──
  const [hidden, setHidden] = React.useState<Set<string>>(
    () => new Set(columns.filter((c) => c.defaultHidden).map((c) => c.key)),
  );
  const hideableColumns = columns.filter((c) => c.hideable);
  const visibleColumns = columns.filter((c) => !hidden.has(c.key));
  const toggleHidden = React.useCallback((key: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Distinct values per "select" filter column (over the full row set).
  const selectOptions = React.useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const col of columns) {
      if (col.filter !== "select") continue;
      const seen = new Set<string>();
      for (const r of rows) {
        const v = col.accessor(r);
        if (v != null && String(v) !== "") seen.add(String(v));
      }
      map[col.key] = [...seen].sort((a, b) => a.localeCompare(b));
    }
    return map;
  }, [columns, rows]);

  // ── Derived rows: filter → sort. ──
  const processedRows = React.useMemo(() => {
    let out = rows;

    // Filter (client-side over accessor).
    for (const col of columns) {
      const q = filters[col.key]?.trim();
      if (!q) continue;
      if (col.filter === "text") {
        const needle = q.toLowerCase();
        out = out.filter((r) => {
          const v = col.accessor(r);
          return v != null && String(v).toLowerCase().includes(needle);
        });
      } else if (col.filter === "select") {
        out = out.filter((r) => String(col.accessor(r) ?? "") === q);
      }
    }

    // Sort (stable: spread before sort).
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col) {
        const mul = sort.dir === "asc" ? 1 : -1;
        out = [...out].sort(
          (a, b) => compareValues(col.accessor(a), col.accessor(b)) * mul,
        );
      }
    }
    return out;
  }, [rows, columns, filters, sort]);

  if (rows.length === 0 && emptyState) {
    return <>{emptyState}</>;
  }

  return (
    <div className={cn("space-y-2", className)}>
      {hideableColumns.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="font-medium">Columns:</span>
          {hideableColumns.map((col) => (
            <label key={col.key} className="inline-flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={!hidden.has(col.key)}
                onChange={() => toggleHidden(col.key)}
                className="h-3 w-3 accent-primary"
              />
              {typeof col.header === "string" ? col.header : col.key}
            </label>
          ))}
        </div>
      )}

      <Table className={className}>
        <TableHeader>
          <TableRow>
            {visibleColumns.map((col) => {
              const sortable = col.sortable !== false;
              const active = sort?.key === col.key;
              const ariaSort: React.AriaAttributes["aria-sort"] = !sortable
                ? undefined
                : active
                  ? sort.dir === "asc"
                    ? "ascending"
                    : "descending"
                  : "none";
              return (
                <TableHead
                  key={col.key}
                  aria-sort={ariaSort}
                  className={cn(
                    col.align === "right" && "text-right",
                    "text-xs uppercase tracking-wider text-muted-foreground",
                    col.className,
                  )}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => handleHeaderClick(col)}
                      className={cn(
                        "inline-flex items-center gap-0.5 select-none transition-colors hover:text-foreground",
                        col.align === "right" && "flex-row-reverse",
                      )}
                    >
                      {col.header}
                      {active ? (
                        sort.dir === "asc" ? (
                          <ChevronUp className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5" />
                        )
                      ) : (
                        <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" />
                      )}
                    </button>
                  ) : (
                    col.header
                  )}
                </TableHead>
              );
            })}
          </TableRow>

          {hasFilters && (
            <TableRow className="hover:bg-transparent">
              {visibleColumns.map((col) => (
                <TableHead key={col.key} className={cn("pt-0 pb-2", col.className)}>
                  {col.filter === "text" ? (
                    <input
                      type="text"
                      value={filters[col.key] ?? ""}
                      onChange={(e) => setFilter(col.key, e.target.value)}
                      placeholder="Filter…"
                      className="h-7 w-full rounded-md border bg-background px-2 text-xs font-normal normal-case tracking-normal text-foreground placeholder:text-muted-foreground"
                    />
                  ) : col.filter === "select" ? (
                    <select
                      value={filters[col.key] ?? ""}
                      onChange={(e) => setFilter(col.key, e.target.value)}
                      className="h-7 w-full rounded-md border bg-background px-1 text-xs font-normal normal-case tracking-normal text-foreground"
                    >
                      <option value="">All</option>
                      {(selectOptions[col.key] ?? []).map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </TableHead>
              ))}
            </TableRow>
          )}
        </TableHeader>

        <TableBody>
          {processedRows.map((row) => (
            <TableRow key={rowKey(row)} className={rowClassName?.(row)}>
              {visibleColumns.map((col) => (
                <TableCell
                  key={col.key}
                  className={cn(
                    col.align === "right" && "text-right tabular-nums",
                    col.className,
                  )}
                >
                  {col.render
                    ? col.render(row)
                    : defaultCellValue(col.accessor(row))}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// Exported for unit tests + downstream consumers that need the pure comparator.
export { compareValues };
