# Encryption architecture

End-to-end envelope encryption for sensitive text columns. Pulled out of CLAUDE.md on 2026-04-28 to keep the load-bearing rules in one searchable file. The original design doc lives at [Research/encryption-architecture.md](../../../Research/encryption-architecture.md); this is the operational reference.

## Envelope encryption (Phase 2 + Phase 3)

Live on prod since 2026-04-22 (commits `fa79dee` → `8dea14e`). Sensitive text columns are encrypted at rest with AES-256-GCM using a per-user DEK; amounts, dates, and FKs stay plaintext so MCP aggregations work server-side.

**Encrypted fields** (see [src/lib/crypto/encrypted-columns.ts](../../src/lib/crypto/encrypted-columns.ts)):
- `transactions.payee`, `note`, `tags` (`TX_ENCRYPTED_FIELDS`). `portfolio_holding` was retired 2026-04-29 (Phase 5 + 6); the FK `portfolio_holding_id` is now the sole source of truth.
- `transaction_splits.note`, `description`, `tags` (`SPLIT_ENCRYPTED_FIELDS`)
- `accounts.name`, `categories.name`, `goals.name`, `loans.name`, `subscriptions.name`, `portfolio_holdings.name` + `symbol` + `accounts.alias` — all migrated 2026-04-24 in Stream D via parallel `(name_ct, name_lookup)` columns

**Key hierarchy:**
- User password → scrypt KDF → KEK (in memory only, discarded after wrap/unwrap)
- KEK wraps the per-user DEK; wrapped DEK stored in `users.dek_wrapped`
- DEK lives in an in-memory cache keyed by JWT `jti` (TTL = session TTL, plus a 2h sliding idle window)
- AES-256-GCM with random IV per row encrypts each field; `v1:` prefix marks ciphertext

**Primitives:**
- [src/lib/crypto/envelope.ts](../../src/lib/crypto/envelope.ts) — scrypt KDF, AES-GCM wrap/unwrap, field encrypt/decrypt with `v1:` prefix and legacy-plaintext passthrough
- [src/lib/crypto/dek-cache.ts](../../src/lib/crypto/dek-cache.ts) — session-keyed cache with sliding idle window
- [src/lib/crypto/encrypted-columns.ts](../../src/lib/crypto/encrypted-columns.ts) — Drizzle column helpers
- [src/lib/crypto/staging-envelope.ts](../../src/lib/crypto/staging-envelope.ts) — `PF_STAGING_KEY`-wrapped envelope for the email-import staging window
- [src/lib/crypto/file-envelope.ts](../../src/lib/crypto/file-envelope.ts) — `v1\0`-prefixed disk envelope for MCP uploads

## Read vs write auth guards

**Important distinction.** Misapplying these is the single most common encryption-adjacent regression.

**Writes** that store encrypted data use `requireEncryption()` (returns 423 if no DEK). Silently writing plaintext into a DB that's supposed to be encrypted is worse than blocking the write. Covers:
- `/api/transactions` POST/PUT
- `/api/transactions/bulk` (update_note/payee/tags)
- `/api/transactions/splits` POST
- `/api/transactions/transfer` POST/PUT/DELETE
- `/api/data/import`, `/api/import/execute`, `/api/import/backfill`, `/api/import/email-config`
- `/api/auth/wipe-account`
- `/api/settings/api-key` POST
- MCP HTTP `record_transaction` / `bulk_record_transactions` / `update_transaction` / `record_transfer` / `update_transfer` / `delete_transfer`

**Reads** use `requireAuth()` + `getDEK(sessionId)` (nullable DEK passed down). Decrypt helpers (`decryptTxRows`, `decryptSplitRows`, `decryptField`) short-circuit when DEK is null — rows pass through unchanged, so encrypted rows surface as `v1:...` ciphertext rather than 423-ing the whole page. Legacy plaintext rows always work. This matters because the in-memory DEK cache is wiped on every deploy restart; a hard 423 on read would block every logged-in user until they re-log in. Covers:
- `/api/dashboard`, `/api/recap`, `/api/recurring`, `/api/forecast`
- `/api/portfolio/overview`, `/api/transactions` GET, `/api/transactions/splits` GET
- `/api/transactions/suggest`, `/api/insights`, `/api/chat`
- `/api/data/export`, `/api/settings/api-key` GET

