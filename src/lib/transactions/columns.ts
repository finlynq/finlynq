/**
 * Shared transaction-table column metadata (issue #59).
 *
 * Single authority for the column-id list across:
 *  - the column-picker / sort / filter settings endpoints
 *    (`/api/settings/tx-columns`, `/api/settings/tx-sort`, `/api/settings/tx-filters`)
 *  - the GET `/api/transactions` sort whitelist
 *  - the client-side `/transactions` page (column picker, header sort, per-column filters)
 *
 * Adding a new column means: (1) extend `COLUMN_IDS`, (2) extend `DEFAULT_COLUMNS`
 * with a sensible default visibility, (3) extend `COLUMN_LABELS`, (4) optionally
 * extend `SORTABLE_COLUMN_IDS` and `FILTER_COLUMN_TYPES` if it should sort/filter,
 * and (5) wire the rendering branch in `transactions/page.tsx`. Removing one is
 * the same in reverse — old saved blobs simply ignore unknown ids.
 */

export const COLUMN_IDS = [
  "select",
  "date",
  "account",
  "accountType",
  "accountName",
  "accountAlias",
  "category",
  "payee",
  "portfolio",
  "portfolioTicker",
  "note",
  "tags",
  "quantity",
  "amount",
  // Issue #59 — audit trio (issue #28) surfaced as opt-in columns.
  "createdAt",
  "updatedAt",
  "source",
  "actions",
] as const;

export type ColumnId = (typeof COLUMN_IDS)[number];

export const DEFAULT_COLUMNS: Array<{ id: ColumnId; visible: boolean }> = [
  { id: "select", visible: true },
  { id: "date", visible: true },
  { id: "account", visible: true },
  { id: "accountType", visible: false },
  { id: "accountName", visible: false },
  { id: "accountAlias", visible: false },
  { id: "category", visible: true },
  { id: "payee", visible: true },
  { id: "portfolio", visible: false },
  { id: "portfolioTicker", visible: false },
  { id: "note", visible: true },
  { id: "tags", visible: false },
  { id: "quantity", visible: true },
  { id: "amount", visible: true },
  // Audit columns default OFF — they're opt-in and only useful for users
  // investigating row provenance / freshness.
  { id: "createdAt", visible: false },
  { id: "updatedAt", visible: false },
  { id: "source", visible: false },
  { id: "actions", visible: true },
];

export const COLUMN_LABELS: Record<ColumnId, string> = {
  select: "Select",
  date: "Date",
  account: "Account",
  accountType: "Account type",
  accountName: "Account name",
  accountAlias: "Account alias",
  category: "Category",
  payee: "Payee",
  portfolio: "Portfolio",
  portfolioTicker: "Ticker",
  note: "Note",
  tags: "Tags",
  quantity: "Qty",
  amount: "Amount",
  createdAt: "Created",
  updatedAt: "Updated",
  source: "Source",
  actions: "Actions",
};

/**
 * Columns that the user can hide / reorder. `select` and `actions` are
 * render scaffolding (checkbox column + per-row edit/split/delete button
 * group); hiding them would break bulk selection and inline editing.
 */
export const TOGGLEABLE_COLUMN_IDS: ColumnId[] = COLUMN_IDS.filter(
  (id) => id !== "select" && id !== "actions",
);

/**
 * Whitelist of column ids that the GET /api/transactions handler will
 * accept as a `sort` parameter. Anything outside this list is rejected.
 *
 * Encrypted name columns (`accountName`, `accountAlias`, `category`,
 * `payee`, `portfolio`, `portfolioTicker`, `note`, `tags`) are deliberately
 * omitted because their plaintext is NULL after Stream D Phase 3 cutover —
 * SQL ORDER BY would group every encrypted row at the bottom and the user
 * would see "random-looking" order. Sorting on those columns must happen
 * post-decryption, which the issue spec defers as a separate enhancement.
 */
export const SORTABLE_COLUMN_IDS = [
  "date",
  "amount",
  "quantity",
  "createdAt",
  "updatedAt",
  "source",
  "accountType",
] as const satisfies ReadonlyArray<ColumnId>;

export type SortableColumnId = (typeof SORTABLE_COLUMN_IDS)[number];

const SORTABLE_SET = new Set<string>(SORTABLE_COLUMN_IDS);

export function isSortableColumnId(v: unknown): v is SortableColumnId {
  return typeof v === "string" && SORTABLE_SET.has(v);
}

/**
 * Filter-input affordance per column. Encrypted columns map to a
 * post-decryption substring filter; date / numeric / enum columns push
 * down into SQL.
 */
export type FilterType = "date" | "text" | "numeric" | "enum";

export const FILTER_COLUMN_TYPES: Partial<Record<ColumnId, FilterType>> = {
  date: "date",
  createdAt: "date",
  updatedAt: "date",
  account: "text",
  accountName: "text",
  accountType: "enum",
  accountAlias: "text",
  category: "enum",
  payee: "text",
  portfolio: "text",
  portfolioTicker: "text",
  note: "text",
  tags: "text",
  quantity: "numeric",
  amount: "numeric",
  source: "enum",
};

export const FILTERABLE_COLUMN_IDS = Object.keys(
  FILTER_COLUMN_TYPES,
) as ColumnId[];

const FILTERABLE_SET = new Set<string>(FILTERABLE_COLUMN_IDS);

export function isFilterableColumnId(v: unknown): v is ColumnId {
  return typeof v === "string" && FILTERABLE_SET.has(v);
}
