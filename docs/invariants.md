# Load-bearing invariants

The rules that have bitten us before. Don't regress on them without a comment explaining why.

CLAUDE.md keeps the one-line rule for each invariant; this doc keeps the full mechanics, callsite lists, and post-launch fix logs. Topic-specific architecture docs ([encryption](architecture/encryption.md), [mcp](architecture/mcp.md), [bank-ledger](architecture/bank-ledger.md), [database](architecture/database.md)) own the deeper design narratives — this file is the catch-all for gotchas that don't have a natural home there.

---

## Lot-tracked portfolio cost basis

(plan/portfolio-lots-and-performance.md, 2026-05-25.) Three new schemas land in [scripts/migrations/20260525_holding_lots_phase1.sql](../scripts/migrations/20260525_holding_lots_phase1.sql) + [20260601_portfolio_snapshots_phase3.sql](../scripts/migrations/20260601_portfolio_snapshots_phase3.sql): `holding_lots` (per-lot cost basis, FIFO depletion), `holding_lot_closures` (one row per (close_tx, lot) pair with realized_gain snapshot), `portfolio_lots_status` (per-user feature flag + backfill watermark — `enabled=false` by default), `portfolio_legacy_realized_gain_snapshot` (pre-cutover avg-cost tooltip data), `portfolio_snapshots` (daily market_value + cost_basis + net_contribution for the performance chart).

**Writes happen unconditionally**: every transactions write-site (REST POST/PUT/DELETE, createTransferPair{,ViaSql} + their delete variants, executeImport per-row, MCP HTTP record_transaction + delete_transaction) routes through [src/lib/portfolio/lots/write-hooks.ts](../src/lib/portfolio/lots/write-hooks.ts) (`applyLotEffectsForTx` / `transferLotHook` / `reverseLotsForDeleteHook`). The hooks soft-fail internally so a lot-side bug never breaks the underlying tx INSERT. The 7th audit invariant `lots-write-hook` in [scripts/audit-invariants.ts](../scripts/audit-invariants.ts) keeps this honest.

**Reads stay legacy until flag-flip** — [src/lib/portfolio/lots/read.ts](../src/lib/portfolio/lots/read.ts) exposes `isLotsEnabledForUser` + `loadMetricsForUser` so the three aggregators (REST `/api/portfolio/overview`, `holdings-value.ts`, MCP HTTP `aggregateHoldings`) can opt in once a user's backfill is verified. Backfill is [scripts/backfill-portfolio-lots.ts](../scripts/backfill-portfolio-lots.ts) (idempotent, marks `backfill_done=true` but leaves `enabled=false` — flag-flip is a manual SQL update after canary diff).

