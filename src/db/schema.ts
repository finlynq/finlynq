import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { DEFAULT_USER_ID } from "./adapter";

export const accounts = sqliteTable("accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default(DEFAULT_USER_ID),
  type: text("type").notNull(), // 'A' (asset) or 'L' (liability)
  group: text("group").notNull().default(""),
  name: text("name").notNull().unique(),
  currency: text("currency").notNull().default("CAD"),
  note: text("note").default(""),
});

export const categories = sqliteTable("categories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default(DEFAULT_USER_ID),
  type: text("type").notNull(), // 'E' (expense), 'I' (income), 'R' (reconciliation)
  group: text("group").notNull().default(""),
  name: text("name").notNull().unique(),
  note: text("note").default(""),
});

export const transactions = sqliteTable("transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default(DEFAULT_USER_ID),
  date: text("date").notNull(),
  accountId: integer("account_id").references(() => accounts.id),
  categoryId: integer("category_id").references(() => categories.id),
  currency: text("currency").notNull().default("CAD"),
  amount: real("amount").notNull().default(0),
  quantity: real("quantity"),
  portfolioHolding: text("portfolio_holding"),
  note: text("note").default(""),
  payee: text("payee").default(""),
  tags: text("tags").default(""),
  isBusiness: integer("is_business").default(0),
  splitPerson: text("split_person"),
  splitRatio: real("split_ratio"),
  importHash: text("import_hash"),
  fitId: text("fit_id"),
});

export const portfolioHoldings = sqliteTable("portfolio_holdings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default(DEFAULT_USER_ID),
  accountId: integer("account_id").references(() => accounts.id),
  name: text("name").notNull(),
  symbol: text("symbol"),
  currency: text("currency").notNull().default("CAD"),
  isCrypto: integer("is_crypto").default(0),
  note: text("note").default(""),
});

export const budgets = sqliteTable("budgets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default(DEFAULT_USER_ID),
  categoryId: integer("category_id")
    .references(() => categories.id)
    .notNull(),
  month: text("month").notNull(),
  amount: real("amount").notNull().default(0),
  currency: text("currency").notNull().default("CAD"),
});

// Feature 1: Loans & Amortization
export const loans = sqliteTable("loans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default(DEFAULT_USER_ID),
  name: text("name").notNull(),
  type: text("type").notNull(), // 'mortgage', 'lease', 'loan', 'student_loan', 'credit_card'
  accountId: integer("account_id").references(() => accounts.id),
  principal: real("principal").notNull(),
  annualRate: real("annual_rate").notNull(),
  termMonths: integer("term_months").notNull(),
  startDate: text("start_date").notNull(),
  paymentAmount: real("payment_amount"),
  paymentFrequency: text("payment_frequency").notNull().default("monthly"),
  extraPayment: real("extra_payment").default(0),
  note: text("note").default(""),
});

// Feature 9: Net Worth Snapshots
export const snapshots = sqliteTable("snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default(DEFAULT_USER_ID),
  accountId: integer("account_id").references(() => accounts.id),
  date: text("date").notNull(),
  value: real("value").notNull(),
  note: text("note").default(""),
});

// Feature 11: Financial Goals
export const goals = sqliteTable("goals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default(DEFAULT_USER_ID),
  name: text("name").notNull(),
  type: text("type").notNull(), // 'savings', 'debt_payoff', 'investment', 'emergency_fund'
  targetAmount: real("target_amount").notNull(),
  deadline: text("deadline"),
  accountId: integer("account_id").references(() => accounts.id),
  priority: integer("priority").default(1),
  status: text("status").notNull().default("active"),
  note: text("note").default(""),
});

// Feature 15: Rebalancing Target Allocations
export const targetAllocations = sqliteTable("target_allocations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default(DEFAULT_USER_ID),
  name: text("name").notNull(),
  targetPct: real("target_pct").notNull(),
  category: text("category").notNull(),
});

