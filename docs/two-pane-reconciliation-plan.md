# Two-pane reconciliation on `/import/pending` — implementation-ready plan

**DevManager item:** FINLYNQ-56 (F-53C). Parent FINLYNQ-53. Shipped
dependencies: FINLYNQ-54 (parser knobs), FINLYNQ-55 (`reconcile_state`
column + `transaction_reconciliation_flags` table), FINLYNQ-57
(unresolved-category gate), FINLYNQ-58 (overlap-merge + `import_hash`
index). All work is captured in the five phases below — no separate
sub-items.

## Context

`/import/pending` today is a single-pane Approve/Reject dialog. After
F-53A/B/E shipped, `staged_transactions` now carries `reconcile_state`
(`unmatched | auto_suggested | linked | skipped_duplicate`) and
`linked_transaction_id`, plus a sibling `transaction_reconciliation_flags`
table — but **the UI never surfaces or sets them**. The verifier-facing
problem is that a user importing a 60-row statement has no way to compare
it side-by-side with what's already in their account, has to eyeball
duplicates, and can't mark "the bank's statement is missing this
transaction I entered manually." This change closes that gap.

Four user decisions taken (2026-05-20):

1. **Auto-match window**: `|Δamount| ≤ 0.01` AND `|Δdate| ≤ 1 day`.
2. **Compute locus**: server-side helper at `src/lib/import/auto-match.ts`;
   results surfaced as `suggestedMatches[]` on the GET staged-detail
   response.
3. **Left-pane endpoint**: `GET /api/transactions/reconciliation?accountId=…&from=…&to=…`
   with `requireEncryption()` (decoded names; no soft fallback).
4. **Phase 1 gate dropped** — threshold no longer load-bearing across
   releases.

## Scope summary

Rebuild `/import/pending` from a single-pane Approve/Reject dialog into a
per-account two-pane reconciliation surface. The right pane shows file
rows from `staged_transactions` for one selected account; the left pane
shows existing `transactions` rows on that account within ±7 days of the
file's date range. The user has four matching actions: accept an
auto-match suggestion, manually link/unlink a file row to a DB row, mark
a file row as `skipped_duplicate`, or flag a DB row as
`missing_from_statement`. Every action persists immediately so a tab
close and reopen restores all four decisions verbatim. The existing
reconciliation balance callout (`Statement says / Finlynq has now / After
approval`) is wired to live-recompute (≤500ms) as each action lands.

## Critical files

### Modify

| Path | Role |
|---|---|
| `pf-app/src/app/(app)/import/pending/page.tsx` | Wholesale rebuild from single-pane dialog into two-pane shell. Keep `StagedRowEditor` + `ReconciliationCallout` + `UnresolvedCategoriesBanner`. |
| `pf-app/src/app/api/import/staged/[id]/route.ts` (GET) | Add `suggestedMatches: { stagedRowId, transactionId, confidence }[]`. Compute by calling `findAutoMatches()` after the per-tier decode loop. |
| `pf-app/src/app/api/import/staged/[id]/rows/[rowId]/route.ts` (PATCH) | Extend Zod schema with `reconcileState` (enum) + `linkedTransactionId` (nullable int). Validate the linked transaction belongs to the same user. Preserve every existing invariant — `import_hash` MUST NOT be recomputed; per-row encryption tier MUST NOT flip; mutual exclusion of `peer_staged_id` vs `target_account_id` unchanged. |
| `pf-app/src/app/api/import/staged/[id]/approve/route.ts` (POST) | Add a fourth bucket BEFORE the three existing buckets: rows where `reconcile_state='linked'` are de-queued (DELETE from staging) with no INSERT into `transactions`. `skipped_duplicate` rows are already filtered by the default-rowIds path. |
| `pf-app/src/components/staging/reconciliation-callout.tsx` | No signature change. Live-delta calculation moves into the parent page (already client-side); the callout stays display-only. |
| `pf-app/src/components/staging/staged-row-editor.tsx` | No body change. The new "reconcile" action surface (Skip / Link / Unlink badges) lives in the new `RowBadge` component rendered next to the editor on each row. |
| `pf-app/CHANGELOG.md` | Unreleased entry per phase commit. |
| `CLAUDE.md` (workspace) | Add load-bearing gotcha "PATCH `reconcileState` writes do NOT recompute `import_hash` or flip `encryption_tier`" once phase 1 lands. |
| `pf-app/docs/architecture/database.md` | Link reconciliation columns section to the new endpoint + page. |

