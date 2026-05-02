# MCP architecture

The MCP server is Finlynq's key differentiator — both transports (HTTP for hosted/managed, stdio for self-host + Claude Desktop) and the patterns shared between them. Pulled out of CLAUDE.md on 2026-04-28.

## Transports

- **HTTP** — `/api/mcp` (Streamable HTTP). Auth via session cookie or Bearer `pf_*` API key. OAuth 2.1 + Dynamic Client Registration (DCR) for Claude Web/Mobile. Tools registered in [mcp-server/register-tools-pg.ts](../../mcp-server/register-tools-pg.ts). DCR endpoint rate-limited to 10 registrations/hour/IP.
- **Stdio** — [mcp-server/index.ts](../../mcp-server/index.ts). Connects via `DATABASE_URL` env var. Tools registered in [mcp-server/register-core-tools.ts](../../mcp-server/register-core-tools.ts) + [tools-v2.ts](../../mcp-server/tools-v2.ts) + [tools-import-templates.ts](../../mcp-server/tools-import-templates.ts).

**Stdio requires `PF_USER_ID`** (added 2026-04-22 in the security audit remediation). The stdio process refuses to start without it. Every tool scopes its queries and writes to that user. INSERTs bind userId from the closure — never from tool arguments. UPDATE/DELETE do a `SELECT 1 FROM … WHERE id = ? AND user_id = ?` ownership pre-check and return an MCP error on miss. `price_cache` and `fx_rates` stay global (intentionally; they're not user data).

Self-hosters using stdio MCP must add `PF_USER_ID` to their Claude Desktop config `env` block alongside `DATABASE_URL`.

`.well-known/mcp.json` server card for discoverability.

## Tool surface — current count

**82 tools registered on HTTP / 78 on stdio** as of 2026-04-30.

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
- **2026-04-30 — `dryRun` previews + auto-source tag on imports ([#33](https://github.com/finlynq/finlynq/issues/33))** (no tool count change): `record_transaction` and `bulk_record_transactions` (HTTP + stdio) accept `dryRun: z.boolean().optional()`. When set, the full validation/resolution pipeline runs (account fuzzy-match, FX rate, holding binding, investment-account constraint, category auto-detect) but the `INSERT` is skipped and `invalidateUserTxCache` is NOT called. Response shape mirrors success: `dryRun: true`, `wouldBeId: null`, `resolvedAccount`/`resolvedCategory`/`resolvedHolding`. `bulk_record_transactions` propagates the flag to every per-row result and uses `previewed` instead of `imported` at the top level. Use this to sanity-check routing before committing — especially when fuzzy account matches might surprise you. The companion auto-source-tag work tags imported rows (`source:wealthposition`) so future statement reconciliations can dedup against rows the bank side has already booked — see [import-connectors.md](../import-connectors.md) §"Source tag" for the connector-side details.
- **2026-04-30 — Investment-account-aware auto-categorization ([#32](https://github.com/finlynq/finlynq/issues/32))** (no tool count change): `record_transaction` / `bulk_record_transactions` writes to an `is_investment=true` account with no `category` no longer pick expense categories. The MCP `autoCategory` helper takes an `isInvestmentAccount` flag; in that mode, expense (`type='E'`) candidates are filtered out of both rule and history candidate pools, a payee-keyword pass routes `dividend` → `Dividends`, `interest` → `Credit Interest`, `forex` / `\bfx\b` / `currency` → `Currency Revaluation` / `Transfers`, and `disbursement` / `withdrawal` → `Transfers` (first-name-found wins among the user's existing categories), and the final fallback prefers `Transfers` / `Investment Activity` over null. Pure routing helpers `pickInvestmentCategoryByPayee` + `fallbackInvestmentCategory` live in [src/lib/auto-categorize.ts](../../src/lib/auto-categorize.ts) so the logic is unit-tested. Stdio MCP unchanged — investment-account writes are already refused there.
- **2026-04-30 — `record_trade` brokerage primitive added ([#34](https://github.com/finlynq/finlynq/issues/34))** (81 → 82 HTTP, 77 → 78 stdio; the prior CLAUDE.md figure of 75 stdio was 2 short of the actual surface):
  - `record_trade(account, side, symbol, quantity, price, currency?, fees?, fxRate?, date?, note?)` — wraps `record_transfer`'s same-account in-kind path so a buy/sell produces a paired (cash sleeve ↔ symbol holding) transfer atomically. `BUY` source = cash sleeve, destination = symbol (auto-created if missing). `SELL` mirrors — symbol must exist, cash sleeve auto-created if missing.
  - Refuses non-investment accounts. The cash sleeve is found-or-created per-currency: same currency as the account → reuses the default `Cash` (symbol IS NULL) sleeve via the existing isCurrencyCodeSymbol pattern; foreign currency → mints `${currency} Cash` with `symbol = currency` so the portfolio aggregator routes it through the cash branch.
  - Cross-currency trades require explicit `fxRate` (trade currency → account currency). The cost-basis amount is locked at `quantity × price × fxRate` in account currency; the source/destination quantities stay in their native units (cash dollars for the sleeve, shares for the symbol).
  - Optional `fees` post as a separate negative-amount transaction on the cash sleeve, tagged `source:record_trade,trade-link:<linkId>` for traceability — NOT part of the transfer pair.
  - Stdio gets the same tool — stdio's record_transaction refuses investment-account writes (no portfolioHolding plumbing), but `record_trade` carries its own holding semantics so the constraint is satisfiable on stdio too. Stdio writes stay plaintext per the existing carve-out.
  - See "Modeling brokerage statements with MCP" below for the recipe + the three statement-shape gotchas.
- **2026-04-30 — `bulk_update` strict schema + name-resolved category/holding ([#61](https://github.com/finlynq/finlynq/issues/61))** (no tool count change):
  - `preview_bulk_update` / `execute_bulk_update` `changes` schemas are now `.strict()` — unknown keys hard-fail at validation time. The previous behavior stripped unknown keys silently, so calls like `changes: { category: "Credit Interest" }` returned `success: true, updated: N` while writing nothing (real-world fallout: 13 IBKR Joint transactions stuck mis-categorized because the silent no-op masked every retry).
  - **HTTP-accepted `changes` keys (now 11):** added `category` (name → `category_id`), `quantity` (nullable; `null` clears), `portfolioHoldingId` (FK with ownership pre-check), `portfolioHolding` (name/ticker → FK via the existing `resolvePortfolioHoldingByName`). All other keys unchanged. Disagreement between `category`/`category_id` or `portfolioHolding`/`portfolioHoldingId` errors out the call.
  - **Stdio surface narrower by design.** Stdio adds only `category` (name → id). `quantity` / `portfolioHoldingId` / `portfolioHolding` stay HTTP-only because stdio has no holding plumbing — mirrors the stdio `record_transaction` carve-out that already refuses investment-account writes. A stdio caller passing `quantity` now gets a clean strict-mode 400 instead of a silent no-op.
  - **`resolveBulkChanges` helper (new, both transports).** Resolves names → ids ONCE upstream of `previewBulk` and `commitBulkUpdate`. Returns `{ resolved, unapplied[], error? }`. `error` (id-vs-name disagreement) hard-fails the call; `unapplied[]` (e.g. ambiguous category, holding not found) flows through to `unappliedChanges` on the response so callers see WHY any sample row's before/after looks identical.
  - **Confirmation-token stability preserved.** Token signs the user-supplied `changes` (not the resolved form) so preview→execute round-trips with the same payload still match; execute re-runs resolution.
  - **`execute_bulk_update` aborts on empty resolved set.** Previously, a request with only an unresolvable `category` would commit zero rows and report success. Now: if every requested change failed resolution, the call errors with `Resolution failures: …` and writes nothing.
  - **Audit-trio invariant preserved (issue #28).** Every new UPDATE branch in `commitBulkUpdate` (quantity, `portfolio_holding_id`) appends `updated_at = NOW()`; `source` is INSERT-only and never touched by `bulk_update`. `invalidateUserTxCache(userId)` continues to fire on every successful commit.

- **2026-05-01 — `from_account_id` / `to_account_id` / strict resolver on `record_transfer` + `record_trade` ([#85](https://github.com/finlynq/finlynq/issues/85))** (no tool count change):
  - Extends the #29 `account_id` + low-confidence-rejection pattern to the remaining money-moving entry points: `record_transfer` (HTTP + stdio) and `record_trade` (HTTP + stdio). The same silent-routing failure mode #29 fixed for `bulk_record_transactions` (99 IBKR rows misrouted to "Appartment" because every fuzzy-account name fell through to a substring match) was still possible on the transfer + trade paths.
  - `record_transfer` (both transports) now accepts **`from_account_id?: number`** and **`to_account_id?: number`**. When set, fuzzy matching is skipped; the FK is validated against `accounts.user_id = ?`. The `fromAccount` / `toAccount` (name) params become optional — at least one of (id, name) per side is required.
  - `record_trade` already had `account_id` from the bulk-rollout; this issue replaces the loose `fuzzyFind` fallback (HTTP + stdio) with `resolveAccountStrict`. Behaviorally identical for confidently-matching names; sloppy substring routes now error.
  - Error shape mirrors `record_transaction`: `Source account "<name>" did not match strongly — closest is "<name>" (id=N) but no shared whitespace token. Re-call with from_account_id=N if that's right, or pick another from: <list>`.
  - **`resolvedFromAccount: { id, name }` + `resolvedToAccount: { id, name }`** added to `record_transfer` success responses so callers can verify routing immediately. **`resolvedAccount: { id, name }`** added to `record_trade` to match.
  - Existing alias / exact / startsWith / token-gated-substring tiers continue to work — confidently-matching names route unchanged.
  - Audit `source` plumbing through `createTransferPair{,ViaSql}` preserved (`txSource: "mcp_http"` / `"mcp_stdio"`); per-user tx cache invalidation (`invalidateUserTxCache(userId)` for both legs) preserved.

- **2026-04-30 — `account_id` on transaction read/write tools, low-confidence fuzzy rejected ([#29](https://github.com/finlynq/finlynq/pull/29))** (no tool count change):
  - `search_transactions` gains `account_id?: number` (HTTP + stdio) — FK fast-path mirroring the existing `portfolio_holding_id` filter, intended for dedup workflows against blank-payee bank-imported transfers where text search misses. Bump `limit` accordingly when this is the only filter.
  - `record_transaction` and `bulk_record_transactions` gain `account_id?: number` (HTTP + stdio). On bulk it lives at both the top level (applies to every row that omits its own) and per row (wins over both name and the top-level fallback). When set, the resolver skips fuzzy matching entirely; the `account` (name) parameter is now optional but at least one of the two must be present.
  - **New `resolveAccountStrict` helper** ([register-tools-pg.ts](../../mcp-server/register-tools-pg.ts) + [register-core-tools.ts](../../mcp-server/register-core-tools.ts)) used on the name path. Same exact/alias/startsWith waterfall as `fuzzyFind`, but substring/reverse-substring hits are only accepted when input and candidate share a whitespace-separated token of length ≥3. Otherwise the row fails with a "did you mean … (id=N)?" error pointing to what `fuzzyFind` would have picked. Reads still use plain `fuzzyFind` — wrong filters are recoverable, wrong writes aren't.
  - **`resolvedAccount: { id, name }` returned in every per-row write response** so the agent can verify routing immediately. On `record_transaction` it's at the top level; on `bulk_record_transactions` it's per result entry — including per-row failures, once the account resolved (so the agent knows which account a row was *about to* write to).
  - Stdio carve-out unchanged — investment-account writes are still refused on stdio (no `portfolioHolding` plumbing); `account_id` resolution runs first and the constraint check fires after. Issue #85 (2026-05-01) extended the same pattern to `record_transfer` + `record_trade`.
- **2026-04-28 — Holding-id ergonomics on portfolio reads + writes** (no tool count change; commits [`ca0a117`](https://github.com/finlynq/finlynq/commit/ca0a117) + [`f429c6f`](https://github.com/finlynq/finlynq/commit/f429c6f)):
  - `get_portfolio_analysis` now returns `id` per holding; `analyze_holding` returns `holdingId`. Both transports. Source: the FK already plumbed through `aggregateHoldings()` `accumulate()` ("first non-null id wins"); the response mappers were dropping it on the floor — write-tool descriptions told the agent to "Get the id from get_portfolio_analysis" but the read tool didn't expose it (root cause of the user-reported "MCP records the sale but the holding never moves" — agent had no way to populate `portfolioHoldingId`).
  - `record_transaction` / `bulk_record_transactions` / `update_transaction` now accept **`portfolioHolding`** (name OR ticker symbol) alongside `portfolioHoldingId`. Resolved via the lookup-only helper `resolvePortfolioHoldingByName` — exact case-insensitive match against `name` / `name_lookup` / `symbol` / `symbol_lookup`, scoped to the resolved account, no auto-create. Errors with a "Name (TICKER)" candidate list on miss; errors when both `portfolioHolding` and `portfolioHoldingId` are passed and disagree (silent "I named X but you bound Y" is worse than rejecting). Mirrors the HMAC dual-cohort handling in `portfolio-holding-resolver.ts` but single-shot — no map pre-build. **HTTP only** — stdio MCP write tools still don't bind to portfolio_holdings (pre-existing carve-out per [Self-hosted limitation](#self-hosted-limitation--stdio-writes-are-plaintext)).
  - `analyze_holding(symbol)` now actually filters by the holding's `symbol` column (HTTP JOINs `ph.symbol_ct` + decrypts; stdio LEFT JOINs `portfolio_holdings` and adds `LOWER(ph.symbol) = LOWER(?)` to the WHERE). Description always claimed "fuzzy match on name OR symbol" — until this commit it only matched name (via `portfolio_holding` text) + payee. Symbol uses **exact** equality, not substring — tickers are short and prone to spurious hits like "GE" matching "ORANGE". Name + payee retain substring matching for long-string ergonomics.

## Modeling brokerage statements with MCP

Brokerage statements have a handful of row shapes that consistently confuse agents reading the tool surface. This section is the canonical recipe — when an agent is importing a statement and is unsure how to model a row, the answer should come from here, not from improvised `record_transaction` calls that lose the holding link.

**Default to `record_trade` for buys and sells.** Modeling a trade by hand with `record_transfer` requires assembling `fromAccount = toAccount`, explicit `holding` + `destHolding`, `quantity` + `destQuantity`, `enteredAmount = cashAmount`, optional `receivedAmount` for FX. This is non-obvious and agents tend to fall back to `record_transaction`, which loses the holding-pair link and atomic two-leg semantics. `record_trade` is the high-level wrapper:

```
record_trade(account="Questrade USD", side="buy", symbol="AAPL", quantity=10, price=150)
record_trade(account="Questrade USD", side="sell", symbol="AAPL", quantity=5, price=160, fees=4.95)
record_trade(account="Questrade CAD", side="buy", symbol="AAPL", quantity=10, price=150, currency="USD", fxRate=1.37)
```

For trades that don't fit the cash-sleeve ↔ symbol-holding shape (in-kind ACATS between brokerages, share-class conversions, rebalances between two existing positions in one account), drop down to `record_transfer` directly — see the `holding` / `destHolding` / `quantity` / `destQuantity` parameters and the in-kind examples in the tool description.

### The three statement gotchas

**(a) Forex trades that look like cross-account transfers but are actually same-account currency conversions.** A statement entry "USD/CAD 1370.00 → 1000.00" inside a single brokerage account is a Norbert's Gambit / FX conversion between the account's CAD cash sleeve and its USD cash sleeve. It is NOT two separate accounts. Model it as an in-kind same-account transfer between the two cash sleeves with `record_transfer`:

```
record_transfer(
  fromAccount="Questrade", toAccount="Questrade",
  amount=1370,                    # CAD leaving
  receivedAmount=1000,            # USD landing — locks fxRate=1000/1370
  holding="CAD Cash", destHolding="USD Cash",
  quantity=1370, destQuantity=1000,
)
```

If the user has a single account with both CAD and USD cash sleeves, this is one statement row → one transfer pair. `record_trade` does NOT handle pure forex (no symbol holding involved); use `record_transfer` directly. Agents that try to model this as `record_transaction(amount=-1370)` + a separate `record_transaction(amount=+1000)` end up with two unlinked rows the user has to reconcile by hand.

**(b) Wire-out events that look like expenses but are cross-account transfers to a bank.** A "WIRE OUT - $5000.00" line on a brokerage statement is the brokerage debiting the user's cash sleeve and sending the funds to an external bank account the user already tracks in Finlynq. Model it as `record_transfer(fromAccount=brokerage, toAccount=bank, amount=5000, holding="Cash", quantity=5000)`. The transfer's auto-created `Transfer` category keeps it out of the user's expense reports; modeling it as `record_transaction(amount=-5000, category="Bank Fees")` would inflate spending and skip the offsetting deposit on the bank side.

**(c) Cancellation / re-issue triplets that net to one entry.** Brokerages often book a trade as three rows: the original execution, a same-day cancellation (equal-and-opposite), and a corrected execution at a different price. Net effect = the corrected execution alone. **Skip the canceled and re-issued legs entirely** — book ONE `record_trade` for the final corrected price/quantity. Importing all three rows into the database yields three transactions whose share counts sum correctly but whose cost-basis history is misleading: the average-cost aggregator sees three buys instead of one.

The canceling row is identifiable by an exactly-opposite quantity AND amount on the same date with the same symbol; the re-issued row carries the corrected numbers. The import-pipeline's dedup engine (SHA-256 hash + bank `fitId`) handles this when the connector tags it correctly, but ad-hoc imports via MCP need the agent to apply the rule explicitly.

### Why not just expose `record_transaction(quantity=…)` for trades?

`record_transaction` writes a single row. A buy or sell is two ledger entries (cash side + holding side) that must move together — the holding's share count (`quantity`) AND the cash sleeve's balance (`amount`) both change. Splitting them into two `record_transaction` calls leaves them unlinked: no shared `link_id`, the unified-edit view in the UI can't fold them back into one operation, and the four-check transfer-pair rule fails. `record_trade` (and `record_transfer` underneath it) writes both rows in a single DB transaction with a server-generated UUID `link_id`, mirroring how the web UI's `/api/transactions/transfer` POST handler works.

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

### `update_transaction` response shape ([#60](https://github.com/finlynq/finlynq/issues/60))

`update_transaction` (HTTP + stdio) returns explicit column attribution on success instead of an opaque field count:

- `fieldsUpdated: string[]` — the exact list of column names actually written (`["category_id", "payee"]`). Replaces the legacy `"updated (N field(s))"` message which masked silent category drops on Stream-D Phase-3 users (see below).
- `resolvedCategory: { id, name }` — only present when `category` was in the input AND the resolver succeeded. Mirrors the per-row shape `bulk_record_transactions` already returns at [register-tools-pg.ts:1966](../../mcp-server/register-tools-pg.ts).
- `updatedAt` and `warnings` unchanged.

### Strict category resolver on writes ([#60](https://github.com/finlynq/finlynq/issues/60))

`update_transaction` uses `resolveCategoryStrict` (analogous to `resolveAccountStrict`) instead of plain `fuzzyFind`. Substring/reverse-substring matches are gated on a length-≥3 whitespace-token overlap, so a sloppy `"Cr"` no longer routes a write to `"Credit Interest"`. On HTTP, the SELECT pulls `name_ct` and runs `decryptNameish(rawCats, dek)` before resolving — without this, Stream-D Phase-3 users (NULL plaintext `categories.name`) hit `fuzzyFind`'s reverse-includes branch (`lo.includes("")` is always true) and silently match the FIRST category in the list. Low-confidence misses return `Category "X" did not match strongly — did you mean "Y" (id=N)?` so the agent has an explicit recovery path. Stdio mirrors the strict resolver but skips the decrypt step (stdio writes are plaintext).

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
