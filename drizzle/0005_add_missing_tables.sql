-- Create tables that were missing from earlier migrations.
-- settings, transaction_rules, and budget_templates are created here
-- with user_id already included (they did not exist when 0002 ran).

CREATE TABLE IF NOT EXISTS `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL DEFAULT 'default',
	`value` text NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `transaction_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL DEFAULT 'default',
	`name` text NOT NULL,
	`match_field` text NOT NULL,
	`match_type` text NOT NULL,
	`match_value` text NOT NULL,
	`assign_category_id` integer REFERENCES `categories`(`id`),
	`assign_tags` text,
	`rename_to` text,
	`is_active` integer NOT NULL DEFAULT 1,
	`priority` integer NOT NULL DEFAULT 0,
	`created_at` text NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `budget_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL DEFAULT 'default',
	`name` text NOT NULL,
	`category_id` integer NOT NULL REFERENCES `categories`(`id`),
	`amount` real NOT NULL,
	`created_at` text NOT NULL
);
