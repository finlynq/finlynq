/**
 * Generic per-column table filters — the shape shared by every table that
 * offers transactions-style header filters.
 *
 * The discriminated union is `ColFilterShape` from the transactions page
 * (src/app/(app)/transactions/_types.ts) with its `columnId` widened from
 * transactions' own `ColumnId` to a plain string, which is the only thing that
 * ever made it transaction-specific. Transactions keeps its narrower alias so
 * its persisted `/api/settings/tx-filters` blobs stay byte-identical.
 *
 * Pure: no React, no `@/db`, safe on both sides of the network boundary. The
 * server re-validates with its own zod schema — never trust the parsed wire
 * shape from `parseTableFilters` alone.
 */

/** Filter affordance a column offers. Mirrors transactions' `FilterType`. */
export type TableFilterType = "date" | "text" | "numeric" | "enum";

export type NumericFilterOp = "eq" | "gt" | "lt" | "between";

export type TableColFilter =
  | { type: "date"; columnId: string; from?: string; to?: string }
  | { type: "text"; columnId: string; value: string }
  | {
      type: "numeric";
      columnId: string;
      op: NumericFilterOp;
      value: number;
      value2?: number;
    }
  | { type: "enum"; columnId: string; values: string[] };

/** An enum filter's choices. Supplied by the consumer — NOT hardcoded here. */
export interface FilterOption {
  value: string;
  label: string;
}

/**
 * Whether a filter carries no actual constraint (an empty date range, a blank
 * substring, an enum with nothing ticked). Such a filter must be dropped rather
 * than sent: an empty `enum` would otherwise mean "match none" server-side and
 * silently blank the table.
 */
export function isEmptyFilter(f: TableColFilter | null | undefined): boolean {
  if (!f) return true;
  switch (f.type) {
    case "date":
      return !f.from && !f.to;
    case "text":
      return f.value.trim() === "";
    case "enum":
      return f.values.length === 0;
    case "numeric":
      return !Number.isFinite(f.value);
  }
}

/** Drop the no-op filters, then JSON-encode for a query param. "" when empty. */
export function serializeTableFilters(filters: TableColFilter[]): string {
  const live = filters.filter((f) => !isEmptyFilter(f));
  return live.length === 0 ? "" : JSON.stringify(live);
}

/**
 * Parse the wire value back to filters. Returns `null` — distinct from `[]` —
 * when the payload is present but unparseable, so a caller can answer 400
 * rather than silently serving an UNFILTERED page that the UI still labels as
 * filtered.
 */
export function parseTableFilters(
  raw: string | null | undefined,
): TableColFilter[] | null {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TableColFilter[]) : null;
  } catch {
    return null;
  }
}

/** The filter currently applied to a column, if any. */
export function findColFilter(
  filters: TableColFilter[],
  columnId: string,
): TableColFilter | undefined {
  return filters.find((f) => f.columnId === columnId);
}

/**
 * Immutably set (or clear, with `null`) one column's filter. Clearing removes
 * the entry entirely rather than leaving an empty one behind.
 */
export function setColFilter(
  filters: TableColFilter[],
  columnId: string,
  next: TableColFilter | null,
): TableColFilter[] {
  const rest = filters.filter((f) => f.columnId !== columnId);
  return next && !isEmptyFilter(next) ? [...rest, next] : rest;
}
