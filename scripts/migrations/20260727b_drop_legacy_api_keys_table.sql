-- Drop the dead `api_keys` table.
--
-- Superseded long ago: API keys live in `settings` as the `api_key` /
-- `api_key_dek` rows (GET/POST /api/settings/api-key, surfaced on
-- /settings/account, validated by src/lib/api-auth.ts). Nothing in the repo
-- reads or writes `api_keys` — not the app, MCP, mobile, scripts, or tests.
-- (`scripts/migrate-hash-api-keys.ts` is named for the FEATURE, not the table:
-- it sweeps `settings WHERE key = 'api_key'`.) It is not in `schema-pg.ts`
-- either, so Drizzle has never modelled it.
--
-- Why it is worth removing rather than ignoring: `api_keys_user_id_fkey`
-- references `users(id)` with **NO ACTION** — no cascade, no SET NULL. A single
-- row would make Postgres refuse the final `DELETE FROM users` in
-- `deleteUserAccount`, raising 23503, rolling back the whole transaction and
-- returning a 500 — i.e. that user could never delete their account. Same
-- failure shape as the documented `admin_audit` edge case, but with no
-- deliberate policy behind it. Measured 2026-07-27: 0 rows on prod and dev, and
-- no code path can create one, so this is a latent trap rather than a live bug.
--
-- The table IS in scripts/baseline/0001_schema_baseline.sql (a pg_dump snapshot
-- of prod taken while it still existed). That is fine and intentional — a
-- from-zero build applies the baseline and then this migration drops it. Do NOT
-- regenerate the baseline for this.
--
-- Defensive: only drops when empty. If an old self-hosted deployment somehow
-- has rows, the migration leaves the table alone and warns rather than
-- destroying data or blocking the deploy.
--
-- It must ALSO tolerate not owning the table. `api_keys` predates the tracked
-- migration chain, so on any deployment where it was created by hand as a
-- different role (prod: owner `postgres`, while migrations run as the app
-- role) `DROP TABLE` fails with "must be owner of table api_keys" — SQLSTATE
-- 42501. That aborts the migration runner and takes the whole deploy with it,
-- which is precisely what the paragraph above says this migration must never
-- do: it is opportunistic cleanup of a dead, empty table, not a load-bearing
-- schema change. Ownership is checked up front and the drop is additionally
-- wrapped so a privilege error downgrades to a warning. Leaving the table is
-- harmless — the FK trap it describes needs at least one row, and no code path
-- can create one. An operator finishes the job with:
--     ALTER TABLE public.api_keys OWNER TO <app_role>;   -- then re-run, or
--     DROP TABLE public.api_keys;                        -- as a superuser
-- (Discovered by a failed prod deploy, 2026-07-27.)

DO $$
DECLARE
  n bigint;
  owner_name text;
BEGIN
  IF to_regclass('public.api_keys') IS NULL THEN
    RAISE NOTICE 'api_keys: already absent, nothing to do';
    RETURN;
  END IF;

  SELECT tableowner INTO owner_name
    FROM pg_tables WHERE schemaname = 'public' AND tablename = 'api_keys';
  IF NOT pg_has_role(current_user, owner_name, 'USAGE') THEN
    -- NB: records as applied, so it will not re-run. Deliberate: re-running
    -- would fail identically until an operator intervenes, and the table is
    -- inert either way.
    RAISE WARNING
      'api_keys: owned by % but migrating as % — NOT dropping. The table is '
      'empty and unreachable from the app, so this is safe to leave. To finish: '
      'ALTER TABLE public.api_keys OWNER TO %; or DROP TABLE it as a superuser.',
      owner_name, current_user, current_user;
    RETURN;
  END IF;

  EXECUTE 'SELECT count(*) FROM public.api_keys' INTO n;
  IF n > 0 THEN
    -- NB: this migration still records as applied, so it will not re-run.
    -- An operator clearing the rows must drop the table by hand afterwards.
    RAISE WARNING
      'api_keys: % row(s) present — NOT dropping. These keys are unreachable '
      'from the app and block account deletion (FK to users is NO ACTION). '
      'Clear them, then DROP TABLE public.api_keys manually.', n;
    RETURN;
  END IF;

  -- Belt-and-braces: the ownership probe above should already have caught the
  -- privilege case, but a DROP can still be refused (e.g. an event trigger, or
  -- a role grant changing mid-deploy). Never let cleanup abort a release.
  BEGIN
    DROP TABLE public.api_keys;
    RAISE NOTICE 'api_keys: dropped (was empty)';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE WARNING
      'api_keys: insufficient privilege to drop as % — left in place (empty, '
      'inert). Drop it manually as its owner or a superuser.', current_user;
  END;
END $$;
