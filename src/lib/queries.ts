import { db, schema, getDialect } from "@/db";
import { eq, and, gte, lte, desc, sql, asc, inArray, isNotNull } from "drizzle-orm";
import type { SQL, AnyColumn } from "drizzle-orm";
import { requireHoldingForInvestmentAccount } from "@/lib/investment-account";
import type { TransactionSource } from "@/lib/tx-source";
import type { SortableColumnId } from "@/lib/transactions/columns";
import { computeReportingFields } from "@/lib/fx/reporting-amount";
import { getDisplayCurrency } from "@/lib/fx-service";

const { accounts, categories, transactions, portfolioHoldings, securities, budgets, budgetTemplates } = schema;

/** Dialect-safe month extraction: strftime for SQLite, to_char for PG */
function monthExpr(dateCol: typeof transactions.date | typeof transactions.date): SQL<string> {
  return getDialect() === "postgres"
    ? sql<string>`to_char(${dateCol}::date, 'YYYY-MM')`
    : sql<string>`strftime('%Y-%m', ${dateCol})`;
}

// Accounts
//
// Stream D Phase 4 (2026-05-03): plaintext `name`/`alias` columns dropped.
// ORDER BY drops the name leg — sort by (type, group) only here; the route
// handler sorts the remaining slice in memory after decrypting `name_ct`.
export async function getAccounts(userId: string, opts?: { includeArchived?: boolean }) {
  const conditions = [eq(accounts.userId, userId)];
  if (!opts?.includeArchived) conditions.push(eq(accounts.archived, false));
  return db.select().from(accounts).where(and(...conditions)).orderBy(accounts.type, accounts.group).all();
}

export async function getAccountById(id: number, userId: string) {
  return db.select().from(accounts).where(and(eq(accounts.id, id), eq(accounts.userId, userId))).get();
}

/** CRUD write payload. Stream D Phase 4 (2026-05-03) dropped plaintext
 * `name`/`alias` columns — callers MUST set the encrypted columns
 * (`nameCt`/`nameLookup`/`aliasCt`/`aliasLookup`) via {@link buildNameFields}
 * with a DEK. Without a DEK, the row is created with NULL ct/lookup and
 * is effectively unreadable. */
type AccountWrite = {
  type: string;
  group: string;
  currency: string;
  note?: string;
  isInvestment?: boolean;
  nameCt?: string | null;
  nameLookup?: string | null;
  aliasCt?: string | null;
  aliasLookup?: string | null;
};

/**
 * Issue #233 — liability accounts that come in with a blank `group` are
 * silently surfaced as `groupName: ""` in `get_cash_flow_forecast`'s
 * `accountsExcluded` partition (the coalesce treats "" as truthy). Default
 * `type='L'` rows whose `group` is missing/blank/whitespace-only to
 * `"Liability"`. Asset accounts keep current behavior — empty group is a
 * meaningful "uncategorized" state for assets.
 */
export function resolveDefaultGroup(
  type: string,
  group: string | null | undefined,
): string {
  const trimmed = (group ?? "").trim();
  if (trimmed) return trimmed;
  return type === "L" ? "Liability" : "";
}

export async function createAccount(userId: string, data: AccountWrite) {
  const normalized: AccountWrite = {
    ...data,
    group: resolveDefaultGroup(data.type, data.group),
  };
  return db.insert(accounts).values({ ...normalized, userId }).returning().get();
}

export async function updateAccount(
  id: number,
  userId: string,
  data: Partial<AccountWrite & { archived: boolean; isInvestment: boolean }>,
) {
  // Apply the same default when the caller supplies `group` explicitly. We
  // only touch it when `group` is in the payload — leaving an unset group
  // untouched is correct semantics for partial updates.
  let normalized = data;
  if (Object.prototype.hasOwnProperty.call(data, "group")) {
    // We need the row's `type` to know whether the liability default applies
    // when the caller didn't also supply `type`. Read once from the existing
    // row.
    const existingType =
      data.type ?? (await getAccountById(id, userId))?.type ?? "A";
    normalized = { ...data, group: resolveDefaultGroup(existingType, data.group) };
  }
  return db.update(accounts).set(normalized).where(and(eq(accounts.id, id), eq(accounts.userId, userId))).returning().get();
}

export async function deleteAccount(id: number, userId: string) {
  return db.delete(accounts).where(and(eq(accounts.id, id), eq(accounts.userId, userId)));
}

// Categories
//
// Stream D Phase 4 (2026-05-03): plaintext `name` column dropped. ORDER BY
// drops the name leg — route handler sorts remaining slice after decrypt.
export async function getCategories(userId: string) {
  return db.select().from(categories).where(eq(categories.userId, userId)).orderBy(categories.type, categories.group).all();
}

export async function getCategoryById(id: number, userId: string) {
  return db.select().from(categories).where(and(eq(categories.id, id), eq(categories.userId, userId))).get();
}

type CategoryWrite = {
  type: string;
  group: string;
  note?: string;
  // Stream D Phase 4 — caller supplies encrypted name fields via
  // buildNameFields() with a DEK.
  nameCt?: string | null;
  nameLookup?: string | null;
};

export async function createCategory(userId: string, data: CategoryWrite) {
  return db.insert(categories).values({ ...data, userId }).returning().get();
}

export async function updateCategory(id: number, userId: string, data: Partial<CategoryWrite>) {
  return db.update(categories).set(data).where(and(eq(categories.id, id), eq(categories.userId, userId))).returning().get();
}

export async function deleteCategory(id: number, userId: string) {
  return db.delete(categories).where(and(eq(categories.id, id), eq(categories.userId, userId)));
}

export async function getTransactionCountByCategory(categoryId: number, userId: string): Promise<number> {
  const result = await db.select({ count: sql<number>`count(*)` }).from(transactions).where(and(eq(transactions.categoryId, categoryId), eq(transactions.userId, userId))).get();
  return result?.count ?? 0;
}

