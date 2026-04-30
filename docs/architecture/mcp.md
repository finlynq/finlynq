# MCP architecture

The MCP server is Finlynq's key differentiator — both transports (HTTP for hosted/managed, stdio for self-host + Claude Desktop) and the patterns shared between them. Pulled out of CLAUDE.md on 2026-04-28.

## Transports

- **HTTP** — `/api/mcp` (Streamable HTTP). Auth via session cookie or Bearer `pf_*` API key. OAuth 2.1 + Dynamic Client Registration (DCR) for Claude Web/Mobile. Tools registered in [mcp-server/register-tools-pg.ts](../../mcp-server/register-tools-pg.ts). DCR endpoint rate-limited to 10 registrations/hour/IP.
- **Stdio** — [mcp-server/index.ts](../../mcp-server/index.ts). Connects via `DATABASE_URL` env var. Tools registered in [mcp-server/register-core-tools.ts](../../mcp-server/register-core-tools.ts) + [tools-v2.ts](../../mcp-server/tools-v2.ts) + [tools-import-templates.ts](../../mcp-server/tools-import-templates.ts).

**Stdio requires `PF_USER_ID`** (added 2026-04-22 in the security audit remediation). The stdio process refuses to start without it. Every tool scopes its queries and writes to that user. INSERTs bind userId from the closure — never from tool arguments. UPDATE/DELETE do a `SELECT 1 FROM … WHERE id = ? AND user_id = ?` ownership pre-check and return an MCP error on miss. `price_cache` and `fx_rates` stay global (intentionally; they're not user data).

Self-hosters using stdio MCP must add `PF_USER_ID` to their Claude Desktop config `env` block alongside `DATABASE_URL`.

`.well-known/mcp.json` server card for discoverability.

## Tool surface — current count

**81 tools registered on HTTP / 75 on stdio** as of 2026-04-28.

The 6 HTTP-only tools are:
- File-upload flow: `list_pending_uploads`, `preview_import`, `execute_import`, `cancel_import`
- `get_loans` (pre-existing HTTP-only read — stdio ships `list_loans` instead)
- (1 historical adjustment — see consolidation log)

### Tool surface evolution

- **2026-04-22 — Waves 1 + 2 parity expansion** brought stdio up to match HTTP for read coverage.
- **2026-04-23 — Consolidation:** dropped 11 redundant tools (86 → 75):
  - `add_transaction` → use `record_transaction`
  - `get_transactions` → subset of `search_transactions`
  - `categorize_transaction` → use `update_transaction`
  - `get_portfolio_summary` + `get_holding_metrics` → folded into `get_portfolio_analysis` with optional `symbols?` filter
  - `get_net_worth_trend` → folded into `get_net_worth` via optional `months?` param
  - `get_rebalancing_suggestions` + `compare_to_benchmark` → folded into `get_investment_insights` via `mode: 'patterns' | 'rebalancing' | 'benchmark'`
  - `pause_subscription` + `resume_subscription` + `cancel_subscription` → use `update_subscription({status, cancel_reminder_date})`
- **2026-04-27 — Portfolio CRUD added** (75 → 78 HTTP):
  - `add_portfolio_holding`, `update_portfolio_holding`, `delete_portfolio_holding` over `portfolio_holdings`
  - Holding renames cascade to all transactions via the `portfolio_holding_id` FK; deletes leave transactions in place with the FK NULL'd (ON DELETE SET NULL)
  - Same change fixed a bug in REST `PUT /api/portfolio` that was skipping Stream D dual-write on rename, silently breaking decryption on Phase 3 prod
  - Added the missing `POST /api/portfolio` for parity
- **2026-04-28 — Transfer trio added** (78 → 81 HTTP, 72 → 75 stdio):
  - `record_transfer` / `update_transfer` / `delete_transfer`
  - Atomic transfer-pair CRUD that creates BOTH legs (debit + credit) under a server-generated UUID `link_id` in a single DB transaction
  - Supports cash transfers, cross-currency (with `receivedAmount` override), in-kind / share transfers (`holding` + `quantity`), and asymmetric in-kind events for splits/mergers/share-class conversions (`destQuantity` ≠ `quantity`)
  - Auto-creates a Transfer category (type='R') on first use; same-account in-kind rebalances allowed
- **2026-04-30 — `account_id` on transaction read/write tools, low-confidence fuzzy rejected ([#29](https://github.com/finlynq/finlynq/pull/29))** (no tool count change):
  - `search_transactions` gains `account_id?: number` (HTTP + stdio) — FK fast-path mirroring the existing `portfolio_holding_id` filter, intended for dedup workflows against blank-payee bank-imported transfers where text search misses. Bump `limit` accordingly when this is the only filter.
  - `record_transaction` and `bulk_record_transactions` gain `account_id?: number` (HTTP + stdio). On bulk it lives at both the top level (applies to every row that omits its own) and per row (wins over both name and the top-level fallback). When set, the resolver skips fuzzy matching entirely; the `account` (name) parameter is now optional but at least one of the two must be present.
  - **New `resolveAccountStrict` helper** ([register-tools-pg.ts](../../mcp-server/register-tools-pg.ts) + [register-core-tools.ts](../../mcp-server/register-core-tools.ts)) used on the name path. Same exact/alias/startsWith waterfall as `fuzzyFind`, but substring/reverse-substring hits are only accepted when input and candidate share a whitespace-separated token of length ≥3. Otherwise the row fails with a "did you mean … (id=N)?" error pointing to what `fuzzyFind` would have picked. Reads still use plain `fuzzyFind` — wrong filters are recoverable, wrong writes aren't.
  - **`resolvedAccount: { id, name }` returned in every per-row write response** so the agent can verify routing immediately. On `record_transaction` it's at the top level; on `bulk_record_transactions` it's per result entry — including per-row failures, once the account resolved (so the agent knows which account a row was *about to* write to).
  - Stdio carve-out unchanged — investment-account writes are still refused on stdio (no `portfolioHolding` plumbing); `account_id` resolution runs first and the constraint check fires after.
- **2026-04-28 — Holding-id ergonomics on portfolio reads + writes** (no tool count change; commits [`ca0a117`](https://github.com/finlynq/finlynq/commit/ca0a117) + [`f429c6f`](https://github.com/finlynq/finlynq/commit/f429c6f)):
  - `get_portfolio_analysis` now returns `id` per holding; `analyze_holding` returns `holdingId`. Both transports. Source: the FK already plumbed through `aggregateHoldings()` `accumulate()` ("first non-null id wins"); the response mappers were dropping it on the floor — write-tool descriptions told the agent to "Get the id from get_portfolio_analysis" but the read tool didn't expose it (root cause of the user-reported "MCP records the sale but the holding never moves" — agent had no way to populate `portfolioHoldingId`).
  - `record_transaction` / `bulk_record_transactions` / `update_transaction` now accept **`portfolioHolding`** (name OR ticker symbol) alongside `portfolioHoldingId`. Resolved via the lookup-only helper `resolvePortfolioHoldingByName` — exact case-insensitive match against `name` / `name_lookup` / `symbol` / `symbol_lookup`, scoped to the resolved account, no auto-create. Errors with a "Name (TICKER)" candidate list on miss; errors when both `portfolioHolding` and `portfolioHoldingId` are passed and disagree (silent "I named X but you bound Y" is worse than rejecting). Mirrors the HMAC dual-cohort handling in `portfolio-holding-resolver.ts` but single-shot — no map pre-build. **HTTP only** — stdio MCP write tools still don't bind to portfolio_holdings (pre-existing carve-out per [Self-hosted limitation](#self-hosted-limitation--stdio-writes-are-plaintext)).
  - `analyze_holding(symbol)` now actually filters by the holding's `symbol` column (HTTP JOINs `ph.symbol_ct` + decrypts; stdio LEFT JOINs `portfolio_holdings` and adds `LOWER(ph.symbol) = LOWER(?)` to the WHERE). Description always claimed "fuzzy match on name OR symbol" — until this commit it only matched name (via `portfolio_holding` text) + payee. Symbol uses **exact** equality, not substring — tickers are short and prone to spurious hits like "GE" matching "ORANGE". Name + payee retain substring matching for long-string ergonomics.

## Confirmation-token preview/execute pattern

Destructive or high-volume ops are split into two tools. The preview tool runs the filter/computation and returns a sample + affected-row count + a signed `confirmationToken`. The execute tool rejects unless the token matches.

Implemented in [src/lib/mcp/confirmation-token.ts](../../src/lib/mcp/confirmation-token.ts) — HMAC-SHA256 over `{userId, operation, sha256(canonicalJson(payload))}`, 5-min TTL, signed with `PF_JWT_SECRET`. Canonical JSON (sorted keys) so `{a,b}` and `{b,a}` hash identically.

Used by:
- Every `preview_bulk_*` / `execute_bulk_*` pair
- `preview_import` / `execute_import`
- `detect_subscriptions` / `bulk_add_subscriptions`
- External-import connectors (WealthPosition ZIP and API paths)

## Per-user in-memory tx cache

[src/lib/mcp/user-tx-cache.ts](../../src/lib/mcp/user-tx-cache.ts) — LRU over 10 users, up to 50k rows each, populated on first read and stored on `globalThis.__pfTxCache` so it survives HMR.

**Why it exists:** AES-GCM uses a random IV per row, so SQL `GROUP BY payee` would bucket every encrypted row into its own group. The cache holds decrypted rows so payee-based aggregations (subscription detection, rule testing, suggestion lookups) work without decrypting on every call.

Read by:
- `detect_subscriptions`
- `test_rule`
- `suggest_transaction_details`
- The auto-categorize historical-frequency fallback

**Every write path that mutates a user's transactions MUST call `invalidateUser(userId)` after the commit** — missing an invalidation = Claude reading stale payees.

If the DEK is null at load (post-deploy), entries are flagged `degraded: true` and payees come back as `v1:...` blobs rather than hard-erroring.

## File upload flow

Web UI posts a CSV/OFX to `POST /api/mcp/upload` (5 MB cap, auth + DEK required). The handler stashes the file (encrypted on disk with `v1\0` magic prefix via [src/lib/crypto/file-envelope.ts](../../src/lib/crypto/file-envelope.ts)), writes a row to the `mcp_uploads` table, and returns `{uploadId, format, rowCount, detectedColumns}`.

`mcp_uploads` schema: `id, user_id, format, storage_path, row_count, created_at, expires_at`.

Claude then calls:
1. `list_pending_uploads` to see what's queued
2. `preview_import(uploadId, templateId?, columnMapping?)` to see the first 20 parsed rows + dedup hits + a `confirmationToken`
3. `execute_import(uploadId, confirmationToken)` to commit via [import-pipeline.ts](../../src/lib/import-pipeline.ts)
4. `cancel_import(uploadId)` drops the row + file

Uploads older than 24h are cleaned up by [src/lib/mcp/upload-cleanup.ts](../../src/lib/mcp/upload-cleanup.ts).

**Stdio MCP** accepts a `filePath` alternative gated by `ALLOW_LOCAL_FILE_IMPORT=1`. It returns a clear error if it encounters an encrypted file (stdio has no DEK). See [src/lib/crypto/file-envelope.ts](../../src/lib/crypto/file-envelope.ts) `maybeDecryptFileBytes()`.

## Binding transactions to portfolio holdings

The integer FK `transactions.portfolio_holding_id` is the canonical link between a transaction and the position it affects (per [encryption.md](encryption.md) "Portfolio holding text → integer FK"). Three ways to populate it via MCP:

1. **`portfolioHoldingId: <int>`** — the explicit FK. Get the id from the read tools below; the write tool runs an ownership pre-check (`SELECT 1 FROM portfolio_holdings WHERE id = ? AND user_id = ?`) and rejects unowned rows.
2. **`portfolioHolding: "<name or ticker>"`** — name OR ticker symbol. Resolved via [resolvePortfolioHoldingByName](../../mcp-server/register-tools-pg.ts) — exact case-insensitive match against `name` plaintext OR `symbol` plaintext OR `name_lookup` HMAC OR `symbol_lookup` HMAC, scoped to the resolved account. No fuzzy/substring fallback. **No auto-create** — errors with a "Name (TICKER)" candidate list of up to 10 holdings on miss; the agent recovers by retrying with a valid identifier or calling `add_portfolio_holding`. The same `nameLookup(dek, trimmed)` HMAC value matches both `name_lookup` and `symbol_lookup` columns since the HMAC is over trimmed-lowercase input regardless of source.
3. **Both passed** — they must agree. If they resolve to different ids the call errors rather than silently picking; the alternative ("I named X but you bound Y") is a worse failure mode than a clear rejection.

Available on `record_transaction` / `bulk_record_transactions` / `update_transaction` — HTTP only. Stdio MCP write tools still don't bind portfolio holdings per the [stdio carve-out](#self-hosted-limitation--stdio-writes-are-plaintext).

### Write-time warnings ([#31](https://github.com/finlynq/finlynq/issues/31))

`record_transaction` / `bulk_record_transactions` / `update_transaction` (HTTP) include a `warnings: string[]` field on success when a row binds a `portfolioHoldingId` and moves cash (`amount != 0`) but omits `quantity`. The transaction is still written; the warning is advisory — without `quantity`, the holding's unit count doesn't move and the portfolio aggregator drifts from the cash ledger.

- Single check today: `portfolioHoldingId != null && amount != 0 && quantity == null` → `"quantity not set — holding unit count was not updated"`. Centralized in [`deriveTxWriteWarnings`](../../src/lib/queries.ts) so future advisory checks land in one place.
- `record_transaction` puts `warnings` at the top level of the success response. `bulk_record_transactions` attaches `warnings` to per-row results only when non-empty (keeps the common case unchanged for callers that don't read it). `update_transaction` warns only when the user *explicitly bound a holding on this update* without also passing `quantity` — touching unrelated fields (e.g. date) on a previously-bound row doesn't fire.
- Stdio MCP doesn't expose `portfolioHoldingId`/`quantity` on write tools and refuses investment-account writes outright, so the warning condition can't trigger there.

### Reading the id back

- `get_portfolio_analysis` — exposes `id: <int>` per holding in the `holdings[]` array (HTTP + stdio).
- `analyze_holding` — exposes `holdingId: <int>` at the top level (HTTP + stdio). The HTTP response uses a tightened first-non-null find (`txns.find(t => t.portfolio_holding_id != null && String(t.portfolio_holding) === holdingName)`) so payee-only fuzzy matches don't surface another holding's id when the analyzed string was a non-investment cash payee like `"Huron Sale"`.
- `search_transactions` — already returned raw `portfolio_holding_id` per row; also accepts a `portfolio_holding_id` filter for FK fast-path queries (cheaper than substring search on the encrypted text column).

### `analyze_holding(symbol)` — name OR ticker

The tool's `symbol` parameter accepts either the full holding name or the ticker. HTTP path JOINs `portfolio_holdings.symbol_ct`, decrypts per-row, and applies in-memory filtering with substring on name + payee but **exact case-insensitive equality on symbol** — tickers are short (3-4 chars) and prone to spurious substring hits like "GE" matching "ORANGE". Stdio path does the equivalent in SQL (`LEFT JOIN portfolio_holdings ph` + `OR LOWER(ph.symbol) = LOWER(?)`).

## Deploy-generation force-logout

Every deploy rotates a `DEPLOY_GENERATION` env var (set by `deploy.sh` as `$(date +%s)` before the service starts). JWTs embed the generation at issue time; [src/lib/auth/jwt.ts](../../src/lib/auth/jwt.ts) rejects tokens whose generation is older than the current process's generation with reason `"deploy-reauth-required"`.

In-flight sessions get a 401 with `code: "deploy-reauth-required"` so the UI can show a "We just updated Finlynq — please sign in again" screen rather than a raw error.

This is deliberate: the in-memory DEK cache is wiped on restart anyway, so forcing re-auth rebuilds it cleanly and avoids the "gibberish payees" degraded state. If `DEPLOY_GENERATION` isn't set (dev), the check is skipped.

## OAuth 2.1 + DCR

Enables Claude Web/Mobile to connect without manual config. DCR endpoint at `/api/oauth/register` is rate-limited to 10 registrations/hour/IP (uses the same `checkRateLimit` helper as `/api/auth/login`). CORS stays `*` (DCR requires it).

OAuth code consumption uses `DELETE ... RETURNING` (atomic claim — concurrent exchanges on the same code can no longer both succeed; see [src/lib/oauth.ts](../../src/lib/oauth.ts) `consumeAuthCode`).

Refresh rotation atomically flips the live row to `revoked_at = now()` and detects reuse: presenting a revoked refresh token revokes every live access token for that user (token-theft containment). Schema column added by [scripts/migrate-oauth-revoked-at.sql](../../scripts/migrate-oauth-revoked-at.sql).

DEK envelope details: see [encryption.md](encryption.md) "Secret-derived DEK envelopes".

## Rule-management tools — known broken

`apply_rules_to_uncategorized`, `create_rule`, `list_rules`, `update_rule` (HTTP + stdio versions) all reference a non-existent `match_payee` column similarly to the bug fixed in `autoCategory` (commit [`7d70677`](https://github.com/finlynq/finlynq/commit/7d70677)). They need the same parallel migration in a follow-up sweep. Pre-existing — no current regression. See [encryption.md](encryption.md) "Auto-categorize rule schema" for the rule schema.

## Self-hosted limitation — stdio writes are plaintext

Stdio MCP (`register-core-tools.ts`, `tools-v2.ts`, `tools-import-templates.ts`) is the one write path that stays plaintext — no DEK in that transport. As of the 2026-04-22 security audit remediation, stdio tools ARE user-scoped via `PF_USER_ID`, but the data they write is still plaintext. Known self-hosted limitation; document it in any Claude Desktop setup guide.