The original Phase 3 deploy used `requireEncryption()` on read routes and 423'd every logged-in session after the deploy restart. Hotfix chain `4531988` → `35b79c5` rewrote reads to the nullable-DEK pattern.

## Auth-tag failure resilience

A null DEK from cache is one failure mode. A *valid DEK that doesn't match the row's ciphertext* is another. AES-GCM throws `Unsupported state or unable to authenticate data` from `Decipheriv.final()` and would otherwise 500 every read for the affected user. All read paths now soft-fall-back instead of throwing.

Shipped 2026-04-27 in commits `152e4e6` + `b45c9cf` + `efd7de2`.

- **`decryptName`, `decryptTxRow`, `decryptSplitRow`** in [src/lib/crypto/encrypted-columns.ts](../../src/lib/crypto/encrypted-columns.ts) wrap their `decryptField` calls in `try/catch`. On failure they log a single `[envelope] decryptName failed; falling back to plaintext` warn line (single, not per-row spam — log dedup is left to journald) and return the dual-write plaintext column when present, or the raw `v1:...` ciphertext as a UI marker.
- **`tryDecryptField(dek, value, context?)`** in [src/lib/crypto/envelope.ts](../../src/lib/crypto/envelope.ts) is the helper for direct-decrypt call sites. Returns `null` on auth-tag failure (NOT the raw ciphertext — see footgun below) so callers can use the standard `tryDecryptField(dek, ct, "label") ?? plaintextFallback` pattern. Used by:
  - [import-pipeline.buildLookups](../../src/lib/import-pipeline.ts)
  - `/api/forecast`, `/api/recurring`, `/api/insights`, `/api/transactions/suggest`, `/api/data/export`
  - [holdings-value.ts](../../src/lib/holdings-value.ts), [weekly-recap.ts](../../src/lib/weekly-recap.ts) (5 sites)
  - [external-import/credentials.ts](../../src/lib/external-import/credentials.ts)
