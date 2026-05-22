# Two-Ledger Import Model — `bank_transactions`

**Status:** Shipped 2026-05-22 (FINLYNQ-XX). Schema migration `20260522_bank-transactions-ledger.sql`.

## Why

Before the refactor, every import (CSV / OFX / PDF / email) flowed:

```
upload → staged_imports + staged_transactions → user review → approve → transactions
```

Dedup ran against `transactions.import_hash`. That created two problems:

1. **Re-import gap after deletion.** If a user deleted an approved transaction, the next upload of the same statement would no longer recognize the row — it'd appear as new, the user would re-approve, and the system silently double-counted.
2. **F-53E overlap-merge dialog.** When a user uploaded a second statement covering an overlapping date range, the system couldn't tell whether the new file overlapped existing data or just re-stated already-seen rows. It surfaced a "Merge / Create new / Cancel" prompt that asked the user to make a decision the system could have made automatically with row-level dedup.

The two-ledger model fixes both. Bank-side history is permanent; system-side transactions are editable; the two stay in sync via a lineage FK; re-uploads are silently absorbed; the merge dialog is gone.

## Data model

```
bank_transactions               ← immutable bank-side ledger
├── id (UUID, server-minted)
├── user_id, account_id (FK)
├── import_hash + occurrence_index   ← (user, account, hash, occ) UNIQUE
├── fit_id                            ← (user, account, fit_id) UNIQUE partial
├── date, amount, currency, ...
├── payee, note, tags, account_name   ← encrypted-in-place (tier-aware)
├── encryption_tier ('service'|'user')
├── source ('import'|'connector'|'backup_restore')
├── first_seen_at, last_seen_at, seen_count, source_filenames[]
└── original_staged_import_id (FK, ON DELETE SET NULL)

transactions                    ← user-editable system-side
├── id (serial INT)
├── ... (unchanged)
└── bank_transaction_id (UUID, ON DELETE SET NULL)   ← NEW
```

**Key shape decisions:**

- **`(user_id, account_id, import_hash, occurrence_index)` is the primary dedup key.** Two intentional same-day duplicates (two coffees at the same place on the same day, same amount) get distinct `occurrence_index` values within a single upload via [`assignOccurrenceIndices`](../../src/lib/import-hash.ts). Without the column, the second coffee would silently bump `seen_count` on the first.
- **`account_id` is NOT NULL.** Postgres treats NULL as distinct in unique indexes — a NULL account_id row would dedup against nothing. The upload route already requires a resolved account, but this enforces it at the DB layer.
- **`encryption_tier` mirrors the staged_transactions pattern.** Email-webhook ingest writes service-tier (no DEK at receive time); approve-time writes user-tier. The login-time [`upgradeStagingEncryption`](../../src/lib/email-import/upgrade-staging-encryption.ts) job flips service → user when the DEK becomes available.
- **`source` is a strict subset of `TransactionSource`.** Only `'import' | 'connector' | 'backup_restore'`. Manual entries (REST POST, MCP HTTP `record_transaction` / `bulk_record_transactions`) never carry bank-statement lineage — they write to `transactions` with `bank_transaction_id = NULL`.

## Write flow

```
upload  → staged_imports + staged_transactions
              ↓
            approve
              ↓
          upsertBankTransaction(dek, row)   ← src/lib/bank-ledger.ts
              ↓
          INSERT INTO bank_transactions ... ON CONFLICT DO UPDATE
              ↓
          {id, wasInserted}
              ↓
          INSERT INTO transactions (..., bank_transaction_id=id)
```

The `upsertBankTransaction` helper is the single chokepoint for bank-ledger writes. It:

1. Encrypts `payee`, `note`, `tags`, `account_name` under the user's DEK (v1: envelope) when `dek != null`, OR under `PF_STAGING_KEY` (sv1: envelope) when `dek == null` (email-webhook path).
2. `INSERT … ON CONFLICT (user_id, account_id, import_hash, occurrence_index) DO UPDATE SET last_seen_at = NOW(), seen_count = seen_count + 1, source_filenames = array_append(..., filename)`.
3. Returns `{ id, wasInserted }` — the `wasInserted` flag (via the Postgres `xmax = 0` trick) lets callers distinguish a fresh ledger entry from a re-import hit.

Four import-side INSERT callsites into `transactions` invoke it:

