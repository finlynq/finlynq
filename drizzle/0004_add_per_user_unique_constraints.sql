-- Per-user unique constraints (future-proofing for multi-user)
-- In SQLite single-user mode these are effectively global constraints
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_user_name_unique" ON "accounts" ("user_id", "name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "categories_user_name_unique" ON "categories" ("user_id", "name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "budgets_user_category_month_unique" ON "budgets" ("user_id", "category_id", "month");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_user_name_unique" ON "subscriptions" ("user_id", "name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goals_user_name_unique" ON "goals" ("user_id", "name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "loans_user_name_unique" ON "loans" ("user_id", "name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "target_allocations_user_name_unique" ON "target_allocations" ("user_id", "name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contribution_room_user_type_year_unique" ON "contribution_room" ("user_id", "type", "year");