### Create

| Path | Role |
|---|---|
| `pf-app/src/app/api/transactions/[id]/reconciliation-flag/route.ts` | `POST` + `DELETE`. POST body: `{ flag_kind: 'missing_from_statement', note?: string }`. Both routes scope on `user_id`; cross-tenant returns 404. |
| `pf-app/src/app/api/transactions/reconciliation/route.ts` | `GET ?accountId=N&from=YYYY-MM-DD&to=YYYY-MM-DD`. Returns decoded rows + the `staged_transactions.id` of any row whose `linked_transaction_id` references each transaction. `requireEncryption()`. |
| `pf-app/src/lib/import/auto-match.ts` | Pure: `findAutoMatches(staged, db): Suggestion[]`. Algorithm in §"Auto-match algorithm" below. |
| `pf-app/src/components/import/reconcile/account-selector.tsx` | |
| `pf-app/src/components/import/reconcile/two-pane-layout.tsx` | |
| `pf-app/src/components/import/reconcile/file-pane.tsx` | |
| `pf-app/src/components/import/reconcile/db-pane.tsx` | |
| `pf-app/src/components/import/reconcile/suggestions-group.tsx` | |
| `pf-app/src/components/import/reconcile/row-badge.tsx` | |

## Concrete contracts

### PATCH `/api/import/staged/[id]/rows/[rowId]` — new Zod fields

```ts
reconcileState: z.enum(['unmatched', 'auto_suggested', 'linked', 'skipped_duplicate']).optional(),
linkedTransactionId: z.number().int().nullable().optional(),
```

Server-side validation rules:

- `reconcileState === 'linked'` ⇒ `linkedTransactionId` must be non-null
  AND owned by `userId`.
- `reconcileState !== 'linked'` ⇒ server forces `linkedTransactionId = null`
  (no orphan refs).
- DB row owned-by check:
  `SELECT 1 FROM transactions WHERE id = $1 AND user_id = $2`. 404 on
  miss (not 403 — avoids existence-disclosure).
- Half-pair transfer rule: if `row.tx_type === 'R'` AND
  `row.peer_staged_id IS NOT NULL`, refuse PATCH with
  `code: 'half_pair_link'` unless the peer row also has
  `reconcile_state='linked'`. The UI links peers together in one batched
  PATCH; server validates the post-state.

Invariants preserved (existing PATCH behaviour):

- `update_set` MUST NOT include `import_hash`.
- `update_set` MUST NOT include `encryption_tier`.

### GET `/api/import/staged/[id]` — new response field

```ts
suggestedMatches: Array<{
  stagedRowId: string;
  transactionId: number;
  confidence: 'exact' | 'fuzzy';  // 'exact' = same date + same amount;
                                  // 'fuzzy' = within ±1d / ±0.01
}>;
```

Computed after the per-tier decode loop. Excludes (a) staged rows
already at `reconcile_state IN ('linked', 'skipped_duplicate')`,
(b) DB rows already referenced by some `staged_transactions.linked_transaction_id`.

### GET `/api/transactions/reconciliation`

```
?accountId=<int>              required
&from=<YYYY-MM-DD>            required
&to=<YYYY-MM-DD>              required
```

Window calculation (caller):
`from = staged_imports.date_range_start - 7d`,
`to = staged_imports.date_range_end + 7d`. Batch-level window — single
query per pane render.

Response:

```ts
{
  success: true,
  data: {
    transactions: Array<{
      id: number;
      date: string;
      amount: number;
      currency: string;
      payee: string | null;       // decoded; null if decrypt failed
      category: string | null;    // decoded
      note: string | null;        // decoded
      txType: 'E' | 'I' | 'R' | 'T';
      linkedStagedRowId: string | null;  // back-reference
      reconciliationFlag: { kind: string; note: string | null } | null;
    }>;
  }
}
```

`requireEncryption()` at the route head — soft fallback rejected per
user decision. User-scoped (`WHERE user_id = $1 AND account_id = $2`).
Cross-tenant returns 404.

### POST/DELETE `/api/transactions/[id]/reconciliation-flag`