// Transactions
//
// Issue #59 — `sort` is whitelisted at the lib boundary so the route handler
// can't accidentally interpolate user input into SQL. The map below is the
// SOLE authority for which Drizzle column expression backs each sortable id;
// extending requires extending `SortableColumnId` in
// `@/lib/transactions/columns` first. Encrypted name columns are NOT in the
// list — sorting on them post-Phase-3 returns NULL-clustered rows.
export type TxSortFilter = {
  // FINLYNQ-177 — single-transaction id deep link. Applied as an owner-scoped
  // `WHERE transactions.id = ?` (alongside the always-present
  // `eq(transactions.userId, userId)`), so `?id=<another user's id>` and
  // `?id=<nonexistent>` both return zero rows — never the full list.
  id?: number;
  startDate?: string;
  endDate?: string;
  // Audit-trio range filters (issue #59). All ISO timestamps; gte/lte
  // pushed straight into SQL via the (user_id, *_at DESC) composite index.
  createdAtFrom?: string;
  createdAtTo?: string;
  updatedAtFrom?: string;
  updatedAtTo?: string;
  accountId?: number;
  categoryId?: number;
  portfolioHoldingId?: number;
  // Multi-id pushdown so the per-column enum filter UI can write
  // (account in [...]) / (category in [...]) without firing one query
  // per chip.
  accountIds?: number[];
  categoryIds?: number[];
  // Numeric range pushdown for amount / quantity columns. Both are signed
  // doubles; passing min and max simulates BETWEEN. Equality uses both
  // bounds set to the same value.
  amountMin?: number;
  amountMax?: number;
  amountEq?: number;
  quantityMin?: number;
  quantityMax?: number;
  quantityEq?: number;
  // Source filter (small-cardinality enum). Multi-select.
  sources?: TransactionSource[];
  search?: string;
  // Sort whitelist — see SORTABLE_COLUMN_IDS in
  // `@/lib/transactions/columns`. Default = `date DESC`.
  sortColumnId?: SortableColumnId;
  sortDirection?: "asc" | "desc";
  limit?: number;
  offset?: number;
};

function buildTxFilterConditions(userId: string, filters?: TxSortFilter) {
  const conditions = [eq(transactions.userId, userId)];
  // FINLYNQ-177 — single-tx id pushdown. Combined with the user_id predicate
  // above, so another user's id (or a nonexistent one) yields zero rows.
  if (filters?.id != null) conditions.push(eq(transactions.id, filters.id));
  if (filters?.startDate) conditions.push(gte(transactions.date, filters.startDate));
  if (filters?.endDate) conditions.push(lte(transactions.date, filters.endDate));
  if (filters?.createdAtFrom) {
    conditions.push(gte(transactions.createdAt, new Date(filters.createdAtFrom)));
  }
  if (filters?.createdAtTo) {
    conditions.push(lte(transactions.createdAt, new Date(filters.createdAtTo)));
  }
  if (filters?.updatedAtFrom) {
    conditions.push(gte(transactions.updatedAt, new Date(filters.updatedAtFrom)));
  }
  if (filters?.updatedAtTo) {
    conditions.push(lte(transactions.updatedAt, new Date(filters.updatedAtTo)));
  }
  if (filters?.accountId) conditions.push(eq(transactions.accountId, filters.accountId));
  if (filters?.categoryId) conditions.push(eq(transactions.categoryId, filters.categoryId));
  if (filters?.portfolioHoldingId) conditions.push(eq(transactions.portfolioHoldingId, filters.portfolioHoldingId));
  if (filters?.accountIds && filters.accountIds.length > 0) {
    conditions.push(inArray(transactions.accountId, filters.accountIds));
  }
  if (filters?.categoryIds && filters.categoryIds.length > 0) {
    conditions.push(inArray(transactions.categoryId, filters.categoryIds));
  }
  if (filters?.amountEq != null) {
    conditions.push(eq(transactions.amount, filters.amountEq));
  } else {
    if (filters?.amountMin != null) conditions.push(gte(transactions.amount, filters.amountMin));
    if (filters?.amountMax != null) conditions.push(lte(transactions.amount, filters.amountMax));
  }
  if (filters?.quantityEq != null) {
    conditions.push(eq(transactions.quantity, filters.quantityEq));
  } else {
    if (filters?.quantityMin != null) conditions.push(gte(transactions.quantity, filters.quantityMin));
    if (filters?.quantityMax != null) conditions.push(lte(transactions.quantity, filters.quantityMax));
  }
  if (filters?.sources && filters.sources.length > 0) {
    conditions.push(inArray(transactions.source, filters.sources));
  }
  if (filters?.search) {
    conditions.push(
      sql`(${transactions.payee} LIKE ${'%' + filters.search + '%'} OR ${transactions.note} LIKE ${'%' + filters.search + '%'} OR ${transactions.tags} LIKE ${'%' + filters.search + '%'})`
    );
  }
  return conditions;
}

/** Map sortable column id → Drizzle column expression. Hard-coded so user
 * input never touches an `ORDER BY` clause directly. Returned as the
 * generic AnyColumn shape Drizzle's `asc`/`desc` accept. */
function txSortExpr(id: SortableColumnId): AnyColumn {
  switch (id) {
    case "date":
      return transactions.date;
    case "amount":
      return transactions.amount;
    case "quantity":
      return transactions.quantity;
    case "createdAt":
      return transactions.createdAt;
    case "updatedAt":
      return transactions.updatedAt;
    case "source":
      return transactions.source;
    case "accountType":
      return accounts.type;
  }
}

