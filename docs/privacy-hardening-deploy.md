# Privacy Hardening — Deploy Notes

This document captures what needs to happen to deploy the privacy-hardening stack. All Phase 1, 2, and 4 findings from the original plan are live on prod, plus **Stream D (display-name encryption) all three phases**. See the "Stream D" section at the bottom for its migration sequence.

## What shipped

### Phase 1 — CRITICAL

| # | Fix | Files |
|---|---|---|
| 1 | API-key split derivation: `authLookupHash(secret)` ≠ `secretWrapKey(secret)`. DB-dump attacker can no longer unwrap the API-key DEK envelope. | `src/lib/api-auth.ts` |
| 2 | OAuth codes + access tokens + refresh tokens hashed at rest. DEK also wrapped under refresh token for the rotation flow (new `dek_wrapped_refresh` column). Webhook secret hashed at rest too. | `src/lib/oauth.ts`, `src/app/api/import/email-config/route.ts`, `src/app/api/import/email-webhook/route.ts`, `src/db/schema-pg.ts` |
| 4 | `users.mfa_secret` encrypted under user DEK. Setup gets DEK from session cache; verify gets DEK from pending-session cache. | `src/lib/auth/queries.ts`, `src/app/api/auth/mfa/setup/route.ts`, `src/app/api/auth/mfa/verify/route.ts` |
| 5 | `wipeUserDataAndRewrap` now deletes `mcp_uploads` (and unlinks files), `staged_imports`, `staged_transactions`, `password_reset_tokens`, `oauth_access_tokens`, `oauth_authorization_codes`, and user's `incoming_emails` rows matching their import address. | `src/lib/auth/queries.ts` |

### Phase 2 — HIGH

| # | Fix | Files |
|---|---|---|
| 3 | Password envelope **pepper**: `scrypt(HMAC(PF_PEPPER, password), salt)`. DB-only leak can no longer run offline password crack without also grabbing the filesystem. | `src/lib/crypto/envelope.ts` |
| 6 | Password strength enforcement: min 12 chars, common-password deny list, 3-of-4 character classes or ≥16 chars. Applies to register + password-reset-confirm. | `src/lib/auth/password-policy.ts`, `src/app/api/auth/register/route.ts`, `src/app/api/auth/password-reset/confirm/route.ts` |
| 7 | MCP uploads encrypted on disk under user DEK. Stdio MCP gets a clear error when it hits an encrypted file. | `src/lib/crypto/file-envelope.ts`, `src/app/api/mcp/upload/route.ts`, `mcp-server/register-tools-pg.ts`, `mcp-server/register-core-tools.ts` |
| 8 | `/api/data/export` POST accepts `{ passphrase }`. With it, the JSON body is AES-GCM-wrapped under a PBKDF2(passphrase) key. | `src/app/api/data/export/route.ts` |
| 10 | Email-verify tokens stored as SHA-256 hash. | `src/lib/auth/queries.ts` |
| 11 | Per-email login rate limit (10/hour, 50/day) alongside the existing per-IP 5/min. Same 429 response so no enumeration leak. | `src/app/api/auth/login/route.ts` |
| 16 | New `admin_audit` table + `logAdminAction()` helper. Wired into `PATCH /api/admin/users` for role/plan changes. | `src/lib/admin-audit.ts`, `src/db/schema-pg.ts`, `src/app/api/admin/users/route.ts` |
| admin | MFA step-up required for `PATCH /api/admin/users` when the admin has MFA enabled. | `src/app/api/admin/users/route.ts` |
| 18 | `/api/admin/stats` no longer returns the per-user recent-logins list; replaced with aggregate `loginsLast24Hours`. | `src/app/api/admin/stats/route.ts`, `src/app/(app)/admin/page.tsx` |

### Phase 4 — Hardening

| # | Fix | Files |
|---|---|---|
| 9 | `staged_transactions.payee/note/category/accountName` encrypted under a server staging key (`PF_STAGING_KEY`) at webhook receive time. Decrypted at approve. DB-dump-only attacker can't read the 14-day staging plaintext window. | `src/lib/crypto/staging-envelope.ts`, `src/lib/email-import/stage-email-import.ts`, `src/app/api/import/staged/[id]/route.ts`, `src/app/api/import/staged/[id]/approve/route.ts` |
| 15 | DEK cache gets a **sliding idle window** (2h default). Drops after idle even if the hard 24h TTL hasn't hit. | `src/lib/crypto/dek-cache.ts` |
| 12 | `scrubSensitive()` in the server logger redacts passwords, tokens (`pf_*`), long hex runs, emails, etc. from log output. Has unit tests. | `src/lib/server-logger.ts`, `src/lib/__tests__/server-logger.test.ts` |

