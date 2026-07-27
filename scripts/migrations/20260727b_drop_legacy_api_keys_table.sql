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

DO $$
DECLARE
  n bigint;
BEGIN
  IF to_regclass('public.api_keys') IS NULL THEN
    RAISE NOTICE 'api_keys: already absent, nothing to do';
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

  DROP TABLE public.api_keys;
  RAISE NOTICE 'api_keys: dropped (was empty)';
END $$;
