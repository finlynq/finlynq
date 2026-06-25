# Finlynq Reconciliation Skill

> **Distribution:** Repo-tracked doc (version-controlled with the tools it documents). Paste into a Claude.ai project's knowledge, surface as a Claude Code skill (`~/claude-skills/`), or reference inline. See also: `pf-app/docs/architecture/bank-ledger.md` and `pf-app/docs/reconciliation.md` for deeper reading.

---

## 1. App overview

Finlynq is a personal-finance **bookkeeping ledger**. It writes only to the user's own PostgreSQL database. It never connects to a bank or brokerage, never reads live account feeds, and never moves real money. All reconcile MCP tools carry this disclaimer explicitly. Treat every tool call as a local-DB read or write, not a bank operation.

---

## 2. Data model

Five tables form the reconciliation layer:

| Table | Role |
|---|---|
| `accounts` | User-defined accounts (checking, savings, investment, etc.). `is_investment` marks portfolio accounts. |
| `transactions` | The canonical ledger — rows the user owns and reviews. `bank_transaction_id` (FK) and `transaction_bank_links` are the two link paths. |
| `bank_transactions` | The bank ledger — rows imported verbatim from uploaded statements. Persistent; never auto-deleted on reconcile. |
| `transaction_bank_links` | M:N join between `transactions` and `bank_transactions`. Each row carries `link_type` (`primary` or `extra`). One transaction can link to multiple bank rows and vice versa; `primary` links are the canonical match used for lineage tracking. |
| `bank_daily_balances` | Balance anchors. **PK is `(user_id, account_id, date)` — there is no synthetic `id` column.** Anchors are independent of bank rows; they can exist on days with no imported row. Set automatically from statement headers on `send_to_bank_ledger`. |

---

## 3. Reconciliation flow

```
upload_statement
    │
    ▼
staged_imports  (pending, not yet in bank ledger)
    │
    ▼  send_to_bank_ledger   (normal path — account already has ledger tx)
    │  approve_staged_rows   (first import only — also creates transactions)
    ▼
bank_transactions  (permanent bank ledger)
    │
    ├─ materialize_bank_row ──────────────────► transactions (new)
    │
    ├─ accept_reconcile_suggestion ──────────► transaction_bank_links (links to existing tx)
    │  accept_reconcile_suggestions (bulk)
    │
    └─ unlink_reconcile ──────────────────────► removes link
```

**Key distinction:** `send_to_bank_ledger` writes ONLY to `bank_transactions` (no ledger rows created). `approve_staged_rows` creates ledger `transactions` AND bank rows — use it only for a brand-new account's first import.

---

## 4. Key field glossary

| Field | Table | Meaning |
|---|---|---|
| `seen_count` / `seenCount` | `bank_transactions` | A **same-row re-import counter**: re-uploading a file whose rows match an existing `import_hash` bumps `seen_count` on the existing single row. This is **NOT a duplicate-rows signal.** True duplicate rows arise when overlapping imports produce **different** `import_hash` values for the same economic event — those show up as distinct rows with distinct ids and are detected by `find_duplicate_bank_rows`. |
| `import_hash` | `bank_transactions` | A deterministic hash computed over the **plaintext payee** (plus date and amount). AES-GCM ciphertext is non-deterministic, so the hash is never computed over ciphertext. It is set once at import and never recomputed by any read path. |
| `dedupStatus` | `bank_transactions` (match engine) | Returned by `get_reconcile_suggestions`: whether the match engine considers a bank row a possible duplicate of an existing ledger transaction. |
| `link_type` | `transaction_bank_links` | `primary` — the canonical bank↔tx link (sets `transactions.bank_transaction_id` FK); `extra` — additional non-canonical link (multi-statement scenarios). `accept_reconcile_suggestion` defaults to `extra`; `accept_reconcile_suggestions` (bulk) defaults to `primary`. |
| `duplicateOfTransactionId` | match engine output | Returned per bank row by `get_reconcile_suggestions`. A non-null value is a **strict flag** that the bank row closely matches an existing ledger transaction — materialize is blocked until resolved. |
| Balance anchor | `bank_daily_balances` | A statement-reported closing balance for `(user, account, date)`. **PK is `(user_id, account_id, date)` — no synthetic `id` column.** Used for the `balanceDelta` check in `get_reconciliation_summary` (positive delta = ledger says MORE than the statement). Set via the staged-import flow; no direct MCP write tool yet. |

---

## 5. Account-type taxonomy

| Type | Has bank-ledger data? | Reconcile tools apply? |
|---|---|---|
| Checking / savings / cash | Yes | Yes — full workflow |
| Credit card | Yes | Yes — full workflow |
| Investment / brokerage | No bank-ledger data in typical use | **Out of scope** for reconcile tools. Investment accounts carry holdings valued at market price; `get_reconciliation_summary` excludes them by default. Use the `portfolio_*` tools for investment writes. |
| Loan | Rarely (manual entries) | Minimal — no statement import flow |

