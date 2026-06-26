/**
 * PostgreSQL schema — mirrors the SQLite schema (schema.ts) for managed hosting.
 *
 * Differences from SQLite:
 *  - Uses pgTable instead of sqliteTable
 *  - Uses native PG types (serial, doublePrecision, boolean, timestamp)
 *  - user_id is required (no default) — the managed platform always provides it
 *  - Unique constraints are scoped per user_id where appropriate
 */

import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  primaryKey,
  timestamp,
  boolean,
  uniqueIndex,
  index,
  uuid,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const accounts = pgTable("accounts", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  type: text("type").notNull(),
  group: text("group").notNull().default(""),
  // Stream D Phase 4 (2026-05-03) — plaintext `name` and `alias` columns
  // physically dropped. All reads route through `name_ct`/`alias_ct` + the
  // session DEK via `decryptName()`. Lookup HMAC for exact-match queries
  // lives in `name_lookup`/`alias_lookup`.
  currency: text("currency").notNull().default("CAD"),
  note: text("note").default(""),
  archived: boolean("archived").notNull().default(false),
  // When true, every transaction in this account must reference a
  // portfolio_holdings row (FK). Cash legs point at a per-account 'Cash'
  // holding; trades/dividends point at their security. Enforcement is
  // application-layer — see src/lib/investment-account.ts. The migration
  // scripts/migrate-accounts-is-investment.sql backfills the flag from any
  // account that already has at least one portfolio_holdings row.
  isInvestment: boolean("is_investment").notNull().default(false),
  // Reconcile v4 Phase 1 (2026-05-27) — per-account pipeline policy.
  // 'auto' = rules fire at upload, rows land directly in ledger.
  // 'approve' = bank-write automatic, ledger commit needs one click.
  // 'manual' = legacy two-pane staging + reconcile flow.
  // CHECK enforced in SQL (accounts_mode_check). Defaults to 'manual'
  // so every existing account keeps the legacy flow.
  mode: text("mode").notNull().default("manual").$type<"auto" | "approve" | "manual">(),
  // Statement-upload field-mapping (2026-06-04).
  // ofx_payee_source — which OFX/QFX field populates the canonical `payee`
  //   column for bank/CC <STMTTRN> rows. 'name' (default = today's behavior:
  //   NAME→payee, MEMO→note) or 'memo' (flip, for banks that bury the
  //   merchant in MEMO). Investment statements ignore this — their per-row
  //   payees are synthesized, not NAME/MEMO-derived.
  // csv_mapping_mode — whether a CSV upload's auto-detected column mapping is
  //   confirmed before staging. 'confirm' (default = the new safe behavior:
  //   show the detected mapping for review) or 'auto' (silent auto-apply,
  //   today's pre-2026-06-04 behavior). Per-account override on top of the
  //   per-user `confirm_csv_mapping` setting default.
  // Both CHECK-enforced in SQL (accounts_ofx_payee_source_check /
  // accounts_csv_mapping_mode_check). See 20260604_import_field_mapping.sql.
  ofxPayeeSource: text("ofx_payee_source").notNull().default("name").$type<"name" | "memo">(),
  csvMappingMode: text("csv_mapping_mode").notNull().default("confirm").$type<"confirm" | "auto">(),
  nameCt: text("name_ct"),
  nameLookup: text("name_lookup"),
  aliasCt: text("alias_ct"),
  aliasLookup: text("alias_lookup"),
});

export const categories = pgTable("categories", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  type: text("type").notNull(),
  group: text("group").notNull().default(""),
  // Stream D Phase 4 (2026-05-03) — plaintext `name` column physically
  // dropped. Reads via `name_ct` + DEK; exact-match queries via `name_lookup`.
  note: text("note").default(""),
  nameCt: text("name_ct"),
  nameLookup: text("name_lookup"),
});

export const transactions = pgTable("transactions", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  date: text("date").notNull(),
  accountId: integer("account_id").references(() => accounts.id),
  categoryId: integer("category_id").references(() => categories.id),
  // currency + amount carry "account currency" semantics post-2026-04-27.
  // amount is the settlement value in the account's native currency; this is
  // what every aggregator sums.
  currency: text("currency").notNull().default("CAD"),
  amount: doublePrecision("amount").notNull().default(0),
  // Phase 2 of the currency rework — entered/account/reporting trilogy.
  // entered_* fields capture what the user actually typed (the trade) and
  // the FX rate used to convert at entry time. Locked at write time so
  // historical balances are stable when rates move. Soft-fallback reads via
  // normalizeTxRow() in src/lib/queries.ts handle un-backfilled rows.
  enteredCurrency: text("entered_currency"),
  enteredAmount: doublePrecision("entered_amount"),
  enteredFxRate: doublePrecision("entered_fx_rate"),
  // Phase 3 of the currency rework (2026-06-06) — the REPORTING leg is now
  // STORED (was "computed at view time and not stored"). reporting_amount is
  // `amount` (account currency) converted to the user's display/reporting
  // currency at THIS row's `date` historical rate, locked at write time.
  // Flow reports (trends / yoy / income-statement income+expense /
  // tax-summary) SUM it directly instead of converting at today's rate.
  // reporting_currency records which currency it's in; when the user switches
  // display currency a background job (recomputeReportingAmounts) re-derives
  // every row at historical rates. Reports fall back to on-the-fly conversion
  // of `amount` for rows where reporting_currency != the current display
  // currency or the value is NULL (un-backfilled / future-dated). See
  // src/lib/fx/reporting-amount.ts.
  reportingCurrency: text("reporting_currency"),
  reportingAmount: doublePrecision("reporting_amount"),
  reportingRate: doublePrecision("reporting_rate"),
  // entered_at is when the row was created — used to detect future-dated
  // entries that the nightly cron should re-rate once their date arrives.
  // NOT a creation timestamp; the FX cron is the only consumer. The new
  // created_at column below is the audit-grade row-creation time.
  enteredAt: timestamp("entered_at", { withTimezone: true }).notNull().defaultNow(),
  // Audit-trio (issue #28, 2026-04-30). Application-layer maintenance —
  // every UPDATE site bumps updated_at = NOW(); INSERT sites set source
  // explicitly to their writer surface. CHECK constraint on `source` lives
  // in scripts/migrate-tx-audit-fields.sql; allowed values mirror the
  // SOURCES tuple in src/lib/tx-source.ts.
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  source: text("source").notNull().default("manual"),
  quantity: doublePrecision("quantity"),
  // FK introduced 2026-04-26. Nullable. The legacy encrypted text column
  // `portfolio_holding` was dropped in Phase 6 (2026-04-29) — the FK is
  // the sole source of truth, JOIN to portfolio_holdings for the display
  // name. ON DELETE SET NULL — see scripts/migrate-tx-portfolio-holding-fk.sql.
  portfolioHoldingId: integer("portfolio_holding_id").references(
    () => portfolioHoldings.id,
    { onDelete: "set null" }
  ),
  note: text("note").default(""),
  payee: text("payee").default(""),
  tags: text("tags").default(""),
  isBusiness: integer("is_business").default(0),
  importHash: text("import_hash"),
  fitId: text("fit_id"),
  linkId: text("link_id"),
  // Issue #96 — multi-currency trade pair linker. Server-generated UUID
  // (NEVER accepted from client) that groups the cash leg + stock leg of a
  // multi-currency trade booked as two separate rows. The four cost-basis
  // aggregators read the cash leg's `entered_amount` as cost basis for
  // the stock leg's holding when this column is set; legacy rows (no
  // `trade_link_id`) fall back to the stock leg's own amount. Distinct
  // from `link_id`, which the four-check transfer-pair rule reserves for
  // `record_transfer` siblings.
  tradeLinkId: text("trade_link_id"),
  // 2026-05-27 — portfolio ops Phase 4. Swaps are internally two unlinked
  // (sell, buy) pairs; this column ties all 4 rows of a swap together so
  // the load endpoint can return the full swap state for edit. NULL on
  // pre-migration swaps (which fall back to delete-and-recreate UX).
  swapLinkId: text("swap_link_id"),
  // 2026-05-25 — portfolio ops Phase 1. Explicit type discriminator for
  // portfolio-related rows (NULL on non-portfolio rows). Valid values
  // listed in the CHECK constraint on the column (see
  // 20260525_portfolio_ops_phase1.sql). The 6 operation helpers in
  // src/lib/portfolio/operations.ts are the canonical writers; existing
  // tx-write sites that handle portfolio rows route through them.
  kind: text("kind"),
  // 2026-05-25 — portfolio ops Phase 1. For portfolio_income /
  // portfolio_expense rows that land on a cash sleeve, this points back
  // to the holding the income/expense pertains to. Example: an AAPL
  // dividend lands on the USD-cash sleeve (portfolio_holding_id =
  // USD_Cash) but related_holding_id = AAPL so reports can group
  // dividends by source holding. ON DELETE SET NULL.
  relatedHoldingId: integer("related_holding_id").references(
    () => portfolioHoldings.id,
    { onDelete: "set null" }
  ),
  // Two-ledger import refactor (2026-05-22) — lineage FK back to the bank-
  // side record of this row. Set on import-sourced INSERTs (executeImport,
  // createTransferPair source leg, approve route's three buckets); NULL on
  // manual entries (REST POST /transactions, MCP HTTP record_transaction /
  // bulk_record_transactions / record_transfer / portfolio_* op tools). ON DELETE
  // SET NULL — the bank ledger and the system-side transaction have
  // independent lifecycles; deleting either does not cascade. After a user
  // account-move, transactions.account_id may diverge from
  // bank_transactions.account_id — that's intentional, the FK is lineage
  // only. Do NOT auto-relink. See docs/architecture/bank-ledger.md.
  bankTransactionId: uuid("bank_transaction_id"),
});

