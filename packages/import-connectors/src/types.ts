// Pluggable connector interface for importing transactions from third-party
// services. WealthPosition is the first implementation; adding another
// provider is a new sibling directory under src/.
//
// This package has zero runtime deps and must not import from Finlynq
// (`@/...`) or Next. That keeps it `npm publish`-safe.

/**
 * Mirror of `RawTransaction` from pf-app/src/lib/import-pipeline.ts:8-20.
 * Duplicated here intentionally so the package stays self-contained.
 * Source of truth is Finlynq's import-pipeline; keep shapes in sync.
 */
export interface RawTransaction {
  date: string;
  account: string;
  amount: number;
  payee: string;
  category?: string;
  currency?: string;
  note?: string;
  tags?: string;
  quantity?: number;
  portfolioHolding?: string;
  fitId?: string;
  /** Shared id for every row in a multi-leg group (transfer, same-account
   *  conversion, liquidation). Lets the UI surface siblings of a transfer
   *  from either leg. Unset for standalone transactions. */
  linkId?: string;
}

export interface ExternalAccount {
  id: string;
  name: string;
  /** Asset / Liability / other — provider-specific raw string. */
  type: string;
  currency: string;
  groupName?: string;
}

export interface ExternalCategory {
  id: string;
  name: string;
  /** Income / Expense / Revaluation — provider-specific raw string. */
  type: string;
  groupName?: string;
}

/**
 * A provider-native transaction before mapping. Each entry represents one
 * side of the posting — either an account or a category. WP, YNAB, Mint
 * all fit this shape with minor adaptations.
 */
export interface ExternalTransactionEntry {
  /** Name that resolves against either ExternalAccount[].name or ExternalCategory[].name. */
  categorization: string;
  amount: string | number;
  currency: string;
  note?: string;
  /** Provider-specific "how much of the held thing changed" (e.g. share count). Non-ticker. */
  holding?: string | number | null;
}

export interface ExternalTransaction {
  id: string;
  date: string;
  payee?: string;
  tags?: string[];
  reviewed?: boolean;
  entries: ExternalTransactionEntry[];
}

export interface ConnectorListTransactionsOpts {
  /** ISO date (YYYY-MM-DD). */
  startDate?: string;
  /** ISO date (YYYY-MM-DD). */
  endDate?: string;
}

export interface ConnectorClient {
  listAccounts(): Promise<ExternalAccount[]>;
  listCategories(): Promise<ExternalCategory[]>;
  /** Async iterator over pages of transactions. Each yielded value is a page. */
  listTransactions(
    opts?: ConnectorListTransactionsOpts,
  ): AsyncIterable<ExternalTransaction[]>;
  /**
   * Balances as of a single date, keyed by ExternalAccount.id.
   * Amount is in the account's own currency. Returning null/undefined means
   * the provider doesn't support balance reconciliation.
   */
  getBalances?(date: string): Promise<Record<string, number>>;
}

export interface ConnectorMetadata {
  id: string;
  displayName: string;
  homepage: string;
  credentialFields: Array<{
    key: string;
    label: string;
    type: "password" | "text";
  }>;
  rateLimit: { requestsPerSecond: number };
}

/**
 * Resolved identity maps passed into the transform. Keys are the
 * provider's external ids; values are Finlynq primary-key ids.
 * `categoryMap` values may be null if the user explicitly chose
 * "leave uncategorized" for that external category.
 */
export interface ConnectorMappingResolved {
  accountMap: Map<string, number>;
  categoryMap: Map<string, number | null>;
  /** Finlynq category id to use for 2-account transfer transactions. */
  transferCategoryId: number | null;
  /** Finlynq account name lookup by id — needed to produce the `account` string on RawTransaction. */
  accountNameById: Map<number, string>;
  /** Finlynq category name lookup by id. */
  categoryNameById: Map<number, string>;
  /** External account metadata lookup by external id — for transfer payee strings and sign decisions. */
  externalAccountById: Map<string, ExternalAccount>;
}

export interface TransformSplitRow {
  /** Finlynq category id for this split row (may be null for uncategorized). */
  categoryId: number | null;
  amount: number;
  note?: string;
}

export interface TransformSplitTx {
  /** The parent RawTransaction (account-side). Use importHash from this row to look up the inserted Finlynq tx id. */
  parent: RawTransaction;
  splits: TransformSplitRow[];
  /** Provider's external transaction id — surfaced in error messages if anything goes wrong. */
  externalId: string;
}

export interface TransformError {
  externalId: string;
  reason: string;
}

export interface TransformResult {
  /** Ready-to-import flat transactions (1A+1C, 2A transfers, 1-entry unconfirmed). */
  flat: RawTransaction[];
  /** Split transactions — parent goes through previewImport; splits are inserted after executeImport. */
  splits: TransformSplitTx[];
  /** Anything we couldn't map safely. */
  errors: TransformError[];
}

export interface Connector<Credentials> {
  metadata: ConnectorMetadata;
  createClient(creds: Credentials): ConnectorClient;
  transform(
    externalTxs: ExternalTransaction[],
    mapping: ConnectorMappingResolved,
  ): TransformResult;
}
