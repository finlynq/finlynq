# Schema migrations

How Finlynq's PostgreSQL schema is created and evolved, for every environment.

> Written 2026-07-24 as part of the GH #312 fix. CLAUDE.md had pointed at this
> file for months but it did not exist — the absence is part of how the schema
> drifted out of the tracked chain in the first place.

## The two artifacts

| Path | Role |
|---|---|
| `scripts/baseline/0001_schema_baseline.sql` | Complete snapshot of the schema. Applied **only to an empty database**. |
| `scripts/migrations/*.sql` | The incremental chain. Every file runs exactly once per environment, in filename order. |

Bookkeeping lives in `schema_migrations(version PRIMARY KEY, applied_at)`, where
`version` is the filename minus `.sql`.

## The two runners

Both implement the same contract; `tests/migration-runner.test.ts` asserts they
agree. **If you change one, change the other.**

| Runner | Used by | Mechanism |
|---|---|---|
| `deploy.sh` (migration section) | prod + dev VPS | bash + `psql` |
| `scripts/run-migrations.mjs` | the Docker image | node + `pg` |

Order of operations, identical in both:

1. `CREATE TABLE IF NOT EXISTS schema_migrations …`
2. If `public` holds **no ordinary tables other than `schema_migrations`**, apply
   the baseline. It ends by recording the migrations it subsumes.
3. Apply every `scripts/migrations/*.sql` not already in the ledger, in filename
   order, each wrapped in **one transaction together with its ledger INSERT**.

A database that holds some tables but no `users` table is refused outright — that
is a half-created schema, and applying a baseline over it would fail messily
partway through. Start from empty, or restore a `pg_dump`.

## Why a baseline exists at all

The chain alone cannot build the schema. Measured against an empty database on
2026-07-24: **38 of 70 migrations failed and only 43 of 70 tables were created.**

The schema had been built by three uncoordinated mechanisms:

1. `drizzle-pg/` — 4 files, 21 tables, run only by the old Docker entrypoint
2. `scripts/migrations/` — 70 files, run only by `deploy.sh`
3. ~39 loose `scripts/migrate-*.sql` — **run by hand against prod, never tracked**

Prod and dev were correct only because (3) had been applied to them manually.
Anything starting from zero got a broken database, which is what GH #312
reported for the published Docker image. It was equally true of a from-scratch
cloud rebuild without a dump to restore.

## Adding a schema change

Add one file to `scripts/migrations/`. That is the whole procedure.

- **Filename:** `YYYYMMDD_short-description.sql`, matching `^[A-Za-z0-9_-]+$`.
  The gate is the sole barrier against SQL injection through a hostile filename,
  since both runners put the version into SQL. No quotes, semicolons,
  backslashes, or whitespace.
- **No `BEGIN`/`COMMIT` inside the file.** The runner already wraps the body plus
  the ledger INSERT in a single transaction; an inner `COMMIT` closes it early
  and decouples the bookkeeping from the DDL, so a later failure leaves the
  migration recorded but half-applied.
- **Write it idempotently** — `IF NOT EXISTS` on tables and indexes, `ADD COLUMN
  IF NOT EXISTS` on columns. Postgres has no `ADD CONSTRAINT IF NOT EXISTS`; use
  a `DO $$ … EXCEPTION WHEN duplicate_object THEN NULL; END $$;` block.
- **Do not regenerate the baseline.** A new migration is simply absent from the
  baseline's subsumed list, so it runs normally on a fresh database. That is the
  designed behaviour.

## Never use `db:push` on a real environment

`npm run db:push` is `drizzle-kit push` — it diffs `schema-pg.ts` against the
live database and applies the delta, **leaving no migration file behind**. That
is precisely how prod acquired 14 tables no migration creates. Scratch databases
only.

It also expresses far less than the schema actually contains: `schema-pg.ts`
declares **0 CHECK constraints and 2 partial indexes**, where prod has **52 and
27**. Anything generated from the ORM schema silently drops the
`opening_balance` 1:1 partial unique index, `accounts_mode_check`, the
`transactions.source` 7-value CHECK, and ~48 others. This is also why the
baseline is a `pg_dump` capture rather than `drizzle-kit generate` output.

## Regenerating the baseline

Rarely needed — only when the chain has grown long enough that a fresh install
replaying it is genuinely slow. Not part of ordinary schema work.

```bash
sudo -u postgres pg_dump -d pf --schema-only --no-owner --no-privileges \
  --no-comments -T public.fx_rates_legacy -T public.schema_migrations
```

Then strip `\restrict` / `\unrestrict`, `SET `, `SELECT pg_catalog.set_config`
and comment lines; keep the header; refresh the subsumed-version list to every
filename currently in `scripts/migrations/`. Verify by applying it to an empty
database and diffing tables / columns / constraints / indexes against prod — the
diff must be zero on all four.

## Verifying a from-zero install

The `smoke` job in `.github/workflows/docker.yml` does this on every PR that
touches the Dockerfile, entrypoint, runner, baseline, or migrations: build the
image, `docker compose up`, wait for `/api/healthz`, **register a user**, then
assert schema floors (≥68 tables, ≥52 CHECK constraints, ≥27 partial indexes,
≥70 ledger rows) and that every table in `schema-pg.ts` exists.

The registration step matters more than the health check. A health check passes
against a half-built database; registration is what actually exercised the
missing tables in #312.

## Known loose ends

- The ~39 `scripts/migrate-*.sql` files remain in the repo. They are now purely
  historical — their effects are folded into the baseline. They are not run by
  anything. Deleting them is a separate cleanup.
- `fx_rates_legacy` exists on prod but is dead (a one-cycle safety net from the
  FX canonicalisation, superseded and never dropped). It is deliberately
  excluded from the baseline. `scripts/migrate-fx-rates-legacy-drop.sql` drops it
  when an operator chooses to.
