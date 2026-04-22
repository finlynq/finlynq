-- PostgreSQL initial schema for managed hosted product.
-- All tables include user_id for multi-tenant isolation.

CREATE TABLE IF NOT EXISTS "accounts" (
  "id" serial PRIMARY KEY,
  "user_id" text NOT NULL,
  "type" text NOT NULL,
  "group" text NOT NULL DEFAULT '',
  "name" text NOT NULL,
  "currency" text NOT NULL DEFAULT 'CAD',
  "note" text DEFAULT ''
);

CREATE TABLE IF NOT EXISTS "categories" (
  "id" serial PRIMARY KEY,
  "user_id" text NOT NULL,
  "type" text NOT NULL,
  "group" text NOT NULL DEFAULT '',
  "name" text NOT NULL,
  "note" text DEFAULT ''
);

CREATE TABLE IF NOT EXISTS "transactions" (
  "id" serial PRIMARY KEY,
  "user_id" text NOT NULL,
  "date" text NOT NULL,
  "account_id" integer REFERENCES "accounts"("id"),
  "category_id" integer REFERENCES "categories"("id"),
  "currency" text NOT NULL DEFAULT 'CAD',
  "amount" double precision NOT NULL DEFAULT 0,
  "quantity" double precision,
  "portfolio_holding" text,
  "note" text DEFAULT '',
  "payee" text DEFAULT '',
  "tags" text DEFAULT '',
  "is_business" integer DEFAULT 0,
  "split_person" text,
  "split_ratio" double precision,
  "import_hash" text,
  "fit_id" text
);

CREATE TABLE IF NOT EXISTS "portfolio_holdings" (
  "id" serial PRIMARY KEY,
  "user_id" text NOT NULL,
  "account_id" integer REFERENCES "accounts"("id"),
  "name" text NOT NULL,
  "symbol" text,
  "currency" text NOT NULL DEFAULT 'CAD',
  "is_crypto" integer DEFAULT 0,
  "note" text DEFAULT ''
);

CREATE TABLE IF NOT EXISTS "budgets" (
  "id" serial PRIMARY KEY,
  "user_id" text NOT NULL,
  "category_id" integer NOT NULL REFERENCES "categories"("id"),
  "month" text NOT NULL,
  "amount" double precision NOT NULL DEFAULT 0,
  "currency" text NOT NULL DEFAULT 'CAD'
);

CREATE TABLE IF NOT EXISTS "loans" (
  "id" serial PRIMARY KEY,
  "user_id" text NOT NULL,
  "name" text NOT NULL,
  "type" text NOT NULL,
  "account_id" integer REFERENCES "accounts"("id"),
  "principal" double precision NOT NULL,
  "annual_rate" double precision NOT NULL,
  "term_months" integer NOT NULL,
  "start_date" text NOT NULL,
  "payment_amount" double precision,
  "payment_frequency" text NOT NULL DEFAULT 'monthly',
  "extra_payment" double precision DEFAULT 0,
  "note" text DEFAULT ''
);

CREATE TABLE IF NOT EXISTS "snapshots" (
  "id" serial PRIMARY KEY,
  "user_id" text NOT NULL,
  "account_id" integer REFERENCES "accounts"("id"),
  "date" text NOT NULL,
  "value" double precision NOT NULL,
  "note" text DEFAULT ''
);

CREATE TABLE IF NOT EXISTS "goals" (
  "id" serial PRIMARY KEY,
  "user_id" text NOT NULL,
  "name" text NOT NULL,
  "type" text NOT NULL,
  "target_amount" double precision NOT NULL,
  "deadline" text,
  "account_id" integer REFERENCES "accounts"("id"),
  "priority" integer DEFAULT 1,
  "status" text NOT NULL DEFAULT 'active',
  "note" text DEFAULT ''
);

CREATE TABLE IF NOT EXISTS "target_allocations" (
  "id" serial PRIMARY KEY,
  "user_id" text NOT NULL,
  "name" text NOT NULL,
  "target_pct" double precision NOT NULL,
  "category" text NOT NULL
);

CREATE TABLE IF NOT EXISTS "recurring_transactions" (
  "id" serial PRIMARY KEY,
  "user_id" text NOT NULL,
  "payee" text NOT NULL,
  "amount" double precision NOT NULL,
  "frequency" text NOT NULL,
  "category_id" integer REFERENCES "categories"("id"),
  "account_id" integer REFERENCES "accounts"("id"),
  "next_date" text,
  "active" integer NOT NULL DEFAULT 1,
  "note" text DEFAULT ''
);

