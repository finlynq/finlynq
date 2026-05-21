# Reconciliation — `/import/pending` two-pane surface

Living feature doc for the per-account two-pane reconciliation UI shipped
in FINLYNQ-56 (May 2026). The [implementation plan](./two-pane-reconciliation-plan.md)
captures the design + phasing; this doc tracks what's actually shipped,
the surface contract, and the roadmap for follow-up work on the same
page.

Cross-references:

- Schema: [database.md](./architecture/database.md) — `staged_transactions`
  reconciliation columns, `transaction_reconciliation_flags`, reader/writer
  routes section.
- Encryption boundaries: [encryption.md](./architecture/encryption.md) —
  per-tier branching on `encryption_tier`, no `import_hash` recompute.
- MCP exposure roadmap: see § Roadmap below — none today; deferred.

## What it does

The user uploads a CSV/OFX/QFX statement or forwards a bank email. The
parsed rows land in `staged_transactions`. Before approval, the user
opens the batch from `/import/pending` and sees **two panes side by
side**:

- **Left pane — "What's in Finlynq (existing)"**: live `transactions`
  rows for the selected account, in a ±7-day window around the staged
  batch's date range.
- **Right pane — "From the file (staged)"**: the staged rows for the
  selected account, with the existing per-row inline editor + checkboxes.

Above the panes: an account selector (single-account batches show a
non-interactive label; multi-account batches get a Select). Above that:
the existing `<ReconciliationCallout>` showing "Statement says / Finlynq
has now / After approval" with **live recompute** as the user takes
actions.

Four matching actions:

1. **Auto-match accept/reject** — a server-side matcher (±0.01 amount,
   ±1 day, same account + currency) surfaces candidate pairs as a pinned
   `<SuggestionsGroup>` above the staged rows. Accept ⇒ PATCH the staged
   row to `reconcile_state='linked'` + `linked_transaction_id=N`. Reject
   ⇒ hide locally (no persist — matcher re-runs on every GET).
2. **Manual link / unlink** — click the link icon on a staged row →
   banner "Pick a transaction on the left pane to link to staged row
   #N" → click "Pick" on a DB row → both flip. Unlink reverts both.
3. **Mark skipped (already imported)** — click × on a staged row →
   `reconcile_state='skipped_duplicate'`, line-through, default-excluded
   from approve. Un-skip reverses (selection stays user-controlled).
4. **Flag DB row as "missing from statement"** — click the flag icon on
   a DB row → POST `/api/transactions/[id]/reconciliation-flag`. The
   flag persists past the staging batch's lifecycle (separate table).

Approve materializes the rest of the batch as usual. **Linked rows
are de-queued** (DELETE from `staged_transactions`, NO INSERT into
`transactions` — the target row already exists). Skipped rows are
default-excluded. Response shape gains `linked: <count>`.

## URL state

`?id=<stagedImportId>&account=<accountId>`. Both update via
`history.replaceState` so tab close + reopen restores selection without
polluting back/forward navigation. The page treats the URL as the
single source of truth for "which batch + which account is open" —
clicking a card from the list view sets `?id=`, picking from the
account selector updates `?account=`.

## Endpoints (Phase 1 backend)

| Route | Verb | Purpose |
|---|---|---|
| `/api/import/staged/[id]` | GET | Detail + rows + decoded names + `suggestedMatches[]` |
| `/api/import/staged/[id]/rows/[rowId]` | PATCH | Per-row edit; extended with `reconcileState` + `linkedTransactionId` |
| `/api/import/staged/[id]/approve` | POST | Materialize; de-queues `linked` rows |
| `/api/import/staged/[id]` | DELETE | Reject (cascade-delete staged rows) |
| `/api/transactions/reconciliation` | GET | Left-pane rows for `?accountId=&from=&to=` |
| `/api/transactions/[id]/reconciliation-flag` | POST / DELETE | Add/remove flag; idempotent DELETE |

All require an unlocked DEK (`requireEncryption()`) — no soft-fallback.

## Auto-match algorithm

[src/lib/import/auto-match.ts](../src/lib/import/auto-match.ts). Pure
function `findAutoMatches({ staged, db })` returning
`{ stagedRowId, transactionId, confidence: 'exact' | 'fuzzy' }[]`.

Match window (user decision 2026-05-20):

- Same `accountId` AND same `currency` (cross-currency rows stay
  unmatched — by design).
- `|Δamount| ≤ 0.01` (rounded-cent statement totals, FX-leg drift).
- `|Δdate| ≤ 1 day` (FX legs that post the next business day).

