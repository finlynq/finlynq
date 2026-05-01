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
