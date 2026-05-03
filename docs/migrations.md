# Schema migration playbook

Per-environment psql commands, in chronological order, for every schema change since the open-source pivot. Pulled out of CLAUDE.md on 2026-04-28.

**Important:** schema migrations are NOT part of `npm run build`. Run them per environment BEFORE pushing the matching code change. All `ALTER TABLE` statements are idempotent (`ADD COLUMN IF NOT EXISTS` / `DROP COLUMN IF EXISTS`). Safe to re-run.

`npm run db:push` runs the PostgreSQL config (the SQLite config is a pre-open-source-pivot artifact). It's a **local-dev convenience** for iterating against your own dev DB; **`deploy.sh` does NOT run it on the deploy hosts** — see issue #5. Apply each schema change here per env via `psql -f scripts/migrate-*.sql` BEFORE pushing the matching code.

> **Staging deprecated 2026-05-03.** Active envs are now **prod + dev only**. Historical entries below preserve the staging command lines for the audit trail; new entries should not include staging. The `pf_staging` database and `finlynq_staging` user remain on the host as a cold artifact (no app deploys there).

See [database.md](architecture/database.md) for the lockfile gotcha that often surfaces during a deploy.

## Stream D Phase 4 — drop plaintext display-name columns (2026-05-03)

Final cutover for the Stream D encrypted-display-names work. **Drops 8 plaintext columns** from `accounts` (`name`, `alias`), `categories` (`name`), `goals` (`name`), `loans` (`name`), `subscriptions` (`name`), and `portfolio_holdings` (`name`, `symbol`). Reads now route through `name_ct` + the session DEK; writes through `buildNameFields()`. Promotes the partial unique indexes on `(user_id, name_lookup)` to full unique indexes (every row is guaranteed to have a non-null lookup post-cutover).

**DEPLOY ORDER MATTERS — code FIRST, then SQL.** The Phase 4 release reads ciphertext only and refuses plaintext writes (it's backwards-compatible with the columns still being there because it just doesn't touch them). The pre-Phase-4 release READS plaintext columns and would 500 if the SQL ran first. Always: push code → confirm green → THEN apply this SQL.