## New env vars

Set these before the deploy, in each env's systemd unit + `.env`:

| Env var | Required? | Generate with |
|---|---|---|
| `PF_PEPPER` | **Required in prod.** Dev falls back to empty-pepper with a warning. | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `PF_STAGING_KEY` | **Required in prod.** Dev falls back to plaintext with a warning. | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

Rotating either of these is an offline-risky operation — do NOT rotate in place once real data exists. Pepper rotation invalidates every DEK envelope; staging key rotation makes existing staged rows undecryptable. Current recommendation: pick once, keep forever, hard-rotate only via a planned re-wrap migration.

## Schema migrations — run BEFORE the code deploy

```bash
# prod
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-privacy-hardening.sql
# staging
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-privacy-hardening.sql
# dev
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-privacy-hardening.sql
```

The migration:
- Adds `oauth_access_tokens.dek_wrapped_refresh` (idempotent, nullable).
- Creates `admin_audit` table + its two indexes.
- Revokes all existing OAuth tokens (token format changed — old ones unreachable anyway).
- Deletes all OAuth authorization codes (same reason, 10-min TTL anyway).
- Nulls out `users.email_verify_token` for unverified users (format changed to SHA-256 hash).

## Expected user-visible impact at deploy time

- **Anyone logged in via OAuth/MCP**: forced to re-authorize. There are zero users currently, so this is a no-op.
- **Anyone with an API key**: their raw key is unchanged (not stored in the DB), but the DEK envelope is re-written on their next MCP call. No user action.
- **Anyone mid-MFA-setup or with MFA enabled**: next verify will decrypt the MFA secret. Since no users, no concern.
- **Anyone registering**: must use a ≥12-char password with 3-of-4 classes (or ≥16-char passphrase). Reject common passwords.

## Risks and rollback

- **DEK-cache sliding-window** may surprise test users: 2h idle drops the cache; next sensitive op returns 423. Adjust `IDLE_TTL_MS` in `src/lib/crypto/dek-cache.ts` if too aggressive.
- **Password-policy rejection** may block automation scripts using short test passwords. Add those passwords to a dev-only bypass if needed (not currently implemented — file as follow-up).
- **`PF_PEPPER` / `PF_STAGING_KEY` misconfiguration**: startup throws in prod. A missing key gives a clear error; a too-short key (<32 chars) also throws. No silent fallback.
- **Rollback**: the schema migration is additive; reverting the code works as long as the new `dek_wrapped_refresh` column is NULL (which it will be for tokens minted after the rollback). The `admin_audit` table is orthogonal. The `staged_transactions.payee` column stores `sv1:...` ciphertexts post-deploy; rolling back the code would surface those as "unreadable plaintext" to the user. No expected blocker since no users.

## Stream D — Display-name encryption (ALL PHASES LIVE on prod, 2026-04-24)

Encrypts `accounts.name`/`alias`, `categories.name`, `goals.name`, `loans.name`, `subscriptions.name`, and `portfolio_holdings.name`/`symbol` against a DB-dump attacker. Full design + phase-by-phase detail is in `PF/STREAM_D.md` (parent-repo doc, not shipped with the pf-app package).

**Architecture**: each plaintext column gets two siblings — `{col}_ct` (AES-GCM ciphertext under user DEK) + `{col}_lookup` (HMAC-SHA256 blind index for exact-match queries). Partial unique index on `(user_id, name_lookup) WHERE name_lookup IS NOT NULL` replaces the old `(user_id, name)` constraint.

**Migration sequence** (run in this order, per env):

```bash
# Phase 1 — add *_ct + *_lookup columns (idempotent, nullable)
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_<env> -d pf_<env> -f scripts/migrate-stream-d.sql

# Phase 2 — code deploy (lazy backfill on every user's next login)
# Ship the code via GHA / systemctl restart. Verify convergence with:
# GET /api/admin/stream-d-progress  →  { complete: true, totalRemaining: 0 }

# Phase 3 — cutover (NULL plaintext on encrypted rows). Preconditions:
#   - every user has logged in at least once since Phase 2 (backfill run)
#   - admin endpoint reports complete: true
PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_<env> -d pf_<env> -f scripts/migrate-stream-d-phase3-null.sql
```