export async function getTransactions(userId: string, filters?: TxSortFilter) {
  const conditions = buildTxFilterConditions(userId, filters);

  // Default = `date DESC`. Add `transactions.id DESC` as a stable tiebreaker
  // so paginated results don't shuffle when many rows share the same value
  // (especially common when sorting by `source` or `accountType`).
  const direction = filters?.sortDirection === "asc" ? asc : desc;
  const sortCol = filters?.sortColumnId ? txSortExpr(filters.sortColumnId) : transactions.date;
  const orderClauses = [direction(sortCol), desc(transactions.id)];

  const query = db
    .select({
      id: transactions.id,
      date: transactions.date,
      accountId: transactions.accountId,
      // Stream D Phase 4 (2026-05-03) — plaintext `accounts.name` /
      // `categories.name` / `portfolio_holdings.name` /
      // `portfolio_holdings.symbol` / `accounts.alias` columns dropped. Only
      // the ciphertext is selected here; the route handler decrypts with
      // the session DEK before serializing.
      accountNameCt: accounts.nameCt,
      accountAliasCt: accounts.aliasCt,
      accountType: accounts.type,
      categoryId: transactions.categoryId,
      categoryNameCt: categories.nameCt,
      categoryType: categories.type,
      currency: transactions.currency,
      amount: transactions.amount,
      // Phase 2 of the currency rework — surface entered-side fields so the
      // tx list shows what the user actually typed. normalizeTxRow() in
      // queries.ts handles the soft-fallback for un-backfilled rows.
      enteredCurrency: transactions.enteredCurrency,
      enteredAmount: transactions.enteredAmount,
      enteredFxRate: transactions.enteredFxRate,
      quantity: transactions.quantity,
      // Portfolio holding name comes off the JOINed portfolio_holdings row.
      // Phase 5 + 6 (2026-04-29) retired the legacy text column on
      // transactions; the FK is now the sole source of truth.
      portfolioHoldingId: transactions.portfolioHoldingId,
      portfolioHoldingNameCt: portfolioHoldings.nameCt,
      portfolioHoldingSymbolCt: portfolioHoldings.symbolCt,
      // Securities master read-flip: the centralized identity for this holding.
      // The route prefers these over the per-position name/symbol when the flag
      // is on, so a renamed security (e.g. a cash sleeve "Cash USD") shows in
      // the ledger instead of the stale position name.
      securityNameCt: securities.nameCt,
      securitySymbolCt: securities.symbolCt,
      note: transactions.note,
      payee: transactions.payee,
      tags: transactions.tags,
      linkId: transactions.linkId,
      // Audit-trio (issue #28). Surface for the edit dialog footer + the
      // future "recently modified" sort. Pre-migration rows backfill to
      // NOW()/'manual' — see migrate-tx-audit-fields.sql.
      createdAt: transactions.createdAt,
      updatedAt: transactions.updatedAt,
      source: transactions.source,
      // Phase 2 portfolio-ops refactor (2026-05-25) — surface kind +
      // tradeLinkId so the transactions UI can:
      //   - route the Edit button on portfolio rows to /portfolio/new
      //   - mark paired cash legs as such in the ledger
      //   - show "cascade delete will also remove sibling X" in the confirm
      kind: transactions.kind,
      tradeLinkId: transactions.tradeLinkId,
    })
    .from(transactions)
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(portfolioHoldings, eq(transactions.portfolioHoldingId, portfolioHoldings.id))
    .leftJoin(securities, eq(portfolioHoldings.securityId, securities.id))
    .where(and(...conditions))
    .orderBy(...orderClauses)
    .limit(filters?.limit ?? 100)
    .offset(filters?.offset ?? 0);

  return query.all();
}

export async function getTransactionCount(userId: string, filters?: TxSortFilter): Promise<number> {
  const conditions = buildTxFilterConditions(userId, filters);

  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(transactions)
    .where(and(...conditions))
    .get();

  return result?.count ?? 0;
}

export async function createTransaction(userId: string, data: {
  date: string;
  accountId: number;
  // Nullable: MCP `record_transaction` / `bulk_record_transactions` write
  // uncategorized rows (`category_id = NULL`) when no category resolves and
  // the account isn't an investment account. The REST POST route always
  // supplies a number, so `null` here is a widening that doesn't change its
  // behavior. The DB column is nullable (schema-pg.ts:76).
  categoryId: number | null;
  currency?: string;
  amount?: number;
  // Phase 2 of the currency rework — entered/account trilogy. The route
  // handler converts entered→account via convertToAccountCurrency() before
  // calling this function and passes both sets of fields. enteredFxRate is
  // locked at write time so historical balances stay reproducible.
  enteredCurrency?: string | null;
  enteredAmount?: number | null;
  enteredFxRate?: number | null;
  // Currency rework Phase 3 — historical reporting amount (account currency →
  // display currency at this row's date). Computed below when not supplied; a
  // caller may pass precomputed values to skip the lookup.
  reportingCurrency?: string | null;
  reportingAmount?: number | null;
  reportingRate?: number | null;
  quantity?: number | null;
  portfolioHoldingId?: number | null;
  // Nullable: the MCP HTTP write path (FINLYNQ-108) passes already-encrypted
  // payee/note/tags whose ternary fallback can be `null` under a cold DEK.
  // REST passes encrypted strings; the columns are nullable text.
  note?: string | null;
  payee?: string | null;
  tags?: string | null;
  isBusiness?: number;
  splitPerson?: string;
  splitRatio?: number;
  // Issue #96 multi-currency trade-pair linker. Server-generated UUID stamped
  // into `trade_link_id`. REST never passes it (the column defaults NULL);
  // FINLYNQ-108 routes MCP HTTP record_transaction/bulk_record_transactions
  // through this helper, and those pass a validated/minted UUID here so the
  // cost-basis aggregators can pair the cash + stock legs. Distinct from the
  // transfer-pair `link_id`.
  tradeLinkId?: string | null;
  // Phase-2 canonicalization discriminator. REST create/update intentionally
  // keep `kind` off their boundary (it's reserved for portfolio-ops helpers
  // in operations.ts); the only non-portfolio writer that sets it through this
  // helper is the opening-balance path (FINLYNQ-206), which stamps
  // `kind='opening_balance'`. Validated by the transactions_kind_check DB
  // constraint. Defaults to NULL when omitted.
  kind?: string | null;
  // Audit-source attribution (issue #28). Defaults to 'manual' when the
  // caller doesn't pass one — the UI POST handler relies on the default,
  // every other writer (import/MCP/connector/sample-data/restore) sets
  // it explicitly so the surface info is set at the route boundary.
  source?: TransactionSource;
}, dek: Buffer | null = null) {
  // Investment-account constraint: every transaction in a flagged account
  // must reference a portfolio_holdings row. Throws
  // InvestmentHoldingRequiredError when the FK is missing — the route
  // handler maps it to a 400.
  await requireHoldingForInvestmentAccount(userId, data.accountId, data.portfolioHoldingId);
  // Issue #212 / FINLYNQ-97 — sign-vs-category invariant is now advisory.
  // The validator still runs at the route boundary (see
  // `/api/transactions` POST/PUT) and surfaces a `warning` on the response
  // body; this helper no longer rejects the row, so the `dek` parameter is
  // kept only for the legacy two-arg call shape and is unused here.
  void dek;
  // Currency rework Phase 3 — lock the historical reporting amount at write
  // time so flow reports SUM a stored value. Best-effort: computeReportingFields
  // never throws and returns null on an unresolved rate, so a reporting-leg miss
  // can't block the ledger write (the self-heal + cron backfill NULLs later).
  let reportingFields = {};
  if (data.reportingAmount == null && data.amount != null && data.currency) {
    const r = await computeReportingFields({
      userId,
      accountCurrency: data.currency,
      amount: data.amount,
      date: data.date,
      reportingCurrency: await getDisplayCurrency(userId),
    });
    if (r) {
      reportingFields = {
        reportingCurrency: r.reportingCurrency,
        reportingAmount: r.reportingAmount,
        reportingRate: r.reportingRate,
      };
    }
  }
  return db.insert(transactions).values({ ...data, ...reportingFields, userId }).returning().get();
}