`'exact'` confidence when date AND amount are bit-identical; `'fuzzy'`
when within tolerance. Multi-candidate cases surface ALL pairs; the
`SuggestionsGroup` renders each accept/reject separately so the user
picks. Excludes:

- staged rows already at `reconcile_state IN ('linked', 'skipped_duplicate')`
- DB rows already referenced by some `staged_transactions.linked_transaction_id`

Compute locus: **server-side**. Surfaced via `suggestedMatches[]` on
the GET staged-detail response, computed inline after the per-tier
decode loop. Window: `dateRangeStart - 7d` to `dateRangeEnd + 7d`,
falling back to min/max of staged-row dates for pre-FINLYNQ-58
batches with NULL ranges.

## Components

Under [src/components/import/reconcile/](../src/components/import/reconcile/):

| Component | Role |
|---|---|
| `account-selector.tsx` | Single-account label OR multi-account `<Select>`; emits change upward |
| `two-pane-layout.tsx` | lg+ side-by-side, narrow viewports stack with DB pane on top |
| `file-pane.tsx` | Staged rows + RowBadge + existing `<StagedRowEditor>` expansion + optional `rowActions` / `header` slots |
| `db-pane.tsx` | DB rows from `/api/transactions/reconciliation` + linked / flagged indicators + optional `rowActions` slot |
| `suggestions-group.tsx` | Pinned auto-match cards above FilePane; accept/reject per pair; multi-candidate friendly |
| `row-badge.tsx` | Colored pill for `reconcile_state` (linked → emerald, suggested → sky, skipped → amber, unmatched → null) |

The existing [`staged-row-editor.tsx`](../src/components/staging/staged-row-editor.tsx)
and [`reconciliation-callout.tsx`](../src/components/staging/reconciliation-callout.tsx)
+ [`unresolved-categories-banner.tsx`](../src/components/staging/unresolved-categories-banner.tsx)
are reused verbatim.

## Live balance ("After approval")

Phase 4. Predicate (in [page.tsx](../src/app/%28app%29/import/pending/page.tsx)):

```ts
const eligible = detail.rows.filter(r =>
  selected.has(r.id) &&
  r.dedupStatus !== 'existing' &&         // already in live balance
  r.reconcileState !== 'skipped_duplicate' && // won't materialize
  r.reconcileState !== 'linked'           // target tx already in balance
);
const liveDelta = eligible.reduce((acc, r) => acc + Number(r.amount ?? 0), 0);
const projected = currentBalance + liveDelta;
```

`useMemo` keyed on `[detail, selected]`. Synchronous client-side; ≤500ms
target met by virtue of React's synchronous render after each `setDetail`.

## Load-bearing rules

Each of these has bitten us somewhere — don't regress without a comment
explaining why.

- **`import_hash` is NEVER recomputed** on any row edit, including the
  new `reconcileState` / `linkedTransactionId` fields. Bank-side dedup
  keys on the ingest-time hash; rewriting it creates a window where
  the row would silently match a different existing transaction.
- **`encryption_tier` is NEVER flipped mid-edit**. Service-tier rows
  re-encrypt under `PF_STAGING_KEY` (`sv1:`); user-tier under DEK
  (`v1:`). The login-time upgrade job is the only path that promotes
  service → user.
- **Half-pair transfer enforcement stays at APPROVE time**, NOT PATCH.
  Two sequential PATCHes for paired legs would deadlock on PATCH-side
  post-state validation. The approve-side classifier already refuses
  half-pair via the existing peer-handled logic; Phase 3 added
  `code: 'half_pair_link'` for the linked-bucket case (`tx_type='R'`
  linked row whose `peer_staged_id` peer is not also linked).
- **`flagged_missing` is NOT a `reconcile_state` value** — flags belong
  on `transaction_reconciliation_flags` (different lifecycle: staging
  rows are ephemeral, flags persist past approval). The CHECK constraint
  on `reconcile_state` rejects the string at the SQL layer.
- **DB-row back-reference is one-way**: `staged_transactions.linked_transaction_id`
  → `transactions.id`. The left-pane endpoint derives the
  `linkedStagedRowId` via a LEFT JOIN; no inverse FK exists on
  `transactions`. UI updates the back-ref in client state on link/unlink
  so the "linked to staged #X" indicator refreshes within 500ms without
  a fetch.
- **Cross-tenant access returns 404 everywhere** (PATCH `linkedTransactionId`,
  GET `accountId`, POST flag, DELETE flag). Never 403 — that leaks
  existence.
