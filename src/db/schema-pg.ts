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
} from "drizzle-orm/pg-core";

export const accounts = pgTable("accounts", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  type: text("type").notNull(),
  group: text("group").notNull().default(""),
  name: text("name").notNull(),
  currency: text("currency").notNull().default("CAD"),
  note: text("note").default(""),
});

export const categories = pgTable("categories", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  type: text("type").notNull(),
  group: text("group").notNull().default(""),
  name: text("name").notNull(),
  note: text("note").default(""),
});

export const transactions = pgTable("transactions", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  date: text("date").notNull(),
  accountId: integer("account_id").references(() => accounts.id),
  categoryId: integer("category_id").references(() => categories.id),
  currency: text("currency").notNull().default("CAD"),
  amount: doublePrecision("amount").notNull().default(0),
  quantity: doublePrecision("quantity"),
  portfolioHolding: text("portfolio_holding"),
  note: text("note").default(""),
  payee: text("payee").default(""),
  tags: text("tags").default(""),
  isBusiness: integer("is_business").default(0),
  importHash: text("import_hash"),
  fitId: text("fit_id"),
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
});

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
  principal: doublePrecision("principal").notNull(),
  annualRate: doublePrecision("annual_rate").notNull(),
  termMonths: integer("term_months").notNull(),
  startDate: text("start_date").notNull(),
  paymentAmount: doublePrecision("payment_amount"),
  paymentFrequency: text("payment_frequency").notNull().default("monthly"),
  extraPayment: doublePrecision("extra_payment").default(0),
  note: text("note").default(""),
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
  targetAmount: doublePrecision("target_amount").notNull(),
  deadline: text("deadline"),
  accountId: integer("account_id").references(() => accounts.id),
  priority: integer("priority").default(1),
  status: text("status").notNull().default("active"),
  note: text("note").default(""),
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

export const priceCache = pgTable("price_cache", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  symbol: text("symbol").notNull(),
  date: text("date").notNull(),
  price: doublePrecision("price").notNull(),
  currency: text("currency").notNull(),
});

export const fxRates = pgTable("fx_rates", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  date: text("date").notNull(),
  fromCurrency: text("from_currency").notNull(),
  toCurrency: text("to_currency").notNull(),
  rate: doublePrecision("rate").notNull(),
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
export const users = pgTable("users", {
  id: text("id").primaryKey(), // UUID
  email: text("email").notNull().unique(),
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
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

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
  transactionId: integer("transaction_id").notNull().references(() => transactions.id),
  categoryId: integer("category_id").references(() => categories.id),
  accountId: integer("account_id").references(() => accounts.id),
  amount: doublePrecision("amount").notNull(),
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
  code: text("code").notNull().unique(),
  codeChallenge: text("code_challenge").notNull(),
  codeChallengeMethod: text("code_challenge_method").notNull().default("S256"),
  redirectUri: text("redirect_uri").notNull(),
  clientId: text("client_id").notNull(),
  expiresAt: text("expires_at").notNull(),
  used: integer("used").notNull().default(0),
  createdAt: text("created_at").notNull(),
});

/** Long-lived access + refresh token pairs issued after code exchange */
export const oauthAccessTokens = pgTable("oauth_access_tokens", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  token: text("token").notNull().unique(),
  refreshToken: text("refresh_token").notNull().unique(),
  clientId: text("client_id").notNull(),
  expiresAt: text("expires_at").notNull(),        // 1 hour
  refreshExpiresAt: text("refresh_expires_at").notNull(), // 30 days
  createdAt: text("created_at").notNull(),
});