POST body:

```ts
{ flag_kind: 'missing_from_statement'; note?: string }
```

Returns 201 + the new row id. `requireEncryption()` (uniform surface; the
flags table itself is plaintext but the route stays consistent).
User-scoped INSERT; cross-tenant 404 on the parent `transactions` row.

DELETE:

- Idempotent: 200 on first delete, 200 with `data: { removed: 0 }` on
  second.
- `WHERE transaction_id = $1 AND user_id = $2 AND flag_kind = $3`
  (defaults `flag_kind` to `'missing_from_statement'` if not in query).

## Auto-match algorithm

`src/lib/import/auto-match.ts`:

```ts
type Input = {
  staged: Array<{
    id: string; date: string; amount: number; currency: string;
    reconcileState: string; accountId: number | null;
  }>;
  db: Array<{
    id: number; date: string; amount: number; currency: string;
    accountId: number; alreadyLinked: boolean;
  }>;
};

type Suggestion = {
  stagedRowId: string;
  transactionId: number;
  confidence: 'exact' | 'fuzzy';
};

function findAutoMatches({ staged, db }: Input): Suggestion[] {
  const eligibleDb = db.filter(d => !d.alreadyLinked);
  const out: Suggestion[] = [];
  for (const s of staged) {
    if (s.reconcileState === 'linked' ||
        s.reconcileState === 'skipped_duplicate') continue;
    const candidates = eligibleDb.filter(d =>
      d.accountId === s.accountId &&
      d.currency === s.currency &&
      Math.abs(d.amount - s.amount) <= 0.01 &&
      Math.abs(dayDiff(d.date, s.date)) <= 1
    );
    for (const c of candidates) {
      const confidence =
        (c.date === s.date && Math.abs(c.amount - s.amount) < 1e-9)
          ? 'exact' : 'fuzzy';
      out.push({ stagedRowId: s.id, transactionId: c.id, confidence });
    }
  }
  return out;
}
```

Same currency required. Multi-candidate cases — surface all; the
SuggestionsGroup renders each as a separate accept/reject pair.
Cross-currency rows (rare on a single statement) stay `unmatched` — by
design.

## Phased delivery

Five phases, each a single isolated commit with passing `npm run build`.

### Phase 1 — Backend (PATCH extension + flag endpoint + db-rows endpoint + auto-match)

**Effort:** 2–3h.

Touches: PATCH route, GET staged-detail route, two new routes, one new
lib file.

**Acceptance:**

- `PATCH /api/import/staged/:id/rows/:rowId` accepts `reconcileState` +
  `linkedTransactionId`; rejects invalid enum with HTTP 400; rejects
  cross-tenant `linkedTransactionId` with HTTP 404.
- `POST /api/transactions/:id/reconciliation-flag` returns HTTP 201 and
  INSERTs into `transaction_reconciliation_flags`; `DELETE` is
  idempotent (200 on second call).
- `GET /api/transactions/reconciliation?accountId=…&from=…&to=…` returns
  decoded rows with `linkedStagedRowId` back-reference; cross-tenant
  `accountId` returns 404.
- `GET /api/import/staged/:id` includes `suggestedMatches: []` (empty
  array when no candidates).
- `import_hash` byte-identical before vs after PATCH on the new fields
  (verify via SQL).
- `encryption_tier` unchanged after PATCH on the new fields (verify via
  SQL).
- `npm run build` passes.

### Phase 2 — UI shell (account selector, URL state, two-pane scaffold)

**Effort:** 2–3h.

Touches: `page.tsx` (rebuild), 4 new components.

URL state: `?id=<batchId>&account=<accountId>`. Account list derived
from already-loaded staged rows. Default to first account when
`?account` absent.

**Acceptance:**

- Account selector narrows BOTH panes; URL updates without a navigation
  reload (`history.replaceState`).
- Right pane (FilePane) renders staged rows for the chosen account with
  the current `reconcileState` as a `<RowBadge>`.
- Left pane (DbPane) renders DB rows from
  `/api/transactions/reconciliation` in the ±7d batch window.
- Closing + reopening the tab with the URL intact restores both panes.
- Mixed-tier rows (one `sv1:` + one `v1:` in the same batch) both render
  decoded payee correctly.

### Phase 3 — Match actions (auto / link / unlink / skip / flag)

