-- Pepper rotation prep — Open #2 from SECURITY_HANDOVER_2026-05-07.md.
--
-- Adds `pepper_version` to users so the envelope decoder can pick which
-- PF_PEPPER variant to use when unwrapping a DEK. Without this column,
-- rotating PF_PEPPER invalidates every encrypted DEK envelope (the existing
-- code looks up a single env var). After this migration, the rotation flow
-- is:
--
--   1. Operator generates a new pepper, sets PF_PEPPER_V2=<new> alongside
--      PF_PEPPER=<old> in the systemd unit. Restarts the service.
--   2. Operator runs scripts/rewrap-peppers.ts which iterates every user
--      row, derives the KEK with PF_PEPPER (old), unwraps the DEK, derives
--      a new KEK with PF_PEPPER_V2 (new), re-wraps, UPDATEs the row, and
--      sets pepper_version = 2.
--   3. Once every user is migrated, operator removes PF_PEPPER from the
--      systemd unit and renames PF_PEPPER_V2 → PF_PEPPER.
--
-- pepper_version=1 means "use PF_PEPPER" (the legacy single-pepper code path).
-- pepper_version=2 means "use PF_PEPPER_V2" (the rotated value during the
-- migration window). The version-to-env-var mapping is hard-coded in
-- src/lib/crypto/envelope.ts so future rotations follow the same pattern
-- (pepper_version=3 → PF_PEPPER_V3, etc.).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS pepper_version SMALLINT NOT NULL DEFAULT 1;

-- Index supports the rewrap-peppers.ts paginated SELECT — the WHERE clause
-- filters by version so subsequent runs only touch rows that haven't been
-- rotated yet (idempotent + resumable).
CREATE INDEX IF NOT EXISTS users_pepper_version_idx ON users(pepper_version)
  WHERE pepper_version < 999; -- noise guard against a future field overflow