export async function updateTransaction(id: number, userId: string, data: Partial<{
  date: string;
  accountId: number;
  categoryId: number;
  currency: string;
  amount: number;
  enteredCurrency: string | null;
  enteredAmount: number | null;
  enteredFxRate: number | null;
  reportingCurrency: string | null;
  reportingAmount: number | null;
  reportingRate: number | null;
  quantity: number;
  portfolioHoldingId: number | null;
  note: string;
  payee: string;
  tags: string;
  isBusiness: number;
  splitPerson: string;
  splitRatio: number;
}>, dek: Buffer | null = null) {
  // Investment-account constraint applies to the post-merge state. Touching
  // accountId xor portfolioHoldingId can flip the row in or out of the
  // constraint, so we resolve both against the current row before checking.
  // `data.portfolioHoldingId === undefined` means the caller didn't include
  // the field; an explicit `null` is treated as a clear intent to unlink
  // (and rejected when the resulting account is investment).
  // Issue #212 / FINLYNQ-97 — sign-vs-category check is now advisory and
  // lives at the route boundary. This helper only does the investment-
  // account FK pre-read; the validator is called from the POST/PUT route
  // and surfaces a `warning` on the response body.
  void dek;
  const needsCurrent =
    data.accountId !== undefined ||
    Object.prototype.hasOwnProperty.call(data, "portfolioHoldingId");
  if (needsCurrent) {
    const current = await db
      .select({
        accountId: transactions.accountId,
        portfolioHoldingId: transactions.portfolioHoldingId,
      })
      .from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.userId, userId)))
      .get();
    if (current) {
      const resultingAccountId = data.accountId ?? current.accountId;
      const resultingHoldingId = Object.prototype.hasOwnProperty.call(data, "portfolioHoldingId")
        ? (data.portfolioHoldingId ?? null)
        : current.portfolioHoldingId;
      await requireHoldingForInvestmentAccount(userId, resultingAccountId, resultingHoldingId);
    }
  }
  // Currency rework Phase 3 — recompute the historical reporting amount when
  // the amount / currency / date changed. Best-effort (never throws; leaves
  // columns untouched on an unresolved rate — self-heal / cron backfill).
  // Skipped when the caller already supplied an explicit reportingAmount.
  let reportingFields: Partial<{
    reportingCurrency: string | null;
    reportingAmount: number | null;
    reportingRate: number | null;
  }> = {};
  const touchesReporting =
    data.reportingAmount === undefined &&
    (data.amount !== undefined || data.currency !== undefined || data.date !== undefined);
  if (touchesReporting) {
    const cur = await db
      .select({ date: transactions.date, currency: transactions.currency, amount: transactions.amount })
      .from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.userId, userId)))
      .get();
    const date = data.date ?? cur?.date;
    const currency = data.currency ?? cur?.currency;
    const amount = data.amount ?? cur?.amount;
    if (date && currency && amount != null) {
      const r = await computeReportingFields({
        userId,
        accountCurrency: currency,
        amount,
        date,
        reportingCurrency: await getDisplayCurrency(userId),
      });
      if (r) {
        reportingFields = {
          reportingCurrency: r.reportingCurrency,
          reportingAmount: r.reportingAmount,
          reportingRate: r.reportingRate,
        };
      }
    }
  }
  // Audit-trio (issue #28): every UPDATE bumps updated_at = NOW(). `source`
  // is INSERT-only and intentionally NOT spread into `data`. The Partial<>
  // input type above doesn't include `source`, so a future caller adding it
  // here would be a type error.
  return db
    .update(transactions)
    .set({ ...data, ...reportingFields, updatedAt: sql`NOW()` })
    .where(and(eq(transactions.id, id), eq(transactions.userId, userId)))
    .returning()
    .get();
}

/**
 * Per-row write warnings for transaction inserts/updates. Pure check —
 * no DB access — so the MCP HTTP write tools (record_transaction,
 * bulk_record_transactions, update_transaction) can call it post-resolve
 * and surface advisory messages alongside `success: true`. Stdio MCP write
 * tools refuse investment-account writes outright and don't expose
 * `portfolioHoldingId`/`quantity`, so the warning condition can't trigger
 * there — those tools don't need to call this.
 *
 * Returns `string[]` for backward compatibility with the MCP response
 * envelope. Each entry is prefixed with a stable code so callers can
 * pattern-match without parsing the message text:
 *   - `[quantity_missing_for_bound_holding]`: a row bound to a
 *     `portfolioHoldingId` that moves cash (`amount != 0`) but omits
 *     `quantity` won't move the holding's unit count. Silent before;
 *     surfaces a warning so callers don't end up with a stale portfolio
 *     view. See issue #31.
 *   - `[amount_overridden_by_entered]` (issue #211 Bug h): when both
 *     `amount` and `enteredAmount` are passed, the tool docstring says
 *     `amount` is silently ignored — make it loud. Surfaces the original
 *     `amount` and the resolved `amount` (after FX) so the caller can
 *     verify the override matched their intent.
 */
