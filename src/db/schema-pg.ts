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
  // Stream D Phase 4 (2026-05-03) — plaintext `name` and `symbol` columns
  // physically dropped. Reads via `name_ct`/`symbol_ct` + DEK; exact-match
  // queries via `name_lookup`/`symbol_lookup`.
  currency: text("currency").notNull().default("CAD"),
  isCrypto: integer("is_crypto").default(0),
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
