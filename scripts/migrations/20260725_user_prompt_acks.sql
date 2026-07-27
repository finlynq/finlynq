-- FINLYNQ-301 phase 1 — generic user-decision prompt surface.
--
-- Additive only (auto-applied by deploy.sh / run-migrations.mjs; NO destructive
-- statements). Per-(user, prompt, version) completion tracking for the reusable
-- "we need an answer from you" surface. Mirrors `announcement_reads`: TEXT
-- user_id with no FK, a composite PK, and a user_idx.
--
-- `version` is in the PK so bumping a prompt's version in the code registry
-- re-asks every user while preserving the prior answer as its own audit row.
-- `answer` stores the accepted value as text for the audit trail ONLY — it is
-- never the source of truth (the registry's writer persists to the real
-- destination, e.g. settings.display_currency). `status` is one of
-- 'answered' | 'deferred' | 'dismissed'.

CREATE TABLE IF NOT EXISTS user_prompt_acks (
  user_id        TEXT NOT NULL,
  prompt_id      TEXT NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL,
  answer         TEXT,
  defer_count    INTEGER NOT NULL DEFAULT 0,
  deferred_until TIMESTAMPTZ,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, prompt_id, version),
  CONSTRAINT user_prompt_acks_status_chk
    CHECK (status IN ('answered', 'deferred', 'dismissed'))
);

CREATE INDEX IF NOT EXISTS user_prompt_acks_user_idx ON user_prompt_acks (user_id);
