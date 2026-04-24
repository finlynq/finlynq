# Privacy Hardening — Deploy Notes

This document captures what needs to happen to deploy the `feat/privacy-phase-1` branch. All Phase 1, 2, and 4 findings from `PF/i-want-to-check-mossy-muffin.md` are implemented; Stream D (Phase 3) is deferred — tracked separately.

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

## Follow-ups (not in this deploy)

- **Stream D** — encrypt account/category/loan/goal/subscription names and portfolio symbols. ~30 call sites. Tracked as Phase 3 of the original plan.
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