// tx_currency_audit — flagged rows where transactions.currency != accounts.currency
// at the time the Phase 2 migration ran. The audit UI lets the user
// Convert / Keep / Edit each row without us silently mutating balances.
export const txCurrencyAudit = pgTable("tx_currency_audit", {
  id: serial("id").primaryKey(),
  transactionId: integer("transaction_id")
    .notNull()
    .references(() => transactions.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  accountCurrency: text("account_currency").notNull(),
  recordedCurrency: text("recorded_currency").notNull(),
  recordedAmount: doublePrecision("recorded_amount").notNull(),
  flaggedAt: timestamp("flagged_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolution: text("resolution"), // 'converted' | 'kept' | 'edited'
});

// Securities master (Tier 2, 2026-06-16). The centralized "identity" entity:
// one row per (user, ticker/cluster). A `portfolio_holdings` row is the
// per-account POSITION (cost basis is account-specific); `securities` lifts the
// shared identity (ticker, name, currency, asset type) up so the same security
// held in N accounts is ONE securities row referenced by N positions.
//
// Identity ONLY — zero dollar amounts. Positions/lots/transactions never move;
// aggregation just swaps the grouping key from an in-memory symbol string to a
// real `security_id` FK (behind a flag during rollout). → plan/architecture/securities.md
//
// `cluster_key` is the privacy-preserving cluster discriminator computed by
// src/lib/securities/canonical.ts — `eq:<symbol_lookup>` / `crypto:<…>` /
// `metal:<…>` (HMAC, ticker-hiding) for symbol-bearing rows, `cash#<CCY>`
// (plaintext currency, non-sensitive) for cash sleeves, `custom:<name_lookup>`
// for symbol-less user holdings. The (user_id, cluster_key) unique index makes
// find-or-create concurrency-safe (23505 re-select) AND keeps clustering
// provably equivalent to the legacy `canonicalKey` partition.
export const securities = pgTable(
  "securities",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    // Cluster discriminator (see header). NOT NULL — every security has one.
    clusterKey: text("cluster_key").notNull(),
    // Display asset class: stock|etf|crypto|cash|metal|custom. Cosmetic — the
    // cluster_key (not asset_type) is the uniqueness/grouping key.
    assetType: text("asset_type").notNull(),
    // Quote/trading currency, copied from the representative position.
    currency: text("currency").notNull().default("USD"),
    isCash: boolean("is_cash").notNull().default(false),
    isCrypto: integer("is_crypto").default(0),
    // Encrypted identity copied VERBATIM from the representative position's
    // ciphertext — no decrypt/re-encrypt needed (same per-user DEK).
    symbolCt: text("symbol_ct"),
    symbolLookup: text("symbol_lookup"),
    nameCt: text("name_ct"),
    nameLookup: text("name_lookup"),
    image: text("image"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One security per (user, cluster). Backs the find-or-create re-select.
    uniqueIndex("securities_user_cluster_idx").on(t.userId, t.clusterKey),
    index("securities_user_idx").on(t.userId),
  ],
);

export const portfolioHoldings = pgTable("portfolio_holdings", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  accountId: integer("account_id").references(() => accounts.id),
  // Securities master (2026-06-16) — nullable FK lifting this position's
  // identity into the shared `securities` row. Populated at write time
  // (resolveOrCreateSecurity) + by the login-time per-user backfill. NULL on
  // un-backfilled rows; aggregators fall back to the legacy `canonicalKey`
  // string for those. ON DELETE SET NULL so deleting a security never orphans
  // a position. → plan/architecture/securities.md
  securityId: integer("security_id").references(() => securities.id, {
    onDelete: "set null",
  }),
  // Stream D Phase 4 (2026-05-03) — plaintext `name` and `symbol` columns
  // physically dropped. Reads via `name_ct`/`symbol_ct` + DEK; exact-match
  // queries via `name_lookup`/`symbol_lookup`.
  currency: text("currency").notNull().default("CAD"),
  isCrypto: integer("is_crypto").default(0),
  // 2026-05-25 — portfolio ops Phase 1. Explicit flag for cash sleeves.
  // See plan/portfolio-operations-refactor and the
  // 20260525_portfolio_ops_phase1.sql migration. Partial unique index on
  // (user_id, account_id, currency) WHERE is_cash=TRUE enforces "at most
  // one cash sleeve per (account, currency)". UI renders cash sleeves as
  // "Cash <currency>" by combining is_cash=TRUE + currency column.
  isCash: boolean("is_cash").notNull().default(false),
  note: text("note").default(""),
  nameCt: text("name_ct"),
  nameLookup: text("name_lookup"),
  symbolCt: text("symbol_ct"),
  symbolLookup: text("symbol_lookup"),
});

// Holding ↔ account many-to-many (2026-04-30). Issue #26 (Section G).
//
// The same holding (e.g. an ETF or a metal) can exist in multiple accounts.
// This join table is the long-term shape; the legacy one-to-many
// `portfolio_holdings.account_id` link is kept during cutover and the row
// here whose `is_primary = true` mirrors it. The 5 portfolio aggregator
// callsites + 8 investment-account-constraint callsites still read the
// legacy column today; issue #25 (Section F) migrates them onto this table.
//
// No encrypted fields — only ids + numbers — so no Stream D dual-write
// considerations and no DEK is required for CRUD on this table. PK is
// composite (holding_id, account_id).
export const holdingAccounts = pgTable(
  "holding_accounts",
  {
    holdingId: integer("holding_id")
      .notNull()
      .references(() => portfolioHoldings.id, { onDelete: "cascade" }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    // Denormalized for per-user filtering. Mirrors portfolioHoldings.userId
    // and accounts.userId — application-layer enforces all three match on
    // every write.
    userId: text("user_id").notNull(),
    qty: doublePrecision("qty").notNull().default(0),
    costBasis: doublePrecision("cost_basis").notNull().default(0),
    // Exactly one row per holding_id should have is_primary=true while the
    // legacy portfolio_holdings.account_id column still exists; that flagged
    // row is what the legacy column mirrors. After Section F drops the
    // column, the flag becomes purely advisory.
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.holdingId, t.accountId] }),
    // Hot path: list every pairing for a user. Composite index ordered for
    // the (user, holding) prefix probe used by GET /api/holding-accounts.
    uniqueIndex("holding_accounts_user_holding_idx").on(
      t.userId,
      t.holdingId,
      t.accountId,
    ),
  ],
);

export const budgets = pgTable("budgets", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  categoryId: integer("category_id")
    .references(() => categories.id)
    .notNull(),
  month: text("month").notNull(),
  amount: doublePrecision("amount").notNull().default(0),
  currency: text("currency").notNull().default("CAD"),
});

export const loans = pgTable("loans", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  // Stream D Phase 4 (2026-05-03) — plaintext `name` column physically
  // dropped. Reads via `name_ct` + DEK; exact-match queries via `name_lookup`.
  type: text("type").notNull(),
  accountId: integer("account_id").references(() => accounts.id),
  currency: text("currency").notNull().default("CAD"),
  principal: doublePrecision("principal").notNull(),
  annualRate: doublePrecision("annual_rate").notNull(),
  // FINLYNQ-136 (Loans v2): nullable — payment-driven loans solve for the
  // term from paymentAmount; at least one of the two must be set.
  termMonths: integer("term_months"),
  startDate: text("start_date").notNull(),
  paymentAmount: doublePrecision("payment_amount"),
  paymentFrequency: text("payment_frequency").notNull().default("monthly"),
  extraPayment: doublePrecision("extra_payment").default(0),
  // FINLYNQ-136 (Loans v2): lease residual/buyout — schedule amortizes down
  // to this instead of 0; balance at term end equals the residual.
  residualValue: doublePrecision("residual_value"),
  note: text("note").default(""),
  // Stream D (2026-04-24) — dual-write.
  nameCt: text("name_ct"),
  nameLookup: text("name_lookup"),
});

export const snapshots = pgTable("snapshots", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  accountId: integer("account_id").references(() => accounts.id),
  date: text("date").notNull(),
  value: doublePrecision("value").notNull(),
  note: text("note").default(""),
});

export const goals = pgTable("goals", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  // Stream D Phase 4 (2026-05-03) — plaintext `name` column physically
  // dropped. Reads via `name_ct` + DEK; exact-match queries via `name_lookup`.
  type: text("type").notNull(),
  currency: text("currency").notNull().default("CAD"),
  targetAmount: doublePrecision("target_amount").notNull(),
  deadline: text("deadline"),
  // Issue #130 (2026-05-03) — `goals.account_id` is being deprecated in
  // favor of the `goal_accounts` join table. It stays as a single-account
  // fallback for one release cycle while every read path migrates to the
  // join. Writes dual-write the legacy column (first id only) AND the join.
  accountId: integer("account_id").references(() => accounts.id),
  priority: integer("priority").default(1),
  status: text("status").notNull().default("active"),
  note: text("note").default(""),
  // Stream D (2026-04-24) — dual-write.
  nameCt: text("name_ct"),
  nameLookup: text("name_lookup"),
});

// Multi-account goal linking (issue #130, 2026-05-03). JOIN grain is
// `(goal_id, account_id, user_id)` — mirror the holding_accounts pattern
// in CLAUDE.md. ON DELETE CASCADE on both FKs so deleting a goal or an
// account cleans the join automatically.
export const goalAccounts = pgTable("goal_accounts", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  goalId: integer("goal_id").notNull().references(() => goals.id, { onDelete: "cascade" }),
  accountId: integer("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
});

export const targetAllocations = pgTable("target_allocations", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  targetPct: doublePrecision("target_pct").notNull(),
  category: text("category").notNull(),
});

export const recurringTransactions = pgTable("recurring_transactions", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  payee: text("payee").notNull(),
  amount: doublePrecision("amount").notNull(),
  frequency: text("frequency").notNull(),
  categoryId: integer("category_id").references(() => categories.id),
  accountId: integer("account_id").references(() => accounts.id),
  nextDate: text("next_date"),
  active: integer("active").notNull().default(1),
  note: text("note").default(""),
});

