# Schema migration playbook

Per-environment psql commands, in chronological order, for every schema change since the open-source pivot. Pulled out of CLAUDE.md on 2026-04-28.

**Important:** schema migrations are NOT part of `npm run build`. Run them per environment BEFORE pushing the matching code change. All `ALTER TABLE` statements are idempotent (`ADD COLUMN IF NOT EXISTS` / `DROP COLUMN IF EXISTS`). Safe to re-run.

`npm run db:push` runs the PostgreSQL config (the SQLite config is a pre-open-source-pivot artifact). It's a **local-dev convenience** for iterating against your own dev DB; **`deploy.sh` does NOT run it on the deploy hosts** — see issue #5. Apply each schema change here per env via `psql -f scripts/migrate-*.sql` BEFORE pushing the matching code.

See [database.md](architecture/database.md) for the lockfile gotcha that often surfaces during a deploy.

## Phase 2 — `users.dek_wrapped` columns

Already applied to prod/staging/dev.

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-encryption.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-encryption.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-encryption.sql
```

## Phase 3 — OAuth DEK columns

Prod + staging applied; dev was empty so `db:push` handled it.

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-encryption-phase3.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-encryption-phase3.sql
```

## price_cache-global

Drop user_id from price_cache + add (symbol, date) index. The old schema had user_id NOT NULL but no write path supplied one, so every insert failed silently and the cache was permanently empty. Run BEFORE deploying the code so `npm run db:push` sees no drift.

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-price-cache-global.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-price-cache-global.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-price-cache-global.sql
```

## fx_rates-global

Drop user_id from fx_rates + add (from, to, date) index. FX rates (USD->CAD etc.) are identical across users; the old schema had user_id NOT NULL and the code worked around it with a DEFAULT_USER_ID fallback. Dedupes by (from, to, date) before drop. Run BEFORE deploying the code.

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-fx-rates-global.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-fx-rates-global.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-fx-rates-global.sql
```

## tx-splits-cascade