- **Strict `decryptField` stays for write paths** where silent fallback would mask real bugs (e.g. the import pipeline's `import_hash` generation, OAuth token unwrap, MFA secret decrypt). Don't replace it everywhere — the soft fallback is for read paths that have a usable plaintext column or where a UI marker beats 500ing the whole page.

### Footgun — `tryDecryptField` MUST return null on failure

Never return the raw ciphertext on decrypt failure. The first iteration of the helper returned `value` on failure to "preserve a marker." That broke every `?? plaintext` fallback at the call sites — `"v1:..."` is truthy, so `??` skipped the fallback and the import preview keyed `accountMap` on ciphertext, producing 6409 false-negative "Unknown account" errors for an affected user.

**Lesson:** never return a truthy "marker" value when the caller's fallback chain depends on null/undefined. If a caller wants a UI marker, it can write `tryDecryptField(...) ?? value`.

### Categories endpoint wrapper

`/api/categories` GET got a `try/catch + logApiError + safeErrorMessage` wrapper to match the `/api/accounts` pattern. Was returning empty 500 bodies that triggered "Unexpected end of JSON input" on the client. Apply the same wrapper to any new route that calls `decryptNamedRows`.

### Known open issue — pathfinder DEK mismatch

User `6c4f164a-…` has 38 accounts / 50 categories / 60 portfolio_holdings whose `name_ct` columns can't be decrypted with the current cached DEK. `encryption_v=1`, `kek_salt`/`dek_wrapped` lengths look correct, login successfully unwraps the DEK 5+ times, `PF_PEPPER` hasn't rotated. Root cause is unidentified. Follow-up: [routine `trig_01WY3vqzqWgxqf8hQ4Bx4hJ5`](https://claude.ai/code/routines/trig_01WY3vqzqWgxqf8hQ4Bx4hJ5) will deploy short-lived `PF_CRYPTO_DEBUG=1` DEK-fingerprint logging to compare login-time vs decrypt-time DEKs. Until then the soft-fallback layer keeps the user's app working off the dual-written plaintext columns.

## Invariants — do not violate

### `import_hash` always over plaintext

`generateImportHash` in [src/lib/import-hash.ts](../../src/lib/import-hash.ts) MUST always see plaintext payee. AES-GCM uses a random IV so ciphertext hashes are non-deterministic and dedup would break. `/api/import/backfill` decrypts before hashing existing rows.

### Auto-categorize rule schema — NO `match_payee` column

The schema is `(match_field, match_type, match_value)` — there is NO `match_payee` column (hasn't been for a long time; an older form referenced one and broke every MCP `record_transaction` call when an active rule existed; fix shipped in commit [`7d70677`](https://github.com/finlynq/finlynq/commit/7d70677)).

Both [src/app/api/transactions/suggest/route.ts](../../src/app/api/transactions/suggest/route.ts) and the MCP HTTP `autoCategory` helper now SQL-filter on `match_field='payee' AND is_active=1 AND assign_category_id IS NOT NULL`, then iterate in memory in priority order to apply `contains` / `exact` / `regex` semantics — same as [src/lib/auto-categorize.ts](../../src/lib/auto-categorize.ts).

The historical-frequency fallback (payee-equality against existing rows) also runs in memory after decryption when a DEK is present.

**Other MCP rule-management tools** (`apply_rules_to_uncategorized`, `create_rule`, `list_rules`, `update_rule` HTTP + stdio versions) all reference `match_payee` similarly and are similarly broken — pre-existing, no regression — needs a parallel migration in a follow-up sweep.

### Portfolio aggregation — `qty>0` is a buy regardless of amount sign

Finlynq-native data records a buy as `amt<0 + qty>0` (paid cash, got shares); the WP ZIP importer records it as `amt>0 + qty>0` (WP's "position balance grew by X" convention). The aggregator tolerates both.

**Every aggregator must implement the same rule** — keying on `amt<0` instead of `qty>0` silently drops every WP-imported holding leg (root cause of a 2026-04-27 prod symptom where the web Portfolio page showed `Uniswap = 1.2606` shares but MCP `analyze_holding` returned `0`; fix in commit [`8046b9b`](https://github.com/finlynq/finlynq/commit/8046b9b)).

Four implementations to keep in sync (all four `INNER JOIN holding_accounts` as of issue #25 / 2026-05-01):
- [/api/portfolio/overview/route.ts](../../src/app/api/portfolio/overview/route.ts) (FK SQL CASE, canonical)
- MCP HTTP [register-tools-pg.ts](../../mcp-server/register-tools-pg.ts) `accumulate()` + `analyze_holding` loop + `recentTransactions[].type` label
- [src/lib/holdings-value.ts](../../src/lib/holdings-value.ts) FK SQL CASE
- MCP stdio [register-core-tools.ts](../../mcp-server/register-core-tools.ts) `get_portfolio_analysis` + `get_portfolio_performance` + `analyze_holding` loop

### Portfolio aggregation — dividends are matched by `category_id`, not by qty/amount sign

Issue [#84](https://github.com/finlynq/finlynq/issues/84) (2026-05-01) replaced the legacy `qty == 0 AND amt > 0` heuristic with a category-id match. The heuristic silently dropped (a) dividend reinvestments (qty>0, amt<0, classified only as buys) and (b) withholding-tax / negative-correction entries (qty=0, amt<0, fell through every branch and disappeared from `dividendsReceived`). For TFSA-CAD holding 425, the heuristic reported $661.27 dividends while the SUM over Dividends-category transactions was ~$726.06 — $64.79 unexplained.

The fix routes through [src/lib/dividends-category.ts](../../src/lib/dividends-category.ts) `resolveDividendsCategoryId(db, userId, dek)`, which looks up the user's `Dividends`/`Dividend` category id (Stream-D-aware: matches both plaintext `name` and the encrypted `name_lookup` HMAC). When the user has no Dividends category, the helper returns null and `dividendsReceived` cleanly sums to 0.

**Branch ordering matters.** The buy/sell branches (qty-direction) come first to preserve "qty>0 is a buy regardless of amount sign". The dividend branch is **independent** of the buy/sell branches — a dividend reinvestment is correctly counted as both a buy (shares acquired) AND a dividend (income received).

Three implementations were updated in lockstep:
- [/api/portfolio/overview/route.ts](../../src/app/api/portfolio/overview/route.ts) — SQL CASE on `category_id`
- MCP HTTP [register-tools-pg.ts](../../mcp-server/register-tools-pg.ts) `accumulate()` (per-row category-id match)
- MCP HTTP [register-tools-pg.ts](../../mcp-server/register-tools-pg.ts) `analyze_holding` (in-memory loop, independent dividend bucket)

MCP stdio [register-core-tools.ts](../../mcp-server/register-core-tools.ts) `analyze_holding` doesn't compute dividends today (no `divAmt` accumulator), so the heuristic-fix is a no-op there. Stdio `get_portfolio_analysis` likewise doesn't expose dividends — separate gap, not regressed.

### Portfolio aggregation — cross-currency cost basis bucketed by `entered_currency` (issue #129)

Issue [#129](https://github.com/finlynq/finlynq/issues/129) (2026-05-04) ports the per-currency bucketing pattern from REST `/api/portfolio/overview` to the other read-side aggregators. For a holding whose `currency` differs from its parent `accounts.currency` (e.g. a USD ETF inside a CAD brokerage account), the legacy code summed `transactions.amount` (account currency) and tagged the total with the holding's currency. A USD position with a single buy of 10 shares for `entered_amount=2,819.64 USD` / `account_amount=3,839.38 CAD` returned `avgCostPerShare=$383.94 USD` (wrong, that's the CAD figure mislabeled) instead of `$281.96 USD`. The downstream `*Reporting` field then re-FXed the already-account-currency value, producing inflated nonsense.

The pattern, mirroring REST overview's: SELECT `entered_amount`, `entered_currency`, `ph.currency` (holding ccy), `a.currency` (account ccy), and the cash leg's `entered_amount`/`entered_currency` for issue [#96](https://github.com/finlynq/finlynq/issues/96) trade pairs. Pre-resolve every distinct `(entered_currency → holding_currency)` FX pair into a sync `Map` cache (one `getRate` call per pair). Per-row buy / sell / dividend amount = `ABS(entered_amount) × fx(entered → holding)`. The output is consistently in holding currency, so `tagAmount(buyAmt, ph.currency, "account")` is correct and `lifetimeCostBasisReporting = buyAmt × fx(holding → reporting)` is a single hop instead of double.

Three aggregators in sync:
- [/api/portfolio/overview/route.ts](../../src/app/api/portfolio/overview/route.ts) — already canonical (the reference implementation since it shipped).
- MCP HTTP [register-tools-pg.ts](../../mcp-server/register-tools-pg.ts) `accumulate()` (consumed by `get_portfolio_analysis` + `get_portfolio_performance`) and `analyze_holding` (independent loop).
- [src/lib/holdings-value.ts](../../src/lib/holdings-value.ts) — GROUP BY `(holding_id, entered_currency)`, post-query loop folds buckets into holding currency, then back into account currency for the `AccountHoldingsValue` contract.

MCP stdio aggregators (`get_portfolio_analysis`, `get_portfolio_performance`, `analyze_holding`) all `streamDRefuseRead` post Stream D Phase 4 because stdio has no DEK to decrypt holding names — the bug never manifested there.

**`analyze_holding` had two related bugs in one tool.** Pre-fix, `holdingCurrency = txns[0]?.currency` read `a.currency` (account ccy from the JOIN), not `ph.currency`. So the response was self-consistent (label and value both wrong but matching) but inconsistent with `get_portfolio_analysis` for the same holding. The fix sources `holdingCurrency` from the new `ph.currency` SELECT AND applies per-row FX normalization in the loop. Without both, the tool would still look right in isolation.

CAD/CAD same-currency holdings are unaffected (FX hop is `1.0`). Issue #96 cash-leg substitution composes (cash leg's `entered_amount` and `entered_currency` are used; the FX hop into holding currency follows). Issue #128 paired-cash-leg sell-branch skip is preserved.

### Portfolio aggregation uses integer FK, not the (now-dropped) encrypted text column

SQL `GROUP BY portfolio_holding_id` is the canonical and only path. `aggregateHoldings()` in `mcp-server/register-tools-pg.ts`, the `/api/portfolio/overview` route, and `src/lib/holdings-value.ts` all run a SQL aggregation on the FK plus a JOIN to `portfolio_holdings.name_ct` for the display name. The legacy `transactions.portfolio_holding` text column was retired 2026-04-29 in [#18](https://github.com/finlynq/finlynq/pull/18) (Phase 5 NULL'd it; Phase 6 dropped it); the orphan-fallback decrypt loop and the `undecryptedTxCount` "sign in again to unlock" banner are gone with it. Portfolio reads no longer need a DEK.

As of issue [#25](https://github.com/finlynq/finlynq/issues/25) (2026-05-01), every aggregator additionally `INNER JOIN holding_accounts ha ON ha.holding_id = t.portfolio_holding_id AND ha.account_id = t.account_id AND ha.user_id = ?`. Today each `portfolio_holdings` row mirrors `holding_accounts` 1:1 via the `is_primary=true` row, so the join is a no-op — but it's forward-compatible with Section G's many-to-many shape, where one canonical position spans multiple `holding_accounts` rows. The JOIN keeps the (holding, account) pair as the join grain so a future split holding aggregates correctly.

**Issue [#86](https://github.com/finlynq/finlynq/issues/86) (2026-05-01).** MCP HTTP `accumulate()` historically keyed its in-memory output Map by holding *display name* — two holdings sharing a name (e.g. VUN.TO in TFSA + RRSP) silently merged into one inflated row. Re-keyed to `holding_id` so each holding stays a distinct row. `get_portfolio_analysis` `phMap` is also re-keyed by `ph.id`, `get_portfolio_performance` returns `holdingId` per row, and `analyze_holding` (HTTP + stdio) gained an optional `holdingId` parameter that short-circuits the fuzzy substring filter; when the substring spans multiple distinct ids the response surfaces an `ambiguous` candidate list rather than averaging across them. The `symbols` filter now matches name + symbol via substring + token-overlap (so `"VCN.TO (TFSA)"` resolves to `"VCN.TO"`) and surfaces unmatched entries in `warnings`. All four aggregators are now aligned at the `holding_id` join grain.

### Per-user canonical-name backfill (issue #25, 2026-05-01)

`enqueueCanonicalizePortfolioNames` at [src/lib/crypto/stream-d-canonicalize-portfolio.ts](../../src/lib/crypto/stream-d-canonicalize-portfolio.ts) is a sibling of `enqueuePhase3NullIfReady`. Both fire on every successful login (web + MFA). The canonicalize helper checks `users.portfolio_names_canonicalized_at`, decrypts each `portfolio_holdings` row's name + symbol, classifies (tickered / cash-sleeve / currency-code / user-defined), and dual-writes a canonical name + `name_ct` + `name_lookup` for the first three classes. Tickered = uppercased symbol. Cash sleeve (`name='Cash', symbol=NULL`) keeps the canonical "Cash". Currency-code (e.g. `symbol='USD'`) becomes `Cash USD`. User-defined positions (no symbol AND `name != 'Cash'`) are left alone — the user typed it, they get to keep it.

DEK-mismatch users (e.g. pathfinder per "Known open issue: pathfinder DEK mismatch" below) bail silently at the sample-decrypt precondition — same gate as `nullPlaintextIfReady`. Their plaintext fallback keeps the page functional; canonicalization is defense-in-depth and skipping it is safe.

Once the helper has run for a user, the PUT handler at [/api/portfolio/route.ts](../../src/app/api/portfolio/route.ts) rejects name edits on canonical rows with HTTP 400 (`isCanonicalHolding(name, symbol)` mirrors the classifier). Symbol / currency / isCrypto / note remain editable. The `HoldingEditDialog` UI disables the Name input on canonical rows with the hint "Name is auto-managed for this holding type. Edit the symbol or currency to rename".

## Secret-derived DEK envelopes

The user password isn't the only key the DEK gets wrapped under. Each long-lived secret that authenticates against the API gets its own envelope so MCP-over-OAuth, API-key, and webhook flows can decrypt user data without re-prompting for the password.

### API-key DEK envelope

When a user creates/regenerates their API key while logged in, the DEK is also wrapped with `secretWrapKey("dek|"+api_key)` and stored in `settings` under key `api_key_dek`. Same wrap helper (`wrapDEKForSecret` / `unwrapDEKForSecret` in [src/lib/api-auth.ts](../../src/lib/api-auth.ts)) is reused for OAuth access tokens and the email-webhook secret.

API keys themselves are stored hashed (`sha256:<64 hex>`) — see [api-auth.ts](../../src/lib/api-auth.ts) `getOrCreateApiKey` and `regenerateApiKey`. `validateApiKey` does a hashed lookup first, falls back to a raw lookup + migrates the row in place on access. The DEK-envelope path is untouched — client-supplied raw key per request is still the unwrap input.

### OAuth MCP DEK envelope

`oauth_authorization_codes.dek_wrapped` holds the session DEK wrapped under `secretWrapKey("dek|"+code)` at authorize time; token exchange unwraps and re-wraps under `secretWrapKey("dek|"+access_token)` into `oauth_access_tokens.dek_wrapped`. Refresh rotations carry the DEK forward via the new `oauth_access_tokens.dek_wrapped_refresh` column (added in the 2026-04-24 Privacy Hardening batch). `validateOauthToken()` returns `{userId, dek}` so MCP-over-OAuth sees decrypted data without re-auth.

OAuth code consumption uses `DELETE ... RETURNING` (atomic claim — concurrent exchanges on the same code can no longer both succeed). Refresh rotation atomically flips the live row to `revoked_at = now()` and detects reuse: presenting a revoked refresh token revokes every live access token for that user (token-theft containment).

### Webhook DEK envelope

When the user regenerates the email webhook from settings, the DEK is wrapped with `secretWrapKey("dek|"+webhook_secret)` and stored as `settings.email_webhook_dek`. The webhook handler unwraps on each call so email-forwarded imports land as ciphertext.

## Wipe-account primitive

`POST /api/auth/wipe-account` (password + `confirmation: "WIPE"`) deletes all user-owned rows and installs a fresh DEK wrapped under the same password. `/api/auth/password-reset/confirm` shares the primitive (`wipeUserDataAndRewrap()` in [src/lib/auth/queries.ts](../../src/lib/auth/queries.ts)) — requires `confirmation: "WIPE"`.

**Atomicity** (commits [`5571070`](https://github.com/finlynq/finlynq/commit/5571070) + [`ad87419`](https://github.com/finlynq/finlynq/commit/ad87419)): the entire delete sequence + the final DEK rewrap run inside a single `db.transaction(async (tx) => ...)` so a late FK failure rolls back instead of leaving the user signed in to a half-wiped account whose DEK was never rotated.

**Strict user_id isolation:** every delete filters by `user_id` only — never by FK reach — so the wipe can ONLY remove rows owned by the wiping user. If a row in another user's table has an FK pointing at one of this user's accounts/categories (cross-tenant data leak from older bugs), the wipe fails with FK 23503 + transaction rollback rather than silently destroying that other user's data. Cleanup of pre-existing cross-tenant rows is an admin out-of-band task.

The `mcp_uploads` file unlink loop runs BEFORE the DB transaction (unlink is not transactional — better to leak a DB row than orphan a plaintext file on disk if the wipe later fails).

`wipeUserDataAndRewrap` also bumps `users.encryptionV` so multi-tab sessions can't keep using the old cached DEK after a password reset.

The wipe cleans `mcp_uploads`+files, `staged_imports`, `staged_transactions`, `password_reset_tokens`, `oauth_access_tokens`, `oauth_authorization_codes`, and the user's own `incoming_emails` rows.

## Backup-restore FK remap

Commit [`ad87419`](https://github.com/finlynq/finlynq/commit/ad87419), 2026-04-27. `/api/data/import` (the JSON backup-restore handler) used to call a `strip()` helper that only removed `id` and forced `userId`, leaving `accountId` / `categoryId` / `assignCategoryId` UNCHANGED from the source backup. When user A's backup was restored as user B, dependent tables silently inherited user A's old account/category integer IDs — and if those IDs still existed in the same DB, Postgres accepted the FK and the row became a cross-tenant reference.

Concrete blast radius on prod: a test user's restore created 60 portfolio_holdings owned by them but pointing at the admin's accounts, which then blocked the admin's wipe with FK 23503.

The fixed `strip()` takes optional `{ accountIdMap, categoryIdMap }` and remaps each FK column through them, **throwing on an unmapped FK** so a corrupt or partial backup fails loudly rather than silently writing leaked rows. Every restore call site that touches an FK-bearing table now passes the right map. Tables with no `accountId`/`categoryId` (target_allocations, fx_rates, import_templates, contribution_room, notifications) keep the old single-arg call.

## Grace migration

Pre-encryption accounts (bcrypt hash but no DEK columns) auto-promote on their next successful login. Existing plaintext rows stay readable via the `v1:` passthrough in `decryptField`. See `promoteUserToEncryption` in [src/lib/auth/queries.ts](../../src/lib/auth/queries.ts).

## Forgot-password policy

Zero-knowledge — there is no recovery key. The reset flow wipes all user data and provisions a fresh DEK. Admin password reset is NOT possible without destroying the user's data.

## Stale-session UX

After a deploy restart, the in-memory DEK cache is empty. Existing JWTs are still valid, but their DEK is gone. Reads degrade gracefully (users see `v1:...` blobs in payee/note/tags until they re-login). Writes that need the DEK return 423 — the client should guide the user to re-login. This is the intentional design; there's no server-side fix short of adding a Redis-backed DEK cache.

The deploy-generation force-logout (see [mcp.md](mcp.md)) addresses this proactively by invalidating JWTs across deploy boundaries so users get a clean re-auth instead of a degraded session.

## Phase 3 status — what's done vs deferred

Phase 2 + Phase 3 shipped to prod on 2026-04-22.

- Writes encrypt on all session-authed paths. Stdio MCP stays plaintext (no DEK in that transport). As of the 2026-04-22 security audit remediation, stdio tools ARE user-scoped via `PF_USER_ID`, but the data they write is still plaintext. Known self-hosted limitation.
- Reads decrypt with the soft-guard pattern.
- `import_hash` on plaintext.
- Auto-categorize fixed.
- Wipe-account + password-reset-confirm.
- OAuth + webhook DEK envelopes wired.
- **Phase 4 (Stream D) — full cutover, prod + dev (2026-05-03).** Display-name encryption on accounts/categories/goals/loans/subscriptions/portfolio_holdings completed: the 8 plaintext columns (`accounts.name`/`alias`, `categories.name`, `goals.name`, `loans.name`, `subscriptions.name`, `portfolio_holdings.name`/`symbol`) are physically dropped from the schema. Reads route through `name_ct` + DEK via `decryptName()` (no plaintext fallback); writes through `buildNameFields(dek, …)`. The lazy backfill helpers (`stream-d-backfill.ts`, `stream-d-phase3-null.ts`) are deleted; only [enqueueCanonicalizePortfolioNames](../../src/lib/crypto/stream-d-canonicalize-portfolio.ts) remains. Stdio MCP create/update tools for these 6 tables refuse with a clean error (no DEK on the stdio transport). See [STREAM_D.md](../../../Plans/STREAM_D.md) and [migrations.md](../migrations.md) "Stream D Phase 4".
- **Still deferred:** `users.display_name`, `contribution_room.note`, plus the wider `*.note` / `*.group` / `recurring_transactions.payee` / `notifications.message` / `transaction_rules.match_value` surface. Would be a separate Stream E. Lower priority.
