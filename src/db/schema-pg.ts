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
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const accounts = pgTable("accounts", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  type: text("type").notNull(),
  group: text("group").notNull().default(""),
  name: text("name").notNull(),
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
  alias: text("alias"),
  // Stream D (2026-04-24) — dual-write: plaintext columns stay until Phase 3 cutover.
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
  name: text("name").notNull(),
  note: text("note").default(""),
  // Stream D (2026-04-24) — dual-write.
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
  // historical balances are stable when rates move. Reporting currency is
  // computed at view time and not stored. Soft-fallback reads via
  // normalizeTxRow() in src/lib/queries.ts handle un-backfilled rows.
  enteredCurrency: text("entered_currency"),
  enteredAmount: doublePrecision("entered_amount"),
  enteredFxRate: doublePrecision("entered_fx_rate"),
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

export const portfolioHoldings = pgTable("portfolio_holdings", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  accountId: integer("account_id").references(() => accounts.id),
  name: text("name").notNull(),
  symbol: text("symbol"),
  currency: text("currency").notNull().default("CAD"),
  isCrypto: integer("is_crypto").default(0),
  note: text("note").default(""),
  // Stream D (2026-04-24) — dual-write. Symbol encrypted too (VGRO.TO leaks broker + region).
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
  name: text("name").notNull(),
  type: text("type").notNull(),
  accountId: integer("account_id").references(() => accounts.id),
  currency: text("currency").notNull().default("CAD"),
  principal: doublePrecision("principal").notNull(),
  annualRate: doublePrecision("annual_rate").notNull(),
  termMonths: integer("term_months").notNull(),
  startDate: text("start_date").notNull(),
  paymentAmount: doublePrecision("payment_amount"),
  paymentFrequency: text("payment_frequency").notNull().default("monthly"),
  extraPayment: doublePrecision("extra_payment").default(0),
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
  name: text("name").notNull(),
  type: text("type").notNull(),
  currency: text("currency").notNull().default("CAD"),
  targetAmount: doublePrecision("target_amount").notNull(),
  deadline: text("deadline"),
  accountId: integer("account_id").references(() => accounts.id),
  priority: integer("priority").default(1),
  status: text("status").notNull().default("active"),
  note: text("note").default(""),
  // Stream D (2026-04-24) — dual-write.
  nameCt: text("name_ct"),
  nameLookup: text("name_lookup"),
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
});

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

export const subscriptions = pgTable("subscriptions", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
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

export const transactionRules = pgTable("transaction_rules", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  matchField: text("match_field").notNull(),
  matchType: text("match_type").notNull(),
  matchValue: text("match_value").notNull(),
  assignCategoryId: integer("assign_category_id").references(
    () => categories.id
  ),
  assignTags: text("assign_tags"),
  renameTo: text("rename_to"),
  isActive: integer("is_active").notNull().default(1),
  priority: integer("priority").notNull().default(0),
  createdAt: text("created_at").notNull(),
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
    // Envelope encryption: per-user DEK wrapped with a password-derived KEK.
    // All fields are base64-encoded. See src/lib/crypto/envelope.ts.
    // Nullable during migration — accounts created before encryption rollout
    // have NULL here and are promoted to encrypted on next login.
    kekSalt: text("kek_salt"),               // 16 bytes, scrypt salt for KEK derivation
    dekWrapped: text("dek_wrapped"),         // 32 bytes, AES-GCM(KEK, DEK)
    dekWrappedIv: text("dek_wrapped_iv"),    // 12 bytes, AES-GCM IV
    dekWrappedTag: text("dek_wrapped_tag"),  // 16 bytes, AES-GCM auth tag
    encryptionV: integer("encryption_v").notNull().default(1),
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
});

export const stagedTransactions = pgTable("staged_transactions", {
  id: text("id").primaryKey(), // UUID
  stagedImportId: text("staged_import_id").notNull().references(() => stagedImports.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id),
  // Plaintext — bounded lifetime (14 days), deleted on approve/reject/expire.
  // Re-inserted into `transactions` with the user's DEK at approve time.
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
});

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