export function deriveTxWriteWarnings(input: {
  portfolioHoldingId?: number | null;
  amount?: number | null;
  quantity?: number | null;
  // Issue #211 Bug h: explicit override-detection inputs. Pass the
  // *user-supplied* `amount` (the literal arg before resolution) and
  // the *user-supplied* `enteredAmount` (likewise). `resolvedAmount`
  // is what the server will write to the DB after FX conversion.
  // Omit any of these to skip the override check.
  originalAmount?: number | null;
  enteredAmount?: number | null;
  resolvedAmount?: number | null;
  enteredCurrency?: string | null;
}): string[] {
  const warnings: string[] = [];
  const hasHolding = input.portfolioHoldingId != null;
  const movesCash = input.amount != null && input.amount !== 0;
  const noQuantity = input.quantity == null;
  if (hasHolding && movesCash && noQuantity) {
    warnings.push(
      "[quantity_missing_for_bound_holding] quantity not set — holding unit count was not updated",
    );
  }
  if (
    input.originalAmount != null &&
    input.enteredAmount != null &&
    input.resolvedAmount != null
  ) {
    const ccy = input.enteredCurrency ? ` ${input.enteredCurrency}` : "";
    warnings.push(
      `[amount_overridden_by_entered] \`amount\`=${input.originalAmount} was overridden by \`enteredAmount\`=${input.enteredAmount}${ccy}; written value is ${input.resolvedAmount} after FX.`,
    );
  }
  return warnings;
}

/**
 * Soft-fallback for the entered-fields trilogy on read paths. Un-backfilled
 * legacy rows have entered_* NULL — for those we surface the recorded
 * (account-currency) values as if the user typed them, since that's the
 * only data we have. Single chokepoint so we don't sprinkle `?? amount`
 * across 30 read sites.
 */
export function normalizeTxRow<T extends {
  amount: number | null;
  currency: string | null;
  enteredAmount?: number | null;
  enteredCurrency?: string | null;
  enteredFxRate?: number | null;
}>(row: T): T & { enteredAmount: number; enteredCurrency: string; enteredFxRate: number } {
  return {
    ...row,
    enteredAmount: row.enteredAmount ?? row.amount ?? 0,
    enteredCurrency: row.enteredCurrency ?? row.currency ?? "CAD",
    enteredFxRate: row.enteredFxRate ?? 1,
  };
}

export async function deleteTransaction(id: number, userId: string) {
  return db.delete(transactions).where(and(eq(transactions.id, id), eq(transactions.userId, userId)));
}

// Portfolio
//
// Stream D: include *_ct columns alongside plaintext. Callers decrypt via
// decryptNamedRows() — queries.ts stays dialect-pure. ORDER BY dropped because
// sorting by ciphertext produces meaningless order; callers that need sorted
// output should sort by decrypted name in memory.
export async function getPortfolioHoldings(userId: string) {
  // Aggregate share count per holding via the FK so callers (transactions UI,
  // transfer dialog destination picker) can show "X shares" without a second
  // round-trip. Uses a correlated subquery so we keep one SELECT per holding
  // rather than a GROUP BY rewrite of the whole query.
  return db
    .select({
      id: portfolioHoldings.id,
      accountId: portfolioHoldings.accountId,
      accountNameCt: accounts.nameCt,
      nameCt: portfolioHoldings.nameCt,
      symbolCt: portfolioHoldings.symbolCt,
      currency: portfolioHoldings.currency,
      // isCrypto is needed by /settings/investments and the holding-edit
      // form so the "Crypto asset" checkbox round-trips correctly. Adding
      // it here keeps GET /api/portfolio (the only consumer of this query)
      // a complete edit-form payload — saves a second round-trip vs.
      // hydrating from /api/portfolio/overview.
      isCrypto: portfolioHoldings.isCrypto,
      // Phase 1 of the portfolio-ops refactor flagged cash sleeves with this
      // boolean. The new operation forms (/portfolio/new) filter their pickers
      // by isCash so users can't pick a cash sleeve in the "Holding to buy"
      // dropdown or pick a stock in the "FX from" dropdown.
      isCash: portfolioHoldings.isCash,
      note: portfolioHoldings.note,
      // Sum of every tx's quantity column for this holding. Plaintext
      // metadata, no decryption needed. NULL coalesces to 0. Cast to
      // double precision so the pg driver returns a JS number rather than
      // a numeric string (PG SUM defaults to numeric, which the pg driver
      // parses as string and which would skip our share-count formatting
      // client-side — `Number(stringValue)` works but `(value as number).toLocaleString()`
      // on a string raw value renders as the original digits without grouping).
      currentShares: sql<number>`COALESCE((
        SELECT SUM(${transactions.quantity})
        FROM ${transactions}
        WHERE ${transactions.userId} = ${userId}
          AND ${transactions.portfolioHoldingId} = ${portfolioHoldings.id}
      ), 0)::float`,
    })
    .from(portfolioHoldings)
    .leftJoin(accounts, eq(portfolioHoldings.accountId, accounts.id))
    .where(eq(portfolioHoldings.userId, userId))
    .all();
}

// Budgets
export async function getBudgets(userId: string, month?: string) {
  const conditions = [eq(budgets.userId, userId)];
  if (month) conditions.push(eq(budgets.month, month));

  return db
    .select({
      id: budgets.id,
      categoryId: budgets.categoryId,
      // Stream D Phase 4 — plaintext `categories.name` dropped. Caller
      // decrypts `categoryNameCt` with session DEK; sorts in memory.
      categoryNameCt: categories.nameCt,
      categoryGroup: categories.group,
      month: budgets.month,
      amount: budgets.amount,
      currency: budgets.currency,
    })
    .from(budgets)
    .leftJoin(categories, eq(budgets.categoryId, categories.id))
    .where(and(...conditions))
    .orderBy(categories.group)
    .all();
}