- **Reject behaviour on auto-match is intentionally local-only**. The
  matcher re-runs on every GET; persisting a per-user "I rejected this
  pair forever" set would inflate the schema and the staging row's
  ephemerality (60-day expire) makes it pointless. If a future workflow
  wants persistent reject, add a `rejected_suggestions` table — don't
  bake it into `staged_transactions`.
- **`requireEncryption()` on all three new endpoints**. No soft-fallback
  on the left-pane endpoint per user decision — degrading to "—" rows
  defeats the reconcile contract.

## Test plan (current)

Live on FINLYNQ-56's DevManager test plan:

- **tc-1 (primary, human-walked)** — end-to-end with auto-match + manual
  link + skip + flag, persisted across a tab close. Verified manually on
  dev; click-walk pending on prod after rollout.
- **tc-2 (human-walked)** — auto-match false positive: accept then
  unlink; verify both rows return to `unmatched` and FK clears.
- **tc-3 (code)** — half-pair transfer still refuses approve. Existing
  approve-side classifier + Phase 3 linked-bucket refusal both apply.
  Jest harness not yet shipped — gated by inverse-mock infra debt.
- **tc-4 (human-walked)** — mixed-tier rows render correctly (one `sv1:`
  + one `v1:` in the same batch). Verified by reading the PATCH endpoint
  source; live verification needs an email-import fixture + a CSV
  upload in the same batch.

## Roadmap — known follow-ups

What's NOT shipped, ordered by likelihood of next pickup:

1. **Persist `auto_suggested` on staged rows.** Today the matcher's
   output is ephemeral (recomputed per GET). Persisting would let the
   UI show "X new suggestions since you last visited" and would let the
   matcher tune the threshold without re-running every existing batch's
   pairs. Tradeoff: storing matcher output couples it to staging-row
   lifecycle (60d expire) and means matcher-algorithm changes need a
   backfill or an "ignore if older than N days" rule.
2. **Multi-account batch support.** Today the matcher and AccountSelector
   assume one account per batch via `staged.boundAccountId`. CSV uploads
   with a per-row Account column (rare but possible) get resolved
   via `accountName` HMAC lookup; the matcher uses the bound account
   for all rows. To fully support multi-account, each row needs an
   `accountId` resolved at ingest time (or at edit time via PATCH).
3. **Flag visibility off `/import/pending`.** The
   `transaction_reconciliation_flags` rows persist past the staging
   batch — but today they only surface in the DbPane during a future
   reconciliation. Surfacing the flag on `/transactions` (badge column,
   filter, etc.) would close the loop. Add a query for "show flagged
   transactions" to the transactions list page.
4. **MCP exposure for the reconciliation surface.** Today an AI assistant
   can call `list_staged_imports` / `get_staged_import` / `approve_staged_rows`
   but cannot drive the link / skip / flag actions through MCP.
   Reasonable MCP additions: `link_staged_to_transaction`,
   `skip_staged_row`, `unskip_staged_row`, `flag_transaction_missing`,
   `unflag_transaction`. All HTTP-only (stdio has no DEK).
5. **Persistent reject for auto-match suggestions.** Today reject is
   local to the page state. If users push back on "I told you that was
   wrong yesterday and you suggested it again today," add a
   `staged_transaction_rejected_matches` table keyed on
   `(user_id, staged_row_id, transaction_id)`. Probably wait for actual
   user complaint before building.
6. **Bulk actions on the FilePane.** Today every action is per-row.
   Multi-select + "skip all selected" or "link selected to selected DB
   rows" would help heavy users with 100+ row statements. Needs UX
   thought — what does "link 5 staged to 3 DB rows" even mean?
7. **Currency-aware match.** Today the matcher requires same currency.
   Cross-currency matches (a USD bill paid through a CAD account) could
   match via FX hop with a stale-FX warning. Probably not worth the
   complexity until a real user asks.
8. **Confidence tuning.** `±0.01 / ±1d` is the team default. If the
   matcher's `exact` confidence rate is low in practice, consider
   tightening to `0` tolerance for `exact` and widening `fuzzy` to
   `±0.05 / ±2d`. Needs telemetry — count exact vs fuzzy accepts vs
   rejects per release.

## Change log

| Date | Change | Tracking |
|---|---|---|
| 2026-05-20 | F-53C two-pane reconciliation UI shipped (Phases 1–5) | FINLYNQ-56 |
| 2026-05-20 | `reconcile_state` + `transaction_reconciliation_flags` schema | FINLYNQ-55 |
| 2026-05-20 | F-53E overlap-merge prompt + already-imported marker | FINLYNQ-58 |
| 2026-05-20 | Approve gate: refuse unresolved categories | FINLYNQ-57 |
| 2026-05-20 | Parser knobs on upload UI | FINLYNQ-54 |
