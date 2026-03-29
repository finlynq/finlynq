-- Add authentication tables for account-based auth (Phase 2: NS-32).
-- Users table for managed edition email/password authentication.
-- Password reset tokens for email-based password recovery.

CREATE TABLE "users" (
  "id" text PRIMARY KEY NOT NULL,
  "email" text NOT NULL UNIQUE,
  "password_hash" text NOT NULL,
  "display_name" text,
  "mfa_enabled" integer NOT NULL DEFAULT 0,
  "mfa_secret" text,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL
);

CREATE TABLE "password_reset_tokens" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "token_hash" text NOT NULL,
  "expires_at" text NOT NULL,
  "used_at" text,
  "created_at" text NOT NULL
);