Add ON DELETE CASCADE to `transaction_splits.transaction_id`. Without CASCADE, deleting a transaction with any split rows raised a FK violation, 500-ing web + MCP delete paths. Migration introspects the FK by (table, column) in `pg_constraint` because the constraint name differs by env (prod/staging: `transaction_splits_transaction_id_fkey`; dev: drizzle's `transaction_splits_transaction_id_transactions_id_fk`). Applied prod + staging + dev on 2026-04-23.

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-tx-splits-cascade.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-tx-splits-cascade.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-tx-splits-cascade.sql
```

## accounts-archived

Add `accounts.archived boolean`. Backs the Archive/Delete buttons on the accounts page. `getAccounts` / `getAccountBalances` filter `archived=false` by default so every caller drops archived accounts from balances + pickers without opt-in. Applied prod 2026-04-24; staging + dev still pending.

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-accounts-archived.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-accounts-archived.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-accounts-archived.sql
```

## accounts-alias

Add `accounts.alias text` (nullable). Backs the per-account short alias used by MCP fuzzy account resolution and the CSV import pipeline. `get_account_balances` returns alias so Claude can see configured shorthands. One alias per account for now; multi-alias is a future additive feature (separate `account_aliases` table). Run BEFORE deploying.

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-accounts-alias.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-accounts-alias.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-accounts-alias.sql
```

## stream-d (Phase 1 + 2)

Display-name encryption. Adds `*_ct` and `*_lookup` columns to accounts/categories/goals/loans/subscriptions/portfolio_holdings (all nullable) plus partial unique indexes on `(user_id, name_lookup) WHERE name_lookup IS NOT NULL`. Plaintext columns + old unique constraints are left intact — dual-write ensures both stay consistent. Lazy backfill on next login fills the `*_ct` columns. Phase 3 (drop plaintext + swap unique indexes) is a later deploy. See [STREAM_D.md](../../STREAM_D.md) and [PRIVACY_HARDENING_2026-04.md](../../PRIVACY_HARDENING_2026-04.md).

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-stream-d.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-stream-d.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-stream-d.sql
```

## stream-d Phase 3 (NULL plaintext)

Applied to prod 2026-04-24. NULL the plaintext name/alias/symbol columns on every encrypted row; `name_ct` + `name_lookup` become the sole source of truth. Columns kept in schema for stdio MCP compat. **Prod-only at the moment** — staging + dev still on Phase 1 + 2.

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-stream-d-phase3-null.sql
```

## transactions-link-id

Add nullable `transactions.link_id text` + partial index on `link_id IS NOT NULL` for cheap sibling lookups. Populated by the WP ZIP importer (every #SPLIT# group shares one linkId) so the tx edit dialog can surface sibling legs of a transfer / same-account conversion / liquidation. Idempotent. Applied prod/staging/dev on 2026-04-24.

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-transactions-link-id.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-transactions-link-id.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-transactions-link-id.sql
```

## tx-portfolio-holding-fk

Phases 1-4 of the integer-FK rollout. Adds `transactions.portfolio_holding_id integer` FK (nullable, ON DELETE SET NULL) referencing `portfolio_holdings(id)`, a partial index on `(user_id, portfolio_holding_id)`, and a partial UNIQUE index on `portfolio_holdings (user_id, account_id, name_lookup)` so the resolver's ON CONFLICT path is concurrency-safe.

Phase 2 (dual-write) and Phase 3 (FK-keyed reads) shipped in the same code deploy; Phase 4 lazy backfill runs on each user's next login.

The FK constraint is introspected by `(table, column)` in `pg_constraint` so the migration is safe to run before OR after `npm run db:push` (db:push generates its own auto-named FK; the DO $$ block recognizes either name and aligns the ON DELETE behavior). Idempotent. Applied prod + staging + dev on 2026-04-26 (commit 97463a7); code shipped to prod only.

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-tx-portfolio-holding-fk.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-tx-portfolio-holding-fk.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-tx-portfolio-holding-fk.sql
```

## tx-portfolio-holding-phase5-null (2026-04-29)

Phase 5 of the FK rollout. NULLs the legacy encrypted `transactions.portfolio_holding` text column on every row whose FK is populated — the FK becomes the sole source of truth. Idempotent (re-running on an already-NULL'd DB is a no-op). Run **before** the matching code deploy (drops `portfolioHolding` from `TX_ENCRYPTED_FIELDS` + deletes the orphan-fallback decrypt loops).

Pre-check inside the migration aborts with `RAISE EXCEPTION` if any row has plaintext but no FK — `withoutFk` must be 0 first. Applied prod-only on 2026-04-29 (1200 rows updated); staging + dev are still on the dual-write Phases 1-4 schema and don't have rows that would be affected.

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-tx-portfolio-holding-phase5-null.sql
```

## tx-portfolio-holding-phase6-drop-column (2026-04-29)

Phase 6: `ALTER TABLE transactions DROP COLUMN IF EXISTS portfolio_holding`. Backwards-incompatible — code stops referencing the column **before** the migration runs (deploy code first, then SQL). Defensive pre-check refuses to run if Phase 5 left rows with non-NULL plaintext. Applied prod-only on 2026-04-29; staging + dev still have the column.

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-tx-portfolio-holding-phase6-drop-column.sql
```

## users-username

Privacy-friendly signup. Adds `users.username` (nullable), makes `users.email` nullable, drops the old single-column UNIQUE on email, creates case-insensitive partial unique indexes on both `lower(email)` and `lower(username)`. Backfills legacy rows with `username = LOWER(email)` (allowed because the username regex now permits `@` + `.` so an email-shaped string is a valid username). Login lookup tries username first then falls back to email. Cross-column collision is enforced at signup time. Reserved bare-handle list (admin/support/import-/...) blocks new signups from claiming routing-conflicting names. Run BEFORE deploying.

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-username.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-username.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-username.sql
```

## fx-rates-canonical

Reshape `fx_rates` to a global canonical-USD cache. Old per-pair shape `(user_id, from_currency, to_currency, rate)` → new `(currency, date, rate_to_usd, source, fetched_at)` UNIQUE on `(currency, date)`. Cross-rates triangulate via USD: `getRate(EUR, CAD) = rate_to_usd[EUR] / rate_to_usd[CAD]`. Drops user_id since rates are universal. Old data preserved in `fx_rates_legacy` for one cycle (drop later via `migrate-fx-rates-legacy-drop.sql`).

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-fx-rates-canonical.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-fx-rates-canonical.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-fx-rates-canonical.sql
```

## tx-three-currencies

3-currency trilogy on transactions. Adds `entered_currency`, `entered_amount`, `entered_fx_rate`, `entered_at` columns. Same on `transaction_splits`. Existing `currency`/`amount` carry "account/settlement currency" semantics post-migration; `entered_*` is what the user typed (locked at entry). Reporting currency is computed at view time, not stored. Backfill: clean rows where `transactions.currency == accounts.currency` get `entered = (currency, amount, 1)`; cross-currency rows are flagged in new `tx_currency_audit` table for user review. Applied to all three envs on 2026-04-27.

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-tx-three-currencies.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-tx-three-currencies.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-tx-three-currencies.sql
```

## goals-loans-currency

Goals + loans gain a `currency` column, default `'CAD'`, backfilled from linked account where present. Applied to all three envs on 2026-04-27.

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-goals-loans-currency.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-goals-loans-currency.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-goals-loans-currency.sql
```

## fx-rates-legacy-drop

Drop the `fx_rates_legacy` table after the soak window. Idempotent. Run when ready.

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-fx-rates-legacy-drop.sql
```

## hash-api-keys (one-shot script)

Hashes all dormant API keys (`pf_*` → `sha256:<64 hex>`) in `settings.value` for `key='api_key'`. Idempotent (skips rows already prefixed with `sha256:`). The validate-on-access fallback in [api-auth.ts](../../src/lib/api-auth.ts) means the deploy order doesn't matter. Prod sweep ran 2026-04-23 (5 keys hashed); staging + dev have no keys yet so no sweep needed.

```sh
node scripts/migrate-hash-api-keys.ts
```

## oauth-revoked-at

Adds `oauth_access_tokens.revoked_at timestamptz` + partial index `(token) WHERE revoked_at IS NULL`. Backs OAuth refresh-token rotation with reuse detection. Idempotent. Applied to prod + staging + dev on 2026-04-23.

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-oauth-revoked-at.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-oauth-revoked-at.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-oauth-revoked-at.sql
```

## email-import-staging

Three new tables for the Resend Inbound flow: `staged_imports` (one per email), `staged_transactions` (parsed rows, CASCADE delete), `incoming_emails` (admin inbox + trash with category discriminator). Applied to prod on 2026-04-23; staging + dev still pending (drizzle-kit push hangs on non-tty SSH when schema has column-drop prompts — use `CREATE TABLE IF NOT EXISTS` directly for those envs).

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-email-import-staging.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-email-import-staging.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-email-import-staging.sql
```

## privacy-hardening (2026-04-24 batch)

Adds `oauth_access_tokens.dek_wrapped_refresh` + `admin_audit` table, then invalidates all live OAuth tokens/codes + unverified email tokens. Idempotent. Applied to all three envs on 2026-04-24.

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-privacy-hardening.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-privacy-hardening.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-privacy-hardening.sql
```

See the deploy playbook at [pf-app/docs/privacy-hardening-deploy.md](privacy-hardening-deploy.md) for the full sequence (env vars first, then SQL, then code, then admin bootstrap).

## accounts-is-investment

Adds `accounts.is_investment boolean NOT NULL DEFAULT false` and backfills it for any account that already has at least one `portfolio_holdings` row pointed at it. For each newly-flagged account, ensures a per-account "Cash" portfolio_holdings row exists (`name='Cash', symbol=NULL, currency=accounts.currency, note='auto-created for cash sleeve'`) and points all unattributed transactions in that account at the Cash holding (rows where BOTH `portfolio_holding_id IS NULL` AND `portfolio_holding IS NULL`). Rows where the legacy plaintext `portfolio_holding` text column is populated stay untouched — the Phase-4 lazy resolver routes them to their actual holding on next login. The migration runs server-side without DEKs, so the auto-created Cash holding's `name_ct` / `name_lookup` columns stay NULL and get filled lazily on next login (same dual-write pattern as Stream D Phase 4). Idempotent — every step uses `IF NOT EXISTS` / `WHERE NOT EXISTS`. Run BEFORE deploying the matching code change so the application-layer constraint check has the column to read.

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-accounts-is-investment.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-accounts-is-investment.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-accounts-is-investment.sql
```

After deploy, monitor via `GET /api/admin/investment-orphans` — non-zero `orphanCount` means some users haven't logged in since the migration (Phase-4 lazy backfill hasn't run for them) or have legacy quantity-bearing rows that the resolver couldn't attribute. Both clear themselves once the user logs in / opens the orphan in the UI.