// Feature 6: Recurring Transactions
export const recurringTransactions = sqliteTable("recurring_transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default(DEFAULT_USER_ID),
  payee: text("payee").notNull(),
  amount: real("amount").notNull(),
  frequency: text("frequency").notNull(),
  categoryId: integer("category_id").references(() => categories.id),
  accountId: integer("account_id").references(() => accounts.id),
  nextDate: text("next_date"),
  active: integer("active").notNull().default(1),
  note: text("note").default(""),
});

// Feature 2: Price Cache
export const priceCache = sqliteTable("price_cache", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default(DEFAULT_USER_ID),
  symbol: text("symbol").notNull(),
  date: text("date").notNull(),
  price: real("price").notNull(),
  currency: text("currency").notNull(),
});

// Feature 5: FX Rates
export const fxRates = sqliteTable("fx_rates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default(DEFAULT_USER_ID),
  date: text("date").notNull(),
  fromCurrency: text("from_currency").notNull(),
  toCurrency: text("to_currency").notNull(),
  rate: real("rate").notNull(),
});

// Feature 19: Notifications
export const notifications = sqliteTable("notifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default(DEFAULT_USER_ID),
  type: text("type").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  read: integer("read").notNull().default(0),
  createdAt: text("created_at").notNull(),
  metadata: text("metadata").default(""),
});

// Feature: Subscription Tracker
export const subscriptions = sqliteTable("subscriptions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default(DEFAULT_USER_ID),
  name: text("name").notNull(),
  amount: real("amount").notNull(),
  currency: text("currency").notNull().default("CAD"),
  frequency: text("frequency").notNull().default("monthly"), // weekly, monthly, quarterly, annual
  categoryId: integer("category_id").references(() => categories.id),
  accountId: integer("account_id").references(() => accounts.id),
  nextDate: text("next_date"),
  status: text("status").notNull().default("active"), // active, paused, cancelled
  cancelReminderDate: text("cancel_reminder_date"),
  notes: text("notes"),
});

// Feature: App Settings (email import config, etc.)
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  userId: text("user_id").notNull().default(DEFAULT_USER_ID),
  value: text("value").notNull(),
});

// Feature: Transaction Rules Engine
export const transactionRules = sqliteTable("transaction_rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default(DEFAULT_USER_ID),
  name: text("name").notNull(),
  matchField: text("match_field").notNull(), // 'payee', 'amount', 'tags'
  matchType: text("match_type").notNull(), // 'contains', 'exact', 'regex', 'greater_than', 'less_than'
  matchValue: text("match_value").notNull(),
  assignCategoryId: integer("assign_category_id").references(() => categories.id),
  assignTags: text("assign_tags"),
  renameTo: text("rename_to"),
  isActive: integer("is_active").notNull().default(1),
  priority: integer("priority").notNull().default(0),
  createdAt: text("created_at").notNull(),
});

// Budget Templates
export const budgetTemplates = sqliteTable("budget_templates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default(DEFAULT_USER_ID),
  name: text("name").notNull(),
  categoryId: integer("category_id")
    .references(() => categories.id)
    .notNull(),
  amount: real("amount").notNull(),
  createdAt: text("created_at").notNull(),
});

// ─── Authentication Tables (Phase 2: NS-32) ────────────────────────────────

/** Users table for account-based auth (managed edition) */
export const users = sqliteTable("users", {
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
export const passwordResetTokens = sqliteTable("password_reset_tokens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  tokenHash: text("token_hash").notNull(), // SHA-256 of the token
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
  createdAt: text("created_at").notNull(),
});

// Feature 8: Tax - Contribution Room
export const contributionRoom = sqliteTable("contribution_room", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().default(DEFAULT_USER_ID),
  type: text("type").notNull(), // 'TFSA', 'RRSP', 'RESP'
  year: integer("year").notNull(),
  room: real("room").notNull(),
  used: real("used").default(0),
  note: text("note").default(""),
});