**Prod state (post-cutover)**:

```
         t          | total | plaintext | encrypted
--------------------+-------+-----------+-----------
 accounts           |     5 |         0 |         5
 categories         |    20 |         0 |        20
 goals              |     2 |         0 |         2
 loans              |     0 |         0 |         0
 portfolio_holdings |     3 |         0 |         3
 subscriptions      |     0 |         0 |         0
```

**Staging + dev**: Phase 1 and Phase 3 migrations are NOT applied (user directed prod-only deploy). Run both SQL files above in sequence when bringing those envs in sync. No code changes needed — the Phase 1+2+3 code is already on main.

**Why NULL-plaintext, not DROP COLUMN**: keeps Drizzle types stable, lets stdio MCP (no DEK) keep creating rows with plaintext when needed, same privacy benefit vs DB dump. The DROP variant is preserved at `scripts/migrate-stream-d-phase3.sql` for reference but should NOT be applied.

## Follow-ups (not yet done)

- **Stdio MCP Phase-3 compatibility** — `mcp-server/register-core-tools.ts` has no DEK. Post-cutover, stdio reads return NULL for names, and stdio writes create rows with `name_ct = NULL`. Two options open: (a) mark stdio read-only, (b) add a `PF_USER_DEK` env var so self-hosted single-user stdio can encrypt.
- **Web display routes still reading plaintext** — `/api/snapshots`, `/api/rebalancing`, `/api/reports/*`, `/api/rules`, parts of the chat engine still reference `categories.name` / `accounts.name` directly. Post-cutover these render NULL (cosmetic, not crashing). Needs a sweep to apply `decryptNamedRows`.
- **CSP nonce hardening** (Finding #14) — Next.js 15+ supports nonces in middleware.
- **HSM / secure-enclave DEK cache** — architectural.
- **HaveIBeenPwned k-anonymity** on password set.
- **Passphrase-wrapped backup restore** — the export side landed; import needs the matching unwrap.

## Verification after deploy

For each env:

1. Confirm env vars set: `ssh server 'systemctl show pf.service | grep -E "PF_PEPPER|PF_STAGING_KEY"'`.
2. Register a test user with a weak password → expect 400.
3. Register a test user with a strong password → expect 201.
4. Exercise OAuth flow end-to-end (authorize → token → MCP read → refresh → MCP read again). Confirm the DB rows for the token look like `sha256:<hex>` and not `pf_oauth_...`.
5. Attempt MFA setup → confirm `users.mfa_secret` is `v1:<iv>:<ct>:<tag>` in the DB.
6. Upload a CSV via MCP upload endpoint → confirm the file on disk starts with the `v1\0` magic, not raw CSV text.
7. Request a data export with `POST /api/data/export` + `{"passphrase": "..."}` → confirm the downloaded file is a JSON blob with `"v": "pf-backup-1"`.
8. Email-send through the webhook → inspect `staged_transactions`, confirm payee starts with `sv1:`.
9. Wait 2h+ idle → next authenticated request that decrypts should 423 on encrypted column reads.
10. Run the scrubber unit test: `npm run test -- server-logger`.

### Stream D specific verification (post-Phase-3)

11. Log in → confirm backfill ran via `journalctl -u pf.service | grep stream-d` (logs `[stream-d] user=<uuid> encrypted N rows:`).
12. `GET /api/admin/stream-d-progress` → expect `{ complete: true, totalRemaining: 0 }`.
13. DB check: `SELECT COUNT(*) FROM accounts WHERE name IS NOT NULL` → 0 for envs where Phase 3 has been applied.
14. DB check: `SELECT name_ct FROM accounts LIMIT 1` → should start with `v1:`.
15. Web UI → dashboard/accounts/categories/goals all still render names correctly (decrypt happens at the route boundary).
16. MCP HTTP `get_account_balances` → returns decrypted names to Claude.
17. Create two accounts with the same name via `POST /api/accounts` → second should 409 (unique constraint on `(user_id, name_lookup)`).