export async function upsertBudget(userId: string, data: { categoryId: number; month: string; amount: number; currency?: string }) {
  const existing = await db
    .select()
    .from(budgets)
    .where(and(eq(budgets.categoryId, data.categoryId), eq(budgets.month, data.month), eq(budgets.userId, userId)))
    .get();

  if (existing) {
    const update: { amount: number; currency?: string } = { amount: data.amount };
    if (data.currency) update.currency = data.currency;
    return db.update(budgets).set(update).where(eq(budgets.id, existing.id)).returning().get();
  }
  return db.insert(budgets).values({ ...data, userId, currency: data.currency ?? "CAD" }).returning().get();
}

export async function deleteBudget(id: number, userId: string) {
  return db.delete(budgets).where(and(eq(budgets.id, id), eq(budgets.userId, userId)));
}

// Budget Templates
export async function getBudgetTemplates(userId: string) {
  return db
    .select({
      id: budgetTemplates.id,
      name: budgetTemplates.name,
      categoryId: budgetTemplates.categoryId,
      // Stream D Phase 4 — plaintext `categories.name` dropped.
      categoryNameCt: categories.nameCt,
      categoryGroup: categories.group,
      amount: budgetTemplates.amount,
      createdAt: budgetTemplates.createdAt,
    })
    .from(budgetTemplates)
    .leftJoin(categories, eq(budgetTemplates.categoryId, categories.id))
    .where(eq(budgetTemplates.userId, userId))
    .orderBy(budgetTemplates.name)
    .all();
}

export async function createBudgetTemplate(userId: string, data: { name: string; categoryId: number; amount: number }) {
  return db
    .insert(budgetTemplates)
    .values({ ...data, userId, createdAt: new Date().toISOString() })
    .returning()
    .get();
}

export async function deleteBudgetTemplate(id: number, userId: string) {
  return db.delete(budgetTemplates).where(and(eq(budgetTemplates.id, id), eq(budgetTemplates.userId, userId)));
}

