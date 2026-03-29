-- Add authentication tables for account-based auth (Phase 2: NS-32).
-- Users table for managed edition email/password authentication.
-- Password reset tokens for email-based password recovery.

CREATE TABLE `users` (
  `id` text PRIMARY KEY NOT NULL,
  `email` text NOT NULL,
  `password_hash` text NOT NULL,
  `display_name` text,
  `mfa_enabled` integer NOT NULL DEFAULT 0,
  `mfa_secret` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `password_reset_tokens` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `user_id` text NOT NULL REFERENCES `users`(`id`),
  `token_hash` text NOT NULL,
  `expires_at` text NOT NULL,
  `used_at` text,
  `created_at` text NOT NULL
);