// Global cache — market data (Yahoo Finance, CoinGecko) is identical across users,
// so rows are shared. Not included in per-user wipe/export/import flows.
export const priceCache = pgTable("price_cache", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  date: text("date").notNull(),
  price: doublePrecision("price").notNull(),
  currency: text("currency").notNull(),
  // FINLYNQ-92 (2026-05-23): nullable, additive. Persists Yahoo's `meta.previousClose`
  // so day-change badges survive cache hits. Null on historical bars (fetchQuoteAtDate
  // doesn't have a prior-day reference) and on rows written before this migration.
  // Readers fall back to change: 0, changePct: 0 when null.
  previousClose: doublePrecision("previous_close"),
  // FINLYNQ-204 (2026-06-25): when this row was last refreshed from the upstream
  // quote API. A today-dated row (date == todayISO()) older than
  // PRICE_CACHE_TODAY_TTL_MS (30 min, price-service.ts) is treated as STALE and
  // lazily re-fetched on read; historical rows (date != today) are immutable and
  // never re-fetched regardless of age. Additive: existing rows default to now()
  // and read as fresh for 30 min after deploy. The refresh write is an explicit
  // UPDATE ... WHERE symbol AND date (the (symbol,date) index is non-unique +
  // prod has duplicate rows) — never an ON CONFLICT upsert.
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

// Operator diagnostics log — global, plaintext, NOT per-user (like price_cache /
// announcements). Persists slow queries (≥ PF_SLOW_QUERY_MS), DB errors, API 5xx
// errors, and outbound-provider failures so the /admin/diagnostics view survives
// restarts (unlike the in-memory marketFetch / sys-metrics buffers). Capped +
// trimmed to the newest PF_DIAGNOSTICS_CAP rows. No user_id / DEK — free-text is
// run through scrubSensitive before write. Deliberately NOT in the per-user
// wipe/delete path (operator-owned, no FK to users).
export const diagnosticsLog = pgTable(
  "diagnostics_log",
  {
    id: serial("id").primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    kind: text("kind").notNull(), // slow_query | db_error | api_error | outbound_error
    durationMs: integer("duration_ms"), // query / request duration when known
    source: text("source"), // 'db' | 'METHOD /path' | provider host
    // FINLYNQ diagnostics Phase 2 (additive): the operation/route that triggered
    // the row ('rebuild:investment', 'GET /api/...') + the environment (prod/dev).
    op: text("op"),
    env: text("env"),
    detail: text("detail"), // truncated SQL text / URL
    message: text("message"), // scrubbed error message (null for a pure slow query)
    code: text("code"), // SQLSTATE / HTTP status / provider status
    meta: jsonb("meta"),
  },
  (t) => [
    index("diagnostics_log_at_idx").on(t.at),
    index("diagnostics_log_kind_at_idx").on(t.kind, t.at),
  ],
);

// Per-(operation, hour) timing rollup — "where is time going / where to focus".
// Aggregated in-app and flushed every ~30s; powers the /admin/system "Top
// operations (24h)" panel. Global/plaintext, trimmed to ~7 days by the app.
export const opRollup = pgTable(
  "op_rollup",
  {
    op: text("op").notNull(),
    bucket: timestamp("bucket", { withTimezone: true }).notNull(), // hour-aligned
    count: integer("count").notNull().default(0),
    totalMs: integer("total_ms").notNull().default(0),
    slowCount: integer("slow_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.op, t.bucket] }), index("op_rollup_bucket_idx").on(t.bucket)],
);

// Durable CPU/load/mem samples (~1/min) so Server Health shows a real 24h chart
// instead of a since-restart in-memory sparkline. Trimmed to ~7 days by the app.
export const systemMetricsSample = pgTable(
  "system_metrics_sample",
  {
    id: serial("id").primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    cpuPct: doublePrecision("cpu_pct"),
    load1: doublePrecision("load1"),
    procCpuPct: doublePrecision("proc_cpu_pct"),
    memUsedMb: integer("mem_used_mb"),
    memTotalMb: integer("mem_total_mb"),
  },
  (t) => [index("system_metrics_sample_at_idx").on(t.at)],
);

// Canonical USD-anchored FX rate cache. Cross-rates are derived by
// triangulation in src/lib/fx-service.ts: getRate(EUR, CAD) = rate_to_usd[EUR] / rate_to_usd[CAD].
// Rows are global (no user_id) — rates don't differ between users.
// Per-user overrides live in fxOverrides below.
export const fxRates = pgTable("fx_rates", {
  id: serial("id").primaryKey(),
  currency: text("currency").notNull(),                      // ISO 4217 code
  date: text("date").notNull(),                              // YYYY-MM-DD
  rateToUsd: doublePrecision("rate_to_usd").notNull(),       // 1 unit of `currency` in USD
  source: text("source").notNull().default("yahoo"),         // 'yahoo' | 'coingecko' | 'fallback' | 'manual'
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

// Per-user manual rate pins. Used for currencies the app doesn't auto-fetch
// (override fallback) AND for users who want to pin a rate that differs from
// the market — e.g. their bank's actual exchange rate.
//
// Most-specific date range wins on lookup. Open-ended (date_to IS NULL)
// rows are the catch-all; bounded rows trump them in their range.
export const fxOverrides = pgTable("fx_overrides", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  currency: text("currency").notNull(),                      // ISO 4217 code
  dateFrom: text("date_from").notNull(),                     // inclusive, YYYY-MM-DD
  dateTo: text("date_to"),                                   // inclusive, NULL = open-ended
  rateToUsd: doublePrecision("rate_to_usd").notNull(),
  note: text("note").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const notifications = pgTable("notifications", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  read: integer("read").notNull().default(0),
  createdAt: text("created_at").notNull(),
  metadata: text("metadata").default(""),
});

// ─── Announcements (admin broadcast) ────────────────────────────────────────
// Admin-authored news/update items broadcast to ALL users. Plaintext by
// design: this is operator content, not per-user data, so it is NOT
// DEK-encrypted. Per-user read/dismiss state lives in `announcement_reads`.
export const announcements = pgTable(
  "announcements",
  {
    id: serial("id").primaryKey(),
    title: text("title").notNull(),
    body: text("body").notNull(), // markdown / plain
    category: text("category").notNull().default("news"), // 'news' | 'update' | 'maintenance'
    severity: text("severity").notNull().default("info"), // 'info' | 'warning'
    pinned: boolean("pinned").notNull().default(false), // drives the banner
    published: boolean("published").notNull().default(false),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(), // admin user id
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("announcements_published_idx").on(t.published, t.expiresAt)],
);

// Per-user read/dismiss state. One row per (user, announcement) the user has
// seen. Absence of a row = unread.
export const announcementReads = pgTable(
  "announcement_reads",
  {
    userId: text("user_id").notNull(),
    announcementId: integer("announcement_id")
      .notNull()
      .references(() => announcements.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.announcementId] }),
    index("announcement_reads_user_idx").on(t.userId),
  ],
);

// ─── User feedback (bug reports / ideas) ─────────────────────────────────────
// Plaintext by design: feedback must be readable by the maintainer (admin
// review page + email to feedback@finlynq.com), and the submitting user's
// per-user DEK is unreadable by an admin. The submit form warns users not to
// include sensitive financial details.
export const feedback = pgTable(
  "feedback",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    type: text("type").notNull().default("other"), // 'bug' | 'idea' | 'question' | 'other'
    message: text("message").notNull(),
    pageUrl: text("page_url"), // route the user was on when submitting
    appVersion: text("app_version"), // 'web' | mobile version string
    status: text("status").notNull().default("new"), // 'new' | 'triaged' | 'resolved'
    adminNote: text("admin_note"),
    // FINLYNQ-226/228 — optional single attachment on the INITIAL submission
    // (the immutable thread seed). Stored ON DISK under the DURABLE uploads root
    // (getUploadsBaseDir() — <root>/uploads/feedback/<userId>/<uuid>.<ext>,
    // OUTSIDE .next so it survives a deploy), PLAINTEXT like the rest of the row
    // (the maintainer has no per-user DEK) — never the user-DEK envelope. v2
    // allows any file type except dangerous (denylist). The on-disk file is
    // unlinked BEFORE the wipe DB transaction (mcp_uploads precedent — see
    // unlinkUserUploadFiles in auth/queries.ts).
    attachmentPath: text("attachment_path"), // absolute on-disk path
    attachmentFilename: text("attachment_filename"), // original upload filename
    attachmentMime: text("attachment_mime"), // e.g. image/png | application/pdf
    attachmentSize: integer("attachment_size"), // bytes
    // Two-sided read tracking for the reply thread. NULL = never opened.
    // unread-for-user = admin message newer than userLastReadAt;
    // unread-for-admin = user message newer than adminLastReadAt.
    userLastReadAt: timestamp("user_last_read_at", { withTimezone: true }),
    adminLastReadAt: timestamp("admin_last_read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("feedback_status_idx").on(t.status, t.createdAt),
    index("feedback_user_idx").on(t.userId),
  ],
);

// Reply-thread messages. feedback.message is the immutable SEED (NOT stored
// here — see the 20260611 migration). Each row is one follow-up from the user
// or the admin. Plaintext, same rationale as feedback.message.
export const feedbackMessages = pgTable(
  "feedback_messages",
  {
    id: serial("id").primaryKey(),
    feedbackId: integer("feedback_id")
      .notNull()
      .references(() => feedback.id, { onDelete: "cascade" }),
    authorRole: text("author_role").notNull(), // 'user' | 'admin'
    authorId: text("author_id").notNull(),
    body: text("body").notNull(),
    // FINLYNQ-228 — optional single attachment per message (user or admin
    // reply). Same on-disk PLAINTEXT model as feedback.attachment* (the file
    // lives under <root>/uploads/feedback/<ownerUserId>/<uuid>.<ext>). A wipe
    // unlinks only the USER-authored message files (authorRole='user'); admin
    // replies' attachments are maintainer-owned and survive.
    attachmentPath: text("attachment_path"), // absolute on-disk path
    attachmentFilename: text("attachment_filename"), // original upload filename
    attachmentMime: text("attachment_mime"), // e.g. image/png | application/pdf
    attachmentSize: integer("attachment_size"), // bytes
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("feedback_messages_thread_idx").on(t.feedbackId, t.createdAt)],
);

export const subscriptions = pgTable("subscriptions", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  // Stream D Phase 4 (2026-05-03) — plaintext `name` column physically
  // dropped. Reads via `name_ct` + DEK; exact-match queries via `name_lookup`.
  amount: doublePrecision("amount").notNull(),
  currency: text("currency").notNull().default("CAD"),
  frequency: text("frequency").notNull().default("monthly"),
  categoryId: integer("category_id").references(() => categories.id),
  accountId: integer("account_id").references(() => accounts.id),
  nextDate: text("next_date"),
  status: text("status").notNull().default("active"),
  cancelReminderDate: text("cancel_reminder_date"),
  notes: text("notes"),
  // Stream D (2026-04-24) — dual-write.
  nameCt: text("name_ct"),
  nameLookup: text("name_lookup"),
});

export const settings = pgTable(
  "settings",
  {
    key: text("key").notNull(),
    userId: text("user_id").notNull(),
    value: text("value").notNull(),
  },
  (table) => [primaryKey({ columns: [table.key, table.userId] })]
);

// FINLYNQ-84 — transaction rules v2: multi-condition matching + richer actions.
// Replaces the legacy flat columns (match_field/match_type/match_value +
// assign_category_id/assign_tags/rename_to) with JSONB conditions + actions.
// Zod schemas at src/lib/rules/schema.ts; matcher at src/lib/auto-categorize.ts.
//
// Migration: pf-app/scripts/migrate-finlynq-84-rules-v2.sql (LOOSE — destructive,
// requires manual code-FIRST-then-SQL flow per docs/migrations.md). TRUNCATE on
// apply per user decision 2026-05-21 (no backfill; users re-enter rules).
export const transactionRules = pgTable("transaction_rules", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  conditions: jsonb("conditions").notNull(),
  actions: jsonb("actions").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  priority: integer("priority").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const budgetTemplates = pgTable("budget_templates", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  categoryId: integer("category_id")
    .references(() => categories.id)
    .notNull(),
  amount: doublePrecision("amount").notNull(),
  createdAt: text("created_at").notNull(),
});

// ─── Authentication Tables (Phase 2: NS-32) ────────────────────────────────

/** Users table for account-based auth (managed edition) */
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(), // UUID
    // Username: required for new signups, primary login handle. Stored as
    // lowercased text; uniqueness is enforced case-insensitively by the
    // partial unique index on lower(username) below. Nullable in the schema
    // because legacy email-only rows are backfilled by the migration.
    username: text("username"),
    // Email: now optional (recovery channel only). Same case-insensitive
    // partial unique index pattern as username.
    email: text("email"),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name"),
    role: text("role").notNull().default("user"), // 'user' | 'admin'
    emailVerified: integer("email_verified").notNull().default(0),
    emailVerifyToken: text("email_verify_token"),
    mfaEnabled: integer("mfa_enabled").notNull().default(0),
    mfaSecret: text("mfa_secret"), // encrypted TOTP secret
    onboardingComplete: integer("onboarding_complete").notNull().default(0),
    plan: text("plan").notNull().default("free"), // 'free' | 'pro' | 'premium'
    planExpiresAt: text("plan_expires_at"),
    stripeCustomerId: text("stripe_customer_id"),
    loginCount: integer("login_count").notNull().default(0),
    lastLoginAt: text("last_login_at"),
    // FINLYNQ-166 — last authenticated access of ANY kind (web session,
    // OAuth/MCP token validation, pf_ API-key). Distinct from last_login_at
    // (web password logins only) — it also reflects MCP / API-key activity, so
    // the admin "Last active" column can flag dormant accounts. Bumped
    // DB-side-throttled (>15 min stale) + fire-and-forget via
    // src/lib/auth/last-active.ts (bumpLastActive). Nullable = never seen active.
    // Migration: 20260620_user_last_active.sql.
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
    // Securities master (2026-06-16) — per-user one-time backfill stamp.
    // The login-time `backfillSecuritiesForUser` (DEK-available, exact
    // canonicalKey parity) clusters existing positions under `securities` rows
    // and stamps this once done. Mirrors `portfolio_names_canonicalized_at`.
    // Migration: 20260622_securities_phase_a.sql.
    securitiesBackfilledAt: timestamp("securities_backfilled_at", { withTimezone: true }),
    // Envelope encryption: per-user DEK wrapped with a password-derived KEK.
    // All fields are base64-encoded. See src/lib/crypto/envelope.ts.
    // Nullable during migration — accounts created before encryption rollout
    // have NULL here and are promoted to encrypted on next login.
    kekSalt: text("kek_salt"),               // 16 bytes, scrypt salt for KEK derivation
    dekWrapped: text("dek_wrapped"),         // 32 bytes, AES-GCM(KEK, DEK)
    dekWrappedIv: text("dek_wrapped_iv"),    // 12 bytes, AES-GCM IV
    dekWrappedTag: text("dek_wrapped_tag"),  // 16 bytes, AES-GCM auth tag
    encryptionV: integer("encryption_v").notNull().default(1),
    // Open #2 — pepper rotation support. Names which env var holds the pepper
    // used when this row's DEK envelope was last wrapped. Version 1 → PF_PEPPER
    // (legacy default). Version 2 → PF_PEPPER_V2. After
    // scripts/rewrap-peppers.ts re-wraps a user's DEK with the new pepper, it
    // bumps this column. The login flow reads it and passes through to
    // deriveKEK so unrotated rows still unwrap with the old pepper.
    pepperVersion: integer("pepper_version").notNull().default(1),
    // FINLYNQ-183 (2026-06-17): the former `base_currency` column was dropped.
    // The app now has ONE user-facing currency (`settings.display_currency`),
    // which also serves as the realized-gain accounting basis. The physical
    // DROP COLUMN ships via the LOOSE migration path
    // (scripts/migrate-drop-base-currency.sql), applied manually after deploy
    // per docs/migrations.md (code-first, then SQL). This schema is safe to
    // run while the column still exists — Drizzle selects explicit columns and
    // the column's NOT NULL DEFAULT 'USD' covers any inserts in the gap.
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    // Case-insensitive partial unique indexes — keep in sync with
    // scripts/migrate-username.sql. Both allow multiple NULLs.
    emailLowerUnique: uniqueIndex("users_email_lower_unique")
      .on(sql`lower(${table.email})`)
      .where(sql`${table.email} IS NOT NULL`),
    usernameLowerUnique: uniqueIndex("users_username_lower_unique")
      .on(sql`lower(${table.username})`)
      .where(sql`${table.username} IS NOT NULL`),
  })
);

/** Password reset tokens */
export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: serial("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  tokenHash: text("token_hash").notNull(), // SHA-256 of the token
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
  createdAt: text("created_at").notNull(),
});

export const contributionRoom = pgTable("contribution_room", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  type: text("type").notNull(),
  year: integer("year").notNull(),
  room: doublePrecision("room").notNull(),
  used: doublePrecision("used").default(0),
  note: text("note").default(""),
});

