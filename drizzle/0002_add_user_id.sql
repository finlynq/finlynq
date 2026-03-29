-- Add user_id column to all data tables for multi-tenant support.
-- Self-hosted uses the default value 'default' for single-user mode.

ALTER TABLE `accounts` ADD `user_id` text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE `categories` ADD `user_id` text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE `transactions` ADD `user_id` text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE `portfolio_holdings` ADD `user_id` text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE `budgets` ADD `user_id` text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE `loans` ADD `user_id` text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE `snapshots` ADD `user_id` text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE `goals` ADD `user_id` text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE `target_allocations` ADD `user_id` text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE `recurring_transactions` ADD `user_id` text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE `price_cache` ADD `user_id` text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE `fx_rates` ADD `user_id` text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE `notifications` ADD `user_id` text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `user_id` text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE `settings` ADD `user_id` text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE `transaction_rules` ADD `user_id` text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE `budget_templates` ADD `user_id` text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE `contribution_room` ADD `user_id` text NOT NULL DEFAULT 'default';