**Effort:** half-day.

Touches: `page.tsx`, `SuggestionsGroup`, `RowBadge`, approve route.

Auto-match suggestions render in a pinned `<SuggestionsGroup>` at the
top of the FilePane. Accept ⇒ PATCH staged row
`{ reconcileState: 'linked', linkedTransactionId: N }`. Reject ⇒ hide
locally (client state only; no persist).

Manual link: click file row → "Link" mode → click DB row → both flip.
Refuse if DB row's `linkedStagedRowId !== null` (toast).

Unlink: PATCH staged row
`{ reconcileState: 'unmatched', linkedTransactionId: null }`.

Skip / unskip: PATCH staged row
`{ reconcileState: 'skipped_duplicate' | 'unmatched' }`.

Mark-missing: POST `/api/transactions/[id]/reconciliation-flag` with
`{ flag_kind: 'missing_from_statement' }`. Un-flag: DELETE same path.

Half-pair transfer enforcement: when the user clicks Link on a
`tx_type='R'` row with `peer_staged_id`, the UI batches TWO PATCHes (one
per leg). Server-side validator refuses a half-pair PATCH.

Approve endpoint extension: route `reconcile_state='linked'` rows to a
new "de-queue only" bucket — DELETE from `staged_transactions`, NO
INSERT into `transactions`. `skipped_duplicate` rows already
default-excluded.

**Acceptance:**

- Accept-suggestion writes both fields; DB pane's "linked to staged #X"
  indicator appears within 500ms.
- Unlink reverts both rows to `unmatched` and clears
  `linked_transaction_id`.
- Mark-skipped excludes the row from the next approve (verify via SELECT
  before/after).
- Flag-missing inserts one row in `transaction_reconciliation_flags`;
  approve of the rest of the batch still succeeds (flag is a no-op for
  approve).
- Half-pair link refused with `code: 'half_pair_link'`.
- All four actions persist across tab close + reopen.

### Phase 4 — Live balance callout

**Effort:** ≤30m.

The existing `ReconciliationCallout` is display-only; the page already
computes `projectedBalance` for the eligible-rows set. Extend the
eligible-rows predicate in `page.tsx` to:

```ts
const eligible = rows.filter(r =>
  r.dedupStatus !== 'existing' &&
  r.reconcileState !== 'skipped_duplicate' &&
  r.reconcileState !== 'linked'  // linked rows already in DB balance
);
```

Recompute is already synchronous on every `setRows` call — the 500ms
target is trivially met in client memory.

**Acceptance:**

- "After approval" updates within 500ms of every match/skip/flag/link/
  unlink action.
- Currency-mismatch caveat unchanged from today (no new FX hops).

### Phase 5 — Polish + edge cases

**Effort:** 1–3h.

- Empty states: no DB rows in ±7d window, no staged rows on selected
  account, no auto-match candidates.
- Error toasts: HTTP 400 from PATCH (invalid enum), 404 from PATCH
  (cross-tenant), 404 from db-rows endpoint, 423 if DEK expires
  mid-session.
- Decimal-tolerance edge: confirm 0.005 rounds correctly (it's accepted;
  we only reject `|Δ| > 0.01`).
- E2E human-walked tc-1.

**Acceptance:**

- All four `tc-*` test cases on FINLYNQ-56 execute cleanly.
- No regression on existing approve / reject / PATCH paths
  (sign-vs-category, half-pair transfer, sv1↔v1 tier preservation,
  `import_hash` stability across edits).

## Cross-cutting `Don't` rules

Verbatim from CLAUDE.md + FINLYNQ-56 body. Each phase MUST honour:

- **Do NOT recompute `import_hash`** on any row edit, including
  `reconcile_state` toggles, link/unlink, or any new PATCH field
  introduced here. Bank-side dedup keys on the ingest-time hash. The
  PATCH's set-builder must STILL exclude `import_hash` defensively.
- **Do NOT flip the per-row `encryption_tier` mid-edit.** Even when the
  user edits payee on a row that was ingested at `service` tier, the
  re-encrypt stays at `service` (`sv1:`). The login-time upgrade job is
  the only path that promotes service → user.
- **Do NOT route `flagged_missing` through `staged_transactions.reconcile_state`.**
  That value is intentionally NOT in the CHECK enum. Flags belong on
  `transaction_reconciliation_flags`.