// Import Templates — saved CSV column mappings for re-use
export const importTemplates = pgTable("import_templates", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  fileHeaders: text("file_headers").notNull(), // JSON: string[]
  columnMapping: text("column_mapping").notNull(), // JSON: {date, amount, account?, payee?, category?, currency?, note?, tags?}
  defaultAccount: text("default_account"),
  isDefault: integer("is_default").notNull().default(0),
  // FINLYNQ-54 follow-up — parser knobs persisted on the template so the
  // upload UI can pre-fill them on next import. Mirrors staged_imports.
  skipHeaderRows: integer("skip_header_rows").notNull().default(0),
  skipFooterRows: integer("skip_footer_rows").notNull().default(0),
  dateFormatOverride: text("date_format_override"),
  defaultCurrency: text("default_currency"),
  // Per-template upload mode (plan/import-modes-simplified-detailed.md).
  //   'simplified' — rows land directly in bank_transactions, skip staged review.
  //   'detailed'   — rows land in staged_imports + staged_transactions; user
  //                  reviews the parse on /import/pending before approve
  //                  materializes them into bank_transactions.
  // CHECK enforced in SQL (import_templates_mode_check). Defaults to
  // 'detailed' so every existing template keeps the legacy flow.
  importMode: text("import_mode").notNull().default("detailed"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// Transaction Splits — split a single transaction across multiple categories/accounts
export const transactionSplits = pgTable("transaction_splits", {
  id: serial("id").primaryKey(),
  transactionId: integer("transaction_id").notNull().references(() => transactions.id, { onDelete: "cascade" }),
  categoryId: integer("category_id").references(() => categories.id),
  accountId: integer("account_id").references(() => accounts.id),
  amount: doublePrecision("amount").notNull(),
  // Phase 2 of the currency rework — same trilogy as transactions. A split
  // may be in a different entered currency than its parent (e.g. a USD bill
  // split between two CAD accounts), with the parent's account currency as
  // the settlement currency.
  enteredCurrency: text("entered_currency"),
  enteredAmount: doublePrecision("entered_amount"),
  enteredFxRate: doublePrecision("entered_fx_rate"),
  note: text("note").default(""),
  description: text("description").default(""),
  tags: text("tags").default(""),
});

// ─── OAuth 2.1 Tables ──────────────────────────────────────────────────────

/** Registered OAuth clients (Dynamic Client Registration, RFC 7591) */
export const oauthClients = pgTable("oauth_clients", {
  id: serial("id").primaryKey(),
  clientId: text("client_id").notNull().unique(),
  clientName: text("client_name"),
  redirectUris: text("redirect_uris").default("[]"),   // JSON array
  grantTypes: text("grant_types").default('["authorization_code"]'),
  responseTypes: text("response_types").default('["code"]'),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method").default("none"),
  createdAt: text("created_at").notNull(),
});

/** Short-lived authorization codes issued during the OAuth authorize flow */
export const oauthAuthorizationCodes = pgTable("oauth_authorization_codes", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  // Stored as authLookupHash(code) — the raw code is on the wire, never in DB.
  code: text("code").notNull().unique(),
  codeChallenge: text("code_challenge").notNull(),
  codeChallengeMethod: text("code_challenge_method").notNull().default("S256"),
  redirectUri: text("redirect_uri").notNull(),
  clientId: text("client_id").notNull(),
  expiresAt: text("expires_at").notNull(),
  used: integer("used").notNull().default(0),
  createdAt: text("created_at").notNull(),
  // Session DEK wrapped with secretWrapKey(code). Null for pre-encryption auth flows.
  dekWrapped: text("dek_wrapped"),
});

/** Long-lived access + refresh token pairs issued after code exchange */
export const oauthAccessTokens = pgTable("oauth_access_tokens", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  // Stored as authLookupHash(accessToken) — raw token never in DB.
  token: text("token").notNull().unique(),
  // Stored as authLookupHash(refreshToken) — raw token never in DB.
  refreshToken: text("refresh_token").notNull().unique(),
  clientId: text("client_id").notNull(),
  expiresAt: text("expires_at").notNull(),        // 1 hour
  refreshExpiresAt: text("refresh_expires_at").notNull(), // 30 days
  createdAt: text("created_at").notNull(),
  // Session DEK wrapped with secretWrapKey(accessToken). Used by validateOauthToken.
  dekWrapped: text("dek_wrapped"),
  // Session DEK wrapped with secretWrapKey(refreshToken). Used by refreshAccessToken
  // to carry the DEK forward when rotating — we don't have the old access token plaintext
  // after the rotation lookup (only the refresh token on the wire).
  dekWrappedRefresh: text("dek_wrapped_refresh"),
  // Set when the pair has been rotated on refresh, or force-invalidated by a
  // reuse-detection event. Live tokens have revoked_at IS NULL. See
  // scripts/migrate-oauth-revoked-at.sql.
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  // FINLYNQ-167 — advanced on each successful token validation (throttled
  // DB-side, >15 min). Drives the admin OAuth-grants panel's last-used column
  // + active/dormant flag. NULL = never validated since the column was added.
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
});

// ─── MCP Uploads (Wave 1 — Part 1: File upload) ────────────────────────────
//
// Holds user-uploaded CSV/OFX files pending preview + import via MCP.
// Files live on the server at `storagePath` until they're executed or expire.
// A background job deletes rows + on-disk blobs after `expiresAt`.
export const mcpUploads = pgTable("mcp_uploads", {
  id: text("id").primaryKey(), // UUID generated by the upload endpoint
  userId: text("user_id").notNull().references(() => users.id),
  format: text("format").notNull(), // 'csv' | 'ofx' | 'qfx'
  storagePath: text("storage_path").notNull(), // absolute path on server
  originalFilename: text("original_filename").notNull(),
  rowCount: integer("row_count"), // populated after parse
  sizeBytes: integer("size_bytes").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  // 'pending' (just uploaded) | 'previewed' (preview called, token issued)
  // | 'executed' (import committed) | 'cancelled' (user cancelled)
  // | 'expired' (past expiresAt, awaiting GC)
  status: text("status").notNull().default("pending"),
});

// ─── Email Import — Staging Queue (Phase B of Resend plan) ─────────────────
//
// When an email lands at `import-<uuid>@finlynq.com` and the uuid resolves to
// a user, the webhook parses attachments into rows and stores them here for
// user review at /import/pending. On approve, rows materialize into the
// `transactions` table encrypted with the user's logged-in DEK and the
// staged rows are deleted. On reject/expire (14d), rows are deleted outright.
// See Research/email-import-resend-plan.md.
export const stagedImports = pgTable("staged_imports", {
  id: text("id").primaryKey(), // UUID
  userId: text("user_id").notNull().references(() => users.id),
  source: text("source").notNull(), // 'email' | 'upload'
  fromAddress: text("from_address"), // display only
  subject: text("subject"),
  svixId: text("svix_id").unique(), // null for self-hosted multipart path; idempotency key for Resend retries
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  // 'pending' | 'imported' | 'rejected' | 'expired'
  status: text("status").notNull().default("pending"),
  totalRowCount: integer("total_row_count").notNull().default(0),
  duplicateCount: integer("duplicate_count").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  // ─── Unified-ingest columns (issue #152, 2026-05-06) ─────────────────
  // Per-statement metadata so non-email sources (CSV/OFX/XLSX uploads,
  // future Plaid sync, MCP "park for later") can populate the same staging
  // tables. All nullable — email path leaves them NULL today.
  statementBalance: doublePrecision("statement_balance"),
  statementBalanceDate: text("statement_balance_date"), // YYYY-MM-DD
  statementCurrency: text("statement_currency"), // ISO 4217
  statementPeriodStart: text("statement_period_start"), // YYYY-MM-DD
  statementPeriodEnd: text("statement_period_end"), // YYYY-MM-DD
  boundAccountId: integer("bound_account_id").references(() => accounts.id),
  // 'ofx' | 'qfx' | 'csv' | 'xlsx' | 'pdf' | 'plaid' | 'mcp'
  fileFormat: text("file_format"),
  originalFilename: text("original_filename"), // display only, e.g. "chase-2026-04.csv"
  // ─── Parser knobs (FINLYNQ-54, 2026-05-20) ───────────────────────────
  // Upload-step preprocessor configuration, persisted so the F-53E merge
  // flow can read it back and re-run with the same shape. Defaults match
  // pre-FINLYNQ-54 behavior (no skip, parser auto-detects date format,
  // no per-statement currency fallback).
  skipHeaderRows: integer("skip_header_rows").notNull().default(0),
  skipFooterRows: integer("skip_footer_rows").notNull().default(0),
  // 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD' | NULL (auto-detect)
  dateFormatOverride: text("date_format_override"),
  defaultCurrency: text("default_currency"), // ISO 4217 from supportedCurrencyEnum
  // ─── Date-range bounds for F-53E overlap detection (FINLYNQ-58) ──────
  // Min/max of the parsed transaction-row dates. Distinct from the
  // statement_period_* columns (which mirror the file's declared period,
  // when present) — date_range_* is the truthful comparator for the
  // overlapping-upload merge prompt because it reflects the actual rows
  // landed in staged_transactions. Both nullable for pre-FINLYNQ-58
  // staged_imports rows; overlap detection skips NULL rows.
  dateRangeStart: text("date_range_start"), // YYYY-MM-DD
  dateRangeEnd: text("date_range_end"), // YYYY-MM-DD
  // ─── Bank balance anchors parsed at upload time (2026-05-24) ─────────
  // JSONB array of { date, balance, currency, source }. Carries CSV
  // balance-column anchors and OFX <LEDGERBAL> from the upload step
  // through to the approve step (where they're INSERTed into
  // bank_daily_balances + validated against the running total). Null
  // means no anchors were parsed; the upload form's statement_balance
  // is a SEPARATE upload_form source carried via the existing
  // statement_balance / statement_balance_date / statement_currency
  // columns above.
  parsedAnchors: jsonb("parsed_anchors"),
  // ─── Manual template-pick fallback (2026-05-28) ──────────────────────
  // When a CSV email-import attachment doesn't match any saved template
  // we capture the column header row + first ~3 data rows here so the
  // user can pick a template (or just bind to an account) post-hoc from
  // /import/pending. `headers` is the raw header string array;
  // `sampleRows` is an array of { [header]: cellValue } maps. Both
  // remain NULL for upload-path imports (those already had a template
  // picker before parse) and for emails whose CSV matched a template at
  // parse time. Hides the picker UI when null.
  headers: jsonb("headers"),
  sampleRows: jsonb("sample_rows"),
  // ─── FINLYNQ-120: staging-metadata encryption tier ───────────────────
  // from_address / subject / original_filename / sample_rows are encrypted
  // in-place (v1: or sv1: envelope). Two-tier, mirrors staged_transactions:
  //   - 'service' (default at email-webhook ingest): sv1: under PF_STAGING_KEY.
  //   - 'user' (web uploads + post-login sweep): v1: under the user's DEK.
  // Read paths branch per-row on this column (decryptStagingMeta /
  // decryptSampleRows). `headers` stays plaintext (column-names only, low
  // sensitivity).
  encryptionTier: text("encryption_tier").notNull().default("service"),
});