Stdio MCP create/update tools for the 6 in-scope tables now refuse the operation with a clean error message (no DEK on the stdio transport, can't compute the encrypted siblings). Use the HTTP MCP transport or the web UI instead.

```sh
# Apply per env AFTER the matching code release is live and stable.
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev  -d pf_dev -f scripts/migrate-stream-d-phase4-drop-columns.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod -d pf     -f scripts/migrate-stream-d-phase4-drop-columns.sql
```

**Applied prod + dev: 2026-05-03** (with the code release). Bypassed the migration's `name_ct IS NULL` precondition with an inline force-NULL variant on both envs because all 3 internal users (pathfinder/demo/hussein) had non-backfilled stragglers we accepted as data loss. The committed migration is the canonical reference for any future env that needs the safe (precondition-respecting) version.

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

## investment-cash-backfill-strict (2026-04-30)

One-time backfill prerequisite for the strict-mode investment-holding constraint (issue [#22](https://github.com/finlynq/finlynq/issues/22)). Reassigns every transaction in an `is_investment=true` account that still has `portfolio_holding_id IS NULL` to the per-account 'Cash' holding so the strict-enforcement code in `src/lib/transfer.ts` (`createTransferPair` + `createTransferPairViaSql`) and `src/lib/import-pipeline.ts` can refuse newly unattributed legs without breaking historical rows. Narrower than `migrate-accounts-is-investment.sql`: that one introduced the flag and reassigned `(FK NULL AND legacy text NULL)`; this one targets just `FK NULL` (Phase 6 already dropped the legacy text column on prod). Idempotent. Verifies orphan count = 0 inside the transaction; raises rather than commits a partial state. **Applied to prod + staging + dev on 2026-04-30** (11 Cash sleeves planted per env, 0 orphan reassignments — every existing tx in an investment account was already FK-bound). Run BEFORE deploying the matching code.

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-investment-cash-backfill.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-investment-cash-backfill.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-investment-cash-backfill.sql
```

After each env, hit `GET /api/admin/investment-orphans` and confirm `{ complete: true, orphanCount: 0 }` before pushing the matching code.

## source-tag backfill (optional, per [#33](https://github.com/finlynq/finlynq/issues/33))

Optional one-off backfill for tagging legacy connector imports with `source:<connector>` so future statement-reconciliation dedup can identify them. New imports carry the tag automatically (WP transform + `createTransferPair*`); this script handles only rows that pre-date the rollout.

Per-user, parameterized — each invocation needs a `:user_id`, `:source` slug, comma-separated `:account_ids`, and a `:from_date` / `:to_date` window. Caveat: skips rows whose `transactions.tags` is encrypted (`v1:%`); those need a Node-side rewrite under the user's DEK and are out of scope for the SQL path. The script reports a count of skipped rows.

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod -d pf \
  -v user_id="$UID" -v source='wealthposition' \
  -v account_ids='12,15,18' -v from_date='2024-01-01' -v to_date='2026-04-29' \
  -f scripts/backfill-source-tag.sql
```

Inspect the SELECT preview and the encrypted-skip count, then uncomment `COMMIT;` at the bottom of the script. Idempotent on re-runs (won't double-tag rows that already contain `source:`).

## holding-accounts (2026-04-30)

Adds the `holding_accounts(holding_id, account_id, user_id, qty, cost_basis, is_primary, created_at)` join table — many-to-many between `portfolio_holdings` and `accounts`. Issue [#26](https://github.com/finlynq/finlynq/pull/26) (Section G). The legacy one-to-many `portfolio_holdings.account_id` column stays in place during the issue [#25](https://github.com/finlynq/finlynq/pull/25) (Section F) consumer migration; the row here whose `is_primary=true` mirrors it. Backfills from the existing single-account state — qty + cost_basis are derived from `transactions` (`SUM(quantity)` and `SUM(ABS(amount)) WHERE quantity>0`) so re-running on a fresh env produces the same numbers the aggregator computes today. Idempotent (`CREATE TABLE IF NOT EXISTS`, `ON CONFLICT DO NOTHING`). No DEK required — only ids + numbers, no encrypted columns. **Applied to prod + staging + dev on 2026-04-30** — 75 rows backfilled per env, 75/75 with `is_primary=true`, equal to `COUNT(*) FROM portfolio_holdings WHERE account_id IS NOT NULL`. Migration ran BEFORE the matching code landed on staging/prod (still on `main`); the additive shape made that order safe (the new code reading `holding_accounts` is only on the `dev` branch as of the apply timestamp).

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-holding-accounts.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-holding-accounts.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-holding-accounts.sql
```

**Production-deploy ordering** (when promoting `dev → main`):

1. The migration is already applied on prod + staging (2026-04-30, see above) — re-running is a no-op (`CREATE TABLE IF NOT EXISTS` + `ON CONFLICT DO NOTHING`), so the deploy itself doesn't need a separate migration step.
2. Merge `dev → main`. GitHub Actions builds + SSH-deploys to staging then prod. The new code reads `holding_accounts` for the `/settings/holding-accounts` page + `/api/holding-accounts` endpoint; the table already exists from step (1), so the route renders on first hit.
3. Smoke-test on staging first: open `/settings/holding-accounts`, confirm every existing holding shows up with one `is_primary=true` pairing matching its current `portfolio_holdings.account_id`. Add a second pairing on a test holding, confirm the legacy column stays unchanged. Toggle "Make primary" to the new pairing, confirm `portfolio_holdings.account_id` flips.
4. Repeat the smoke test on prod after the prod deploy completes.
5. The 5 portfolio aggregator callsites + 8 investment-account-constraint callsites in CLAUDE.md still read `portfolio_holdings.account_id` in this release; `holding_accounts` is additive. Issue [#25](https://github.com/finlynq/finlynq/pull/25) (Section F) migrates them onto the join table as a separate PR — that PR is NOT additive, so its deploy will require freshly verifying that the migration's qty + cost_basis backfill matches the aggregator output the moment before code switchover.


## tx-audit-fields (2026-04-30, issue #28)

Adds `transactions.created_at`, `transactions.updated_at`, and `transactions.source` (`text NOT NULL DEFAULT 'manual'` with a CHECK constraint on the seven allowed values: `manual`, `import`, `mcp_http`, `mcp_stdio`, `connector`, `sample_data`, `backup_restore`). All three are system-time / system-attribution facts distinct from the user-supplied `transactions.date`. Maintained at the application layer (no triggers — matches the existing convention; coverage grep is cheap to run). Idempotent. Pre-migration creation time + true source are unrecoverable — backfill sets timestamps to NOW() and source to 'manual'. We deliberately do NOT use `entered_at` as a backfill source because semantics differ (entered_at is FX-settlement input, created_at is system audit). **Applied to prod + staging + dev on 2026-04-30** (column DEFAULTs handled the backfill — UPDATE 0 in the defensive sweep on every env, meaning no rows needed coercion). Run BEFORE the matching code deploy so the new columns exist when `getTransactions` SELECTs them.

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-tx-audit-fields.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-tx-audit-fields.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-tx-audit-fields.sql
```

After each env, smoke-check by inserting any transaction (UI or MCP) and confirming `created_at` / `updated_at` / `source` populate; then edit the same row and confirm `updated_at` advances while `created_at` and `source` stay frozen.

## portfolio-canonical-names (2026-05-01, issue #25)

**Applied to prod + staging + dev on 2026-05-01.**

Schema-only prep for the per-user canonical-name backfill helper at [src/lib/crypto/stream-d-canonicalize-portfolio.ts](../src/lib/crypto/stream-d-canonicalize-portfolio.ts). Adds a single column — `users.portfolio_names_canonicalized_at text` (NULL = needs canonicalization on next login, non-NULL = done). The helper is fired from the login path (sibling to `enqueuePhase3NullIfReady`); on first run it decrypts each `portfolio_holdings` row's name + symbol, classifies tickered / cash-sleeve / currency-code / user-defined, and dual-writes the canonical name + `name_ct` + `name_lookup` for the first three classes. User-defined rows are left alone. DEK-mismatch users (pathfinder per CLAUDE.md "Known open issue: pathfinder DEK mismatch") bail silently at the sample-decrypt precondition — mirrors `nullPlaintextIfReady`'s gate-check pattern. Idempotent (`ADD COLUMN IF NOT EXISTS`). Run BEFORE the matching code deploy so the helper has the column to read/write.

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-portfolio-canonical-names.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-portfolio-canonical-names.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-portfolio-canonical-names.sql
```

After deploy, monitor the helper's progress via the rough check `SELECT COUNT(*) FROM users WHERE portfolio_names_canonicalized_at IS NOT NULL;` — it climbs as users log in. DEK-mismatch users keep `portfolio_names_canonicalized_at` NULL indefinitely (their plaintext fallback still renders the page correctly).

## tx-audit-indexes (2026-04-30, issue #59)

**Applied to prod + staging + dev on 2026-05-01.**

Index-only follow-up to `tx-audit-fields` — adds two composite indexes on the audit-trio columns so the new "Sort by Created / Updated" headers on `/transactions` don't table-scan once a user has 50k+ transactions. `source` is small-cardinality enum (7 values); the existing `(user_id)` index handles equality / IN filters fine, so no index added there. Idempotent. Run BEFORE the matching code deploy so the indexes are present when the new sort headers go live.

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-tx-audit-indexes.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-tx-audit-indexes.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-tx-audit-indexes.sql
```

Verify with `\d+ transactions` — `transactions_user_updated_at_idx` and `transactions_user_created_at_idx` should both appear in the index list.

## tx-29100-holding-reassignment (data fix, 2026-05-01, issue [#81](https://github.com/finlynq/finlynq/issues/81))

One-off **data fix** (no code change, no schema change). Transaction 29100 (a +$10,000 EFT RRSP contribution) was booked by the bank-import pipeline against holding **497** ('Cash' on account 600 Mimi TFSA). It belongs on holding **425** ('TFSA-CAD' on account 614 IBKR TFSA). The fix mutates a single row's `portfolio_holding_id` and bumps `updated_at`; `source` is **deliberately preserved** to honor the CLAUDE.md audit-trio invariant (`transactions.source` is INSERT-only).

**Gate:** holding 425 must already have a `holding_accounts` row matching `(holding_id=425, account_id=<tx 29100's account_id>, user_id=<owner>)`. Per CLAUDE.md, every portfolio aggregator now JOINs through `holding_accounts` on `(holding, account)`; running the UPDATE without that pairing in place silently drops the leg from the aggregator. The pre-state SELECT below catches that and aborts before the UPDATE.

**Cache bust:** raw psql bypasses the MCP per-user tx cache (no `invalidateUser(userId)` call). Bounce the relevant `finlynq-*` systemd unit on each env after the fix lands so Claude reads fresh data on next request.

### Pre-state verification (run on each env before the UPDATE)

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod -d pf <<'SQL'
-- Confirm tx exists, owned by the right user, currently on 497.
SELECT id, user_id, account_id, portfolio_holding_id, amount, payee, source, updated_at
FROM transactions
WHERE id = 29100;

-- Confirm both holdings belong to the same user.
SELECT id, user_id, name, symbol FROM portfolio_holdings WHERE id IN (425, 497);

-- Confirm holding 425 has a holding_accounts row covering the tx's account_id.
-- MUST return exactly 1 row. If 0, STOP — gate on issue #95 (holding_accounts integrity).
SELECT ha.holding_id, ha.account_id, ha.user_id
FROM holding_accounts ha
WHERE ha.holding_id = 425
  AND ha.user_id = (SELECT user_id FROM transactions WHERE id = 29100)
  AND ha.account_id = (SELECT account_id FROM transactions WHERE id = 29100);
SQL
```

### The fix (single-row UPDATE, fully scoped)

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod -d pf <<'SQL'
BEGIN;

UPDATE transactions
SET portfolio_holding_id = 425,
    updated_at = NOW()
    -- source intentionally untouched (INSERT-only audit invariant)
WHERE id = 29100
  AND user_id = (SELECT user_id FROM transactions WHERE id = 29100)
  AND portfolio_holding_id = 497;  -- defensive: only update if still on 497

-- Verify exactly 1 row updated and source unchanged before committing.
SELECT id, portfolio_holding_id, source, updated_at FROM transactions WHERE id = 29100;

COMMIT;
SQL
```

The `user_id = ?` and `portfolio_holding_id = 497` predicates make the statement idempotent and impossible to widen by accident. Re-running after commit returns 0 affected rows.

### Post-state spot-check

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod -d pf <<'SQL'
-- Tx now on 425 with bumped updated_at.
SELECT id, portfolio_holding_id, account_id, source, updated_at
FROM transactions WHERE id = 29100;

-- Holding 497 no longer references tx 29100.
SELECT COUNT(*) FROM transactions
WHERE portfolio_holding_id = 497 AND id = 29100;  -- expect 0.
SQL
```

Then load `/portfolio` (or call MCP `get_portfolio_analysis`) for the IBKR TFSA account and confirm the contribution is now attributed to TFSA-CAD (holding 425) instead of Mimi TFSA Cash (holding 497).

### Per-env rollout

Run the same three blocks (pre-state → fix → post-state) per env, replacing the connection in each:

```sh
# dev
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     ...

# staging
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging ...

# prod
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         ...
```

After the prod fix, restart the prod systemd service (`systemctl restart finlynq-prod` or equivalent) so the MCP per-user tx cache for the affected user is dropped and Claude sees the new attribution.

**Out of scope:** holding 497's separate $72,791 phantom `dividendsReceived` figure — deferred until issue [#84](https://github.com/finlynq/finlynq/issues/84) (`dividendsReceived` aggregator switch from `qty=0` heuristic to category_id match) lands. Auditing other bank-import rows that may have mis-routed onto holding 497 is a separate sweep.

## holding-accounts-backfill-orphans (2026-05-01, issue [#95](https://github.com/finlynq/finlynq/issues/95))

Repair pass for holdings created via MCP `add_portfolio_holding` (HTTP + stdio) before the issue #95 fix. The original code path inserted a `portfolio_holdings` row but never inserted the matching `holding_accounts` pairing — every portfolio aggregator (issue #25) JOINs through `holding_accounts` on `(holding_id, account_id, user_id)`, so any such holding is silently invisible to `get_portfolio_analysis`, `get_portfolio_performance`, and `analyze_holding`. Symptoms: a holding shows up in `/portfolio` but not in MCP analyses; transactions bound to it count toward account balance but the position itself shows no price/qty/cost in the aggregator output.

The script INSERTs `holding_accounts` rows for portfolio holdings missing one, with `is_primary=true`, `qty=0`, `cost_basis=0` (matching the same defaults the original `holding-accounts (2026-04-30)` backfill used — aggregators read live qty/cost from `transactions`). Idempotent (`ON CONFLICT DO NOTHING`). Expected dev impact at minimum 3 rows (ids 539, 540, 541 from the source review). **Not auto-applied by `deploy.sh` per the standing convention** — operator runs per env BEFORE the matching code lands.

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-holding-accounts-backfill-orphans.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-holding-accounts-backfill-orphans.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-holding-accounts-backfill-orphans.sql
```

Post-migration verify with `SELECT COUNT(*) FROM portfolio_holdings ph LEFT JOIN holding_accounts ha ON ha.holding_id = ph.id WHERE ha.holding_id IS NULL;` — expect 0.

**Out of scope:** the wider INSERT-site audit listed in issue #95 (REST `POST /api/portfolio`, REST crypto add, backup-restore, csv-parser, the connector pipeline, `getOrCreateCashHolding`, transfer auto-create, both `record_trade` cash-sleeve auto-create branches). This script repairs existing orphans but every NEW holding from those paths still re-creates the orphan-pairing class until they're each migrated to dual-write. Re-running this script is safe and idempotent.

## holding-accounts-repair-divergence (2026-05-01, issue [#95](https://github.com/finlynq/finlynq/issues/95))

Companion repair pass for the second symptom in the source review: holdings where `holding_accounts.account_id` diverges from `portfolio_holdings.account_id` for the same `holding_id`. Example: holding 428 (VUN.TO) — `holding_accounts.account_id=600` (Mimi TFSA) but `portfolio_holdings.account_id=614` (IBKR TFSA), with every transaction living on 614. The aggregators JOIN on the divergent pair and the leg disappears.

The fix only touches `is_primary=true` rows (the legacy `portfolio_holdings.account_id` mirror). Non-primary rows are intentional multi-account pairings (Section G future use) and must not be modified.

**WARNING — composite-PK collision:** the UPDATE rewrites the `(holding_id, account_id)` PK. If a holding has BOTH a divergent primary row AND a separate non-primary row at the target `ph.account_id`, the UPDATE collides with `23505 unique_violation` and the whole BEGIN block rolls back. The script's step 1b is a pre-check — if it returns any rows, the operator must DELETE the orphan or merge `qty`/`cost_basis` manually before re-running. Run the audit blocks in dev first; expected diff for holding 428 is `ha_account_id=600 -> ph_account_id=614`. **Not auto-applied by `deploy.sh`** — operator runs per env BEFORE the matching code lands.

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-holding-accounts-repair-divergence.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-holding-accounts-repair-divergence.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-holding-accounts-repair-divergence.sql
```

Post-migration verify with `SELECT COUNT(*) FROM holding_accounts ha JOIN portfolio_holdings ph ON ph.id = ha.holding_id WHERE ha.account_id != ph.account_id AND ha.is_primary = true;` — expect 0. Specifically for holding 428: `SELECT ph.account_id, ha.account_id FROM portfolio_holdings ph JOIN holding_accounts ha ON ha.holding_id = ph.id WHERE ph.id = 428;` should return `(614, 614)` post-repair.

## trade-link-id (2026-05-01, issue [#96](https://github.com/finlynq/finlynq/issues/96))

Adds `transactions.trade_link_id text` (nullable) + a partial index on `(user_id, trade_link_id) WHERE trade_link_id IS NOT NULL`. Used by `record_transaction` / `bulk_record_transactions` (HTTP MCP) to group the two legs of a multi-currency stock trade — cash-out leg and stock-in leg — booked as separate transactions. The four cost-basis aggregators (REST `/api/portfolio/overview`, `src/lib/holdings-value.ts`, MCP HTTP `aggregateHoldings` + `analyze_holding`, MCP stdio `get_portfolio_performance` + `analyze_holding`) LEFT JOIN to the cash leg via `trade_link_id` and use its `entered_amount` (in `entered_currency`) as cost basis for the stock leg's holding, instead of the stock leg's amount which uses Finlynq's live FX rate and under-counts the broker's spread. Legacy rows with no `trade_link_id` fall back to the stock leg's amount unchanged. `trade_link_id` is **server-generated only** (mirrors `link_id`'s pattern in `src/lib/transfer.ts:569`) — never accepted as a client-supplied UUID. Distinct from `link_id`, which the four-check transfer-pair rule reserves for `record_transfer` siblings. Idempotent (`IF NOT EXISTS`).

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-trade-link-id.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-trade-link-id.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-trade-link-id.sql
```

Post-migration verify with `SELECT column_name FROM information_schema.columns WHERE table_name='transactions' AND column_name='trade_link_id';` — expect 1 row. The aggregator LEFT JOIN is forward-compatible (no rows match until a writer stamps a UUID), so the code path is safe to deploy *before* any user has used the new `tradeGroupKey` parameter — pre-existing data routes through the fallback branch unchanged.

## mcp-idempotency-keys (2026-05-01, issue [#98](https://github.com/finlynq/finlynq/issues/98))

Adds `mcp_idempotency_keys` — a new table backing caller-supplied retry safety for `bulk_record_transactions` (HTTP + stdio MCP). Schema: `(id SERIAL, user_id TEXT, key UUID, tool_name TEXT, response_json JSONB, created_at TIMESTAMPTZ DEFAULT NOW())` plus `UNIQUE (user_id, key)` + `(created_at)` btree index for the 72h sweep. The unique index spans the **pair**, not the key alone — Alice's UUID K and Bob's UUID K are independent batches, never collide. Idempotent (`CREATE TABLE IF NOT EXISTS` / `CREATE [UNIQUE] INDEX IF NOT EXISTS`).

The HTTP and stdio handlers in `bulk_record_transactions` look up `(user_id, key, tool_name='bulk_record_transactions', created_at > NOW() - INTERVAL '72 hours')` BEFORE any account/category/holdings prefetch — a hit returns the stored `response_json` verbatim, no INSERTs into `transactions`, no `invalidateUserTxCache` call. After a successful (non-dryRun, ok>0) batch they store the redacted response (plaintext payee stripped from per-row `message`, account/category names replaced with `[redacted]` — `transactionId`, `resolvedAccount.id`, `resolvedCategory.id` preserved). `ON CONFLICT (user_id, key) DO NOTHING` closes the concurrent-retry race.

A daily cron in [src/lib/cron/sweep-mcp-idempotency.ts](../src/lib/cron/sweep-mcp-idempotency.ts) wired in `instrumentation.ts` deletes rows older than 72h. The replay lookup also filters on freshness, so the cron is purely a table-growth bound.

```sh
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-mcp-idempotency.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-mcp-idempotency.sql
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-mcp-idempotency.sql
```

Post-migration verify with `\d mcp_idempotency_keys` (table + indexes present) and a smoke check from the app: pass an `idempotencyKey` UUID to `bulk_record_transactions`, confirm the rows commit, then call again with the same `(user, key)` and confirm `imported: 0`-equivalent replay (stored `response_json` returned with `replayed: true` appended). The retry path leaves `transactions.created_at` / `updated_at` untouched on the original rows — replay never re-enters the writer.

**Out of scope:** idempotency for other write tools (`record_transaction`, `update_transaction`, `delete_transaction`, `record_trade`, `record_transfer`). Those are lower volume / lower retry risk; revisit only after we see whether callers actually pass keys here.