- **Do NOT skip the sign-vs-category invariant on approve** (issue
  #212). Linked rows skip materialize entirely so the gate doesn't
  apply; non-linked rows still must satisfy it.
- **Do NOT bypass transfer-pair routing** (issue #155). Link/unlink on
  a `tx_type='R'` row must still validate the half-pair rule from the
  approve endpoint — both peer-linked rows are linked together, or
  neither.
- **Do NOT add a SQL filter to `aggregateHoldings()` or any aggregator**
  while wiring the left pane (issue #236). The pane reads
  `transactions` raw; no aggregator changes here.
- **Do NOT bypass `requireEncryption`** on the PATCH, the new flag
  endpoint, or the new db-rows endpoint. All three need decoded names
  or re-encryption.
- **Do NOT accept client-supplied `linkId` or `trade_link_id`** anywhere
  new. Out of scope for this work, but flagged defensively in case a
  future merge prompt or auto-link path wants one.

## Verification

Map to the 4 live test cases on FINLYNQ-56:

| Test case | Phase | Verification |
|---|---|---|
| **tc-1-full-reconciliation-flow** (primary, human) | Phase 5 | Human walk-through on dev. Setup: dev user, CSV upload with ≥10 rows at `encryption_tier='user'`, ≥3 pre-existing DB tx matching staged amounts. Verify: account-selector narrows panes; auto-match surfaces; accept/manual-link/skip/flag all four work; ≤500ms callout updates; tab-close + reopen preserves all four decisions; approve materializes only `unmatched`/`auto_suggested` rows; `import_hash` byte-identical before vs after; 1 new row in `transaction_reconciliation_flags`. Evidence: `SELECT id, reconcile_state, linked_transaction_id, import_hash FROM staged_transactions WHERE staged_import_id='<uuid>'` before + after, plus 4 screenshots. |
| **tc-2-auto-match-false-positive** (human) | Phase 5 | Setup: two same-day same-amount different-payee tx (e.g., two $20 ATMs). Accept auto-match, then unlink. Verify: both rows return to `unmatched`; `linked_transaction_id` becomes NULL; no orphan FK survives. Evidence: SQL before / mid / after. |
| **tc-3-half-pair-transfer-still-errors** (code) | Phase 3 | Jest case in `pf-app/tests/staging-link-half-pair.test.ts`: PATCH one leg of a peer-linked `tx_type='R'` pair to `reconcileState='linked'`; expect HTTP 400 with `code: 'half_pair_link'`. Approve of the same batch with only one leg checked must continue to refuse with the existing half-pair error. |
| **tc-4-mixed-tier-rows-render-correctly** (human) | Phase 2 | Setup: one staged batch with one `sv1:` row (email-ingest fixture) + one `v1:` row (upload fixture). Verify: both decode in the right pane; PATCH on either re-encrypts under its existing tier. Evidence: `SELECT id, encryption_tier, substring(payee_ct from 1 for 4) AS prefix FROM staged_transactions` before AND after PATCH on each row — prefix matches tier on both rows both times. |

Plus the regression gate runs `cd pf-app && npm run audit:invariants` to
confirm no new write-site missed `invalidateUserTxCache` /
`buildNameFields` / etc. (Phase 1 + 3 each).

Cross-suite spot-check after Phase 5:

```bash
cd pf-app
npm run build                         # passes
npm run audit:invariants              # exits 0
psql $DATABASE_URL -c "SELECT reconcile_state, COUNT(*) FROM staged_transactions GROUP BY 1"
```

## Open questions (none remaining)

All five open questions resolved:

1. **Auto-match threshold**: `|Δamount| ≤ 0.01` AND `|Δdate| ≤ 1 day`.
   (User decision 2026-05-20.)
2. **Multi-candidate**: surface all; SuggestionsGroup renders each as
   separate accept/reject.
3. **DB-row pane scope**: batch-level window (min staged date − 7d to
   max staged date + 7d), one query per pane render.
4. **Flag visibility off `/import/pending`**: out of scope. Deferred to
   a separate item if/when desired.
5. **Transfer-pair link/unlink semantics**: refuse half-pair link
   server-side with `code: 'half_pair_link'`; UI batches both legs
   together.