export const stagedTransactions = pgTable("staged_transactions", {
  id: text("id").primaryKey(), // UUID
  stagedImportId: text("staged_import_id").notNull().references(() => stagedImports.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id),
  // Encrypted — bounded lifetime (60 days, 2026-05-06), deleted on
  // approve/reject/expire. Re-inserted into `transactions` with the user's
  // DEK at approve time.
  //
  // Two-tier encryption:
  //   - 'service' (default at ingest): wrapped with PF_STAGING_KEY (sv1:),
  //     readable by anyone with the env var + DB.
  //   - 'user': wrapped with the user's DEK (v1:), readable only by that
  //     user. The login-time upgrade job (enqueueUpgradeStagingEncryption)
  //     flips rows from service → user when the DEK becomes available.
  // Read paths branch on `encryption_tier` to pick decryptStaged() vs
  // tryDecryptField(dek, ...).
  date: text("date").notNull(),
  amount: doublePrecision("amount").notNull(),
  currency: text("currency").default("CAD"),
  payee: text("payee"),
  category: text("category"),
  accountName: text("account_name"),
  note: text("note"),
  rowIndex: integer("row_index").notNull(),
  isDuplicate: boolean("is_duplicate").notNull().default(false),
  importHash: text("import_hash").notNull(),
  encryptionTier: text("encryption_tier").notNull().default("service"),
  // ─── Unified-ingest columns (issue #152, 2026-05-06) ─────────────────
  // Full-transaction parity fields so uploads/transfers/investment trades
  // round-trip through staging. Not encrypted — structural / numeric / FK.
  // Existing email-path rows take the defaults: tx_type='E',
  // dedup_status='new', row_status='pending', everything else NULL.
  txType: text("tx_type").notNull().default("E"), // 'E' | 'I' | 'R' (CHECK enforced in SQL)
  quantity: doublePrecision("quantity"), // for investment trades; NULL for cash-only
  // FINLYNQ-195 — investment-import capture (v1, staging only). The TICKER /
  // SYMBOL and the security NAME mapped from a brokerage CSV when the target is
  // an investment account. SENSITIVE free-text → encrypted-in-place under the
  // row's two-tier scheme (v1: user-DEK / sv1: PF_STAGING_KEY), exactly like
  // `payee`/`note`. Read paths branch per-row on `encryption_tier`. NULL for
  // every cash-account row. v1 captures only — these do NOT materialize into
  // `transactions` / lot-aware portfolio ops (deferred follow-up).
  ticker: text("ticker"),
  securityName: text("security_name"),
  // Resolved holding when the row is on an investment account. Set by the
  // user / classifier in staging; required at approve time for investment
  // accounts (see CLAUDE.md "Investment-account constraint").
  portfolioHoldingId: integer("portfolio_holding_id").references(
    () => portfolioHoldings.id,
    { onDelete: "set null" }
  ),
  // Cross-currency rows (issue #129) — amount in the entered currency when
  // it differs from the account currency.
  enteredAmount: doublePrecision("entered_amount"),
  enteredCurrency: text("entered_currency"), // ISO 4217
  tags: text("tags"), // free-text tags like live `transactions.tags`
  // OFX FITID — bank-supplied transaction id. Carried through staging so
  // dedup at approve time can match the same key the import-pipeline uses.
  fitId: text("fit_id"),
  // Transfer pairing (tx_type='R'):
  //   - peer_staged_id: when both legs are in staging (e.g. a brokerage CSV
  //     that includes both sides). Self-FK; DEFERRABLE INITIALLY DEFERRED
  //     so both rows can be inserted in the same transaction.
  //   - target_account_id: when only one leg is in staging — user picks the
  //     destination account; approve mints the second leg via createTransferPair().
  // Mutually exclusive (enforced application-layer at approve time).
  peerStagedId: text("peer_staged_id"),
  targetAccountId: integer("target_account_id").references(() => accounts.id),
  // Persisted classification so the review UI doesn't re-run dedup on every page load.
  dedupStatus: text("dedup_status").notNull().default("new"), // 'new' | 'existing' | 'probable_duplicate'
  // Per-row state. 'approved' rows are deleted immediately after the
  // materialize-into-`transactions` step (today's behavior); the column lets
  // the MCP "approve a subset" path mark intent before the actual delete.
  rowStatus: text("row_status").notNull().default("pending"), // 'pending' | 'approved' | 'rejected'
  // FINLYNQ-55 (2026-05-20) — reconciliation-decision columns for the
  // two-pane reconciliation UI (F-53C). CHECK enforced in SQL:
  //   'unmatched'          — default; no decision yet (the file row hasn't
  //                          been auto-matched and the user hasn't acted).
  //   'auto_suggested'     — system found a probable DB-side match; user
  //                          hasn't confirmed.
  //   'linked'             — user confirmed a link to linked_transaction_id.
  //   'skipped_duplicate'  — F-53E "already imported" marker.
  // 'flagged_missing' is intentionally NOT a value here — DB-side flags
  // belong to transactionReconciliationFlags (different lifecycle: staging
  // rows are ephemeral, flags persist past approval).
  reconcileState: text("reconcile_state").notNull().default("unmatched"),
  // FK into the live `transactions` table when the user manually links a
  // file row to an existing DB row. transactions.id is serial(integer) so
  // this column is integer, not uuid. ON DELETE SET NULL so a transaction
  // wipe doesn't cascade into staging rows that the user may still want
  // to re-link.
  linkedTransactionId: integer("linked_transaction_id").references(
    () => transactions.id,
    { onDelete: "set null" },
  ),
});

// ─── bank_transactions — persistent bank-side ledger (2026-05-22)
//
// Two-ledger import refactor. Records every row from every statement the
// user has ever approved. Re-importing an already-approved row silently
// bumps `seen_count` / `last_seen_at` / `source_filenames` instead of
// overwriting anything — content (import_hash, fit_id, date, amount,
// payee, tx_type) is immutable once written.
//
// The `transactions.bank_transaction_id` FK above links the system-side
// row back to its bank-side lineage. User edits to `transactions` (rename
// payee, recategorize, split, transfer-pair) never propagate to the bank
// ledger; bank-side updates from re-imports never overwrite the user's
// transaction. After a user account-move, `transactions.account_id` and
// `bank_transactions.account_id` may diverge — that's intentional.
//
// Two-tier encryption mirrors staged_transactions:
//   - 'service' (default at ingest): wrapped with PF_STAGING_KEY (sv1:).
//     Used by the email-webhook ingest path where no user DEK is in scope.
//   - 'user': wrapped with the user's DEK (v1:). Approve-time ingest writes
//     directly to user-tier; the login-time upgrade job
//     (upgradeStagingEncryption) flips service-tier rows to user-tier when
//     the DEK becomes available.
// Read paths branch on `encryption_tier` to pick decryptStaged() vs
// tryDecryptField(dek, ...).
//
// Dedup key is `(user_id, account_id, import_hash, occurrence_index)` —
// the `occurrence_index` disambiguates intentional same-day duplicates.
// `(user_id, account_id, fit_id)` is the partial-unique fallback when the
// bank provides a FITID. CHECK constraints on `encryption_tier` and
// `source` enforce the enum membership.
//
// See pf-app/docs/architecture/bank-ledger.md for the full design and the
// load-bearing invariants in CLAUDE.md "Two-ledger import model".
// ─── bank_upload_batches — lineage for upload batches
//
// 2026-05-25. One row per upload batch (simplified-direct OR detailed-via-
// approve). Anchors the Recent Uploads panel on /reconcile and gives batch
// undo a clean handle without array-membership joins on
// bank_transactions.source_filenames.
//
// CASCADE rules:
//   - user_id, account_id → CASCADE: deleting a user/account purges the
//     batch history (matches wipe-account semantics).
//   - template_id → SET NULL: a template can be deleted without nuking
//     batch history that referenced it.
//   - staged_import_id → SET NULL: staged_imports rows are TTL'd; the
//     batch row outlives them.
// Inbound FKs (bank_transactions.upload_batch_id, bank_daily_balances.
// upload_batch_id) are SET NULL — deleting a batch row does NOT cascade-
// delete the rows it created. Phase 4's batch-undo endpoint handles the
// cascade explicitly so it can prompt the user about linked transactions
// before pulling the trigger.
export const bankUploadBatches = pgTable("bank_upload_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accountId: integer("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  templateId: integer("template_id").references(() => importTemplates.id, {
    onDelete: "set null",
  }),
  // 'upload' | 'email' | 'connector' — CHECK enforced in SQL.
  source: text("source").notNull(),
  // 'simplified' | 'detailed' — CHECK enforced in SQL.
  mode: text("mode").notNull(),
  filename: text("filename"),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  rowCount: integer("row_count").notNull().default(0),
  anchorCount: integer("anchor_count").notNull().default(0),
  // Detailed-mode batches reference the staged_imports row they came from.
  // NULL for simplified-mode batches.
  stagedImportId: text("staged_import_id").references(() => stagedImports.id, {
    onDelete: "set null",
  }),
  // ─── FINLYNQ-120: filename encryption tier ───────────────────────────
  // `filename` is encrypted in-place (v1:/sv1: envelope) — this row is
  // PERMANENT so plaintext leaked bank identity indefinitely. Both writers
  // (simplifiedUpload + the detailed approve route) have a DEK, so new rows
  // land at 'user' tier. 'service' exists only for the login-sweep upgrade of
  // pre-FINLYNQ-120 plaintext rows. Read paths branch per-row.
  encryptionTier: text("encryption_tier").notNull().default("service"),
});

export const bankTransactions = pgTable("bank_transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accountId: integer("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  importHash: text("import_hash").notNull(),
  occurrenceIndex: integer("occurrence_index").notNull().default(0),
  fitId: text("fit_id"),
  date: text("date").notNull(), // YYYY-MM-DD, matches transactions.date
  amount: doublePrecision("amount").notNull(),
  currency: text("currency").notNull(),
  enteredAmount: doublePrecision("entered_amount"),
  enteredCurrency: text("entered_currency"),
  enteredFxRate: doublePrecision("entered_fx_rate"),
  quantity: doublePrecision("quantity"),
  // Encrypted-in-place text columns (v1: or sv1: envelope per encryption_tier).
  payee: text("payee").notNull(),
  note: text("note"),
  tags: text("tags"),
  // FINLYNQ-195 — investment-import capture (v1). TICKER/SYMBOL + security NAME
  // mapped from a brokerage CSV when the target is an investment account.
  // Encrypted-in-place under the row's tier like `payee`/`note`/`tags`. NULL for
  // cash-account rows. Captured only in v1 — never materialized into
  // `transactions` / portfolio ops (deferred follow-up).
  ticker: text("ticker"),
  securityName: text("security_name"),
  // Free-text account label from the source file's header. Display-only —
  // the `account_id` FK is the truth.
  accountName: text("account_name"),
  // 'service' | 'user' — CHECK enforced in SQL.
  encryptionTier: text("encryption_tier").notNull().default("service"),
  // 'upload' | 'email' | 'connector' | 'mcp_import' | 'backup_restore' —
  // subset of the SOURCES tuple in src/lib/tx-source.ts. Manual entries
  // never carry bank-statement lineage; they bypass this table entirely.
  source: text("source").notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  seenCount: integer("seen_count").notNull().default(1),
  // Array of filenames this row has appeared in. Append-only. Bumped on
  // every re-import hit via array_append(EXCLUDED.source_filenames[1]).
  sourceFilenames: text("source_filenames")
    .array()
    .notNull()
    .default(sql`ARRAY[]::TEXT[]`),
  // Lineage hint — which staged_imports row first introduced this. NULL
  // for backfilled rows and for direct-import paths (legacy self-hosted
  // email webhook + backup-restore) that bypass staging. ON DELETE SET
  // NULL because staged_imports rows are TTL'd at 60 days.
  originalStagedImportId: text("original_staged_import_id").references(
    () => stagedImports.id,
    { onDelete: "set null" },
  ),
  // Phase 1 of import-modes refactor (2026-05-25). NULL for pre-refactor
  // rows. Populated for every batch written by the new simplified-upload
  // helper AND for every batch promoted via the post-refactor approve
  // route. ON DELETE SET NULL so a batch row going away doesn't cascade-
  // delete the bank ledger row — Phase 4's undo endpoint walks the
  // cascade explicitly.
  uploadBatchId: uuid("upload_batch_id").references(() => bankUploadBatches.id, {
    onDelete: "set null",
  }),
});

