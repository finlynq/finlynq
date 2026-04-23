-- Migration: email import staging queue + admin inbox (Phase A + B).
--
-- Adds three tables backing the Resend Inbound integration:
--
--   staged_imports       — one row per incoming email that parsed to transactions
--   staged_transactions  — parsed rows awaiting user approval (plaintext, 14d TTL)
--   incoming_emails      — admin mailbox (info@/admin@/etc.) + trash bin (24h TTL)
--
-- See Research/email-import-resend-plan.md for the full design.
--
-- Idempotent. Safe to re-run.
--
-- Apply before deploying the code that references these tables, so that
-- `npm run db:push` sees no drift:
--
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-email-import-staging.sql
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-email-import-staging.sql
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-email-import-staging.sql

BEGIN;

-- ─── staged_imports ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staged_imports (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  source          TEXT NOT NULL,                              -- 'email' | 'upload'
  from_address    TEXT,
  subject         TEXT,
  svix_id         TEXT UNIQUE,                                -- null for self-hosted multipart path
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status          TEXT NOT NULL DEFAULT 'pending',            -- 'pending'|'imported'|'rejected'|'expired'
  total_row_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  expires_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_staged_imports_user_status
  ON staged_imports (user_id, status);
CREATE INDEX IF NOT EXISTS idx_staged_imports_expires_at
  ON staged_imports (expires_at)
  WHERE status = 'pending';

-- ─── staged_transactions ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staged_transactions (
  id                TEXT PRIMARY KEY,
  staged_import_id  TEXT NOT NULL REFERENCES staged_imports(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id),
  date              TEXT NOT NULL,
  amount            DOUBLE PRECISION NOT NULL,
  currency          TEXT DEFAULT 'CAD',
  payee             TEXT,
  category          TEXT,
  account_name      TEXT,
  note              TEXT,
  row_index         INTEGER NOT NULL,
  is_duplicate      BOOLEAN NOT NULL DEFAULT false,
  import_hash       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_staged_transactions_import
  ON staged_transactions (staged_import_id);
CREATE INDEX IF NOT EXISTS idx_staged_transactions_user
  ON staged_transactions (user_id);

-- ─── incoming_emails (admin mailbox + trash) ───────────────────────────────
CREATE TABLE IF NOT EXISTS incoming_emails (
  id                TEXT PRIMARY KEY,
  category          TEXT NOT NULL,                            -- 'mailbox' | 'trash'
  to_address        TEXT NOT NULL,
  from_address      TEXT NOT NULL,
  subject           TEXT,
  body_text         TEXT,
  body_html         TEXT,
  attachment_count  INTEGER NOT NULL DEFAULT 0,
  svix_id           TEXT UNIQUE,                              -- idempotency
  received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ,                              -- NULL for mailbox, NOW()+24h for trash
  triaged_at        TIMESTAMPTZ,
  triaged_by        TEXT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_incoming_emails_category_received
  ON incoming_emails (category, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_incoming_emails_trash_expires
  ON incoming_emails (expires_at)
  WHERE category = 'trash';

COMMIT;
