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

// Global cache — market data (Yahoo Finance, CoinGecko) is identical across users,
// so rows are shared. Not included in per-user wipe/export/import flows.
export const priceCache = pgTable("price_cache", {
  id: serial("id").primaryKey(),
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
  // Session DEK wrapped with SHA-256(code). Null for pre-encryption auth flows.
  dekWrapped: text("dek_wrapped"),
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
  // Session DEK wrapped with SHA-256(token). Null for pre-encryption tokens.
  dekWrapped: text("dek_wrapped"),
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
