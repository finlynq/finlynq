-- Add columns that were added to the schema but missing from migrations.

-- transactions: import deduplication and OFX/QFX import support
ALTER TABLE `transactions` ADD `import_hash` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `fit_id` text;--> statement-breakpoint

-- portfolio_holdings: crypto flag
ALTER TABLE `portfolio_holdings` ADD `is_crypto` integer DEFAULT 0;--> statement-breakpoint

-- users: role, email verification, onboarding, billing fields
ALTER TABLE `users` ADD `role` text NOT NULL DEFAULT 'user';--> statement-breakpoint
ALTER TABLE `users` ADD `email_verified` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `users` ADD `email_verify_token` text;--> statement-breakpoint
ALTER TABLE `users` ADD `onboarding_complete` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `users` ADD `plan` text NOT NULL DEFAULT 'free';--> statement-breakpoint
ALTER TABLE `users` ADD `plan_expires_at` text;--> statement-breakpoint
ALTER TABLE `users` ADD `stripe_customer_id` text;