CREATE TABLE IF NOT EXISTS "price_cache" (
  "id" serial PRIMARY KEY,
  "symbol" text NOT NULL,
  "date" text NOT NULL,
  "price" double precision NOT NULL,
  "currency" text NOT NULL
);

CREATE TABLE IF NOT EXISTS "fx_rates" (
  "id" serial PRIMARY KEY,
  "date" text NOT NULL,
  "from_currency" text NOT NULL,
  "to_currency" text NOT NULL,
  "rate" double precision NOT NULL
);

CREATE TABLE IF NOT EXISTS "notifications" (
  "id" serial PRIMARY KEY,
  "user_id" text NOT NULL,
  "type" text NOT NULL,
  "title" text NOT NULL,
  "message" text NOT NULL,
  "read" integer NOT NULL DEFAULT 0,
  "created_at" text NOT NULL,
  "metadata" text DEFAULT ''
);

CREATE TABLE IF NOT EXISTS "subscriptions" (
  "id" serial PRIMARY KEY,
  "user_id" text NOT NULL,
  "name" text NOT NULL,
  "amount" double precision NOT NULL,
  "currency" text NOT NULL DEFAULT 'CAD',
  "frequency" text NOT NULL DEFAULT 'monthly',
  "category_id" integer REFERENCES "categories"("id"),
  "account_id" integer REFERENCES "accounts"("id"),
  "next_date" text,
  "status" text NOT NULL DEFAULT 'active',
  "cancel_reminder_date" text,
  "notes" text
);

CREATE TABLE IF NOT EXISTS "settings" (
  "key" text NOT NULL,
  "user_id" text NOT NULL,
  "value" text NOT NULL,
  PRIMARY KEY ("key", "user_id")
);

CREATE TABLE IF NOT EXISTS "transaction_rules" (
  "id" serial PRIMARY KEY,
  "user_id" text NOT NULL,
  "name" text NOT NULL,
  "match_field" text NOT NULL,
  "match_type" text NOT NULL,
  "match_value" text NOT NULL,
  "assign_category_id" integer REFERENCES "categories"("id"),
  "assign_tags" text,
  "rename_to" text,
  "is_active" integer NOT NULL DEFAULT 1,
  "priority" integer NOT NULL DEFAULT 0,
  "created_at" text NOT NULL
);

CREATE TABLE IF NOT EXISTS "budget_templates" (
  "id" serial PRIMARY KEY,
  "user_id" text NOT NULL,
  "name" text NOT NULL,
  "category_id" integer NOT NULL REFERENCES "categories"("id"),
  "amount" double precision NOT NULL,
  "created_at" text NOT NULL
);

CREATE TABLE IF NOT EXISTS "contribution_room" (
  "id" serial PRIMARY KEY,
  "user_id" text NOT NULL,
  "type" text NOT NULL,
  "year" integer NOT NULL,
  "room" double precision NOT NULL,
  "used" double precision DEFAULT 0,
  "note" text DEFAULT ''
);

-- Indexes for multi-tenant query performance
CREATE INDEX IF NOT EXISTS "idx_accounts_user_id" ON "accounts" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_categories_user_id" ON "categories" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_transactions_user_id" ON "transactions" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_transactions_user_date" ON "transactions" ("user_id", "date");
CREATE INDEX IF NOT EXISTS "idx_portfolio_holdings_user_id" ON "portfolio_holdings" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_budgets_user_id" ON "budgets" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_loans_user_id" ON "loans" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_snapshots_user_id" ON "snapshots" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_goals_user_id" ON "goals" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_recurring_transactions_user_id" ON "recurring_transactions" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_subscriptions_user_id" ON "subscriptions" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_notifications_user_id" ON "notifications" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_transaction_rules_user_id" ON "transaction_rules" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_price_cache_symbol_date" ON "price_cache" ("symbol", "date");
CREATE INDEX IF NOT EXISTS "idx_fx_rates_pair_date" ON "fx_rates" ("from_currency", "to_currency", "date");
CREATE INDEX IF NOT EXISTS "idx_budget_templates_user_id" ON "budget_templates" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_contribution_room_user_id" ON "contribution_room" ("user_id");

-- Unique constraints scoped per user
CREATE UNIQUE INDEX IF NOT EXISTS "idx_accounts_user_name" ON "accounts" ("user_id", "name");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_categories_user_name" ON "categories" ("user_id", "name");
