-- Announcements — admin broadcast of news/updates to all users (2026-06-10).
--
-- `announcements` holds admin-authored, plaintext broadcast items (operator
-- content, NOT per-user data, so intentionally un-encrypted). `pinned` items
-- drive the dismissible in-app banner; all published+unexpired items show on
-- /whats-new. `announcement_reads` tracks per-user read/dismiss state — absence
-- of a row means unread for that user.

CREATE TABLE IF NOT EXISTS announcements (
  id           SERIAL       PRIMARY KEY,
  title        TEXT         NOT NULL,
  body         TEXT         NOT NULL,
  category     TEXT         NOT NULL DEFAULT 'news',   -- 'news' | 'update' | 'maintenance'
  severity     TEXT         NOT NULL DEFAULT 'info',   -- 'info' | 'warning'
  pinned       BOOLEAN      NOT NULL DEFAULT FALSE,
  published    BOOLEAN      NOT NULL DEFAULT FALSE,
  published_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  created_by   TEXT         NOT NULL,                  -- admin user id
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Hot path: list active (published + unexpired) items.
CREATE INDEX IF NOT EXISTS announcements_published_idx
  ON announcements (published, expires_at);

CREATE TABLE IF NOT EXISTS announcement_reads (
  user_id         TEXT         NOT NULL,
  announcement_id INTEGER      NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  read_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, announcement_id)
);

CREATE INDEX IF NOT EXISTS announcement_reads_user_idx
  ON announcement_reads (user_id);
