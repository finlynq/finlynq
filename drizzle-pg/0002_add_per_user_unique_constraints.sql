-- Per-user unique constraints for multi-tenant isolation
-- Account names must be unique per user (not globally)
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_user_name_unique" ON "accounts" ("user_id", "name");

-- Category names must be unique per user (not globally)
CREATE UNIQUE INDEX IF NOT EXISTS "categories_user_name_unique" ON "categories" ("user_id", "name");

-- Budget entries: one per user+category+month
CREATE UNIQUE INDEX IF NOT EXISTS "budgets_user_category_month_unique" ON "budgets" ("user_id", "category_id", "month");

-- Subscription names unique per user
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_user_name_unique" ON "subscriptions" ("user_id", "name");

-- Goal names unique per user
CREATE UNIQUE INDEX IF NOT EXISTS "goals_user_name_unique" ON "goals" ("user_id", "name");

-- Loan names unique per user
CREATE UNIQUE INDEX IF NOT EXISTS "loans_user_name_unique" ON "loans" ("user_id", "name");

-- Target allocation names unique per user
CREATE UNIQUE INDEX IF NOT EXISTS "target_allocations_user_name_unique" ON "target_allocations" ("user_id", "name");

-- Contribution room: one per user+type+year
CREATE UNIQUE INDEX IF NOT EXISTS "contribution_room_user_type_year_unique" ON "contribution_room" ("user_id", "type", "year");