// ─── transaction_bank_links — many-to-many between transactions and bank_transactions
//
// 2026-05-23. The 2026-05-22 two-ledger refactor added a 1:1 lineage FK
// `transactions.bank_transaction_id`. This join table lifts that to many-to-many
// in both directions so the standalone /reconcile page can express:
//   - 1 bank row → N transactions  (a single bank charge split into multiple
//     system-side transactions because the user tracks them separately)
//   - N bank rows → 1 transaction  (a recurring fee spread across statements
//     that the user wants to track as one annual line)
//
// The existing `transactions.bank_transaction_id` FK stays as the "primary
// link" hint — every primary join row mirrors it. Aggregators / wipe-account /
// backup-restore that already read the FK keep working unchanged; only the
// new reconcile surface consults this table.
//
// CASCADE on both FKs:
//   - Deleting a transaction removes its join rows (the bank row persists).
//   - Deleting a bank row removes its join rows (transactions persist; their
//     FK independently flips to NULL via the existing ON DELETE SET NULL rule).
// Net: wipe-account's existing "delete transactions THEN bank_transactions"
// ordering keeps working without modification.
//
// `link_type` is one of 'primary' | 'extra' — NOT enforced by SQL CHECK in v1
// (rules-v2 precedent — drift between code enum + SQL CHECK is a CLAUDE.md
// contract breach unless documented; the API layer's Zod schema is the
// enforcement layer). `source` mirrors the SOURCES tuple in src/lib/tx-source.ts.
export const transactionBankLinks = pgTable(
  "transaction_bank_links",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    transactionId: integer("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    bankTransactionId: uuid("bank_transaction_id")
      .notNull()
      .references(() => bankTransactions.id, { onDelete: "cascade" }),
    // 'primary' | 'extra'. Exactly one 'primary' per transaction at a time
    // (application-layer invariant — when a primary link is removed the
    // transactions.bank_transaction_id FK is cleared in the same DB tx).
    linkType: text("link_type").notNull().default("extra"),
    // Writer-surface attribution. Mirrors the SOURCES tuple. Today's writers:
    //   'manual'         — user clicked Accept on a reconcile suggestion
    //   'import'         — backfilled from the FK by Phase 1 / dual-write
    //                      retrofit on the 4 import chokepoints (Phase 5)
    //   'reconcile_link' — created during materialize-from-bank-row flow
    //   'backup_restore' — restored from an export
    source: text("source").notNull().default("manual"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The pair (transaction_id, bank_transaction_id) is globally unique —
    // a given tx can link to a given bank row at most once, regardless of
    // link_type. Re-linking with a different link_type goes through
    // UPDATE rather than INSERT.
    uniqueIndex("transaction_bank_links_pair_uq").on(
      table.transactionId,
      table.bankTransactionId,
    ),
    // Hot paths for the /api/reconcile/suggestions endpoint:
    //   - "give me every join row for these tx ids"
    //   - "give me every join row for these bank ids"
    index("transaction_bank_links_user_tx_idx").on(
      table.userId,
      table.transactionId,
    ),
    index("transaction_bank_links_user_bank_idx").on(
      table.userId,
      table.bankTransactionId,
    ),
  ],
);

// ─── transaction_reconciliation_flags — DB-side reconciliation annotations
//
// FINLYNQ-55 (2026-05-20). Separate table (not a column on `transactions`)
// because the per-transaction-and-user flag lifecycle is distinct from the
// transaction row itself: a flag can be added, removed, or carry a note,
// independently of any column on `transactions`. Keeping it out of the hot
// `transactions` table also avoids touching every aggregator with a fresh
// "is_flagged" predicate.
//
// Today's only `flag_kind` is `missing_from_statement` (the DB has a row
// the statement file doesn't, and the user explicitly chose to keep it
// rather than delete it). Future kinds — `requires_review`,
// `manual_adjustment`, etc. — would slot in via a follow-up migration that
// widens the CHECK list.
//
// CASCADE on `transaction_id` and `user_id` so a transaction delete or a
// wipe-account run (CLAUDE.md "Wipe-account is single-transaction +
// user_id-only filters") cleans up the flag automatically without the wipe
// endpoint needing to know about this table.
export const transactionReconciliationFlags = pgTable(
  "transaction_reconciliation_flags",
  {
    id: uuid("id").primaryKey(),
    transactionId: integer("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    // text("user_id") — users.id is text (UUID stored as text), matches
    // every other userId column in this schema.
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    flagKind: text("flag_kind").notNull(), // 'missing_from_statement' (CHECK in SQL)
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

// ─── Email Import — Admin Inbox + Trash (Phase A) ──────────────────────────
//
// Catch-all for emails that don't match an `import-<uuid>` user address:
//   - category='mailbox': info@/admin@/support@/etc. or a user-display-name
//     match — admin triages via /admin/inbox, kept indefinitely.
//   - category='trash': anything else (random probes, expired import-*,
//     body-only emails) — auto-deleted after 24 hours.
// Body content may contain attacker-controlled HTML — UI must render in a
// sandboxed iframe. Never use dangerouslySetInnerHTML on body_html.
export const incomingEmails = pgTable("incoming_emails", {
  id: text("id").primaryKey(), // UUID
  category: text("category").notNull(), // 'mailbox' | 'trash'
  toAddress: text("to_address").notNull(),
  fromAddress: text("from_address").notNull(),
  subject: text("subject"),
  bodyText: text("body_text"),
  bodyHtml: text("body_html"),
  attachmentCount: integer("attachment_count").notNull().default(0),
  svixId: text("svix_id").unique(), // idempotency for Resend retries
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  // NULL for mailbox (kept indefinitely), now()+24h for trash (auto-swept)
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  triagedAt: timestamp("triaged_at", { withTimezone: true }),
  triagedBy: text("triaged_by").references(() => users.id),
});

// ─── Email-to-Transaction Inbox (Epic B2, 2026-06-05) ──────────────────────
//
// Per-user inbound email turned into transactions. Distinct from
// `incoming_emails` (admin-triage, plaintext, no user_id, 24h TTL): this is
// per-user, two-tier encrypted, 60-day TTL, and tracks an `action` lifecycle.
//
// Two-tier encryption mirrors staged_transactions / bank_transactions:
//   - from_address / subject / body_text / body_html are 'service' (sv1:,
//     PF_STAGING_KEY) at webhook ingest where no DEK exists, upgraded to
//     'user' (v1:, user DEK) by the DEK-bearing sweep. Read paths branch on
//     `encryption_tier` per row. NOT registered in user-encrypted-registry.ts
//     (that drives the plaintext→v1 sweep, which would double-encrypt sv1:).
//
// body_html may contain attacker-controlled markup — the UI MUST render it in
// a sandboxed iframe (no allow-scripts), never dangerouslySetInnerHTML.
//
// Migration: scripts/migrations/20260615_email_inbox.sql.
export const emailInbox = pgTable(
  "email_inbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Two-tier encrypted (sv1:/v1:). from_address + subject are rule-match
    // inputs; body_* render in the detail view (sandboxed iframe).
    fromAddress: text("from_address"),
    subject: text("subject"),
    bodyText: text("body_text"),
    bodyHtml: text("body_html"),
    // 'service' | 'user' — CHECK enforced in SQL.
    encryptionTier: text("encryption_tier").notNull().default("service"),
    // Provider message id (Resend id OR the DevManager push `message_id`, i.e.
    // the underlying Mailpit id) — the idempotency / dedupe key.
    messageId: text("message_id"),
    // Idempotency = provider message id. UNIQUE so re-delivery is a no-op.
    dedupeKey: text("dedupe_key").notNull().unique(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // 'pending' | 'auto_recorded' | 'duplicate_skipped' | 'needs_review' |
    // 'unparseable' | 'discarded' | 'manually_recorded' — CHECK in SQL.
    action: text("action").notNull().default("pending"),
    // 'attachment' | 'body' — CHECK in SQL. v1 auto-routes body only.
    sourceKind: text("source_kind").notNull(),
    // The staged_imports row holding the parsed candidate. SET NULL (TTL'd).
    stagedImportId: text("staged_import_id").references(() => stagedImports.id, {
      onDelete: "set null",
    }),
    // The email rule that matched at auto-record time. FK added in SQL after
    // both tables exist; SET NULL on rule delete.
    matchedRuleId: integer("matched_rule_id"),
    // 'high' | 'low' | NULL — body-parse confidence. low/NULL never auto-record.
    parseConfidence: text("parse_confidence"),
    // Materialized transaction id once recorded. SET NULL on tx delete.
    recordedTransactionId: integer("recorded_transaction_id").references(
      () => transactions.id,
      { onDelete: "set null" },
    ),
  },
  (t) => [
    index("email_inbox_user_action_idx").on(t.userId, t.action, t.receivedAt),
  ],
);

// ─── Email import rules — sender/subject → account auto-record (Epic B2) ────
//
// Per-user "when an email from X arrives, record it into account Y" rules.
// Drives the DEK-bearing sweep (Epic B5). Sensitive free-text (name,
// match_value) is user-DEK encrypted at rest (v1: always — written by the
// CRUD route which always carries a session DEK), decrypted before matching.
// Mirrors transaction_rules' crypto posture; NOT in user-encrypted-registry.ts
// (handled by src/lib/email-rules/crypto.ts).
export const emailImportRules = pgTable(
  "email_import_rules",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Display name — user-DEK encrypted (v1:).
    name: text("name").notNull(),
    // 2026-06-17 — multi-condition AND group: { all: EmailCondition[] }. Source
    // of truth going forward; text-field string values user-DEK encrypted (v1:),
    // numeric amount thresholds plaintext (src/lib/email-rules/crypto.ts). NULL
    // ⇒ read the flat match_type/op/value fallback (pre-migration rows).
    conditions: jsonb("conditions"),
    // Legacy flat match — FROZEN back-compat fallback (NOT NULL dropped in the
    // 20260617 migration; new rows leave these NULL and use `conditions`).
    // 'sender'|'subject' — CHECK in SQL (passes on NULL).
    matchType: text("match_type"),
    // 'contains' | 'exact' | 'regex'.
    matchOp: text("match_op"),
    // The needle — user-DEK encrypted (v1:).
    matchValue: text("match_value"),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    categoryId: integer("category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    // FINLYNQ-189 (2026-06-17) — optional transfer destination. NULL ⇒
    // category/expense mode (today's behavior). When set, a matched email
    // records a TRANSFER from `account_id` (outflow/source) → this account
    // (inflow) via the canonical web transfer write path (resolveTransferCategoryId
    // → the "Transfer" category, FINLYNQ-131; one server-generated link_id),
    // and `category_id` is ignored (mutually exclusive). v1 is SAME-CURRENCY
    // only — the record path refuses a cross-currency source/dest pair. ON
    // DELETE SET NULL (like category_id): deleting the dest account clears the
    // destination (rule degrades to category mode), never cascade-deletes the
    // rule the way the NOT-NULL source account_id does.
    transferDestAccountId: integer("transfer_dest_account_id").references(
      () => accounts.id,
      { onDelete: "set null" },
    ),
    // 'auto' (auto-record) | 'review' (resolve account, wait for a click).
    mode: text("mode").notNull().default("auto"),
    // 2026-06-16 — v1 transforms applied in the single materialize path before
    // the account-bound import_hash + ledger write. flip_sign / date_source are
    // plaintext knobs (used by the record path, no secrecy value). payee_override
    // is free-text → user-DEK encrypted (v1:) like name/match_value
    // (src/lib/email-rules/crypto.ts).
    flipSign: boolean("flip_sign").notNull().default(false),
    dateSource: text("date_source").notNull().default("parsed"), // 'parsed' | 'received'
    payeeOverride: text("payee_override"), // nullable, encrypted
    // 2026-06-18 — recorded-currency override. NULL ⇒ use the target account's
    // currency (the default); an ISO code forces that currency regardless of
    // what the email body parsed (a bare `$` defaults USD). Plaintext.
    currency: text("currency"),
    isActive: boolean("is_active").notNull().default(true),
    priority: integer("priority").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("email_import_rules_user_active_idx").on(
      t.userId,
      t.isActive,
      t.priority,
    ),
  ],
);

// ─── MCP Idempotency Keys (issue [#98](https://github.com/finlynq/finlynq/issues/98)) ─────
//
// Caller-supplied retry safety for `bulk_record_transactions` (HTTP + stdio).
// First call with `idempotencyKey=K` writes the rows AND stashes the response
// JSON here keyed by `(user_id, key)`. Any retry within 72h returns the
// stored `response_json` verbatim with no INSERTs into `transactions`. Keys
// are scoped per user — Alice's UUID K cannot replay against Bob's row, so
// the UNIQUE index spans the pair, not the key alone. A daily cron in
// [src/lib/cron/sweep-mcp-idempotency.ts](../lib/cron/sweep-mcp-idempotency.ts)
// deletes rows older than 72h. `response_json` MUST be redacted of plaintext
// payee / account name before persisting (Stream D rule) — see the writer in
// `register-tools-pg.ts` / `register-core-tools.ts`.
export const mcpIdempotencyKeys = pgTable("mcp_idempotency_keys", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  key: uuid("key").notNull(),
  toolName: text("tool_name").notNull(), // 'bulk_record_transactions' for now
  responseJson: jsonb("response_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdKeyUnique: uniqueIndex("mcp_idempotency_keys_user_id_key_unique")
    .on(t.userId, t.key),
}));

// ─── Admin Audit Log (Finding #16) ──────────────────────────────────────────
//
// Append-only record of every admin mutation. Never UPDATE/DELETE via app code;
// if enforcement is needed, use a Postgres role with only INSERT on this table
// for the app user. Events so far: role_change, plan_change, inbox_triaged,
// inbox_promoted, inbox_deleted.
export const adminAudit = pgTable("admin_audit", {
  id: serial("id").primaryKey(),
  adminUserId: text("admin_user_id").notNull().references(() => users.id),
  targetUserId: text("target_user_id").references(() => users.id),
  action: text("action").notNull(),
  // JSON-serialised "before" + "after" snapshots (for role/plan changes).
  // Free-form so new actions can add their own shape without migrations.
  beforeJson: text("before_json"),
  afterJson: text("after_json"),
  ip: text("ip"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Revoked JWT jtis ───────────────────────────────────────────────────────
//
// Server-side JWT denylist (B7, 2026-05-07). A jti is INSERTed here when a
// user logs out (so a stolen cookie can't keep accessing plaintext-only
// routes — finding H-5) or when an MFA-pending token is exchanged for a
// real session (so the pending token can't be replayed against /mfa/verify
// — finding H-4). The auth path consults this table on every request via a
// 30s in-process cache. A daily cron prunes rows whose `expires_at` < NOW()
// (tokens past their JWT exp would already fail signature verification).
export const revokedJtis = pgTable("revoked_jtis", {
  jti: text("jti").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

// ─── Webhooks — schema for the v1 webhook delivery surface (FINLYNQ-60) ────
//
// Foundation for the FINLYNQ-43 cohort. Spec lives in
// pf-app/docs/architecture/webhook-events.md; the worker (FINLYNQ-61), the
// UI (FINLYNQ-63), and the tx-write wiring (FINLYNQ-62) ship separately.
//
// `secret` is plaintext on purpose — the delivery worker fires async from
// background jobs (cron, retry queue) where the user DEK isn't in scope.
// The secret is a row-scoped HMAC key, not user-derived data; rotation is
// via revoke-and-recreate. Storing under user DEK would break the worker.
// Do NOT add a `name_ct` sibling here.
//
// `event_filter` element type and `webhookDeliveries.event` MUST stay in
// sync with webhook-events.md's v1 vocabulary — drift is a contract
// breach. The SQL migration encodes the closed list as CHECK constraints
// (`webhooks_event_filter_check`, `webhook_deliveries_event_check`); a new
// event in v1 requires a follow-up migration widening BOTH CHECKs and a
// CHANGELOG entry. v2-shape breaks rev `Content-Type`, not the column.
//
// FK cascades: `webhooks.user_id -> users(id) ON DELETE CASCADE` AND
// `webhook_deliveries.webhook_id -> webhooks(id) ON DELETE CASCADE` — both
// load-bearing for the wipe-account flow (CLAUDE.md "Wipe-account is
// single-transaction + user_id-only filters"): deleting a user cleans up
// the webhook rows automatically without the wipe endpoint touching this
// table.
//
// `gen_random_uuid()` is built-in to Postgres 13+ (no pgcrypto extension
// needed). Finlynq runs on Postgres 16.
export const webhooks = pgTable("webhooks", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  // text("user_id") — users.id is text (UUID stored as text); matches the
  // pattern across every other userId column in this schema.
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  // Random >=32-char hex, server-generated on insert, NEVER accepted from
  // client. Plaintext for worker access — see file header comment above.
  secret: text("secret").notNull(),
  // Closed v1 event list, enforced by CHECK at the SQL layer (see
  // webhooks_event_filter_check in the matching migration). Drizzle's
  // text-array column type is `text("...").array()`.
  eventFilter: text("event_filter").array().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // Surfaced as a warning dot on the settings UI after a delivery's retry
  // budget is exhausted (3 attempts at 1m/5m/25m per webhook-events.md).
  lastFailedAt: timestamp("last_failed_at", { withTimezone: true }),
});

// `event` mirrors the same v1 closed list as `webhooks.event_filter`'s
// element type (enforced by `webhook_deliveries_event_check` in SQL).
// `payload_hash` is SHA-256 hex of the raw request body bytes (NOT the
// HMAC signature) — lets the UI display a delivery fingerprint without
// storing the body itself (the "no PII in webhook payloads" rule from
// webhook-events.md applies to anything we'd persist alongside the row).
// `status_code` is NULL until the dispatcher attempts; on exhausted
// retries the worker writes a negative sentinel (-1) per the retry
// policy in webhook-events.md.
export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  webhookId: uuid("webhook_id")
    .notNull()
    .references(() => webhooks.id, { onDelete: "cascade" }),
  event: text("event").notNull(),
  payloadHash: text("payload_hash").notNull(),
  statusCode: integer("status_code"),
  attemptedAt: timestamp("attempted_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ─── bank_daily_balances — per-day bank-reported anchor balances (2026-05-24)
//
// Independent of `bank_transactions`. An anchor is "the bank told us X
// on date D" — it survives row deletion and may exist on days that have
// no row at all (e.g., user-typed statement balance for a statement-end
// date with no transactions on it).
//
// Re-import semantics: ON CONFLICT (user_id, account_id, date) DO UPDATE
// — newer balance wins. A re-downloaded statement with a corrected value
// should overwrite. Load-bearing per CLAUDE.md "Bank balance anchors".
//
// CASCADE on user_id + account_id so wipe-account and account delete
// clean up automatically. PK enforces "at most one anchor per day".
export const bankDailyBalances = pgTable("bank_daily_balances", {
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accountId: integer("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  // YYYY-MM-DD, matches bank_transactions.date format.
  date: text("date").notNull(),
  balance: doublePrecision("balance").notNull(),
  // ISO 4217. Captured at insert from accounts.currency or the
  // statement's CURDEF. Drives /reconcile header's FX hop decision.
  currency: text("currency").notNull(),
  // 'csv_column' | 'ofx_ledgerbal' | 'upload_form' today.
  // 'email' | 'connector' | 'backup_restore' reserved for future
  // surfaces. CHECK enforced in SQL; keep this enum in sync with the
  // SOURCES tuple in src/lib/bank-ledger-balance.ts.
  source: text("source").notNull(),
  // Append-only history of filenames that produced or re-confirmed
  // this anchor. Mirrors bank_transactions.source_filenames pattern.
  sourceFilenames: text("source_filenames")
    .array()
    .notNull()
    .default(sql`ARRAY[]::TEXT[]`),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // Phase 1 of import-modes refactor (2026-05-25). NULL for pre-refactor
  // anchors. Populated for every anchor that arrived with a tracked upload
  // batch. ON DELETE SET NULL so Phase 4's batch-undo endpoint walks the
  // anchor deletion explicitly.
  uploadBatchId: uuid("upload_batch_id").references(() => bankUploadBatches.id, {
    onDelete: "set null",
  }),
}, (table) => [
  primaryKey({ columns: [table.userId, table.accountId, table.date] }),
  // Hot path: "give me the most recent anchor for this account" — drives
  // the /reconcile header's "bank says (as of <date>): $X" display, and
  // the validation helper's "find prior anchor" lookup. The DESC
  // ordering on `date` lives in the SQL migration; PG scans the index
  // either direction so the Drizzle reflection can omit it without
  // changing the runtime plan.
  index("bank_daily_balances_account_date_desc_idx").on(
    table.userId,
    table.accountId,
    table.date,
  ),
]);

// ─── holding_lots — per-lot cost basis tracking (Phase 1, 2026-05-25)
//
// Foundation for plan/portfolio-lots-and-performance.md. Each row is one
// open lot (buy / dividend-reinvest / transfer-in / split-adjust /
// backfilled). FIFO depletion on sell writes holdingLotClosures rows.
//
// No encrypted columns — display name lives on portfolioHoldings. Stdio
// MCP can read this table directly without a DEK (unblocks the
// streamDRefuseRead refusal on get_portfolio_analysis et al.).
//
// Migration: scripts/migrations/20260525_holding_lots_phase1.sql.
export const holdingLots = pgTable(
  "holding_lots",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    holdingId: integer("holding_id")
      .notNull()
      .references(() => portfolioHoldings.id, { onDelete: "cascade" }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    openTxId: integer("open_tx_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    // YYYY-MM-DD; inherits parent_lot's date on transfer-in legs.
    openDate: text("open_date").notNull(),
    qtyOriginal: doublePrecision("qty_original").notNull(),
    qtyRemaining: doublePrecision("qty_remaining").notNull(),
    // In `currency`. Multi-currency trades (issue #96): cost_per_share is
    // computed from the cash leg's entered_amount, not the stock leg's amount.
    costPerShare: doublePrecision("cost_per_share").notNull(),
    currency: text("currency").notNull(),
    fxToUsdAtOpen: doublePrecision("fx_to_usd_at_open"),
    // 'buy' | 'reinvest_div' | 'transfer_in' | 'split_adj' | 'backfill'
    // CHECK enforced in SQL.
    origin: text("origin").notNull(),
    parentLotId: integer("parent_lot_id").references(
      (): any => holdingLots.id,
      { onDelete: "set null" },
    ),
    // 'open' | 'closed' | 'transferred_out' — CHECK enforced in SQL.
    status: text("status").notNull().default("open"),
    // 2026-05-26 Phase 3: 'long' (default) | 'short'. A short lot is
    // opened when a Sell exceeds available long inventory; later Buys
    // close shorts before opening fresh long lots.
    side: text("side").notNull().default("long"),
    // Mirrors transactions.source (tx-source.ts SOURCES tuple).
    source: text("source").notNull().default("manual"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // FIFO selection hot path: "open lots for (user, holding, account)
    // ordered by open_date ASC, id ASC".
    index("holding_lots_user_hold_acct_status_open_idx").on(
      table.userId,
      table.holdingId,
      table.accountId,
      table.status,
      table.openDate,
      table.id,
    ),
    // Reverse-by-tx hot path: reverseLotsForDelete maps a deleted
    // transaction back to its lot.
    index("holding_lots_open_tx_idx").on(table.openTxId),
  ],
);

// ─── holding_lot_closures — one row per (close_tx, lot) pair
//
// A single sell can deplete multiple FIFO lots; a single transfer-out
// closes exactly one lot. Realized gain is computed once at close time
// and stored, so the Phase 2 tax-year query is a simple date filter.
export const holdingLotClosures = pgTable(
  "holding_lot_closures",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    lotId: integer("lot_id")
      .notNull()
      .references(() => holdingLots.id, { onDelete: "cascade" }),
    closeTxId: integer("close_tx_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    closeDate: text("close_date").notNull(),
    qtyClosed: doublePrecision("qty_closed").notNull(),
    // Post-issue-#96 substitution: paired sells use the cash leg's
    // entered_amount as proceeds, not the stock leg's amount.
    proceedsPerShare: doublePrecision("proceeds_per_share").notNull(),
    // Snapshot of holdingLots.costPerShare at close time.
    costPerShare: doublePrecision("cost_per_share").notNull(),
    realizedGain: doublePrecision("realized_gain").notNull(),
    currency: text("currency").notNull(),
    daysHeld: integer("days_held").notNull(),
    // 'sell' | 'transfer_out' — CHECK enforced in SQL.
    closeKind: text("close_kind").notNull(),
    // 2026-05-28 Phase 5 — historical FX snapshot at close time for the
    // realized-gain-in-base-currency aggregator. Nullable; legacy
    // closures fall back to "current rate" with a warning surfaced by
    // the aggregator response.
    fxToUsdAtClose: doublePrecision("fx_to_usd_at_close"),
    source: text("source").notNull().default("manual"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("holding_lot_closures_user_close_date_idx").on(
      table.userId,
      table.closeDate,
      table.lotId,
    ),
    index("holding_lot_closures_close_tx_idx").on(table.closeTxId),
  ],
);

// ─── portfolio_lots_status — per-user feature flag + backfill watermark
//
// The three aggregators (REST overview, holdings-value lib, MCP HTTP)
// branch on `enabled` to pick the lot-derived metrics path
// (src/lib/portfolio/metrics.ts) vs the legacy avg-cost math. The
// scripts/backfill-portfolio-lots.ts admin script sets `backfill_done`
// after writing lot rows for every (holding, account) pair; an admin
// flips `enabled` after canary verification.
export const portfolioLotsStatus = pgTable("portfolio_lots_status", {
  userId: text("user_id").primaryKey(),
  backfillDone: boolean("backfill_done").notNull().default(false),
  enabled: boolean("enabled").notNull().default(false),
  backfilledAt: timestamp("backfilled_at", { withTimezone: true }),
  notes: text("notes").notNull().default(""),
});

// ─── portfolio_snapshots — daily per-user/account value (Phase 3, 2026-06-01)
//
// One row per (user, day, account). account_id NULL = whole-portfolio
// aggregate. Stored in the user's reporting currency AT SNAP TIME —
// retroactive reporting-ccy switches don't re-FX historical bars (TWRR
// is dimensionless, so a value-chart-currency discontinuity is the
// only artifact, surfaced via a tooltip).
//
// `gaps_filled=true` marks days where price_cache or fx_rates fell
// back to last-known. UI shows "incomplete history" on ranges
// containing any gap-filled day.
export const portfolioSnapshots = pgTable("portfolio_snapshots", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  snapDate: text("snap_date").notNull(),
  accountId: integer("account_id").references(() => accounts.id, { onDelete: "cascade" }),
  marketValue: doublePrecision("market_value").notNull(),
  costBasis: doublePrecision("cost_basis").notNull(),
  netContribution: doublePrecision("net_contribution").notNull().default(0),
  currency: text("currency").notNull(),
  gapsFilled: boolean("gaps_filled").notNull().default(false),
  source: text("source").notNull().default("cron"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── portfolio_snapshot_dirty — auto-rebuild work queue (2026-06-02)
//
// One row per user with stale snapshot history. The nightly snapshot cron is
// forward-only (writes only today), so a back-dated investment edit leaves
// history stale. Every investment-affecting tx write stamps this row
// (markSnapshotsDirty) co-located with invalidateUser; the snapshot-drain cron
// re-materializes `[from_date, today]` and clears rows whose marked_at is
// unchanged (writes arriving mid-rebuild bump marked_at and survive to the
// next tick). `from_date` is the earliest affected date, coalesced via LEAST.
// plan/net-worth-over-time.md Part B.
export const portfolioSnapshotDirty = pgTable("portfolio_snapshot_dirty", {
  userId: text("user_id").primaryKey(),
  fromDate: text("from_date").notNull(),
  markedAt: timestamp("marked_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── reporting_recompute_status — currency-switch recompute progress (2026-06-06)
//
// Phase 3 of the currency rework. When a user switches their display/reporting
// currency, recomputeReportingAmounts() re-derives every transaction's
// reporting_amount at historical rates into the new currency. This one-row-per-
// user table drives the progress toast on the Settings page: `total`/`done` are
// bumped as the job batches through rows, `finished_at` is set when complete.
// `GET /api/settings/reporting-currency/recompute/status` reads it. Best-effort
// progress only — reports stay correct via the on-the-fly fallback regardless.
export const reportingRecomputeStatus = pgTable("reporting_recompute_status", {
  userId: text("user_id").primaryKey(),
  targetCurrency: text("target_currency").notNull(),
  total: integer("total").notNull().default(0),
  done: integer("done").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

// ─── portfolio_cash_snapshot_meta — cash-snapshot staleness watermark (2026-06-13)
//
// The "Net Worth Over Time" chart stores per-account daily CASH balances in
// portfolio_snapshots (source='cash', is_investment=false accounts) at each
// day's historical FX rate. Unlike the investment side, the cash side needs no
// DEK, so it's kept fresh by a real background cron + a DEK-free chart-load
// self-heal. `created_at` on portfolio_snapshots isn't bumped on re-UPSERT, so
// this per-user row is the watermark instead: a fingerprint of the user's cash
// transactions (max updated-time + row count, the latter catching DELETEs)
// captured at build time, plus the 'to' date the build covered.
// isCashStale() compares a live fingerprint against this row.
// plan/net-worth-cash-snapshots.md Phase 1.
export const portfolioCashSnapshotMeta = pgTable("portfolio_cash_snapshot_meta", {
  userId: text("user_id").primaryKey(),
  txMaxUpdated: timestamp("tx_max_updated", { withTimezone: true }),
  txCount: integer("tx_count").notNull().default(0),
  builtThrough: text("built_through"),
  builtAt: timestamp("built_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── portfolio_legacy_realized_gain_snapshot — pre-cutover avg-cost gain
//
// Avg-cost realized gain ≠ FIFO realized gain on partial-sell users. This
// table is the one-time snapshot of the legacy value per
// (user, holding, account) at backfill time, surfaced as a tooltip on the
// Phase 1 realized-gain column ("Pre-2026-05 avg-cost: $X"). Written
// exactly once; never updated. DROPpable after a release cycle of
// stability with all users enabled.
export const portfolioLegacyRealizedGainSnapshot = pgTable(
  "portfolio_legacy_realized_gain_snapshot",
  {
    userId: text("user_id").notNull(),
    holdingId: integer("holding_id").notNull(),
    accountId: integer("account_id").notNull(),
    avgCostRealized: doublePrecision("avg_cost_realized").notNull(),
    currency: text("currency").notNull(),
    snappedAt: timestamp("snapped_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.holdingId, table.accountId] }),
  ],
);

// ─── backfill_runs — transaction-canonicalization pipeline (2026-06-02)
//
// One row per "compute proposals" invocation on /settings/backfill. Carries
// the preflight mode choice (refuse_orphans vs synthesize_orphans, see
// pf-app/docs/architecture/backfill.md S8) + the scope filter.
// CASCADE on user_id so wipe-account cleans up automatically.
//
// Migration: scripts/migrations/20260602_backfill_pipeline.sql.
export const backfillRuns = pgTable("backfill_runs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // 'refuse_orphans' | 'synthesize_orphans' — CHECK enforced in SQL.
  mode: text("mode").notNull(),
  // { accountIds?: number[], stagedImportId?: string,
  //   dateFrom?: 'YYYY-MM-DD', dateTo?: 'YYYY-MM-DD' }. Empty = all.
  scopeFilter: jsonb("scope_filter").notNull().default(sql`'{}'::jsonb`),
  // 'planning' | 'ready' | 'applied' | 'partially_applied' | 'cancelled' | 'undone'
  status: text("status").notNull().default("planning"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
});

// ─── backfill_proposals — proposed canonical reshapes for review
//
// One row per proposed canonical reshape. `replacementRowsJson` is the
// payload the apply path UPDATEs the existing rows into; for drift
// proposals (S4) it carries BOTH variant payloads keyed by
// 'separate_fee_row' and 'absorb_into_cost' — the user's `variantChoice`
// picks one.
//
// `synthesizedRowsJson` carries net-new rows for synthesize-mode orphans
// and for drift variant A (separate fee row).
//
// `dependsOnProposalIds` (S7) — a Sell proposal depends on every Buy
// proposal in the same (holding, account) whose lots the Sell FIFO-closes
// from. Enforced in the UI selector AND server-side at apply.
export const backfillProposals = pgTable("backfill_proposals", {
  id: serial("id").primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => backfillRuns.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // 'buy_pair' | 'sell_pair' | 'dividend' | 'fx_pair' |
  // 'brokerage_deposit_pair' | 'brokerage_withdrawal_pair' |
  // 'classify_only' | 'drift' | 'orphan_stock_leg'
  proposalKind: text("proposal_kind").notNull(),
  // 'high' | 'medium' | 'low' | 'refused' — CHECK enforced in SQL.
  confidence: text("confidence").notNull(),
  refusalReason: text("refusal_reason"),
  summary: text("summary").notNull(),
  // transactions.id values being displaced/updated by this proposal.
  existingRowIds: integer("existing_row_ids")
    .array()
    .notNull()
    .default(sql`ARRAY[]::INTEGER[]`),
  replacementRowsJson: jsonb("replacement_rows_json").notNull(),
  synthesizedRowsJson: jsonb("synthesized_rows_json"),
  // { balance, lots: [{ holdingId, qtyDelta }], realizedGainBase }
  deltasJson: jsonb("deltas_json").notNull(),
  dependsOnProposalIds: integer("depends_on_proposal_ids")
    .array()
    .notNull()
    .default(sql`ARRAY[]::INTEGER[]`),
  // NULL until the user picks. Drift proposals refuse to apply with NULL.
  // 'separate_fee_row' | 'absorb_into_cost' — CHECK enforced in SQL.
  variantChoice: text("variant_choice"),
  // NULL until the user picks. dividend_reinvestment proposals refuse to
  // apply with NULL — mirror of variantChoice for the holding-picker
  // flow. Apply route reads this when proposal_kind='dividend_reinvestment'.
  chosenHoldingId: integer("chosen_holding_id"),
  // Pre-suggested holding ids for the picker UI. Set by the planner
  // (Pass 1.6) to every non-cash holding in the row's account. UI
  // pre-selects the top one and offers the rest as alternatives.
  candidateHoldingIds: integer("candidate_holding_ids")
    .array()
    .notNull()
    .default(sql`ARRAY[]::INTEGER[]`),
  // Phase 3 — `missing_lot` proposals carry which lot op to run.
  // CHECK enforced in SQL: NULL OR 'open' | 'close' | 'transfer'.
  lotAction: text("lot_action"),
  // Phase 4b — `dividend_reinvestment` proposals require the user to
  // pick between treating the row as a cash dividend (zero out qty,
  // no lot opens) or a share reinvestment (qty interpreted as shares,
  // lot opens). CHECK in SQL: NULL OR 'cash_dividend' | 'drip'.
  dividendVariant: text("dividend_variant"),
  // Kind override (migration 20260609) — set ONLY for refused
  // `orphan_stock_leg` proposals that the user wants to apply with a
  // hand-picked kind. NULL for every other proposal. Apply route
  // dispatches to applyOrphanOverride() before the refused short-circuit
  // when chosenKind != null. CHECK in SQL constrains to the 15 override-
  // eligible kinds (pair-less + paired). See migration file for the full
  // list and rationale.
  chosenKind: text("chosen_kind"),
  // Paired-kind partner row when the user picks an existing unmatched
  // candidate via the CounterpartPicker. NULL when chosenKind is
  // pair-less OR when counterpartMode='synth_new'.
  chosenCounterpartTxId: integer("chosen_counterpart_tx_id"),
  // 'link_existing' | 'synth_new'. Captures the partner-vs-synth toggle.
  // NULL for pair-less chosenKind.
  chosenCounterpartMode: text("chosen_counterpart_mode"),
  // The underlying stock when chosenKind is `portfolio_income` /
  // `portfolio_expense` — apply swaps the row onto the matching cash
  // sleeve and stamps `related_holding_id` to this id. Mirror of the
  // `cash_dividend` branch of `dividend_reinvestment`. NULL otherwise.
  chosenRelatedHoldingId: integer("chosen_related_holding_id"),
  // The category the user picked for a pair-less income override
  // (chosenKind ∈ dividend/interest/portfolio_income/portfolio_expense).
  // Apply stamps it on the row so it lands in the right report. NULL =
  // apply resolves-or-creates the canonical category for dividend/interest.
  // Migration 20260614. NULL for every non-income-override proposal.
  chosenCategoryId: integer("chosen_category_id"),
  // 'pending' | 'approved' | 'rejected' | 'applied' | 'undone' | 'refused_with_reason'
  status: text("status").notNull().default("pending"),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ─── backfill_audit — snapshot of pre-apply row state for undo
//
// Snapshot of the row state BEFORE the apply UPDATE/INSERT. The undo
// endpoint reads this to restore the pre-apply state. Kept indefinitely
// (no TTL) so the audit trail survives — the 7-day UX limit on the Undo
// button is enforced application-side.
//
// `txId` is INTEGER (not REFERENCES) intentionally: the row may have been
// deleted by an unrelated flow, and the snapshot is what we restore from.
export const backfillAudit = pgTable("backfill_audit", {
  id: serial("id").primaryKey(),
  proposalId: integer("proposal_id")
    .notNull()
    .references(() => backfillProposals.id, { onDelete: "cascade" }),
  txId: integer("tx_id").notNull(),
  beforeJson: jsonb("before_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
