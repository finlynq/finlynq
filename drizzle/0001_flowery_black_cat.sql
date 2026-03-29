CREATE TABLE `contribution_room` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`year` integer NOT NULL,
	`room` real NOT NULL,
	`used` real DEFAULT 0,
	`note` text DEFAULT ''
);
--> statement-breakpoint
CREATE TABLE `fx_rates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`from_currency` text NOT NULL,
	`to_currency` text NOT NULL,
	`rate` real NOT NULL
);
--> statement-breakpoint
CREATE TABLE `goals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`target_amount` real NOT NULL,
	`deadline` text,
	`account_id` integer,
	`priority` integer DEFAULT 1,
	`status` text DEFAULT 'active' NOT NULL,
	`note` text DEFAULT '',
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `loans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`account_id` integer,
	`principal` real NOT NULL,
	`annual_rate` real NOT NULL,
	`term_months` integer NOT NULL,
	`start_date` text NOT NULL,
	`payment_amount` real,
	`payment_frequency` text DEFAULT 'monthly' NOT NULL,
	`extra_payment` real DEFAULT 0,
	`note` text DEFAULT '',
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`read` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`metadata` text DEFAULT ''
);
--> statement-breakpoint
CREATE TABLE `price_cache` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`date` text NOT NULL,
	`price` real NOT NULL,
	`currency` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recurring_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`payee` text NOT NULL,
	`amount` real NOT NULL,
	`frequency` text NOT NULL,
	`category_id` integer,
	`account_id` integer,
	`next_date` text,
	`active` integer DEFAULT 1 NOT NULL,
	`note` text DEFAULT '',
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer,
	`date` text NOT NULL,
	`value` real NOT NULL,
	`note` text DEFAULT '',
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`amount` real NOT NULL,
	`currency` text DEFAULT 'CAD' NOT NULL,
	`frequency` text DEFAULT 'monthly' NOT NULL,
	`category_id` integer,
	`account_id` integer,
	`next_date` text,
	`status` text DEFAULT 'active' NOT NULL,
	`cancel_reminder_date` text,
	`notes` text,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `target_allocations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`target_pct` real NOT NULL,
	`category` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `transactions` ADD `is_business` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `transactions` ADD `split_person` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `split_ratio` real;