**Realized-gain math honors all six aggregator invariants** (#25 grain, #84 dividend-by-category, #96 paired cash-leg cost substitution, #128 paired-cash-leg sell-branch skip, #129 per-currency bucketing, #236 no amount<0 prefilter) — the engine in [src/lib/portfolio/lots/engine.ts](../src/lib/portfolio/lots/engine.ts) encodes each one; backfill reuses the same engine for parity.

**Dashboards + MCP**: Phase 2 ships [/portfolio/realized-gains](../src/app/(app)/portfolio/realized-gains/page.tsx) + [/portfolio/dividends](../src/app/(app)/portfolio/dividends/page.tsx) + MCP HTTP `get_realized_gains` + `get_dividend_income`. Phase 3 ships the [PerformanceChart](../src/components/portfolio/PerformanceChart.tsx) (TWRR Modified Dietz chained daily + MWRR XIRR), API at `/api/portfolio/performance`, the cron at [src/lib/cron/portfolio-snapshots.ts](../src/lib/cron/portfolio-snapshots.ts) (registered from [instrumentation.ts](../src/instrumentation.ts) — `src/lib/cron/index.ts` doesn't exist), backfill at [scripts/backfill-portfolio-snapshots.ts](../scripts/backfill-portfolio-snapshots.ts), and MCP HTTP `get_portfolio_performance_v2`. TODOs left under baseline exceptions in `scripts/audit-invariants.ts`: MCP HTTP `bulk_record_transactions` / `record_trade` / `update_transaction` still need lot-hook wiring before any user's `enabled` flag flips TRUE.

## Financial health calculator is a single source of truth

At [src/lib/financial-health.ts](../src/lib/financial-health.ts) (FINLYNQ-94, 2026-05-23). Do NOT duplicate the formulas in route bodies or MCP tool bodies — every callsite (`/api/health-score`, MCP HTTP `get_financial_health_score`) goes through `calculateFinancialHealth({ db, userId, dek, reportingCurrency })`.

**6 components, weights 0.25 / 0.20 / 0.15 / 0.15 / 0.15 / 0.10** (Savings Rate / DTI / Emergency Fund / NW Trend / Budget Adherence / Age of Money — sum 1.0). Excluded components (insufficient history, no budgets, AoM ageInDays=0) drop out and the remaining weights renormalize across kept ones (per #235). **Age of Money is the 6th** — the promoted MCP #235 impl dropped it; FINLYNQ-94 restored it (the REST impl never dropped it).

All queries are over plaintext columns (`categories.type`, `accounts.type`, `accounts.group`, `accounts.is_investment`, `transactions.amount`, `transactions.date`, `budgets.amount`); `dek` is accepted as a future-extension param but is unused today. The MCP-only `detailRich` field on Net Worth Trend carries the structured `{direction, magnitudePct, descriptor}` shape introduced in #235; surface it in dialog UIs that need the parsed delta. Stdio MCP doesn't expose this tool today.

## Two-ledger import model

(2026-05-22.) `bank_transactions` is the persistent, append-only-ish bank-side ledger. `transactions.bank_transaction_id` (nullable UUID, ON DELETE SET NULL) is the lineage FK. Full design + post-launch fix log: [bank-ledger.md](architecture/bank-ledger.md).

1. **Content immutability** — `import_hash`, `fit_id`, `date`, `amount`, `payee`, `tx_type` are NEVER updated after first INSERT; only `last_seen_at` / `seen_count` / `source_filenames` bump on re-import via the [upsertBankTransaction](../src/lib/bank-ledger.ts) ON CONFLICT path.
2. **Dedup source-of-truth moved** from `transactions.import_hash` → `bank_transactions.import_hash`: `checkDuplicates` / `checkFitIdDuplicates` / `findDuplicateMatches` / `findFitIdMatches` in [src/lib/import-hash.ts](../src/lib/import-hash.ts) query the bank ledger. A deleted system-side transaction no longer creates a re-import gap. The `*Matches` variants LEFT JOIN to `transactions` via `bank_transaction_id` and surface `id: null` when no transaction is linked.
3. **`occurrence_index` disambiguates same-day duplicates** within a single upload via [assignOccurrenceIndices](../src/lib/import-hash.ts) — without it, two `$5 coffee` rows on the same day same payee collapse via ON CONFLICT into one bank row.
4. **`account_id` is NOT NULL** on `bank_transactions` (Postgres treats NULL as distinct in unique indexes — a NULL account row would dedup against nothing); upload route enforces a resolved account before staging.
5. **Diverge by design**: `transactions.account_id` is user truth, `bank_transactions.account_id` is statement truth. They MAY diverge after a user account-move. Do NOT auto-relink the FK.
6. **Import-sourced INSERTs into `transactions` must set `bank_transaction_id`** — the 4 chokepoints are [executeImport](../src/lib/import-pipeline.ts), [createTransferPair](../src/lib/transfer.ts), [createTransferPairViaSql](../src/lib/transfer.ts), and the approve route's peer-pair bucket. Manual REST/MCP HTTP entries leave it NULL.
7. **`executeImport` gained an options object** (5th param + new 6th): `executeImport(rows, force, userId, dek, txSource, { bankLedgerMode, filename, stagedImportId })`. Default `bankLedgerMode='merge'`; backup-restore passes `'preserve_ids'` with `RawTransaction.bankTransactionId` pre-resolved.
8. **`createTransferPair*` gained `fromLegBankTransactionId` / `toLegBankTransactionId`** opts. Pre-resolved by the approve route's target-transfer bucket; manual UI / MCP calls leave both null.
9. **Login-time `upgradeStagingEncryption` extends to `bank_transactions`** — same service→user re-encrypt pass for service-tier bank rows from the email-webhook ingest path.
10. **Wipe-account deletes `bank_transactions` AFTER `transactions`** in the single-transaction scope (FK is ON DELETE SET NULL, so transactions wipe first, then user_id-scoped bank delete is a clean drop).
11. **Backup-restore preserves bank lineage** — re-inserts `bank_transactions` BEFORE `transactions`, builds `bankTxIdMap` (UUID → UUID), remaps `transactions.bank_transaction_id`. Pre-refactor backups (no `bankTransactions` array) restore with NULL FK — accepted lineage loss.
12. **F-53E overlap-merge dialog is gone** — re-uploads of identical files still produce a staged batch but every row is auto-flagged `reconcile_state='skipped_duplicate'` via the bank-ledger probe; user rejects with one click. The `/api/import/staging/upload` route no longer accepts `action` or `mergeIntoStagedImportId` form fields.
13. **`source` on `bank_transactions`** is a strict subset of `TransactionSource`: only `'import' | 'connector' | 'backup_restore'`.
14. **Bank-ledger upserts are FATAL** — `upsertBankTransaction` failures in [import-pipeline.ts](../src/lib/import-pipeline.ts) and the approve route's peer-pair + target-transfer branches abort the entire approve before any `transactions` INSERT runs. The previous silent-continue (errors appended to `importErrors[]`) produced exactly the symptom seen on dev launch day: rows landing in `transactions` with NULL `bank_transaction_id` while the bank-ledger pane stayed empty. The approve route catches the throw and returns `{ success: false, code: "bank_ledger_upsert_failed", error }`; the `/import/pending` page renders the unwrapped PG-cause message (code + detail) in the toast so the actual root cause surfaces (was a `${array}::TEXT[]` literal bug fixed in [bank-ledger.ts](../src/lib/bank-ledger.ts) — Drizzle doesn't serialize JS arrays to PG's `{elem}` literal form; use `ARRAY[${elem}]::TEXT[]` instead).
15. **File → bank-ledger dedup is exact-only** — the probable-duplicate fuzzy pass (`buildDuplicateCandidatePool` / `detectProbableDuplicates`) was removed from `/api/import/staging/upload` on 2026-05-22 dev. File-side classification is `'new'` vs. `'existing'` only; `'probable_duplicate'` is no longer produced (DB CHECK still permits legacy rows). The fuzzy infrastructure remains in [src/lib/external-import/duplicate-detect{,-pool}.ts](../src/lib/external-import/duplicate-detect.ts) for the future bank-ledger → transactions reconciliation surface.
16. **Bank-ledger UI feed at `/import/pending`** — left pane reads from new endpoint [GET /api/import/bank-ledger?accountId=X](../src/app/api/import/bank-ledger/route.ts) returning the FULL continuous history (no date window), NOT from `/api/transactions/reconciliation` (±7d window over `transactions`). `DbTransactionRow.id` is now `string` (bank UUID); separate `linkedTransactionId: number | null` carries the system-side tx id. Link / flag actions in the page target `linkedTransactionId` — bank-only rows (history without a current transaction) render as read-only "bank-only". Migration: [scripts/migrations/20260522_bank-transactions-ledger.sql](../scripts/migrations/20260522_bank-transactions-ledger.sql).
17. **M:N reconcile join + dual-write** (2026-05-23) — `transaction_bank_links(id, user_id, transaction_id, bank_transaction_id, link_type, source, created_at)` lifts the 1:1 FK to many-to-many in both directions (1 bank → N tx and N bank → 1 tx) for the standalone [/reconcile](../src/app/(app)/reconcile/page.tsx) surface. `link_type` is `'primary' | 'extra'`; every primary join row mirrors `transactions.bank_transaction_id`. CASCADE on both FKs so wipe-account + tx-delete clean up automatically; existing wipe ordering is unchanged. Migration [scripts/migrations/20260523_transaction-bank-links.sql](../scripts/migrations/20260523_transaction-bank-links.sql) creates the table + backfills primary rows from every existing FK + extends the `transactions.source` CHECK with the new `'reconcile_link'` writer-surface label (used by `POST /api/reconcile/materialize` when the user materializes a tx from a bank-only row). **Dual-write invariant**: every site that sets `transactions.bank_transaction_id` on a fresh INSERT must also INSERT a `link_type='primary'` row in the same DB scope via `ON CONFLICT (transaction_id, bank_transaction_id) DO NOTHING`. The 4 retrofitted callsites — [executeImport](../src/lib/import-pipeline.ts), [createTransferPair{,ViaSql}](../src/lib/transfer.ts), staged-approve peer-pair bucket in [approve/route.ts](../src/app/api/import/staged/[id]/approve/route.ts), and backup-restore in [data/import/route.ts](../src/app/api/data/import/route.ts) — use `source='import'` or `'backup_restore'`; reconcile-page-driven writes (`linkTransactionToBank` / materialize) use `'manual'` / `'reconcile_link'`. Reconcile-page user-driven writes route through [src/lib/reconcile/links.ts](../src/lib/reconcile/links.ts) which owns the FK transition (set on primary-INSERT when FK was NULL; clear on primary-DELETE when FK still points there). Reads on the `/reconcile` page route through [src/lib/reconcile/match-engine.ts](../src/lib/reconcile/match-engine.ts) — three layers: `join_existing` → `exact_hash` (tx.import_hash = bank.import_hash) → `fuzzy` (small purpose-built bank↔tx scorer; defaults from `RECONCILE_DEFAULT_THRESHOLDS` re-exported from [duplicate-detect.ts](../src/lib/external-import/duplicate-detect.ts) `DEFAULT_OPTIONS`). Thresholds persist per-user in `settings(key='reconcile_thresholds')` via `/api/settings/reconcile-thresholds`, edited at [/settings/reconciliation](../src/app/(app)/settings/reconciliation/page.tsx). **`import_hash` is NEVER recomputed** by the materialize path — it's copied verbatim from the bank row (load-bearing dedup invariant). Backup export at [data/export/route.ts](../src/app/api/data/export/route.ts) now serializes `transactionBankLinks[]`; restore reinserts after `transactions` with the FK-derived primary rows as a safety net for pre-2026-05-23 backups. Stdio MCP exposes no reconcile tools today (HTTP only for v1).

## Bank balance anchors

(2026-05-24.) New table `bank_daily_balances(user_id, account_id, date, balance, currency, source, source_filenames[], first_seen_at, last_seen_at)` with PK on `(user_id, account_id, date)`. An anchor is "the bank told us X on date D" — independent of `bank_transactions` rows so it survives row deletion and can exist on days with no transactions. See [bank-ledger.md](architecture/bank-ledger.md) "Daily balance anchors" for the full design.

**One anchor per day**: parser walks the CSV row-by-row and OVERWRITES on every `(date)` hit so the final map value is the last-in-file-order's balance for that date (the "last effective balance of the day" — works for ASC or DESC file sort alike).

**Three live anchor sources**: `csv_column` (CSV with a mapped "Balance" column via [extractBalanceAnchors](../src/lib/csv-parser.ts)), `ofx_ledgerbal` (OFX/QFX `<LEDGERBAL><BALAMT>` + `<DTASOF>`), `upload_form` (user-typed `statementBalance` form field on /import/reconcile). Reserved future sources: `email`, `connector`, `backup_restore`.

**Re-import semantics**: `ON CONFLICT (user_id, account_id, date) DO UPDATE` — newer balance wins, `last_seen_at` bumps, `source_filenames` appends. A re-downloaded statement with a corrected value should overwrite (load-bearing).

**Anchor commit gate** (2026-05-22 final): the approve route at [staged/[id]/approve/route.ts](../src/app/api/import/staged/%5Bid%5D/approve/route.ts) fires `upsertBankBalanceAnchors` whenever `boundAccountId != null && dedupedAnchors.length > 0` — **explicitly NOT gated on `imported > 0` and NOT gated on `importErrors.length === 0`**. The `dedupedAnchors` block lives ABOVE the "No rows selected" early-return so an anchors-only approve (every row dupe, no linked rows) bypasses that 400 via a fresh `anchorsOnlyApprove = staged.boundAccountId != null && dedupedAnchors.length > 0` flag. Anchors are a sibling fact to transactions: row-materialization absence does NOT invalidate them. The `importErrors` clause was tried as a rollback signal but `executeImport` pushes per-row WARNINGS (not failures) into that array — things like "auto-created Cash holding" or "category not found, defaulted to X" — and a single warning silently discarded every anchor. Real catastrophic failure paths (bank-ledger upsert throws, FX engine throws) abort the approve before reaching this block via earlier returns, so the gate has full rollback semantics without the false-positive clause.

**Template→bound_account_id wiring** (2026-05-22): `import_templates.default_account` (a stored account NAME) is now propagated end-to-end. `TemplateOption` on [components/reconcile/upload-card.tsx](../src/components/reconcile/upload-card.tsx) carries `defaultAccount?: string | null`; `applyTemplateKnobs` resolves it against the loaded `accounts` prop and `setSelectedAccountId(matchedId)`; `/import/reconcile/page.tsx` `templateOptions` mapping propagates the field (was dropping it). Net effect: picking a template with `default_account` set → account dropdown auto-fills → `accountId` reaches upload form-data → `staged_imports.bound_account_id` gets set → anchor upsert gate `boundAccountId != null` passes. Without this, anchors landed in `parsed_anchors` JSONB but never reached `bank_daily_balances`.

**Validation algorithm** at [validateBankBalances](../src/lib/bank-ledger-balance.ts) is **checkpoint-style and NON-compounding** — for each anchor in the staged batch, find the most-recent prior anchor in `bank_daily_balances`, sum bank-row amounts strictly between `(prior.date, new.date]`, compare `prior.balance + sum` to `new.balance` against a `0.005` float tolerance. Errors do NOT compound forward — period N validates against period N-1's anchor regardless of whether N-1 itself had a mismatch (user decision 2026-05-22). **First-ever import = first anchor**: no prior anchor → skip validation for that anchor. No backward extrapolation, no opening-balance UI on accounts. **Mismatches are warn-but-allow**: approve route returns `balanceWarnings: BalanceMismatch[]` and the /import/pending page renders [BalanceWarningBanner](../src/components/staging/balance-warning-banner.tsx) above the per-row list; user clicks Approve regardless.

**The bank-vs-system compare renders on `/import/pending` only** (relocated from `/reconcile` per user decision 2026-05-22) via [BalanceSummaryCard](../src/components/reconcile/balance-summary-card.tsx) reading [GET /api/reconcile/balance-summary?accountId=X](../src/app/api/reconcile/balance-summary/route.ts) — bank-side = `latestAnchor.balance + Σ(bank_tx.amount where date > latestAnchor.date)` when an anchor exists, **`null` when no anchor exists** (the previous `sumAllBankAmounts` sum-from-zero fallback was removed 2026-05-22); system-side = canonical account-balance (investment → `getHoldingsValueByAccount[id].value`, cash → `SUM(transactions.amount)`); `delta = systemSide - bankSide` (also null when bankSide is null); status enum is `balanced | mismatch | no_anchor`. The card renders "—" for both bank-side and delta in the `no_anchor` state. **Anchors-only approve hint**: when `dedupedAnchorsCount > 0 && eligibleRowCount === 0`, an info banner above the row table tells the user that clicking Approve will still load the anchors even though zero rows will materialize.

**Two distinct Balance columns on `/import/pending` bank-ledger pane** (2026-05-22 split): "Calculated" (system-computed) + "Loaded" (bank's reported anchor value), sorted newest-first, one-balance-per-day rule applied independently per column on the FIRST row of each day in display order. Headers always render; cells show "—" when null. The bank-ledger route [/api/import/bank-ledger](../src/app/api/import/bank-ledger/route.ts) enriches each row with `runningBalance` (Calculated) + `anchorBalance` + `anchorSource` (Loaded). The staged pane (right side) shows the file's parsed Balance values from `parsed_anchors` + the upload-form `statement_balance` lifted as a synthetic anchor.

**Calculated algorithm** (2026-05-22 refactor): per-date nearest-prior-anchor lookup with STRICT `<`. For each visible row's date `d`: `lastAnchor = most recent anchor with anchor.date < d` (strictly before, not on the day itself); `calculated[d] = lastAnchor.balance + Σ(bank_tx.amount in (lastAnchor.date, d])`; no `lastAnchor` → `null` (no backward extrapolation from a future anchor). Three properties fall out: (1) on an anchor day, Calculated is derived from the PRIOR anchor — independent of d's own anchor — so Calculated and Loaded become a real cross-check rather than circular logic; (2) drift only accumulates within each anchor-to-anchor gap and resets at the next anchor going forward; (3) dates before the first-ever anchor stay null. New helper [listBankAnchors](../src/lib/bank-ledger-balance.ts); the route does a binary search for the nearest prior anchor + precomputed cumulative sum of bank-tx amounts; O((N+M) log N) per request. **The previous algorithm** (single-latest-anchor projected globally via cumByDate offset) silently ignored every anchor except the latest and let drift compound linearly across the whole history; replaced because the user uploaded 26 anchors and 25 of them were being silently discarded.

**Calculated + Loaded are computed on read** — neither value is stored. **`import_hash` is NEVER recomputed** when anchors are extracted or upserted (load-bearing dedup invariant; anchors are a sibling fact). **`ColumnMapping.balance?: string`** is the new optional field on [import-templates.ts](../src/lib/import-templates.ts); auto-detect picks up "balance" / "running balance" / "closing balance" / "balance after" / "ending balance" / "account balance" headers.

**Anchors round-trip through backup**: `bankDailyBalances[]` array on export, restored after `accounts` with `accountIdMap` remap and `source` falling back to `'backup_restore'` for pre-2026-05-24 backups. **Cascade**: `users.id` ON DELETE CASCADE + `accounts.id` ON DELETE CASCADE — wipe-account and account delete clean anchors automatically. Migration: [scripts/migrations/20260524_bank-daily-balances.sql](../scripts/migrations/20260524_bank-daily-balances.sql) (additive only — also adds nullable `staged_imports.parsed_anchors JSONB` to carry CSV/OFX anchors from upload to approve).

## Crypto / encryption gotchas

### `tryDecryptField` MUST return `null` on auth-tag failure

NOT the raw ciphertext. Still load-bearing for transaction payee/note/tags decryption (those columns are ciphertext-only with no plaintext fallback even pre-Phase-4). For Stream D display names (post Phase 4) the situation is the same: callers get null and render "—"; no plaintext fallback to revive. Returning truthy ciphertext would silently surface `v1:...` strings in the UI. → [encryption.md](architecture/encryption.md) "Footgun"

### Staged-transactions reads MUST branch on `encryption_tier` per row

(2026-05-06.) `'service'` rows decrypt with `decryptStaged()` (PF_STAGING_KEY, `sv1:`); `'user'` rows decrypt with `tryDecryptField(dek, ...)` (user DEK, `v1:`). Mixed tiers within the same `staged_imports` batch are expected mid-upgrade since the login-time job is async. Any new read path that calls `decryptStaged` blindly will return raw `v1:...` ciphertext for already-upgraded rows because `decryptStaged` passes through values without its `sv1:` marker. The three existing read paths in [staged/[id]/route.ts](../src/app/api/import/staged/[id]/route.ts), [staged/[id]/approve/route.ts](../src/app/api/import/staged/[id]/approve/route.ts), and the per-row PATCH at [staged/[id]/rows/[rowId]/route.ts](../src/app/api/import/staged/[id]/rows/[rowId]/route.ts) are the canonical pattern. The upgrade job MUST NOT recompute `import_hash`.

**Issue #155 added per-row PATCH** — same per-row tier branching applies to writes: edited text fields (payee/category/note) re-encrypt under the row's EXISTING tier (service → sv1:, user → v1:); we never flip tiers mid-edit (login-time upgrade job is the only path that promotes service → user). The PATCH endpoint MUST NOT recompute `import_hash` even when payee is edited.

**FINLYNQ-56 (2026-05-20) extended the PATCH** with two reconciliation-action fields — `reconcileState` (enum: `unmatched | auto_suggested | linked | skipped_duplicate`) and `linkedTransactionId` (nullable int, server-validated to belong to the same user — cross-tenant 404). Same invariants apply: `import_hash` NEVER recomputed, `encryption_tier` NEVER flipped, even when the new fields are the only change. State enforcement: `reconcileState='linked'` requires non-null `linkedTransactionId`; non-`'linked'` state forces `linkedTransactionId=null` on the write. Half-pair transfer validation is deferred to APPROVE TIME (not PATCH) per user decision 2026-05-20.

### Stream D Phase 4: writes use `name_ct` + `name_lookup` ONLY

(No plaintext, 2026-05-03 dev, promoted to prod 2026-05-07.) The 8 plaintext columns are physically dropped on **both prod and dev**; writes must call `buildNameFields(dek, { name, ... })` and spread the result into the INSERT/UPDATE values. Without an unlocked DEK the write errors out — no silent "skip the encrypted columns" fallback. Stdio MCP create/update tools for the 6 in-scope tables refuse the operation cleanly because no DEK is available on the stdio transport.

### Dedup keys on `name_lookup` HMAC ONLY

(Post Stream D Phase 4, 2026-05-03 dev + 2026-05-07 prod.) Pre-Phase-4 there were two indexes per table (plaintext + lookup); Phase 4 dropped the plaintext columns so only the HMAC remains. Importers without a DEK can't compute the HMAC and degrade to "no match" — they error or skip rather than misidentify rows.

### `import_hash` always over plaintext payee

AES-GCM uses random IV; ciphertext hashes are non-deterministic. `/api/import/backfill` decrypts before hashing.

### Reads use `requireAuth()` + nullable DEK; writes use `requireEncryption()` (423 if no DEK)

Soft-fallback on read prevents deploy-restart 423 cascades; hard-fail on write prevents silent plaintext leaks. → [encryption.md](architecture/encryption.md) "Read vs write auth guards"

## Staging approve: transfer-pair routing

(Issue #155, 2026-05-06.) The `/api/import/staged/[id]/approve` endpoint classifies selected rows into three buckets BEFORE calling `executeImport`: (a) `tx_type='R'` with `peer_staged_id` set on BOTH legs in the user's selection — mint a single server-side `link_id` (NEVER from client), INSERT both legs in one statement with inverted amounts, type='R', and the same link_id; (b) `tx_type='R'` with `target_account_id` set — call `createTransferPair()` (owns FX, transfer-category resolution, four-check link-id rule); (c) everything else — `executeImport`. Half-pairs (only one of two peer-linked rows checked) error out without materializing — committing a half-pair would orphan the leg. The `peer_staged_id` and `target_account_id` are mutually exclusive (PATCH server-side guard + UI disables the inactive option).

**`RawTransaction.portfolioHoldingId` is a new optional hint** on `executeImport` (issue #155): when set, the holding-name resolver pass is skipped for that row. Used by the staging-approve flow where the user already picked a holding and we have the FK; prevents the resolver from auto-minting a phantom Cash sleeve on top of the user's pick. Other callers (CSV/OFX upload, email-import) still use the historical `portfolioHolding` name path.

## Auto-categorize rules are JSONB conditions + actions

(FINLYNQ-84, 2026-05-21.) Replaces the legacy flat columns (`match_field`, `match_type`, `match_value`, `assign_category_id`, `assign_tags`, `rename_to`). `transaction_rules` now has `conditions JSONB NOT NULL` (AND-only `{ all: Condition[] }` group across 7 field/op combos — `payee/note/tags` string ops, `amount` gt/lt/eq/between, `account` is/is_not, `currency` is/is_not, `date` weekday/day_of_month/between) plus `actions JSONB NOT NULL` (typed array over 7 kinds — `set_category`, `set_tags`, `rename_payee`, `set_entered_currency`, `set_portfolio_holding`, plus two side-effect kinds `set_account`, `create_transfer`). Plus `updated_at TIMESTAMPTZ` audit column + index on `(user_id, is_active, priority DESC)`. Engine at [src/lib/auto-categorize.ts](../src/lib/auto-categorize.ts) (`matchesRule()` AND-folds over `conditions.all[]`); pure-action patcher at [src/lib/rules/execute.ts](../src/lib/rules/execute.ts). Full design: [transaction-rules-v2.md](transaction-rules-v2.md).

**Side-effect actions (`set_account`, `create_transfer`) are REFUSED on the apply-to-committed-rows surfaces** — `apply_rules_to_uncategorized` on both HTTP + stdio surfaces them in `skipped[]` with `reason: 'requires_staging'`. Side-effect actions DO fire from STAGED-batch paths (FINLYNQ-88, 2026-05-22). Approve-time materialization classifier routes the resulting `tx_type='R'` + `target_account_id` rows through `createTransferPair` (mints `link_id` server-side per the four-check transfer-pair rule).

**Rule effects on `staged_transactions` are PERSISTED at upload time + via manual Re-apply** (FINLYNQ-88, 2026-05-22) — `applyRulesToStagedBatch` at [src/lib/rules/apply-to-staged-batch.ts](../src/lib/rules/apply-to-staged-batch.ts) walks active rules over staged rows and folds matched actions into a single tier-preserving UPDATE per row. Three callsites:
1. `POST /api/import/staging/upload` invokes it inside the row-INSERT transaction so users land on `/import/pending` with rule effects visible.
2. `POST /api/import/staged/[id]/apply-rules` is the manual "Re-apply rules" button on `/import/pending` (operates over the entire batch; confirmation modal warns about overwriting manual edits — we don't track touched fields, modal is the safety net).
3. `POST /api/import/staged/[id]/create-rule` (inline rule creation from the unresolved-categories banner) now accepts side-effect actions and applies them scoped to `{ onlyRuleId: ruleId }` so re-running doesn't blow away other rules' effects on user-edited rows.

Helper enforces six invariants in the UPDATE shape: `import_hash` NEVER recomputed even on `rename_payee`; `encryption_tier` NEVER flipped (re-encrypt at the row's existing tier); `reconcile_state IN ('linked', 'skipped_duplicate')` rows SKIPPED entirely; `link_id`/`trade_link_id` NEVER touched (approve-time mint only); cross-tenant FK guards via 3 batched ownership SELECTs with un-owned-FK actions silently SKIPPED at apply time; sign-vs-category mismatch on `set_category` SKIPS just that action (other actions on the same rule still fire). `set_account` to investment account assigns `defaultHoldingForInvestmentAccount` Cash sleeve when `portfolio_holding_id` is currently null AND no `set_portfolio_holding` action fires on the same rule. `create_transfer` skips when the row is already `R`/`T` OR has any pairing field set.

**The `decryptNameish` BEFORE `fuzzyFind` invariant from issue #214 still applies** to every category-by-name resolution site that still uses fuzzyFind — MCP HTTP `create_rule` + `update_rule` keep the legacy shorthand (match_payee + assign_category by NAME) and synthesize the v2 shape internally; the fuzzy resolver pass runs `decryptNameish` first so the waterfall's reverse-includes step doesn't collapse to `lo.includes("")`. The same invariant covers the resolver-class data-loss-risk surface across other delete/lookup tools — audited callsites: HTTP `delete_account` (issue #230), HTTP `delete_budget` + `delete_loan` (issue #211). The `delete_account` hotfix added an `accountId` exact-id param so the destructive write has a DEK-free safe path; new resolver-class tools should follow the same shape.

**MCP stdio `autoCategory()` write-time path is intentionally narrow**: only payee conditions + `set_category` actions land at write time — any other condition kind or action makes the rule ineligible for stdio writes (full-fidelity rule firing is HTTP-only). **`set_portfolio_holding` is assign-existing-id-only** — sidesteps the `holding_accounts` dual-write invariant. **`link_id` / `trade_link_id` are server-generated only** — `create_transfer.linkId` is NOT an action-config field; `createTransferPair` mints it. **`import_hash` is NEVER recomputed** by inline-create-rule batch updates, upload-time rule pre-apply, or manual Re-apply. **Cross-tenant FK guards** via `verifyOwnership({ categoryIds, accountIds, holdingIds })` on every id referenced inside conditions + actions; backup-restore walks the JSONB to remap FKs. **Migration is destructive** (TRUNCATE + DROP/ADD COLUMN) — lives at the LOOSE path [scripts/migrate-finlynq-84-rules-v2.sql](../scripts/migrate-finlynq-84-rules-v2.sql), NOT the auto-run dir.

## Portfolio aggregator alignment

### `qty>0` is a buy regardless of amount sign

Four aggregator implementations must stay aligned (REST `/api/portfolio/overview` + `src/lib/holdings-value.ts` + MCP HTTP `accumulate()` / `analyze_holding` + MCP stdio `get_portfolio_analysis` / `get_portfolio_performance` / `analyze_holding`). Keying on `amt<0` silently drops every WP-imported holding leg.

**As of issue #25 (2026-05-01) every aggregator JOINs through `holding_accounts`** on `(holding_id = t.portfolio_holding_id, account_id = t.account_id, user_id = ?)` so the (holding, account) pair is the join grain. The legacy "holdings-value orphan" path was eliminated when transactions Phase 5 dropped the orphan-fallback decrypt loop on 2026-04-29.

**`holding_accounts.qty` and `holding_accounts.cost_basis` are CACHED columns; aggregators read live `SUM(transactions.quantity)` / cost basis from `transactions` and JOIN `holding_accounts` only for the `(holding, account)` grain. DO NOT switch any aggregator to read the cached columns** — they go stale on every DELETE/transfer (5 known callsites leave them stale-but-harmless) and there is no invalidation path. The cache is reserved for future use; today it is a trap. (issue #99)

**Issue #86 (2026-05-01) — key by id, not name.** MCP HTTP `accumulate()` historically keyed its in-memory `Map` by holding name and silently merged name-collision rows (e.g. VUN.TO across TFSA + RRSP); now `accumulate()` and `aggregateHoldings()` key by `holding_id`, `get_portfolio_analysis` `phMap` by `ph.id`, and `get_portfolio_performance` returns `holdingId` per row. `analyze_holding` (HTTP + stdio) gained an optional `holdingId` parameter; when the substring spans multiple ids the response surfaces an `ambiguous` candidate list rather than averaging across them.

**Issue #129 (2026-05-04) per-currency cost-basis bucketing.** Cross-currency holdings (e.g. a USD ETF inside a CAD account) need cost basis summed in the holding's *own* currency. SELECT `entered_amount`, `entered_currency`, `ph.currency` (holding ccy), `a.currency` (account ccy), and the cash leg's `entered_amount`/`entered_currency`; pre-resolve every distinct `(entered → holding)` FX pair into a sync cache; per-row buy/sell/dividend amount = `ABS(entered_amount) × fx(entered_currency → holding_currency)`. MCP HTTP `analyze_holding`'s `holdingCurrency` is sourced from `ph.currency`, NOT `a.currency`.

**Issue #236 (2026-05-10) — `aggregateHoldings()` MUST NOT pre-filter `t.amount < 0` in SQL.** The legacy `buysOnly: true` opt SQL-prefiltered `t.amount < 0` to "narrow to buys", which silently dropped every WP-imported buy row (WP convention is `amt>0+qty>0`). The opt was removed entirely from the function signature; `get_investment_insights` modes `patterns` + `rebalancing` (HTTP-only) are the fifth caller of the canonical aggregator and inherit the alignment invariant. Buy classification is `accumulate()`'s job, keying on `qty > 0` direction. **Adding the SQL filter back, in `aggregateHoldings()` or any new aggregator path, will silently drop WP-imported buys.** → [encryption.md](architecture/encryption.md) "Portfolio aggregation"

### Every `portfolio_holdings` INSERT path dual-writes a `holding_accounts` row

(Issue #95 + follow-up cohort #205, 2026-05-09.) `holding_accounts(holding_id, account_id, user_id, qty=0, cost_basis=0, is_primary=true)` in the same transaction. Enforced at all 9 sites today: MCP HTTP `add_portfolio_holding` (canonical pattern at [mcp-server/register-tools-pg.ts:4190-4201](../mcp-server/register-tools-pg.ts)), MCP HTTP `record_trade` cash-sleeve auto-create, REST `POST /api/portfolio`, REST `POST /api/portfolio/crypto` (skipped when `accountId` is null), backup-restore bulk insert in `/api/data/import`, [csv-parser.ts](../src/lib/csv-parser.ts) per-row insert, [portfolio-holding-resolver.ts](../src/lib/external-import/portfolio-holding-resolver.ts) auto-create branch, [zip-orchestrator.ts](../src/lib/external-import/zip-orchestrator.ts) bulk insert, and [getOrCreateCashHolding](../src/lib/investment-account.ts) (highest-traffic auto-create). All sites use `ON CONFLICT (holding_id, account_id) DO NOTHING` for idempotency and `DELETE` the orphan `portfolio_holdings` row only on hard pairing-INSERT failure (not on conflict). Stdio MCP create paths refuse cleanly post Stream D Phase 4. Without the pairing the holding is silently invisible to every aggregator and live `SUM(transactions.quantity)` evaluates to 0.

### Goals: multi-account linking via `goal_accounts`

(Issue #130, 2026-05-04.) JOIN grain is `(goal_id, account_id, user_id)`, mirrors the `holding_accounts` pattern. Writes dual-write the legacy `goals.account_id` column (first id only, deprecated, kept for one release cycle as a fallback) AND the join. Reads prefer the join when populated. ON DELETE CASCADE on both `goal_accounts.goal_id` and `goal_accounts.account_id`. Every client-supplied `account_ids` is verified to belong to the user before INSERT (no cross-tenant FK — same risk pattern as backup-restore FK remap). Backup export includes `goalAccounts`; restore wipes BEFORE goals and re-inserts AFTER goals via a new `goalIdMap` in `strip()`. **MCP HTTP `add_goal` / `update_goal` accept `account_ids: number[]`; legacy single `account` (fuzzy-match) still resolves to a one-element list.** Stdio MCP add/update goals continue to refuse cleanly per Stream D Phase 4.

### Dividend classification matches `transactions.category_id = (user's Dividends category)` — NOT a heuristic

(Issue #84, 2026-05-01.) The legacy `quantity == 0 AND amount > 0` heuristic silently dropped (a) dividend reinvestments (qty>0, amt<0) and (b) withholding-tax / negative-correction entries (qty=0, amt<0). The fix routes through [src/lib/dividends-category.ts](../src/lib/dividends-category.ts) `resolveDividendsCategoryId(db, userId, dek)`, which looks up the user's `Dividends`/`Dividend` category id (Stream-D-aware: matches both plaintext `name` and the encrypted `name_lookup` HMAC). Three aggregators are aligned: REST `/api/portfolio/overview` (SQL CASE on `category_id`), MCP HTTP `accumulate()` (per-row `r.category_id` match), MCP HTTP `analyze_holding` (in-memory loop). MCP stdio `analyze_holding` doesn't compute dividends at all today — separate gap, not regressed.

**Buy/sell branches (qty-direction) come first, then the dividend branch is independent** — a dividend reinvestment is now correctly counted as both a buy (shares acquired) AND a dividend (income received). When the user has no Dividends category, `dividendsReceived` sums to 0 cleanly. Don't reintroduce the qty/amount-sign heuristic anywhere. **Partial real-Postgres regression coverage** (FINLYNQ-65, 2026-05-20) — `pf-app/tests/portfolio-aggregator-dividends-and-sellskip.test.ts` exercises MCP HTTP `aggregateHoldings()` against a `finlynq_test` Postgres.

### `link_id` is server-generated only

UUID v4 minted in `createTransferPair`; never accepted from the client. Four-check rule for "is a transfer pair": link_id + sole sibling + both type='R' + different accounts (relaxed for in-kind same-account rebalances).

### `trade_link_id` is server-generated, DISTINCT from `link_id`

(Issue #96, 2026-05-01.) UUID v4 minted in MCP HTTP `bulk_record_transactions` per `tradeGroupKey` group, or supplied to `record_transaction` for second-leg binding (server validates: UUID exists for this user, ≤1 existing leg). Never accepted as a free-form client field. **Multi-currency trade exception:** when a stock-leg buy row has `trade_link_id` matching a paired cash-leg sibling (same user, qty=0/NULL, different id), all four cost-basis aggregators substitute the cash leg's `entered_amount` (in `entered_currency`) for the stock leg's amount. The cash leg is the broker's actual settlement at IBKR's FX rate; the stock leg is the same trade re-priced at Finlynq's live rate (under-counts the spread). DO NOT reuse `link_id` for trade pairs — that would break the four-check transfer-pair rule.

**Realized-gain sell branch (issue #128, 2026-05-04):** the same paired cash-leg row is also EXCLUDED from the qty<0 sell branch in three of the four aggregators (REST `/api/portfolio/overview`, MCP HTTP `accumulate()`, MCP HTTP `analyze_holding`). Predicate is `trade_link_id IS NOT NULL AND amount = 0` — conjunctive so legitimate cash withdrawals (no link, amount<0) keep their sell-branch behavior. Without this skip the cash sleeve booked a phantom realized loss of `-sellQty * avgCost` on every paired buy. → [mcp.md](architecture/mcp.md) "Cost basis rules"

**Phase 2 portfolio-ops convention (2026-05-25) breaks the `amount = 0` half of the issue #128 predicate**: cash legs minted by [src/lib/portfolio/operations.ts](../src/lib/portfolio/operations.ts) have `amount != 0` (they carry the cash effect on the cash sleeve). The issue #128 predicate `trade_link_id IS NOT NULL AND amount = 0` no longer matches them. In practice the new cash legs are still handled correctly because cash sleeves have `is_cash=true` and `holding_lots` is empty for them — so `realizedGainDisplay` stays 0 via the `assetType: "cash"` branch rather than via the sell-skip rule. **However**, when adding any new aggregator path that uses the issue #128 predicate, ALSO match `OR kind LIKE '%_cash_leg'` (or filter on `portfolio_holdings.is_cash=true`) so future operations.ts-minted cash legs stay excluded. → [HANDOVER_2026-05-25_PORTFOLIO_OPS_P3.md](../../HANDOVER_2026-05-25_PORTFOLIO_OPS_P3.md) "Known concerns #4"

## Portfolio operations (Phase 2, 2026-05-25)

Six dedicated operations replace the implicit "any transaction with a `portfolio_holding_id` is a portfolio op" pattern. All entry points (forms at `/portfolio/new`, the `+ Add Transaction` dropdown on `/transactions`, the API routes under `/api/portfolio/operations/*`, MCP via the existing `record_transaction` / `record_trade` tools) eventually go through [src/lib/portfolio/operations.ts](../src/lib/portfolio/operations.ts). The six ops: `recordBuy`, `recordSell`, `recordSwap` (= sell + buy in same account), `recordInKindTransfer`, `recordPortfolioIncomeOrExpense`, `recordFxConversion`.

### Stock leg POSITIVE, cash leg NEGATIVE, sum = 0

A Buy is an internal swap (cash → asset). The stock leg's `amount` carries the book value of the acquisition; the cash leg's `amount` carries the cash effect on the matching `is_cash=true` sleeve. Sum across the pair = 0.

| Kind | qty | amount | Holding |
|---|---|---|---|
| `buy` | +shares | +totalCost | security |
| `buy_cash_leg` | -totalCost | -totalCost | cash sleeve |
| `sell` | -shares | -totalProceeds | security |
| `sell_cash_leg` | +totalProceeds | +totalProceeds | cash sleeve |
| `portfolio_income` | +amount | +amount | cash sleeve |
| `portfolio_expense` | -amount | -amount | cash sleeve |
| `fx_from` | -fromAmount | -fromAmount | from-currency cash sleeve |
| `fx_to` | +toAmount | +toAmount | to-currency cash sleeve |
| `fx_fee` | -feeAmount | -feeAmount | fee-currency cash sleeve |
| `in_kind_transfer_out` | -shares | 0 | security (source acct) |
| `in_kind_transfer_in` | +shares | 0 | security (dest acct) |

**Pre-2026-05-25 convention put the cash effect on the stock leg (`amount=-totalCost`) with `amount=0` on the cash leg.** This displayed as "AAPL: -$2000" in the ledger — confusing because acquiring shares is a positive event. **Don't reintroduce that convention.** The lot engine uses `Math.abs(amount)` so the sign flip does NOT affect `cost_per_share` math.

### `TxRowForLots` carries `kind`; `applyLotEffectsForTx` skips `*_cash_leg` rows

(2026-05-25 follow-up.) [src/lib/portfolio/lots/types.ts](../src/lib/portfolio/lots/types.ts) `TxRowForLots` gained an optional `kind?: string | null` field. [src/lib/portfolio/lots/write-hooks.ts](../src/lib/portfolio/lots/write-hooks.ts) `applyLotEffectsForTx` early-outs when `kind` matches `/_cash_leg$/`. Without this guard, a `buy_cash_leg` (qty=-totalCost) would be misclassified as a sell by the qty<0 dispatch and spam `closeLotsForSellHook` shortfall warnings (cash sleeves never have lots opened against them). The guard is defensive — callers that don't pass `kind` (legacy paths, the generic `/api/transactions` POST) keep the existing behavior.

### Portfolio-op kinds only originate from `operations.ts` (audit invariant #8)

Any file writing `kind: "buy" | "sell" | "buy_cash_leg" | "sell_cash_leg" | "fx_from" | "fx_to" | "fx_fee" | "in_kind_transfer_in" | "in_kind_transfer_out"` MUST `import` from `@/lib/portfolio/operations`. Grep-based regex enforced by [scripts/audit-invariants.ts](../scripts/audit-invariants.ts) invariant `portfolio-ops-kind-via-operations`. Three baseline exceptions:

1. `src/lib/portfolio/operations.ts` itself — canonical writer, can't self-import.
2. `scripts/seed-demo.ts` — legacy raw-SQL pattern (predates operations.ts); Phase 2 follow-up TODO to route through operations.ts so the seed produces paired cash-leg rows uniformly.
3. `scripts/backfill-buy-sell-cash-legs.ts` — one-off raw-`pg.Pool` backfill script with a TypeScript union-type annotation (`kind: "buy" | "sell"`) that's a regex false-positive (the script only WRITES `*_cash_leg` literals). Remove the exception when the script is deleted post-backfill.

### Cash sleeves are explicit `portfolio_holdings` rows with `is_cash=true`

(Phase 1, 2026-05-25.) `portfolio_holdings.is_cash BOOLEAN NOT NULL DEFAULT FALSE` + partial UNIQUE `(user_id, account_id, currency) WHERE is_cash=true`. Users provision sleeves via the `/accounts/[id]` Cash sleeves panel (POST `/api/portfolio/holdings/cash-sleeve`) BEFORE recording a Buy/Sell/FX in that currency. The 6 operation helpers refuse with `CashSleeveNotFoundError` (mapped to HTTP 400 + `{accountId, currency}`) when missing; forms surface "Create one in the account page" with a deep link. [src/lib/investment-account.ts](../src/lib/investment-account.ts) `getOrCreateCashHolding` auto-creates with `isCash: true` going forward (the Phase 1 SQL migration backfilled `is_cash=true` for existing rows where `symbol_ct IS NULL`).

### Cascade delete across `trade_link_id` / `link_id` siblings

(Phase 2 5-fix sweep, 2026-05-25.) `DELETE /api/transactions?id=N` at [src/app/api/transactions/route.ts](../src/app/api/transactions/route.ts) computes the full set of sibling rows sharing either `trade_link_id` (buy/sell cash-leg pairs) or `link_id` (in-kind transfers, FX conversions) and deletes them in one pass. Reverse-lots-for-delete runs BEFORE the deletes so `reverseLotsForDeleteHook` can still see the rows. Edit guard (`canEditPortfolioRow`) runs against every row in the set; blocking-tx ids exclude rows already in the delete set so the 409 message stays actionable. Response: `{success, deletedIds[], cascaded}`.

The shared helper `cascadeDeleteForReplace(userId, editId)` at [src/app/api/portfolio/operations/_helpers.ts](../src/app/api/portfolio/operations/_helpers.ts) gates the edit-as-replace path on the 6 operation POST routes with the same semantics — it returns a `NextResponse` (refusal/404) or `null` (caller may proceed to create the fresh pair).

### Edit-as-replace via `?editId=N` + GET load endpoint

(Phase 2 5-fix sweep, 2026-05-25.) Portfolio-op rows are immutable from the generic `/api/transactions` PUT path — the generic dialog's portfolio-holding picker can't safely edit a paired row without leaving the cash-leg sibling stale. Instead, [transactions/page.tsx](../src/app/(app)/transactions/page.tsx) `startEdit` detects `kind` in the portfolio-ops set and routes to `/portfolio/new?op=<op>&editId=N`. The dedicated form fetches existing data via [GET /api/portfolio/operations/load?id=N](../src/app/api/portfolio/operations/load/route.ts) (which dispatches by `kind` to the right operation shape, resolves cash-leg / FX-leg / in-kind-leg siblings to the primary leg, and decrypts payee/note/tags), prefills, and on submit sends `editId` in the POST body. The matching POST route runs `cascadeDeleteForReplace` then `recordX`. Response: `{...newIds, replaced: <editId>}`.

**SwapForm is notice-only** when `editId` is present — swaps are two unlinked op pairs internally (no `swap_link_id`), so they can't be edited as a unit. UX: "Delete the original sell + buy separately, then create a fresh swap here."

### Edit-guard refuses when the lot has downstream closures

[src/lib/portfolio/operations.ts](../src/lib/portfolio/operations.ts) `canEditPortfolioRow(userId, txId)` returns `{allowed: false, blockingClosureTxIds: number[]}` when the tx opened a lot that has any `holding_lot_closures` row (sell or transfer-out). Wired into:

- `PUT /api/transactions` — refuses with 409 + `{code: "portfolio_edit_blocked", blockingClosureTxIds}`.
- `DELETE /api/transactions` — same. Blocking ids exclude rows in the delete set (so deleting an entire pair where the sell is one of the legs doesn't block itself).
- `cascadeDeleteForReplace` (edit-as-replace) — same semantics.

UI surfaces `blockingClosureTxIds` as `/transactions?search=#<id>` deep links so the user can navigate to and delete each dependent row first.

### Engine refuses invalid `link_id` pairings

(Phase 1, 2026-05-25.) [src/lib/portfolio/lots/engine.ts](../src/lib/portfolio/lots/engine.ts) `transferLot` throws `InvalidLinkPairError` when source and dest legs of a `link_id` pair reference different holdings (e.g. AAPL + Cash USD — the bug that motivated the refactor). [src/lib/portfolio/lots/write-hooks.ts](../src/lib/portfolio/lots/write-hooks.ts) `applyLotEffectsForLinkPair` dispatcher classifies pairs into 3 buckets:

- **Same holding, neither cash** → `transferLotHook` (existing in-kind transfer)
- **Both cash sleeves** → `fxConversionHook` (no lot writes; cash sleeves don't carry lots)
- **Anything else** → throws `InvalidLinkPairError`

`softFail` re-throws `InvalidLinkPairError` so existing soft-fail callers (e.g. `transfer.ts::createTransferPair`) also produce hard errors on invalid pairs. Net effect: it's now impossible to silently create a broken `link_id` pair, regardless of the entry path (REST, MCP, import, raw API).

## Account balance formulas

### Accounts with holdings = `holdings.value`, not `b.balance + holdings.value`

Cash sleeve is already inside `holdings.value` via the currency-as-holding pattern. Old formula double-counted custodian-managed RRSPs.

**Goals page (issue #151, 2026-05-06) follows the same rule** — `GET /api/goals` `currentAmount` branches on `accounts.is_investment` per linked account: investment accounts contribute `getHoldingsValueByAccount(...).value`, cash accounts contribute `SUM(transactions.amount)`. Each per-account contribution is FX-converted into the goal currency before summing, so multi-currency goals report meaningful progress. Don't reintroduce a flat `SUM(transactions.amount)` over all linked accounts — for an investment account that's "net cash contributed" (buy/sell pairs net to ≈0), not market value.

### Investment-account constraint: `is_investment=true` ⇒ every tx references a `portfolio_holdings` row

Enforced application-layer (no DB CHECK constraint) at 8 callsites — REST `createTransaction`/`updateTransaction`, `createTransferPair{,ViaSql}` (both legs default to per-account Cash holding for pure-cash transfers), import-pipeline (post-resolver Cash default pass), MCP HTTP `record_transaction`/`bulk_record_transactions`/`update_transaction`. **Stdio MCP `record_transaction`/`bulk_record_transactions` refuse writes to investment accounts** — stdio doesn't expose `portfolioHolding` parameters. Helper API: `requireHoldingForInvestmentAccount` (strict), `defaultHoldingForInvestmentAccount` (permissive — returns Cash holding id), `getOrCreateCashHolding`, `backfillInvestmentAccount` (called from PATCH `/api/accounts` on false→true toggle). Cash holding shape: `name='Cash', symbol=NULL, currency=accounts.currency`. → [src/lib/investment-account.ts](../src/lib/investment-account.ts)

## FX gotchas

### Currency-as-symbol in portfolio

Never pass a 3-4 letter ISO 4217 code (`CAD`, `USD`, `XAU`) to Yahoo Finance. Yahoo returns the wrong company (e.g. NASDAQ:CAD = Cadiz Inc ≈ $95). `isCurrencyCodeSymbol()` excludes these and routes through the cash branch.

### FX historical lookup uses `result.indicators.quote[0].close[]`, NOT `meta.regularMarketPrice`

(Issue #206, 2026-05-09.) Yahoo's `/v8/finance/chart/<sym>?period1=...&period2=...` historical payload returns today's price under `meta.regularMarketPrice` even when the requested window is in the past. The historical branch in [src/lib/fx-service.ts](../src/lib/fx-service.ts) `fetchYahooRateToUsd()` walks `result.timestamp[]` + `result.indicators.quote[0].close[]` and picks the latest close ≤ requested date. The latest-rate branch (`date >= today`) still uses `meta.regularMarketPrice` (correct there) — don't accidentally swap both directions.

**The window is biased BACKWARDS from the requested date** (issue #231, 2026-05-10): `start = requestedDate - 7d, end = requestedDate + 1d`. A forward-only window silently missed weekend / exchange-holiday lookups. 7d back covers the worst-case Christmas–New Year cluster (4 closed days) + a weekend; +1d forward absorbs a UTC timezone seam where Yahoo's bar timestamp can land on the next calendar day. The picker predicate stays `tsMs <= dateMs` — only the window bounds change.

**The cache must NEVER persist future-dated rows** — `writeCached()` is gated on `date <= today` in `getRateToUsdDetailed`, and `findNearestCached()` filters `date <= today` as defense in depth. Future-date query support is still load-bearing for the engine (`convertToAccountCurrency` for future-dated bills + the `settleFutureFxRates` cron) — the future-date hard-reject lives at the MCP tool boundary, NOT in the engine. The cache-purge migration [scripts/migrations/20260509_fx-cache-purge-future-dates.sql](../scripts/migrations/20260509_fx-cache-purge-future-dates.sql) drops poisoned rows on first deploy.

### Triangulated FX responses surface a worst-case top-level `source` + per-leg `legs[]`

(Issue #231, 2026-05-10.) `get_fx_rate` and `convert_amount` (HTTP + stdio MCP) collapse leg sources via `collapseLegSources(legs)` exported from [fx-service.ts](../src/lib/fx-service.ts) — ranking `fallback` > `stale` > `override` > `live (yahoo/coingecko/stooq)`. `override` is the positive label only when EVERY leg is overridden (one override + one stale = "stale"); a single live provider is preserved by name only when all legs use that exact provider (mixed live → worst-rank). Top-level `effectiveDate` is the earliest (most-stale) across legs. `convert_amount` previously returned `source: "triangulated"` which hid stale legs entirely; that string is gone. The `legs: { from, to }` object on each response carries `{ rate, source, effectiveDate, currency }` per leg so callers can audit which side degraded. Don't reintroduce the flat `"triangulated"` label or sum/average sources.

### MCP currency enums use `supportedCurrencyEnum`, not `["CAD", "USD"]`

(Issue #206, 2026-05-09.) The 6 create/update tool sites in HTTP [register-tools-pg.ts](../mcp-server/register-tools-pg.ts) (`add_account`, `update_account`, `add_portfolio_holding`, `update_portfolio_holding`, `add_subscription`, `update_subscription`) and their stdio mirrors in [register-core-tools.ts](../mcp-server/register-core-tools.ts) use the widened enum (32 fiats + 4 cryptos + 4 metals). The FX engine has triangulated through USD for every supported pair since the canonical-USD model — the artificial CAD/USD constraint on creates was the regression. The 3 FX tools (`get_fx_rate` / `set_fx_override` / `convert_amount`) keep `z.string()` at the schema layer and route through `validateCurrencyCode()` at runtime.

## MCP gotchas

### Stdio MCP requires `PF_USER_ID`

Process exits if missing. Every tool scopes by that userId; INSERTs bind from the closure, not from arguments. `price_cache` and `fx_rates` stay global. → [mcp.md](architecture/mcp.md)

### Stdio MCP writes are plaintext

No DEK in that transport. User-scoped via `PF_USER_ID` but data isn't encrypted. Known self-hosted limitation.

### Every MCP tx-mutating write must call `invalidateUser(userId)`

On the per-user tx cache after the commit. Missing it = Claude reading stale payees.

## Audit & validation

### Audit trio: `transactions.created_at` / `updated_at` / `source`

(Issue #28, 2026-04-30.) Application-layer maintenance, no Postgres trigger. Every UPDATE site (~30 across REST, transfer.ts, import-pipeline, settle-future-fx cron, investment-account backfill, MCP HTTP, MCP stdio) must append `updated_at = NOW()` (or `sql\`NOW()\`` in Drizzle). `source` is INSERT-only and never modified — the column has a 7-value CHECK constraint (`manual` / `import` / `mcp_http` / `mcp_stdio` / `connector` / `sample_data` / `backup_restore`) that fails fast on typos. Mirror the `SOURCES` tuple in [src/lib/tx-source.ts](../src/lib/tx-source.ts) when adding a new source. Backup-restore preserves the original `source` from the JSON; pre-migration backups fall back to `'backup_restore'` via `coerceSourceForRestore`. The cron settling future-dated FX deliberately bumps `updated_at` but preserves `source`. Splits writes bump the parent transaction's `updated_at`.

### Sign-vs-category advisory (warn-but-allow)

(Issue #212, 2026-05-09; converted from hard reject to advisory warning in FINLYNQ-97, 2026-05-23.) `E`-type categories *typically* have `amount ≤ 0`; `I`-type *typically* have `amount ≥ 0`; `R`/`T` exempt; uncategorized exempt; `amount === 0` exempt. The validator runs at every tx-write callsite — REST `createTransaction`/`updateTransaction` (now called at the `/api/transactions` POST/PUT route boundary), MCP HTTP `record_transaction` / `bulk_record_transactions` / `update_transaction`, MCP stdio `record_transaction` / `update_transaction` (cash-account branch — investment writes already refused), and import-pipeline (per-row `getCategoryTypeMap` pre-fetch once per batch). **The row LANDS regardless of the result.** When the validator returns a non-null `SignCategoryMismatchError`, the message is surfaced through each transport's existing warnings channel: REST adds a top-level `warning: string`; HTTP MCP single-write tools append to `data.warnings[]`; HTTP MCP `bulk_record_transactions` appends to the per-row `results[i].warnings[]` and the row remains `success: true`; stdio MCP appends to `data.warnings[]`; import-pipeline pushes `"Warning: Row N — …"` into `importErrors[]`. Legitimate mismatches (refund booked against the original Groceries expense category as `+50`, clawback against an Income line) are now first-class. Transfer-pair legs are still exempt by construction. Validation still runs on `resolved.amount` AFTER FX. `categories.type` is plaintext so the rule fires on every transport. Helper at [src/lib/transactions/sign-category-invariant.ts](../src/lib/transactions/sign-category-invariant.ts) — pure `validateSignVsCategory({ amount, categoryType, categoryName })` + `validateSignVsCategoryById(userId, dek, categoryId, amount)` for the REST route + bulk `getCategoryTypeMap(userId, dek, ids)` for the batch path. Keep the validator pure — no DB I/O.

## Backup, wipe, and data lifecycle

### Backup-restore must remap FKs

`/api/data/import` `strip()` takes `accountIdMap` + `categoryIdMap`, throws on unmapped FK. Old code silently created cross-tenant FKs.

### Wipe-account is single-transaction + user_id-only filters

Strict isolation. Cross-tenant FK violations roll back the whole wipe. `mcp_uploads` file unlink runs BEFORE the DB transaction.

## Deploy & infra

### `PF_PEPPER` + `PF_STAGING_KEY` ≥32 chars in prod

Module-load throws if missing. **Also set on `finlynq-demo-reset.service`** — separate systemd unit, doesn't inherit. Missed in the first deploy → demo login 500'd.

**Pepper rotation is now non-destructive** (PR #189, 2026-05-07): `users.pepper_version SMALLINT NOT NULL DEFAULT 1` names which env var holds the pepper used when the row's DEK was wrapped (v1→`PF_PEPPER`, v>1→`PF_PEPPER_V<n>`). `getPepperForVersion(n)` in [envelope.ts](../src/lib/crypto/envelope.ts) reads the right one; `deriveKEK` accepts an optional pepper version (defaults to 1 for back-compat). Login route reads `user.pepperVersion` and threads through. **Lazy rewrap on login** — when `PF_PEPPER_TARGET_VERSION` is set to N>1, a successful unwrap is followed by re-wrap with the new pepper + a `pepper_version` UPDATE inside the same login request. Each user pays one extra ~80ms scrypt+wrap on next login; no force-logout needed. Operator playbook + `scripts/rewrap-peppers.ts` admin tool documents the full rotation flow. **Plumbing only by default** — no rotation triggered until operator sets `PF_PEPPER_TARGET_VERSION` AND tests against a prod-DB copy first.

### `PF_JWT_SECRET` fatal in prod

`src/lib/auth/jwt.ts` throws at module load if missing. Dev falls back with a one-time warn.

### Prod and demo coexist on one Postgres DB

The Finlynq prod VPS hosts the operator's real account AND the public demo user (`users.id = '00000000-0000-0000-0000-00000000demo'`) in the same `pf` database — there is NO separate demo DB. The seed-demo script wipes rows scoped to demo's user_id only. The B9 safety guard refusing seed runs on multi-user DBs is bypassed via `Environment=PF_ALLOW_DEMO_SEED=1` set in `/etc/systemd/system/finlynq-demo-reset.service`. Don't forget to set this on a fresh deploy host or the nightly seed timer will silently no-op.

### CSRF gate has a 5-route bypass list

(PR #184, 2026-05-07.) `csrfCheck` in [middleware.ts](../src/middleware.ts) skips the gate for `/api/auth/login`, `/api/auth/register`, `/api/auth/password-reset/request`, `/api/auth/password-reset/confirm`, `/api/auth/verify-email`. These authenticate via password / reset token / email-verification token — not the session cookie — so a stale `pf_session` from a previous session doesn't 403 a fresh login attempt. Login CSRF is mitigated by the freshly-issued cookie's SameSite=Lax + the credential requirement; URL-token routes use the unguessable token as the CSRF nonce. Adding a NEW pre-auth state-changing route requires adding it to `CSRF_BYPASS_PATHS` or it 403s users with stale cookies. The gate is still active for `/api/auth/logout` and every session-auth'd route.

### Orchestrator dedup MUST include archived accounts

`getAccounts(userId, { includeArchived: true })`. The DB's UNIQUE partial index spans archived rows. Auto-unarchive via `bindToExisting` when binding to one. → [import-connectors.md](import-connectors.md) §7

### `npm run db:push` runs on Linux (lockfile gotcha)

Windows `npm install` strips Linux-only optional deps and breaks CI's `npm ci`. Run on the deploy host. → [database.md](architecture/database.md) "Lockfile gotcha"

### `deploy.sh` runs tracked migrations automatically

(2026-05-04.) From `pf-app/scripts/migrations/*.sql`. Each is applied exactly once per env via the `schema_migrations` bookkeeping table, inside a single transaction with the version INSERT, in lexical filename order. The original `db:push` attempt failed (issue #5) because `DATABASE_URL` from the systemd unit didn't survive the `sudo -u` hop in `run_as`; the new runner side-steps that by reading `DATABASE_URL` directly out of the unit's `EnvironmentFile` and calling `psql` from the deploy user (no sudo hop). Run order in `deploy.sh` is `git pull → npm install → backup → migrations → build → restart`; a failed migration leaves the OLD service running on the OLD schema with a known-good DB snapshot taken seconds earlier. **Loose `scripts/migrate-*.sql` files are historical** — already applied to prod + dev, kept as the canonical record for fresh-env bootstraps and as the home for **destructive** migrations that still need manual "code FIRST, then SQL" sequencing.

## Import flow gotchas

### `/import` classic flow: picker-then-preview

(2026-05-21.) CSV uploads with ≥1 saved template open a [TemplatePickerDialog](../src/app/(app)/import/components/template-picker-dialog.tsx) BEFORE the preview — header signature is extracted client-side from the first 64KB and scored against every saved template via `scoreTemplateMatch`. "Auto-detect (no template)" in the picker sends `noTemplate=1` to `/api/import/preview`; the route propagates it as `skipAutoMatchTemplate: true` on `parseCsvWithFallback` so **step 3 (auto-match saved template by header overlap) is suppressed**. Without that suppression, picking "Auto-detect" would silently re-apply a template the user just declined. The legacy post-upload suggestion banner is removed. Reaching the picker again from the preview dialog goes through the `← Change template` footer button, which is only rendered when the dialog was opened via the picker. The `/import/reconcile` + `/import/pending` staging path is unaffected.

### `PreviewResult.duplicateMatches[]` is the canonical "Matches existing transaction #X" surface

(2026-05-21.) Mirrors `probableDuplicates[]`: per-row `{ rowIndex, matchBasis: "fit_id" | "import_hash", matchedTx: { id, date, amount, source } }`. Produced by `previewImport()` in [pf-app/src/lib/import-pipeline.ts](../src/lib/import-pipeline.ts) via two new lookup helpers — `findDuplicateMatches(hashes, userId)` and `findFitIdMatches(fitIds, userId)` in [pf-app/src/lib/import-hash.ts](../src/lib/import-hash.ts) — that return `Map<key, MatchInfo>` instead of `Set<key>`. **Both pick the lowest-id match per key** on collision so the surfaced txn id is stable across re-runs. The set-returning helpers `checkDuplicates` and `checkFitIdDuplicates` stay for `executeImport` and the three other callers. Any new "show me the matched txn" UI on the classic `/import` flow reads this field; staging-path equivalents (issue #156's MCP staging tools) don't expose it yet.
