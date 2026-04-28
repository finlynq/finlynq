-- Migration: add users.username + make users.email nullable
--
-- Privacy-friendly signup: users now register with a required username and an
-- optional email. Email becomes a recovery channel (password reset / verify
-- mail) — users who skip it operate fully zero-knowledge, consistent with the
-- existing "forgot password = wipe + rewrap" policy.
--
-- Schema changes:
--   * adds users.username text (nullable; partial unique on lower(username))
--   * drops the email NOT NULL + UNIQUE constraints
--   * adds case-insensitive partial unique on lower(email)
--   * best-effort backfills username from email local-part for legacy rows.
--     Hand-assignments for prod live at the bottom (commented).
--
-- Idempotent. Safe to re-run.
--
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-username.sql
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-username.sql
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-username.sql

BEGIN;

-- 1. Add username column (nullable so backfill is non-blocking).
ALTER TABLE users ADD COLUMN IF NOT EXISTS username text;

-- 2. Make email nullable.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

-- 3. Drop the old single-column UNIQUE on email. Constraint name varies across
--    envs (drizzle named it differently in dev) — introspect by (table, column)
--    like migrate-tx-splits-cascade.sql does.
DO $$
DECLARE c text;
BEGIN
  SELECT con.conname INTO c
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
   WHERE rel.relname = 'users'
     AND con.contype = 'u'
     AND (
       SELECT array_agg(att.attname ORDER BY att.attnum)
         FROM pg_attribute att
        WHERE att.attrelid = con.conrelid
          AND att.attnum = ANY(con.conkey)
     ) = ARRAY['email']::name[]
   LIMIT 1;
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', c);
  END IF;
END $$;

-- 4. Case-insensitive partial unique indexes. Both allow multiple NULLs.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique
  ON users (LOWER(email)) WHERE email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_unique
  ON users (LOWER(username)) WHERE username IS NOT NULL;

-- 5. Backfill legacy rows: the username regex now allows '@' and '.', so the
--    cleanest backfill is to use the full email as the username (lowercased).
--    No collisions possible because email itself is uniquely indexed and
--    the cross-column collision rule kicks in only at new-signup time.
UPDATE users
   SET username = LOWER(email)
 WHERE username IS NULL AND email IS NOT NULL;

-- 6. Hand-assignments for nicer handles (commented). The auto-backfill
--    above produces dotted-and-lowercased usernames from email; if you
--    want a nicer handle for a small number of admin/seed users, do it
--    by uncommenting per env after the auto-backfill runs.
-- UPDATE users SET username = '<handle>' WHERE email = '<email>';

COMMIT;
