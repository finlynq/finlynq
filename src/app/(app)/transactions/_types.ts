/**
 * Shared types for the /transactions page + its extracted hooks/components
 * (FINLYNQ-111 Phase 2). Moved verbatim out of page.tsx so the extracted
 * sub-components reference one authority instead of duplicating shapes.
 */

import type { ColumnId as SharedColumnId } from "@/lib/transactions/columns";
import type { TransactionSource } from "@/lib/tx-source";

export type Transaction = {
  id: number;
  date: string;
  accountId: number;
  accountName: string;
  accountAlias?: string | null;
  accountType?: string | null;
  categoryId: number;
  categoryName: string;
  categoryType: string;
  currency: string;
  amount: number;
  // Phase 2 currency rework — entered/account trilogy. Server may or may not
  // populate these (older rows + GET responses that pre-date the column
  // selection won't); use the soft-fallback chokepoint at every read site.
  enteredAmount?: number | null;
  enteredCurrency?: string | null;
  enteredFxRate?: number | null;
  quantity: number | null;
  portfolioHolding: string | null;
  // Ticker for the transaction's holding (e.g. "VGRO.TO"). Surfaced so the
  // optional Ticker column doesn't need a separate fetch per row.
  portfolioHoldingSymbol?: string | null;
  note: string;
  payee: string;
  tags: string;
  isBusiness: number | null;
  linkId: string | null;
  // Audit-trio (issue #28). Surfaced as a footer line in the edit dialog so
  // users can see when a row was created/last edited and which writer
  // surface authored it. Server-side fields are non-null (NOT NULL DEFAULTs)
  // but typed optional here for tolerance against any stale client state.
  createdAt?: string | null;
  updatedAt?: string | null;
  source?: TransactionSource | null;
  // Phase 2 portfolio-ops refactor (2026-05-25) — `kind` is the operation
  // discriminator (buy/sell/buy_cash_leg/etc). When set, Edit routes to
  // the dedicated /portfolio/new form instead of the generic edit dialog.
  // `tradeLinkId` is the buy/sell pair UUID — used to fetch the sibling
  // cash leg in the editor.
  kind?: string | null;
  tradeLinkId?: string | null;
};

export type LinkedSibling = {
  id: number;
  date: string;
  accountId: number | null;
  accountName: string | null;
  accountCurrency: string | null;
  categoryId: number | null;
  categoryName: string | null;
  // Returned by /api/transactions/linked so the client can run the four-check
  // rule for "is this a transfer pair I should open in unified Transfer mode?"
  categoryType: string | null;
  amount: number;
  currency: string;
  enteredAmount: number | null;
  enteredCurrency: string | null;
  enteredFxRate: number | null;
  quantity: number | null;
  portfolioHolding: string | null;
  payee: string | null;
  note: string | null;
  tags: string | null;
};

export type Account = {
  id: number;
  name: string;
  currency: string;
  alias?: string | null;
  type?: string | null;
  // Surfaced from /api/accounts so the Transfer dialog can hide the in-kind
  // / portfolio block when neither the source nor destination is an
  // investment account (Section E #10). Always present on the wire because
  // getAccounts uses select()-all on the row.
  isInvestment?: boolean;
  /** The lookups fetch asks for archived accounts too (see `useLookups`), so
   *  filter chips and the account filter can name an archived account and the
   *  `accountType` filter can resolve its ids. Create-mode pickers drop them. */
  archived?: boolean;
};

export type Category = { id: number; name: string; type: string; group: string };

export type Holding = {
  id: number;
  // accountId is the source-of-truth account linkage on portfolio_holdings.
  // Used to filter the picker in Add Transaction so the user only sees
  // holdings that belong to the selected account. Future M2M migration
  // (Section F/G #15) will swap this for `accounts: number[]`; the dialog
  // filter is the only line that changes.
  accountId: number | null;
  name: string;
  symbol: string | null;
  accountName: string | null;
  // Sum of transactions.quantity for this holding — surfaces in the in-kind
  // Source / Destination dropdowns so the user can see current positions.
  currentShares?: number | null;
};

// Issue #59 — discriminated-union shape for per-column filters. Mirrors the
// server-side zod schema in /api/settings/tx-filters; the page state holds
// the same shape so persistence is byte-identical.
export type ColFilterShape =
  | { type: "date"; columnId: SharedColumnId; from?: string; to?: string }
  | { type: "text"; columnId: SharedColumnId; value: string }
  | { type: "numeric"; columnId: SharedColumnId; op: "eq" | "gt" | "lt" | "between"; value: number; value2?: number }
  | { type: "enum"; columnId: SharedColumnId; values: string[] };

// Per-user header sort (issue #59). `null` direction = unsorted (default
// `date DESC` server-side). Persisted via /api/settings/tx-sort.
export type SortPref = {
  columnId: import("@/lib/transactions/columns").SortableColumnId | null;
  direction: "asc" | "desc" | null;
};

export type ColumnPref = { id: SharedColumnId; visible: boolean };
