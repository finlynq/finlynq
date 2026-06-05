-- Email-to-Transaction Inbox — per-user inbound email + auto-record rules
-- (2026-06-05, Epic B2). Auto-applied by deploy.sh exactly once per env.
--
-- Two tables:
--   email_inbox        — one row per inbound email routed to a user's
--                        import-<hex>@finlynq.com address. Distinct from
--                        `incoming_emails` (admin-triage, plaintext, no
--                        user_id, 24h TTL) — this is per-user, two-tier
--                        encrypted, 60-day TTL, and tracks an `action`
--                        lifecycle (pending → auto_recorded / duplicate_skipped
--                        / needs_review / unparseable / discarded /
--                        manually_recorded).
--   email_import_rules — per-user "sender/subject → account (+ optional
--                        category)" auto-record rules. Drives the DEK-bearing
--                        sweep (Epic B5). Sensitive free-text (name,
--                        match_value) is user-DEK encrypted at rest, like
--                        transaction_rules.
--
-- Encryption posture:
--   - email_inbox.{from_address, subject, body_text, body_html} are two-tier
--     envelopes (sv1: service-tier at webhook ingest where no DEK exists →
--     v1: user-tier after the login-time / sweep upgrade), keyed by the
--     `encryption_tier` column — exactly like staged_transactions /
--     bank_transactions. Read paths branch per-row on encryption_tier.
--   - email_import_rules.{name, match_value} are always user-tier (v1:) —
--     written by the CRUD route which always has a session DEK (requireEncryption).
--
-- Untrusted HTML: body_html may contain attacker-controlled markup; the UI
-- MUST render it in a sandboxed iframe (no allow-scripts), never
-- dangerouslySetInnerHTML.

CREATE TABLE IF NOT EXISTS email_inbox (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          TEXT         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Two-tier encrypted envelopes (sv1: / v1:). from_address + subject are the
  -- rule-match inputs; body_* render in the inbox detail (sandboxed iframe).
  from_address     TEXT,
  subject          TEXT,
  body_text        TEXT,
  body_html        TEXT,
  encryption_tier  TEXT         NOT NULL DEFAULT 'service'
                                CHECK (encryption_tier IN ('service','user')),
  -- The provider message id (Mailpit message ID for fetch + delete). Display
  -- ids are opaque; kept for the deleteReceived contract + poll backstop.
  message_id       TEXT,
  -- Idempotency key = provider message id. UNIQUE so a re-delivered webhook
  -- (or the poll backstop racing the webhook) is a no-op.
  dedupe_key       TEXT         NOT NULL UNIQUE,
  received_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ  NOT NULL,
  -- Lifecycle. 'pending' is the transient state between row creation and the
  -- webhook classifying it; webhook lands on needs_review / unparseable; the
  -- DEK-bearing sweep flips to auto_recorded / duplicate_skipped; the user can
  -- manually_recorded / discarded from the tab.
  action           TEXT         NOT NULL DEFAULT 'pending'
                                CHECK (action IN (
                                  'pending','auto_recorded','duplicate_skipped',
                                  'needs_review','unparseable','discarded',
                                  'manually_recorded'
                                )),
  -- 'attachment' (CSV/PDF/Excel → existing staging pipeline) or 'body'
  -- (heuristic body parse). v1 auto-routes body emails only.
  source_kind      TEXT         NOT NULL
                                CHECK (source_kind IN ('attachment','body')),
  -- The staged_imports row holding the parsed candidate (body) or rows
  -- (attachment). SET NULL because staged_imports is TTL'd at 60 days.
  staged_import_id TEXT         REFERENCES staged_imports(id) ON DELETE SET NULL,
  -- The email rule that matched at auto-record time (audit / UI). SET NULL so
  -- deleting a rule doesn't orphan-delete the inbox history.
  matched_rule_id  INTEGER,
  -- Body-parse confidence. 'high' → eligible for auto-record; 'low'/NULL never
  -- auto-promote (stay needs_review / unparseable).
  parse_confidence TEXT         CHECK (parse_confidence IN ('high','low')),
  -- Materialized transaction id once auto/manually recorded (display + undo).
  recorded_transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL
);

-- Hot path: the per-user inbox list, newest first, optionally filtered by action.
CREATE INDEX IF NOT EXISTS email_inbox_user_action_idx
  ON email_inbox (user_id, action, received_at DESC);

CREATE TABLE IF NOT EXISTS email_import_rules (
  id          SERIAL       PRIMARY KEY,
  user_id     TEXT         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Display name (user-DEK encrypted v1:).
  name        TEXT         NOT NULL,
  -- 'sender' matches from_address; 'subject' matches subject.
  match_type  TEXT         NOT NULL CHECK (match_type IN ('sender','subject')),
  match_op    TEXT         NOT NULL CHECK (match_op IN ('contains','exact','regex')),
  -- The needle (user-DEK encrypted v1:). Decrypted before matching in the sweep.
  match_value TEXT         NOT NULL,
  -- Target account for the recorded transaction. CASCADE: deleting the account
  -- removes the rule (a rule pointing at a gone account can't auto-record).
  account_id  INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Optional category. SET NULL: deleting the category leaves the rule active
  -- but uncategorized (the sweep then needs a category before auto-record, so
  -- it falls back to needs_review).
  category_id INTEGER      REFERENCES categories(id) ON DELETE SET NULL,
  -- 'auto'   → matched emails auto-record (full transaction via the sweep).
  -- 'review' → matched emails resolve the account but wait for a user click.
  mode        TEXT         NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto','review')),
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  priority    INTEGER      NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Hot path: load a user's active rules, highest priority first, for the sweep.
CREATE INDEX IF NOT EXISTS email_import_rules_user_active_idx
  ON email_import_rules (user_id, is_active, priority DESC);

-- email_inbox.matched_rule_id → email_import_rules.id (SET NULL on rule delete).
-- Added after both tables exist to avoid an ordering dependency.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'email_inbox_matched_rule_fk'
  ) THEN
    ALTER TABLE email_inbox
      ADD CONSTRAINT email_inbox_matched_rule_fk
      FOREIGN KEY (matched_rule_id) REFERENCES email_import_rules(id) ON DELETE SET NULL;
  END IF;
END $$;
