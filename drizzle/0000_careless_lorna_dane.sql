CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`group` text DEFAULT '' NOT NULL,
	`name` text NOT NULL,
	`currency` text DEFAULT 'CAD' NOT NULL,
	`note` text DEFAULT ''
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_name_unique` ON `accounts` (`name`);--> statement-breakpoint
CREATE TABLE `budgets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category_id` integer NOT NULL,
	`month` text NOT NULL,
	`amount` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`group` text DEFAULT '' NOT NULL,
	`name` text NOT NULL,
	`note` text DEFAULT ''
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_name_unique` ON `categories` (`name`);--> statement-breakpoint
CREATE TABLE `portfolio_holdings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer,
	`name` text NOT NULL,
	`symbol` text,
	`currency` text DEFAULT 'CAD' NOT NULL,
	`note` text DEFAULT '',
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`account_id` integer,
	`category_id` integer,
	`currency` text DEFAULT 'CAD' NOT NULL,
	`amount` real DEFAULT 0 NOT NULL,
	`quantity` real,
	`portfolio_holding` text,
	`note` text DEFAULT '',
	`payee` text DEFAULT '',
	`tags` text DEFAULT '',
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