// Budget Rollover: get previous month overspend per category
export async function getBudgetRollover(userId: string, currentMonth: string) {
  const [y, m] = currentMonth.split("-").map(Number);
  const prevDate = new Date(y, m - 2, 1);
  const prevMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, "0")}`;

  const prevBudgets = await getBudgets(userId, prevMonth);
  if (prevBudgets.length === 0) return [];

  const prevStartDate = `${prevMonth}-01`;
  const prevEndDate = `${prevMonth}-${new Date(prevDate.getFullYear(), prevDate.getMonth() + 1, 0).getDate()}`;
  const prevSpending = await getSpendingByCategory(userId, prevStartDate, prevEndDate);

  const spendMap = new Map<number, number>();
  prevSpending.forEach((s) => {
    if (s.categoryId != null) {
      spendMap.set(s.categoryId, Math.abs(s.total));
    }
  });

  return prevBudgets
    .map((b) => {
      const spent = spendMap.get(b.categoryId) ?? 0;
      const overspend = spent - b.amount;
      return {
        categoryId: b.categoryId,
        // Stream D Phase 4 — caller decrypts categoryNameCt for display.
        categoryNameCt: b.categoryNameCt,
        budgetAmount: b.amount,
        spent,
        rolloverAmount: overspend > 0 ? overspend : 0,
      };
    })
    .filter((r) => r.rolloverAmount > 0);
}

// Dashboard aggregations
//
// Stream D Phase 4 (2026-05-03): plaintext `accounts.name`/`alias` dropped.
// GROUP BY drops the name leg; result rows carry only `*_ct` columns and
// callers decrypt via the route handler. ORDER BY drops name as well —
// route sorts in memory after decrypt.
export async function getAccountBalances(userId: string, opts?: { includeArchived?: boolean }) {
  const conditions = [eq(accounts.userId, userId)];
  if (!opts?.includeArchived) conditions.push(eq(accounts.archived, false));
  return db
    .select({
      accountId: accounts.id,
      accountNameCt: accounts.nameCt,
      accountType: accounts.type,
      accountGroup: accounts.group,
      currency: accounts.currency,
      archived: accounts.archived,
      isInvestment: accounts.isInvestment,
      aliasCt: accounts.aliasCt,
      balance: sql<number>`COALESCE(SUM(${transactions.amount}), 0)`,
    })
    .from(accounts)
    .leftJoin(transactions, eq(accounts.id, transactions.accountId))
    .where(and(...conditions))
    .groupBy(
      accounts.id,
      accounts.nameCt,
      accounts.type,
      accounts.group,
      accounts.currency,
      accounts.archived,
      accounts.isInvestment,
      accounts.aliasCt,
    )
    .orderBy(accounts.type, accounts.group)
    .all();
}

export async function getMonthlySpending(userId: string, startDate: string, endDate: string) {
  // Stream D Phase 4 — plaintext `categories.name` dropped. GROUP BY drops
  // the name leg; rows carry `categoryNameCt` for caller-side decryption.
  //
  // FINLYNQ-123 — monthly spending is a FLOW figure feeding anomaly/trend
  // detection. Emit per-(month, category, currency, reporting_currency) slices
  // with both the raw `amount` sum and the stored historical `reporting_amount`
  // sum so the caller (/api/insights) can convert each slice to the display
  // currency before aggregating. Without this, an FX swing between months reads
  // as a spending spike. The caller collapses the slices back per (month,
  // category).
  return db
    .select({
      month: monthExpr(transactions.date),
      categoryGroup: categories.group,
      categoryNameCt: categories.nameCt,
      categoryType: categories.type,
      currency: transactions.currency,
      reportingCurrency: transactions.reportingCurrency,
      totalAmount: sql<number>`SUM(${transactions.amount})`,
      totalReporting: sql<number | null>`SUM(${transactions.reportingAmount})`,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(and(eq(transactions.userId, userId), gte(transactions.date, startDate), lte(transactions.date, endDate)))
    .groupBy(monthExpr(transactions.date), categories.nameCt, categories.group, categories.type, transactions.currency, transactions.reportingCurrency)
    .orderBy(monthExpr(transactions.date))
    .all();
}

export async function getSpendingByCategory(userId: string, startDate: string, endDate: string) {
  // Stream D Phase 4 — plaintext `categories.name` dropped.
  return db
    .select({
      categoryId: categories.id,
      categoryNameCt: categories.nameCt,
      categoryGroup: categories.group,
      categoryType: categories.type,
      total: sql<number>`SUM(${transactions.amount})`,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(
      and(
        eq(transactions.userId, userId),
        gte(transactions.date, startDate),
        lte(transactions.date, endDate),
        eq(categories.type, "E")
      )
    )
    .groupBy(categories.id, categories.nameCt, categories.group, categories.type)
    .orderBy(sql`SUM(${transactions.amount})`)
    .all();
}

export async function getSpendingByCategoryAndCurrency(userId: string, startDate: string, endDate: string) {
  // Stream D Phase 4 — plaintext `categories.name` dropped.
  return db
    .select({
      categoryId: categories.id,
      categoryNameCt: categories.nameCt,
      categoryGroup: categories.group,
      categoryType: categories.type,
      currency: transactions.currency,
      total: sql<number>`SUM(${transactions.amount})`,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(
      and(
        eq(transactions.userId, userId),
        gte(transactions.date, startDate),
        lte(transactions.date, endDate),
        eq(categories.type, "E")
      )
    )
    .groupBy(categories.id, categories.nameCt, categories.group, categories.type, transactions.currency)
    .orderBy(sql`SUM(${transactions.amount})`)
    .all();
}

// Currency rework Phase 3 — return per-(month, type, currency, reporting_currency)
// slices so the dashboard route can convert each slice to the display currency
// (stored reporting_amount when it matches, else an on-the-fly fallback) before
// aggregating. Dashboard-only caller. See src/app/api/dashboard/route.ts.
export async function getIncomeVsExpenses(userId: string, startDate: string, endDate: string) {
  return db
    .select({
      month: monthExpr(transactions.date),
      type: categories.type,
      currency: transactions.currency,
      reportingCurrency: transactions.reportingCurrency,
      totalAmount: sql<number>`SUM(${transactions.amount})`,
      totalReporting: sql<number | null>`SUM(${transactions.reportingAmount})`,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(
      and(
        eq(transactions.userId, userId),
        gte(transactions.date, startDate),
        lte(transactions.date, endDate),
        sql`${categories.type} IN ('E', 'I')`
      )
    )
    .groupBy(monthExpr(transactions.date), categories.type, transactions.currency, transactions.reportingCurrency)
    .orderBy(monthExpr(transactions.date))
    .all();
}

/**
 * FINLYNQ-128 — per-month, per-category, per-type income/expense slices so the
 * dashboard route can build the Income-vs-Expenses tooltip breakdown. Same WHERE
 * + currency/reporting slicing as getIncomeVsExpenses, but adds the category
 * grain (categoryId + nameCt for decryption). The route converts each slice to
 * the display currency and ranks per (month, type) via rankBreakdown.
 */
export async function getIncomeExpenseByCategory(userId: string, startDate: string, endDate: string) {
  return db
    .select({
      month: monthExpr(transactions.date),
      type: categories.type,
      categoryId: categories.id,
      categoryNameCt: categories.nameCt,
      currency: transactions.currency,
      reportingCurrency: transactions.reportingCurrency,
      totalAmount: sql<number>`SUM(${transactions.amount})`,
      totalReporting: sql<number | null>`SUM(${transactions.reportingAmount})`,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(
      and(
        eq(transactions.userId, userId),
        gte(transactions.date, startDate),
        lte(transactions.date, endDate),
        sql`${categories.type} IN ('E', 'I')`
      )
    )
    .groupBy(
      monthExpr(transactions.date),
      categories.type,
      categories.id,
      categories.nameCt,
      transactions.currency,
      transactions.reportingCurrency,
    )
    .orderBy(monthExpr(transactions.date))
    .all();
}

// Currency rework Phase 3 — dashboard spending-by-category with per-currency +
// reporting slices so the route can convert to the display currency. Distinct
// from getSpendingByCategory (left raw for the budget-rollover internal caller).
export async function getSpendingByCategoryWithReporting(userId: string, startDate: string, endDate: string) {
  return db
    .select({
      categoryId: categories.id,
      categoryNameCt: categories.nameCt,
      categoryGroup: categories.group,
      categoryType: categories.type,
      currency: transactions.currency,
      reportingCurrency: transactions.reportingCurrency,
      totalAmount: sql<number>`SUM(${transactions.amount})`,
      totalReporting: sql<number | null>`SUM(${transactions.reportingAmount})`,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(
      and(
        eq(transactions.userId, userId),
        gte(transactions.date, startDate),
        lte(transactions.date, endDate),
        eq(categories.type, "E")
      )
    )
    .groupBy(categories.id, categories.nameCt, categories.group, categories.type, transactions.currency, transactions.reportingCurrency)
    .all();
}

export async function getNetWorthOverTime(userId: string) {
  return db
    .select({
      month: monthExpr(transactions.date),
      currency: accounts.currency,
      cumulative: sql<number>`SUM(${transactions.amount})`,
    })
    .from(transactions)
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(eq(transactions.userId, userId))
    .groupBy(monthExpr(transactions.date), accounts.currency)
    .orderBy(monthExpr(transactions.date))
    .all();
}

// ─── Net-worth / balance over time (plan/net-worth-over-time.md Part A) ──────
//
// Accurate merged series: cash/liability accounts computed live from
// `transactions`, investment accounts read from stored `portfolio_snapshots`.
// These two helpers feed the pure `buildNetWorthHistory` core; FX + the live
// today-override happen in /api/net-worth-history.

/**
 * Per-day, per-currency cash delta for NON-investment accounts (optionally a
 * single account). Investment accounts are excluded so their buy/sell legs
 * (which net to ~0) never get summed as a "balance" — their value comes from
 * snapshots instead. Returns deltas over ALL history (the cumulative on any
 * grid day needs every delta before the window). Archived accounts are
 * excluded to mirror the dashboard hero's account set.
 */
export async function getCashDailyDeltas(userId: string, accountId?: number) {
  const conditions = [
    eq(transactions.userId, userId),
    eq(accounts.isInvestment, false),
    eq(accounts.archived, false),
  ];
  if (accountId != null) conditions.push(eq(transactions.accountId, accountId));
  return db
    .select({
      date: transactions.date,
      currency: accounts.currency,
      delta: sql<number>`COALESCE(SUM(${transactions.amount}), 0)`,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(...conditions))
    .groupBy(transactions.date, accounts.currency)
    .orderBy(asc(transactions.date))
    .all();
}

/**
 * Per-account portfolio snapshot rows in [from, to], for INVESTMENT accounts
 * only. Pass `from="1900-01-01"` so the first grid day always has a
 * nearest-at-or-before value to carry forward. NEVER returns the
 * whole-portfolio NULL aggregate row (that would double-count against the
 * per-account sum the chart builds).
 *
 * The `accounts.is_investment = true` join is load-bearing: `buildDailySnapshot`
 * writes a per-account snapshot for ANY account with holdings — including a
 * misconfigured `is_investment=false` account that still has holdings (e.g. the
 * demo's Brokerage). Such an account is summed by `getCashDailyDeltas`
 * (`is_investment=false`), so without this filter its snapshots would ALSO land
 * in the investment pass → double-counting. Partitioning both passes on the
 * same `is_investment` flag the dashboard hero uses keeps them disjoint and the
 * latest point equal to the hero.
 */
export async function getInvestmentSnapshotsInRange(
  userId: string,
  from: string,
  to: string,
  accountId?: number,
) {
  const conditions = [
    eq(schema.portfolioSnapshots.userId, userId),
    gte(schema.portfolioSnapshots.snapDate, from),
    lte(schema.portfolioSnapshots.snapDate, to),
    eq(accounts.isInvestment, true),
  ];
  if (accountId != null) {
    conditions.push(eq(schema.portfolioSnapshots.accountId, accountId));
  } else {
    conditions.push(isNotNull(schema.portfolioSnapshots.accountId));
  }
  return db
    .select({
      accountId: schema.portfolioSnapshots.accountId,
      snapDate: schema.portfolioSnapshots.snapDate,
      marketValue: schema.portfolioSnapshots.marketValue,
      currency: schema.portfolioSnapshots.currency,
    })
    .from(schema.portfolioSnapshots)
    .innerJoin(accounts, eq(schema.portfolioSnapshots.accountId, accounts.id))
    .where(and(...conditions))
    .orderBy(asc(schema.portfolioSnapshots.snapDate))
    .all();
}

/**
 * Per-ACCOUNT per-day cash delta (is_investment=false, archived=false). Mirror
 * of {@link getCashDailyDeltas} grouped by account_id so the cash-snapshot
 * builder can keep a separate running cumulative per account (each account has
 * exactly one currency, carried on the row). plan/net-worth-cash-snapshots.md
 * Phase 2.
 */
export async function getCashDailyDeltasByAccount(userId: string, accountId?: number) {
  const conditions = [
    eq(transactions.userId, userId),
    eq(accounts.isInvestment, false),
    eq(accounts.archived, false),
  ];
  if (accountId != null) conditions.push(eq(transactions.accountId, accountId));
  return db
    .select({
      accountId: transactions.accountId,
      currency: accounts.currency,
      date: transactions.date,
      delta: sql<number>`COALESCE(SUM(${transactions.amount}), 0)`,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(...conditions))
    .groupBy(transactions.accountId, accounts.currency, transactions.date)
    .orderBy(asc(transactions.date))
    .all();
}

/**
 * Stored CASH snapshots in [from, to] — the cash-side mirror of
 * {@link getInvestmentSnapshotsInRange}. Filters `is_investment=false`,
 * `archived=false`, and `source='cash'` (defense-in-depth: source + the
 * is_investment partition keep this disjoint from the investment reader, which
 * filters `is_investment=true`). NEVER returns the whole-portfolio NULL
 * aggregate (the cash builder never writes one, and the inner join on a NULL
 * account_id wouldn't match anyway — the explicit isNotNull is belt-and-braces).
 * plan/net-worth-cash-snapshots.md Phase 2.
 */
export async function getCashSnapshotsInRange(
  userId: string,
  from: string,
  to: string,
  accountId?: number,
) {
  const conditions = [
    eq(schema.portfolioSnapshots.userId, userId),
    gte(schema.portfolioSnapshots.snapDate, from),
    lte(schema.portfolioSnapshots.snapDate, to),
    eq(accounts.isInvestment, false),
    eq(accounts.archived, false),
    eq(schema.portfolioSnapshots.source, "cash"),
  ];
  if (accountId != null) {
    conditions.push(eq(schema.portfolioSnapshots.accountId, accountId));
  } else {
    conditions.push(isNotNull(schema.portfolioSnapshots.accountId));
  }
  return db
    .select({
      accountId: schema.portfolioSnapshots.accountId,
      snapDate: schema.portfolioSnapshots.snapDate,
      marketValue: schema.portfolioSnapshots.marketValue,
      currency: schema.portfolioSnapshots.currency,
    })
    .from(schema.portfolioSnapshots)
    .innerJoin(accounts, eq(schema.portfolioSnapshots.accountId, accounts.id))
    .where(and(...conditions))
    .orderBy(asc(schema.portfolioSnapshots.snapDate))
    .all();
}

/**
 * Cheap staleness fingerprint over the user's CASH (is_investment=false,
 * archived=false) transactions: the newest create/update instant plus the row
 * count. `count` is load-bearing — a DELETE leaves max-updated untouched, so
 * only the count drop reveals it. Mirrors the exact filter the cash builder
 * reads through so archiving an account (which removes its txns from the set)
 * flips the count and triggers a rebuild that drops its snapshots.
 * plan/net-worth-cash-snapshots.md Phase 2.
 */
export async function getCashTxFingerprint(
  userId: string,
): Promise<{ maxUpdated: Date | null; count: number }> {
  const rows = await db
    .select({
      maxUpdated: sql<
        Date | string | null
      >`GREATEST(MAX(${transactions.createdAt}), MAX(${transactions.updatedAt}))`,
      count: sql<number>`COUNT(*)`,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(
      and(
        eq(transactions.userId, userId),
        eq(accounts.isInvestment, false),
        eq(accounts.archived, false),
      ),
    )
    .all();
  const r = rows[0];
  const raw = r?.maxUpdated ?? null;
  const maxUpdated =
    raw == null ? null : raw instanceof Date ? raw : new Date(String(raw));
  return { maxUpdated, count: Number(r?.count ?? 0) };
}