`is_investment = true` accounts are excluded from `get_reconciliation_summary` (omit `accountIds` to auto-exclude them). Passing an investment `accountId` to `materialize_bank_row` is refused.

---

## 6. Common patterns and root causes

**Overlapping imports.** The same statement period uploaded twice (e.g. a monthly file and a year-to-date file that share rows) produces duplicate bank rows with different `import_hash` values. `seen_count` stays 1 on each — the signal is two distinct row ids for the same `(date, amount, payee)`. Resolve with `find_duplicate_bank_rows` then `delete_bank_transaction`.

**Manual vs imported.** A user manually entered a transaction before importing the statement. The match engine surfaces it as a suggestion (`suggestions` bucket). `accept_reconcile_suggestion` links the existing tx to the bank row without creating a new transaction.

**Timing lag.** A transaction clears the bank on a different date than the user recorded it. The match engine uses fuzzy amount + payee matching with a date window; the suggestion appears in `get_reconcile_suggestions` even when dates differ slightly.

**No balance anchor yet.** `get_reconciliation_summary` returns `balanceDelta: null` for accounts where no anchor exists. Anchors are loaded automatically by `send_to_bank_ledger` from the statement header.

**Pipeline policy wrong.** An account set to `manual` mode will not auto-apply rules at upload. Use `set_account_mode` to flip to `auto` or `approve`.

---

## 7. Tool decision tree

All reconcile tools are HTTP-only and require an unlocked DEK. Call `finlynq_help(topic="reconcile")` for the canonical tool list at any time.

**Session start — health check across accounts**
→ `get_reconciliation_summary()` — one call returns per-account `linked / suggestions / bankOnly / txOnly / balanceDelta`. Drill into a specific account only when a count is non-zero.

**Need to stage a statement (no browser session)**
→ `upload_statement(fileContent[base64], fileName, accountId)` — returns a `stagedImportId`.

**Promote a staged import into the bank ledger**
→ `send_to_bank_ledger(stagedImportId)` — writes only to `bank_transactions`, loads the balance anchor. Use this when the account already has ledger transactions for the period.
→ `approve_staged_rows(stagedImportId)` — only for a brand-new account's first import (also creates `transactions` rows).

**Inspect one account's reconcile state (linked / suggestions / bankOnly / txOnly)**
→ `get_reconcile_suggestions(accountId)` — each bank row carries `suggestedCategoryId`, `suggestedTransferAccountId`, `duplicateOfTransactionId`.

**Duplicate bank rows from overlapping imports**
→ `find_duplicate_bank_rows(accountId)` — returns groups with `canonicalId` (oldest, keep) and `duplicateIds[]`.
→ `delete_bank_transaction(bankTransactionId, dryRun?)` — removes each extra row. Run `dryRun: true` first to preview affected transactions.

**Materialize a bank-only row as a new transaction**
→ `materialize_bank_row(bankTransactionId, categoryId?)` — category mode (creates one tx).
→ `materialize_bank_row(bankTransactionId, destAccountId)` — transfer mode (outflow rows only; creates a transfer pair).

**Link an existing transaction to a bank row (one pair)**
→ `accept_reconcile_suggestion(bankTransactionId, transactionId)` — default `link_type: extra`.

**Link many pairs in one call**
→ `accept_reconcile_suggestions(pairs[])` — positional results; partial commit (each pair is independent). Defaults to `link_type: primary`.

**Undo a link**
→ `unlink_reconcile(bankTransactionId, transactionId)`.

**Flip per-account pipeline policy**
→ `set_account_mode(accountId, mode)` — `auto | approve | manual`.

**Re-fire rules over a pending staged import**
→ `apply_rules_to_staged_import(stagedImportId)`.

**Bulk-materialize matched bank rows via rules (preview + confirm)**
→ `apply_rules_to_bank_rows(bankRowIds)` — two-step: first call returns a `confirmationToken`; resend with the token and `autoMaterialize: true` to commit.

**Read the balance anchors for an account**
→ `get_balance_anchors(accountId, dateMin?, dateMax?)` — lists `{ accountId, date, amount, currency, source, createdAt }` ordered date DESC. Anchors are keyed by `(accountId, date)` (no synthetic id).

**Create or correct a balance anchor (the bank's reported balance for a date)**
→ `upsert_balance_anchor(accountId, date, amount, currency)` — `ON CONFLICT (accountId, date) DO UPDATE` (newer balance wins); returns `created` (true=inserted, false=updated). Stamps `source='mcp_manual'` and immediately shifts the `balanceDelta` reported by `get_reconciliation_summary` / `get_reconcile_suggestions`.
