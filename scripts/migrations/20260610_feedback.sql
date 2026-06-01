-- User feedback — in-app bug reports / ideas (2026-06-10).
--
-- Plaintext by design: feedback must be readable by the maintainer (the
-- /admin/feedback review page + the email to feedback@finlynq.com), and the
-- submitting user's per-user DEK is unreadable by an admin. The submit form
-- warns users not to include sensitive financial details.

CREATE TABLE IF NOT EXISTS feedback (
  id          SERIAL       PRIMARY KEY,
  user_id     TEXT         NOT NULL,
  type        TEXT         NOT NULL DEFAULT 'other',  -- 'bug' | 'idea' | 'question' | 'other'
  message     TEXT         NOT NULL,
  page_url    TEXT,
  app_version TEXT,
  status      TEXT         NOT NULL DEFAULT 'new',    -- 'new' | 'triaged' | 'resolved'
  admin_note  TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Hot path: admin review queue ordered by recency, filtered by status.
CREATE INDEX IF NOT EXISTS feedback_status_idx
  ON feedback (status, created_at DESC);

CREATE INDEX IF NOT EXISTS feedback_user_idx
  ON feedback (user_id);
