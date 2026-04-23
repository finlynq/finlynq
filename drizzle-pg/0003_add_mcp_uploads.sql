-- Wave 1B — Part 1: file upload table for MCP preview/execute flow.
-- Holds CSV/OFX files the user dropped via /api/mcp/upload. Rows (and the
-- blob at storage_path) are GC'd by a background job once past expires_at.
CREATE TABLE IF NOT EXISTS "mcp_uploads" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "format" text NOT NULL,
  "storage_path" text NOT NULL,
  "original_filename" text NOT NULL,
  "row_count" integer,
  "size_bytes" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL
);

ALTER TABLE "mcp_uploads"
  ADD CONSTRAINT "mcp_uploads_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE no action ON UPDATE no action;

-- Fast lookup of a user's pending/previewed uploads
CREATE INDEX IF NOT EXISTS "mcp_uploads_user_status_idx"
  ON "mcp_uploads" ("user_id", "status");

-- Fast GC scan of expired rows
CREATE INDEX IF NOT EXISTS "mcp_uploads_expires_idx"
  ON "mcp_uploads" ("expires_at");
