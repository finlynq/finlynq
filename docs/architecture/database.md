# Database & identity architecture

PostgreSQL + Drizzle ORM, the DB proxy pattern, MCP pg-compat shim, identity model. Pulled out of CLAUDE.md on 2026-04-28.

## PostgreSQL-only

All SQLite code has been removed. Database is PostgreSQL via `pg.Pool` + Drizzle ORM. The `DATABASE_URL` or `PF_DATABASE_URL` env var (PF_DATABASE_URL takes precedence) activates PostgreSQL mode via [instrumentation.ts](../../instrumentation.ts) on server startup.

22 tables in [src/db/schema-pg.ts](../../src/db/schema-pg.ts).

## DB proxy pattern

[src/db/index.ts](../../src/db/index.ts) exports a `db` Proxy that lazily delegates to the PostgresAdapter. The `wrapPgBuilder()` function adds `.all()`, `.get()`, `.run()` methods to Drizzle PG query builders for backward compatibility with old SQLite-style call sites.

- [src/db/adapters/postgres.ts](../../src/db/adapters/postgres.ts) — `PostgresAdapter` (pg.Pool + Drizzle init)
- [src/db/connection.ts](../../src/db/connection.ts) — backward-compat stubs (PostgreSQL-only mode)
- [src/db/pg-shim.ts](../../src/db/pg-shim.ts) — patches Drizzle PG query builders with `.get/.all/.run`

## MCP pg-compat layer

[mcp-server/pg-compat.ts](../../mcp-server/pg-compat.ts) provides a SQLite-like `prepare(sql).all()/get()/run()` API backed by `pg.Pool`. Automatically translates:
- `?` → `$N` placeholders
- `strftime()` → `to_char()`
- `IFNULL` → `COALESCE`
- `GROUP_CONCAT` → `STRING_AGG`

This avoids rewriting 1700+ lines of raw SQL in MCP tools.

**Footgun:** the pg-compat `transaction()` helper acquires a fresh pool client for each inner `prepare()` call. If you need a true single-connection transaction (e.g. atomic dual-INSERT with locks), go through `pool.connect()` directly. The transfer-pair `*ViaSql` helpers in [src/lib/transfer.ts](../../src/lib/transfer.ts) sidestep this for the same reason.

## HMR resilience

DB adapter and Drizzle instance stored on `globalThis` (`__pfAdapter`, `__pfDrizzle`) so they survive Next.js hot module reloads in dev. Same pattern for the MCP per-user tx cache (`__pfTxCache`) — see [mcp.md](mcp.md).

## Multi-user mode

PostgreSQL with per-user isolation at the query level. Admin role controls access to admin-only nav items.

Stdio MCP isolation is enforced via the `PF_USER_ID` env var (not session auth, since stdio has no HTTP layer) — see [mcp.md](mcp.md).

## Identity model — username primary, email recovery-only

Shipped 2026-04-26. Account login is keyed on `users.username` (required at signup, 3–254 chars, `[a-z0-9._@+_-]`, lowercased + case-insensitive unique via partial index on `lower(username)`).

The character class intentionally allows `@` and `.` so an email-shaped string is a valid username — privacy-conscious users can register with `cool.dragon@madeup.fake` to avoid leaking a real email if the DB is compromised.

Email is optional; when present it's the password-reset / verification mail destination, otherwise the account is fully zero-knowledge (forgot password = wipe + rewrap, no recovery key — same policy that's existed since the AGPL pivot).

`/api/auth/login` accepts a single `identifier` field (username OR email) and `getUserByIdentifier` always tries the username column first, falling back to email — the cross-column collision rule enforced at signup (`isIdentifierClaimed` in [src/lib/auth/queries.ts](../../src/lib/auth/queries.ts)) guarantees a single string can match at most one user.

Reserved bare-handle list (admin/support/import-/...) blocks new signups from claiming routing-conflicting names; doesn't apply when the username contains `@`.