| Callsite | Trigger |
|---|---|
| [`executeImport`](../../src/lib/import-pipeline.ts) | Cash bucket of approve route + legacy self-hosted email webhook + backup-restore (when `bankLedgerMode='merge'`) |
| [`createTransferPair`](../../src/lib/transfer.ts) | Target-account transfer bucket of approve route — caller pre-upserts and passes `fromLegBankTransactionId` / `toLegBankTransactionId` |
| [`createTransferPairViaSql`](../../src/lib/transfer.ts) | MCP stdio variant — accepts the same FK params (stdio doesn't have a DEK so the params today are always NULL) |
| Approve route bucket 1 (peer-pair transfers) | Caller pre-upserts both legs and stamps both FKs on the raw SQL INSERT |

## Dedup source-of-truth

Post-refactor, `checkDuplicates` / `checkFitIdDuplicates` / `findDuplicateMatches` / `findFitIdMatches` in [src/lib/import-hash.ts](../../src/lib/import-hash.ts) all query `bank_transactions.import_hash` (not `transactions.import_hash`). The `*Matches` variants LEFT JOIN to `transactions` via `bank_transaction_id` to surface the linked transaction id when present; rows whose linked transaction was deleted return `{ id: null, bankTransactionId: <uuid>, ... }` so the UI can render "Previously imported (no current transaction)" instead of "Matches existing transaction #X".

## Load-bearing invariants

1. **`bank_transactions` content is immutable.** `import_hash`, `fit_id`, `date`, `amount`, `payee`, `tx_type` are NEVER updated after first insert. Only metadata (`last_seen_at`, `seen_count`, `source_filenames`) bumps on a re-import hit.
2. **`import_hash` is computed once at ingest from plaintext payee.** Never recomputed. Inherits the existing CLAUDE.md invariant.
3. **`account_id` is NOT NULL.** Upload route refuses unbound CSVs before staging; staging approve requires resolved account before upsert.
4. **`transactions.account_id` is user truth; `bank_transactions.account_id` is statement truth.** They MAY diverge after a user account-move. Do NOT auto-relink `bank_transaction_id` on `update_transaction` — the FK is lineage only.
5. **Import-sourced INSERTs into `transactions` must set `bank_transaction_id`.** Manual REST/MCP HTTP entries leave it NULL. The 5 chokepoints above are the canonical write surface.
6. **`upgradeStagingEncryption` extends to `bank_transactions`.** Same per-row service→user re-encrypt pass at login.
7. **Wipe-account deletes `bank_transactions` AFTER `transactions`.** The FK is ON DELETE SET NULL, so transactions can be wiped first; the user_id-scoped bank delete is then a clean drop.
8. **Backup-restore preserves bank lineage.** Re-inserts `bank_transactions` BEFORE `transactions`, builds a `bankTxIdMap` (UUID → UUID), remaps `transactions.bank_transaction_id` through the map. Pre-refactor backups (no `bankTransactions` array) restore with `bank_transaction_id = NULL` — accepted lineage loss.

## What changed externally

- **F-53E "Overlapping pending upload" dialog is gone.** Re-uploads of identical files still produce a staged batch, but every row is auto-flagged `reconcile_state='skipped_duplicate'` via the bank-ledger probe in the upload route. The user sees the existing "already imported" UI and rejects with one click.
- **`executeImport` gained an options object.** `executeImport(rows, force, userId, dek, txSource, { bankLedgerMode, filename, stagedImportId })`. Default `bankLedgerMode='merge'`; backup-restore uses `'preserve_ids'`.
- **`createTransferPair` / `createTransferPairViaSql` gained `fromLegBankTransactionId` / `toLegBankTransactionId` opts.** Pre-resolved by the approve route's target-transfer bucket.
- **`ExactDuplicateMatchInfo.id` is now `number | null`.** A bank-ledger row whose linked transaction was deleted returns `id: null`. The new field `bankTransactionId: string` is always present.

## Post-launch fixes (2026-05-22 dev → main)

Shipped same-day as the initial refactor, in response to dev verification:

1. **Bank-ledger UI feed at `/import/pending`** (commit `315ca31`). The left pane was still reading `/api/transactions/reconciliation` (±7d window over `transactions`), so users uploading a new statement only saw the upload's own rows on the right and an empty / narrowly-windowed left pane — defeating the "continuous statement from the bank side" intent. New endpoint [GET /api/import/bank-ledger?accountId=X](../../src/app/api/import/bank-ledger/route.ts) returns the full continuous history for the account, decrypted tier-aware (`user` via DEK, `service` via `PF_STAGING_KEY`), with per-row enrichment for the linked system-side tx + manual-link back-reference. `DbTransactionRow.id` is now `string` (bank UUID); `linkedTransactionId: number | null` carries the live tx id. Link / flag actions key on `linkedTransactionId` — bank-only rows render as read-only "bank-only".

2. **Bank-ledger upserts are FATAL** (commit `25bc931` + `33bbfbd`). The original Phase 3 wiring wrapped `upsertBankTransaction` in a try/catch that pushed errors onto `importErrors[]` and continued. Dev launch day exposed the symptom: transactions landed with NULL `bank_transaction_id`, the left pane stayed permanently empty, no log, no toast. Now: the catch re-throws after logging via `console.error` with `{userId, accountId, importHash, pgCode, pgMessage, pgDetail}`. The throw propagates BEFORE the batch `INSERT INTO transactions`, so a failed upsert leaves zero rows in either table. Approve route catches the throw and returns `{ success: false, code: "bank_ledger_upsert_failed", error }`; the page surfaces the unwrapped PG cause (code + detail) in the toast.

3. **Array-literal serialization bug fixed** (commit `a2381ab`). `${jsArray}::TEXT[]` doesn't serialize a JS array to PG's `{elem1,elem2}` literal form through Drizzle's sql template — PG receives a bare string and returns `22P02 malformed array literal`. Fix: build the array inline with `ARRAY[…]` using a properly-bound element:
   ```ts
   const filenamesFragment = row.filename
     ? sql`ARRAY[${row.filename}]::TEXT[]`
     : sql`ARRAY[]::TEXT[]`;
   ```
   Also tightened the ON CONFLICT empty-array check from `EXCLUDED.source_filenames = ARRAY[]::TEXT[]` to `array_length(EXCLUDED.source_filenames, 1) IS NULL` (idiomatic — PG returns NULL for empty-array length, not 0).

4. **File → bank-ledger dedup is exact-only** (commit `41c0918`). Per user feedback: file-to-bank-ledger should only compare exact `import_hash` / `fit_id` against `bank_transactions`. The previous probable-duplicate fuzzy pass (`buildDuplicateCandidatePool` + `detectProbableDuplicates`) queried `transactions` for FX-spread / date-drift heuristics — which conflated "what the bank reported" with "what's in my live view". File-side classification is now binary: `'new'` vs. `'existing'`. The `'probable_duplicate'` value is no longer produced (DB CHECK still permits legacy rows). 87 lines of fuzzy-match infrastructure left intact in [duplicate-detect.ts](../../src/lib/external-import/duplicate-detect.ts) + [duplicate-detect-pool.ts](../../src/lib/external-import/duplicate-detect-pool.ts) — reserved for the future bank-ledger → transactions reconciliation surface.

## Standalone reconcile page + M:N join (2026-05-23)

Shipped as the follow-up to the 2026-05-22 refactor. Lifts the 1:1 lineage FK to **many-to-many** in both directions so the user can express:
- **1 bank → N transactions** — one bank charge split into multiple system-side transactions because the user tracks them separately (different categories, different splits).
- **N bank → 1 transaction** — a recurring fee spread across statements that the user wants to track as a single annual line.

The existing `transactions.bank_transaction_id` FK stays as the **"primary link" hint**. Every primary join row mirrors it; extra links (the M:N second-and-beyond) live only in the join table. Aggregators / wipe-account / backup-restore that already read the FK keep working unchanged.

### Schema

```sql
CREATE TABLE transaction_bank_links (
  id                  SERIAL PRIMARY KEY,
  user_id             TEXT    NOT NULL,
  transaction_id      INTEGER NOT NULL REFERENCES transactions(id)      ON DELETE CASCADE,
  bank_transaction_id UUID    NOT NULL REFERENCES bank_transactions(id) ON DELETE CASCADE,
  link_type           TEXT    NOT NULL DEFAULT 'extra',   -- 'primary' | 'extra'
  source              TEXT    NOT NULL DEFAULT 'manual',  -- mirrors SOURCES tuple
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (transaction_id, bank_transaction_id)
);
```

`link_type` is not enforced by SQL CHECK in v1 (rules-v2 precedent — drift between code enum + SQL CHECK is a CLAUDE.md contract breach unless documented; Zod at the API boundary is the enforcement layer). `transactions.source` CHECK gains `'reconcile_link'` for the materialize-from-bank-row path.

CASCADE on both FKs is load-bearing — wipe-account's existing "delete transactions THEN bank_transactions" ordering keeps working untouched because deletes on either side automatically tidy the join. Backfill: the migration inserts a primary join row for every existing `transactions.bank_transaction_id IS NOT NULL` row, idempotent via `ON CONFLICT (transaction_id, bank_transaction_id) DO NOTHING`.

Migration: [scripts/migrations/20260523_transaction-bank-links.sql](../../scripts/migrations/20260523_transaction-bank-links.sql).

### Match engine

Three layers, in order — each layer's pairs are excluded from the next:

1. **`join_existing`** — pairs already in `transaction_bank_links` (surface as "linked" with their `link_type`). Never auto-mutated; user explicitly unlinks via the UI.
2. **`exact_hash`** — pairs not in the join table where `transactions.import_hash = bank_transactions.import_hash` AND `account_id` matches. Score 1.0. Surfaced as a suggestion; manual accept required (we don't auto-link historical FK-null rows to avoid surprising the user with retroactive lineage they may have intentionally rejected during staging review).
3. **`fuzzy`** — pairs not in (1) or (2), scored by a small purpose-built bank↔tx scorer in [match-engine.ts](../../src/lib/reconcile/match-engine.ts). Same amount/date/payee rubric as the cross-source detector ([duplicate-detect.ts](../../src/lib/external-import/duplicate-detect.ts)) so the unified threshold story holds. The detector's transfer-pair-sibling + holding-symbol hints are intentionally omitted — `bank_transactions` doesn't carry that info. Greedy assignment per layer (one tx ↔ one bank); user can build M:N explicitly via the UI after.

Defaults: `dateToleranceDays: 7, amountTolerancePct: 0.07, amountToleranceFloor: 50, scoreThreshold: 0.6` — re-exported from `duplicate-detect.ts` `DEFAULT_OPTIONS` as `RECONCILE_DEFAULT_THRESHOLDS` so the single source of truth covers both surfaces.

### Per-user thresholds

Persist in the generic `settings(key='reconcile_thresholds')` row, JSON-serialized. GET/PUT at [/api/settings/reconcile-thresholds](../../src/app/api/settings/reconcile-thresholds/route.ts), edited at [/settings/reconciliation](../../src/app/(app)/settings/reconciliation/page.tsx).

### Routes + page

- `GET /api/reconcile/suggestions?accountId=X` — runs the match engine, returns linked + suggestions + bankOnly + txOnly with per-id decrypted enrichment.
- `POST /api/reconcile/links` `{ transactionId, bankTransactionId, linkType }` — `requireEncryption`; delegates to [linkTransactionToBank](../../src/lib/reconcile/links.ts) (single DB transaction; sets FK if linkType='primary' AND FK was NULL).
- `DELETE /api/reconcile/links` `{ transactionId, bankTransactionId }` — `requireEncryption`; delegates to [unlinkTransactionFromBank](../../src/lib/reconcile/links.ts) (clears FK if removed row was primary AND FK still pointed there).
- `POST /api/reconcile/materialize` `{ bankTransactionId, categoryId?, accountId? }` — creates a fresh `transactions` row mirrored from the bank row with `source='reconcile_link'`, FK set, primary join row inserted. Refuses materialize into investment accounts (those need `portfolio_holding_id`). `import_hash` copied verbatim — NEVER recomputed.
- Page: [/reconcile](../../src/app/(app)/reconcile/page.tsx) — per-account two-pane view (BankPane left forks the staging variant, TransactionsPane right with inline SuggestionCards).

### Dual-write retrofit (Phase 5)

Every site that sets `transactions.bank_transaction_id` on a fresh INSERT now also inserts a `link_type='primary'` row in the same DB scope with `ON CONFLICT (transaction_id, bank_transaction_id) DO NOTHING`:

- [executeImport](../../src/lib/import-pipeline.ts) — batch INSERT uses `.returning({ id, bankTransactionId })`, then a single follow-up insert into `transaction_bank_links` for every row with a non-NULL FK. `source='import'` (or `'connector'` per `txSource`).
- [createTransferPair](../../src/lib/transfer.ts) — inside the Drizzle transaction, after both leg INSERTs.
- [createTransferPairViaSql](../../src/lib/transfer.ts) — raw-SQL variant, same shape via `client.query`.
- Staged-approve peer-pair bucket in [approve/route.ts](../../src/app/api/import/staged/[id]/approve/route.ts) — batch `.returning({ id })`, then bulk join INSERT.
- Backup-restore in [data/import/route.ts](../../src/app/api/data/import/route.ts) — primary rows derived from the FK as a safety net for pre-2026-05-23 backups; explicit `transactionBankLinks[]` (if present in the JSON) re-inserts after, ON CONFLICT dedupes against the primaries.

Backup export at [data/export/route.ts](../../src/app/api/data/export/route.ts) now serializes `transactionBankLinks[]`.

## Future work (deferred)

- Read-only UI for the bank-side ledger (per-account "everything the bank reported" view).
- MCP read tools (`list_bank_transactions`, `get_bank_history`, `list_reconcile_suggestions`, `accept_link`, `materialize_from_bank`).
- Drop `staged_imports.date_range_start` / `date_range_end` columns (no readers post the F-53E removal).
- Per-row "Matches existing transaction #X" surface on the staging-path (`/import/pending`) — today it lives only on the classic `/import` flow.
- Bank-only row hover: surface `seen_count`, `first_seen_at`, `last_seen_at`, `source_filenames[]` as a tooltip / detail drawer.
- Persisting rejected reconcile suggestions so they don't reappear on next load. Today reject is page-scoped state. Future option: a `link_type='rejected'` row or sibling `reconcile_rejections` table.
- Cross-account view on `/reconcile` (v1 is per-account).
- New `audit:invariants` rule for "FK-set without join-insert" to catch dual-write drift before it ships.