JWT no longer carries the email claim — `sub` (userId) is the source of truth and identity fields are looked up fresh from the DB on every session read.

- Validator: [src/lib/auth/username.ts](../../src/lib/auth/username.ts)
- UI: `/cloud` ([src/app/cloud/page.tsx](../../src/app/cloud/page.tsx))
- Live availability check: `/api/auth/username-check`

Migration: [scripts/migrate-username.sql](../../scripts/migrate-username.sql).

## Session/identity endpoint

`GET /api/auth/session` is the single source of truth for "who am I, what can I see." Returns:

```ts
{
  authenticated: boolean,
  method: string,
  authMethod: string,
  userId: string,
  mfaVerified: boolean,
  onboardingComplete: boolean,
  isAdmin: boolean,
  username: string,
  email: string | null,
  displayName: string | null,
  displayCurrency: string,
}
```

`isAdmin` is derived from `users.role === 'admin'` in managed mode (PostgreSQL); always `false` in self-hosted.

The nav ([src/components/nav.tsx](../../src/components/nav.tsx)) and OAuth authorize page ([src/app/oauth/authorize/page.tsx](../../src/app/oauth/authorize/page.tsx)) both consume this.

**Do not reintroduce `/api/auth/unlock`** — it was removed in `db9fd75` (SQLite purge) and any new caller should hit `/api/auth/session` instead.

## Drizzle config — `db:push` runs the PostgreSQL config

The default `npm run db:push` script points at `drizzle-pg.config.ts`. The SQLite config is a pre-open-source-pivot artifact — don't route deploys through it. `deploy.sh` invokes `npm run db:push` as part of every prod deploy.

## Lockfile gotcha (Linux vs Windows)

`package-lock.json` must be regenerated on Linux, not Windows. `npm install` on Windows omits Linux-specific optional deps (`@emnapi/runtime`, `esbuild` linux builds) and CI's `npm ci` rejects the result with `Missing: @emnapi/runtime from lock file`.

If the lockfile needs an update, run `npm install` on the deploy host (or any Linux box) and commit that version.

Also keep ownership clean on the deploy host: if you ever run `sudo npm install` there, chown the tree back to `paperclip-agent:paperclip-agent` afterwards or the next `deploy.sh` will EACCES.

**Symptom when violated:** the dev host's `git pull` aborts with `error: Your local changes to the following files would be overwritten by merge: package-lock.json`. Fix is `git checkout -- package-lock.json` on the host before pulling; `npm install` on the host afterward will re-add the Linux deps.

## Schema migrations are NOT part of `npm run build`

Run them per environment BEFORE pushing the matching code change. See [migrations.md](../migrations.md) for the full chronological psql playbook.

All `ALTER TABLE` statements are written idempotent (`ADD COLUMN IF NOT EXISTS` / `DROP COLUMN IF EXISTS`). Safe to re-run.

## `transactions.tags` — vocabulary and reserved prefixes

`transactions.tags` is a **comma-separated string of free-text labels**. The same column is used for user-applied tags ("morning", "work") and a small set of system-applied tags with reserved prefixes:

| Prefix | Meaning | Set by | Notes |
|---|---|---|---|
| `source:<format>` | File / wire format the row arrived as | All import paths (issue [#62](https://github.com/finlynq/finlynq/issues/62)) | One per row at most. Allowed values: `csv`, `excel`, `pdf`, `ofx`, `qfx`, `ibkr-xml`, `email`. Canonical list in [`src/lib/tx-source.ts`](../../src/lib/tx-source.ts) (`FORMAT_TAGS`). |
| `trade-link:<linkId>` | Links a fee row to its parent trade | `record_trade` MCP tool | Orthogonal to `source:`. |
| `ibkr:fx-conversion`, `ibkr:fx-translation`, `ibkr:asset:<class>` | Descriptive metadata from IBKR Flex | `transformIbkrFile` | Carries semantic info about the entry kind, not provenance. Stays alongside the format tag. |

Rules:

- The system never modifies the user-applied free-text tags on a row — system tags are merged in via `applySourceTag` / `withSourceTag`, which preserve the existing list.
- Tag matching is **case-insensitive** for idempotency. Re-importing the same file does not duplicate `source:csv`.
- The `source:<format>` tag is **distinct** from the audit-column `transactions.source` enum (`manual` / `import` / `mcp_http` / …). The audit column captures the writer surface (issue #28); the tag captures file shape. A WP-orchestrated CSV import has `source='connector'` in the audit column and `source:csv` in the tag — both pieces of information are preserved.
- On Stream-D-encrypted deployments `tags` may live as ciphertext (`v1:%`). SQL-only backfills must skip those rows; see [`scripts/backfill-source-tag.sql`](../../scripts/backfill-source-tag.sql).

## `staged_imports` — parser knobs (FINLYNQ-54)

The unified-ingest staging tables (`staged_imports` + `staged_transactions`, see CLAUDE.md "Unified-ingest staging pipeline") carry per-statement parser configuration that the upload UI surfaces in its "Import options" panel and the F-53E merge flow reads back. Four columns added 2026-05-20 by [`scripts/migrations/20260520_finlynq-54-parser-knobs.sql`](../../scripts/migrations/20260520_finlynq-54-parser-knobs.sql):

| Column | Type | Default | Meaning |
|---|---|---|---|
| `skip_header_rows` | `INTEGER NOT NULL` | `0` | Raw lines stripped off the top of the CSV before header detection (EU/ME bank exports often prepend title/metadata rows). Bounded by `CHECK (>= 0)`. |
| `skip_footer_rows` | `INTEGER NOT NULL` | `0` | Raw lines stripped off the bottom (summary/total rows). Bounded by `CHECK (>= 0)`. |
| `date_format_override` | `TEXT` | `NULL` | One of `'DD/MM/YYYY'` / `'MM/DD/YYYY'` / `'YYYY-MM-DD'` when set; `NULL` = parser auto-detect. Short-circuits the day-vs-month inference in `normalizeDate()`. Bounded by enum `CHECK`. |
| `default_currency` | `TEXT` | `NULL` | ISO 4217 fallback applied to rows missing a `currency` / `entered_currency`. Validated against `supportedCurrencyEnum` at the API layer. |

`bound_account_id` (added in `20260506_staging_unified_columns.sql`) is the fifth knob (default account) and was already present — FINLYNQ-54 only unified the UX into the same panel; the column was unchanged. Defaults preserve pre-FINLYNQ-54 behavior, so existing uploads that don't open the options panel are unaffected. `import_hash` is **not** recomputed when these knobs are toggled (load-bearing — dedup must stay stable across re-runs).

## `staged_transactions` reconciliation columns + `transaction_reconciliation_flags` (FINLYNQ-55)

Schema scaffolding for the two-pane reconciliation UI (F-53C) ahead of the UI itself. Two additive columns on `staged_transactions` + one new table, all delivered 2026-05-20 by [`scripts/migrations/20260520_finlynq-55-reconcile-state.sql`](../../scripts/migrations/20260520_finlynq-55-reconcile-state.sql):

| Column on `staged_transactions` | Type | Default | Meaning |
|---|---|---|---|
| `reconcile_state` | `TEXT NOT NULL` | `'unmatched'` | One of `'unmatched'` / `'auto_suggested'` / `'linked'` / `'skipped_duplicate'`. The file-side row's reconciliation decision. `CHECK` over the four values. `'flagged_missing'` is **not** a value here — DB-side flags live on `transaction_reconciliation_flags` (different lifecycle: staging rows are ephemeral, flags persist past approval). |
| `linked_transaction_id` | `INTEGER NULL` | `NULL` | FK into `transactions(id)` (which is `serial(integer)`, hence integer here). Set when the user manually links a file row to an existing DB row. `ON DELETE SET NULL` — a transaction wipe doesn't cascade into staging rows the user may want to re-link. |

The new `transaction_reconciliation_flags` table carries the DB-side annotations:

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PRIMARY KEY` | |
| `transaction_id` | `INTEGER NOT NULL` | `REFERENCES transactions(id) ON DELETE CASCADE`. |
| `user_id` | `TEXT NOT NULL` | `REFERENCES users(id) ON DELETE CASCADE` — wipe-account cleans up flags via the cascade without the wipe endpoint needing to know about the table. |
| `flag_kind` | `TEXT NOT NULL` | `CHECK (flag_kind IN ('missing_from_statement'))` for now. Future kinds widen the CHECK in a follow-up migration. |
| `note` | `TEXT NULL` | Optional user-supplied annotation. |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | |

Index on `(user_id, transaction_id)` — covers the per-user-per-tx prefix probe the reconciliation pane runs as it iterates rows.

Why the separate table: a flag's lifecycle is distinct from any column on `transactions` (added, removed, can carry a note, independent of any column on the parent row), and keeping it out of the hot `transactions` table avoids touching every aggregator with a fresh `is_flagged` predicate. Per the FINLYNQ-55 issue body, the alternative of adding `reconcile_state='flagged_missing'` to staging rows was rejected — staging rows are ephemeral (deleted on approve/reject/expire) and flags need to outlive the staging row.

Backup-restore (`/api/data/import` `strip()`) gained a `transactionIdMap` remap arg in the same change. Pre-migration backups (column absent) fall back to the column default `'unmatched'` / `NULL`. The `transaction_reconciliation_flags` rows aren't in the backup format today — that's a separate decision (the table's contents are user-curated annotations on DB-side rows; if/when included they'd remap via the same `transactionIdMap`).

### Reader / writer routes (FINLYNQ-56)

> Living feature doc for the `/import/pending` two-pane reconciliation surface is at [`pf-app/docs/reconciliation.md`](../reconciliation.md) — what's shipped, components, load-bearing rules, roadmap. This subsection is the schema-side companion.

The two-pane reconciliation UI on `/import/pending` reads + writes these columns through three endpoints:

- **PATCH [`/api/import/staged/[id]/rows/[rowId]`](../../src/app/api/import/staged/%5Bid%5D/rows/%5BrowId%5D/route.ts)** — accepts optional `reconcileState` + `linkedTransactionId` fields. Cross-tenant `linkedTransactionId` returns 404 (never 403 — no existence disclosure). State `'linked'` requires a non-null `linkedTransactionId`; non-`'linked'` state forces it to null on write. `import_hash` and `encryption_tier` are NEVER touched by this PATCH. Half-pair transfer rule is enforced at APPROVE time, not PATCH (two sequential PATCHes for paired legs would deadlock on post-state validation; the approve-side classifier already handles it).
- **GET [`/api/transactions/reconciliation`](../../src/app/api/transactions/reconciliation/route.ts)** — `?accountId=&from=&to=` returns decoded `transactions` rows for the left pane. `requireEncryption()` (no soft-fallback — the user is mid-import so they already have a DEK; decoded names are part of the reconcile contract). Each row carries `linkedStagedRowId` (back-reference computed via LEFT JOIN on `staged_transactions.linked_transaction_id`) and `reconciliationFlag` (most-recent `transaction_reconciliation_flags` row, or null).
- **POST / DELETE [`/api/transactions/[id]/reconciliation-flag`](../../src/app/api/transactions/%5Bid%5D/reconciliation-flag/route.ts)** — `POST { flag_kind: 'missing_from_statement', note? }` inserts a row; DELETE is fully idempotent (200 with `data: { removed: 0 }` on second call). Both `requireEncryption()` for surface uniformity (the table itself is plaintext but the flag intent is gated behind a logged-in DEK-equipped session). Cross-tenant 404 on the parent `transactions` row.

The approve endpoint at [`/api/import/staged/[id]/approve`](../../src/app/api/import/staged/%5Bid%5D/approve/route.ts) gained a new bucket: rows where `reconcile_state='linked'` are de-queued at cleanup (DELETED from `staged_transactions`) without an INSERT into `transactions` — the live row already exists. Response shape gains a `linked: <count>` field alongside `imported`. Half-pair transfer rule extended to this bucket via `code: 'half_pair_link'`.

## `staged_imports.date_range_*` + `idx_transactions_user_import_hash` (FINLYNQ-58)

F-53E foundations for the overlap-merge prompt + already-imported marker, delivered 2026-05-20 by [`scripts/migrations/20260520_finlynq-58-date-range-and-import-hash-index.sql`](../../scripts/migrations/20260520_finlynq-58-date-range-and-import-hash-index.sql):

| Addition | Type | Meaning |
|---|---|---|
| `staged_imports.date_range_start` | `TEXT NULL` (YYYY-MM-DD) | Min of the parsed transaction-row dates. Drives the overlap-detection predicate `lte(existing.date_range_start, new.date_range_end) AND gte(existing.date_range_end, new.date_range_start)`. Distinct from `statement_period_start` (which mirrors the file's declared period, e.g. OFX `<DTSTART>`) — `date_range_*` reflects the actual rows landed in `staged_transactions` and is therefore the truthful comparator. Today both columns are populated identically (min/max row date); the split keeps the door open for divergence. Pre-FINLYNQ-58 rows take NULL — overlap detection skips them cleanly (no overlap can be computed). |
| `staged_imports.date_range_end` | `TEXT NULL` (YYYY-MM-DD) | Max of the parsed transaction-row dates. Pairs with `date_range_start`. |
| `idx_transactions_user_import_hash` | partial composite index | `ON transactions (user_id, import_hash) WHERE import_hash IS NOT NULL`. Powers the per-upload "already-imported" probe in `POST /api/import/staging/upload`, which probes ~100–1000 hashes per batch against the full user history. Composite `(user_id, import_hash)` because every probe is user-scoped (cross-tenant guard); partial-NULL exclusion makes the index ~½ the size when many transactions have NULL import_hash (manual entries, restored-from-backup rows). |

The two flows that depend on these:

1. **Overlap-merge prompt.** First-pass upload returns `{ success: true, data: { mergeCandidate: ... } }` without inserting when an existing pending row matches; client re-fires with `action=merge` + `mergeIntoStagedImportId=<id>` (appends) or `action=new` (bypasses). Merge widens the target's `date_range_*` to encompass appended rows; drops in-batch `import_hash` collisions silently. Load-bearing: import_hash is NOT recomputed on merge; the existing `staged_imports.created_at` + parser knobs are NOT mutated; cross-tenant merge (`WHERE id = ? AND user_id = ?`) returns 404 with no information leak; merge into `status != 'pending'` returns 409.

2. **Already-imported marker.** Per-row probe against `transactions.import_hash` for the same user; hits set `staged_transactions.reconcile_state = 'skipped_duplicate'` at INSERT (the same column added by FINLYNQ-55). Approve endpoint default-excludes `'skipped_duplicate'` rows when `rowIds` is omitted; the marker is set ONLY at INSERT — row PATCH preserves the existing value and the user can manually re-check to override (the approve endpoint honors the explicit `rowIds` list verbatim).

## `webhooks` + `webhook_deliveries` (FINLYNQ-60)

Schema foundation for the v1 webhook delivery surface — first sub-item of the FINLYNQ-43 decomposition (F-43A). The vocabulary contract lives in [`webhook-events.md`](webhook-events.md); the worker (FINLYNQ-61 / F-43B), the tx-write wiring (FINLYNQ-62 / F-43C), and the settings UI (FINLYNQ-63 / F-43D) all depend on these two tables but ship separately. Migration: [`scripts/migrations/20260520_finlynq-60-webhooks.sql`](../../scripts/migrations/20260520_finlynq-60-webhooks.sql) (additive, idempotent, auto-applied by `deploy.sh` via the `schema_migrations` tracker).

| Column on `webhooks` | Type | Default | Meaning |
|---|---|---|---|
| `id` | `UUID PRIMARY KEY` | `gen_random_uuid()` | PG 13+ built-in; no `pgcrypto` extension needed. |
| `user_id` | `TEXT NOT NULL` | — | `REFERENCES users(id) ON DELETE CASCADE`. Type matches `users.id` (`text`, UUID-as-text). Cascade is load-bearing for the wipe-account flow. |
| `url` | `TEXT NOT NULL` | — | Delivery URL — user-controlled. |
| `secret` | `TEXT NOT NULL` | — | Random ≥32-char hex, server-generated on insert, NEVER accepted from client. **Plaintext on purpose** — the delivery worker fires async from background jobs (cron, retry queue) where the user DEK isn't in scope. The secret is a row-scoped HMAC key, not user-derived data; rotation is via revoke-and-recreate. Storing under user DEK would break the worker. Do NOT add a `name_ct` sibling here. |
| `event_filter` | `TEXT[] NOT NULL` | — | Closed v1 event list. `CHECK (array_length(event_filter, 1) > 0 AND event_filter <@ ARRAY['transaction.created', 'transaction.updated', 'transaction.deleted', 'transfer.created', 'import.approved'])` — every element must be in the v1 set, and an empty filter is rejected. Adding a new event in v1 requires a follow-up migration widening this CHECK and the matching `webhook_deliveries.event` CHECK. |
| `created_at` | `TIMESTAMPTZ NOT NULL` | `NOW()` | |
| `last_failed_at` | `TIMESTAMPTZ NULL` | `NULL` | Surfaced as a warning dot on the settings UI after a delivery's retry budget runs out (3 attempts at 1m/5m/25m per `webhook-events.md`). |

| Column on `webhook_deliveries` | Type | Default | Meaning |
|---|---|---|---|
| `id` | `UUID PRIMARY KEY` | `gen_random_uuid()` | |
| `webhook_id` | `UUID NOT NULL` | — | `REFERENCES webhooks(id) ON DELETE CASCADE` — revoking a webhook cleans up its delivery history without the revoke endpoint touching this table. |
| `event` | `TEXT NOT NULL` | — | `CHECK (event IN (<v1 list>))`. The list MUST mirror the `webhooks.event_filter` element CHECK; drift between the two or vs. `webhook-events.md` is a contract breach. |
| `payload_hash` | `TEXT NOT NULL` | — | SHA-256 hex of the raw request body bytes (NOT the HMAC signature). Lets the UI display a delivery fingerprint without storing the body itself (the "no PII in webhook payloads" rule applies to anything persisted alongside the row). |
| `status_code` | `INTEGER NULL` | `NULL` | `NULL` = enqueued, not-yet-attempted. `2xx` = success. Negative sentinel (`-1`) = exhausted retries per the retry policy in `webhook-events.md`. |
| `attempted_at` | `TIMESTAMPTZ NOT NULL` | `NOW()` | |

Indexes:

| Index | Purpose |
|---|---|
| `idx_webhooks_user_id` | List-all-webhooks-for-user. |
| `idx_webhooks_user_id_created_at_desc` | Settings UI "recent first" sort. |
| `idx_webhook_deliveries_webhook_id_attempted_at_desc` | Per-webhook "recent deliveries" pane in the settings UI. |

FK cascades summary: `webhooks.user_id → users(id) ON DELETE CASCADE` AND `webhook_deliveries.webhook_id → webhooks(id) ON DELETE CASCADE`. Both are load-bearing for the wipe-account flow (CLAUDE.md "Wipe-account is single-transaction + user_id-only filters") — deleting a user cascades through `webhooks` into `webhook_deliveries` automatically, no orphans.

Strict scope of FINLYNQ-60: schema only. No worker code (FINLYNQ-61), no tx-write callsite wiring (FINLYNQ-62), no UI page (FINLYNQ-63), no MCP tools — those land in their own sub-items.
