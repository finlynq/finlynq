# Transaction-canonicalization backfill pipeline

**Status:** Shipped to dev 2026-06-02. Schema + planner + apply/undo + UI + CLI. **Three bugs surfaced from review — see "Known issues — pending fix" below before extending this code.**
**Migration:** [scripts/migrations/20260602_backfill_pipeline.sql](../../scripts/migrations/20260602_backfill_pipeline.sql)
**Key modules:**
- Pure planner: [src/lib/portfolio/backfill/planner.ts](../../src/lib/portfolio/backfill/planner.ts)
- Types:        [src/lib/portfolio/backfill/types.ts](../../src/lib/portfolio/backfill/types.ts)
- Synthesize:   [src/lib/portfolio/backfill/synthesize.ts](../../src/lib/portfolio/backfill/synthesize.ts)
- Dependencies: [src/lib/portfolio/backfill/dependencies.ts](../../src/lib/portfolio/backfill/dependencies.ts)
- Apply + Undo: [src/lib/portfolio/backfill/apply.ts](../../src/lib/portfolio/backfill/apply.ts)
- UI:           [src/app/(app)/settings/backfill/page.tsx](../../src/app/(app)/settings/backfill/page.tsx) (wizard) + [[runId]/page.tsx](../../src/app/(app)/settings/backfill/[runId]/page.tsx) (review)
- CLI:          [scripts/backfill-cli.ts](../../scripts/backfill-cli.ts)
- Tests:        [tests/backfill-planner.test.ts](../../tests/backfill-planner.test.ts)

## Why

The Phase 5c cash-sleeve lot tracking shipped 2026-05-26 only writes lots for transactions inserted *through* the live engine (operations.ts hooks). Anything imported from a competitor (Wealthfolio, Ghostfolio, Mint) or imported pre-Phase-2 carries `kind=NULL`, no `trade_link_id`, and no Phase 2 canonical pair shape. The Realized Gains page is empty for those rows, and lot inventory is wrong.

This is also load-bearing for ongoing migrations: when a user imports a competitor CSV via a new connector, the rows land in `transactions` with NULL kind and no canonical pairing. The same pipeline reshapes them into Phase 2 canonical pairs so the rest of the system works.

## Pipeline (four stages, hard checkpoints)

```
PLAN          → reads transactions/holdings → writes backfill_runs + backfill_proposals
REVIEW        → user toggles status per proposal in /settings/backfill/[runId] two-pane UI
APPLY         → per-proposal DB tx: UPDATE transactions in place, replay live lot hooks,
                snapshot displaced state to backfill_audit
UNDO (≤7d UX) → restore from backfill_audit, refuses with 409 if downstream closures exist
                (mirrors cascadeDeleteForReplace's guard at _helpers.ts:77-190)
```

## Stitching engine — per-row detectors

The planner walks `transactions` ordered by `(account, date, id)`. For each row, in order (first match wins):

| Shape | Detection | Canonical kind | Confidence |
|---|---|---|---|
| Stock holding + qty>0 + cash sleeve row same date/exact-magnitude amount | Pair | `buy` + `buy_cash_leg` | HIGH |
| Stock holding + qty<0 + cash sleeve row same date/exact-magnitude amount | Pair | `sell` + `sell_cash_leg` | HIGH |
| Stock holding + qty=0 + amount>0 + category=Dividends | Single-row | `dividend` | HIGH |
| Two cash sleeves same account different currency, opposite signs | Pair | `fx_from` + `fx_to` | MEDIUM (planned for V2) |
| Cash sleeve + non-investment sibling same date/amount | Pair | `brokerage_deposit_{in,out}` | HIGH (planned for V2) |
| Stock holding + qty>0 + NO exact cash candidate | Orphan | depends on run mode | varies |

**Refusal cases** (`proposal.confidence='refused'`, not auto-applyable):
- **S1 cross-currency** — stock-leg currency != cash-leg currency. The user must record an FX Conversion first; V1 doesn't synthesize FX rates.
- **S2 combined cash leg** — one cash row matches the sum of multiple stock legs. The user must split it manually in /transactions.
- **S4 drift** — same-date+same-account near-magnitude match but `|stock| - |cash| > $0.01`. Surfaces with TWO action variants:
  - Variant A `separate_fee_row`: book a Brokerage Fee row on the cash sleeve to absorb the drift. Preserves audit trail.
  - Variant B `absorb_into_cost`: raise the stock-leg amount to match the cash-leg. Cleaner ledger but changes cost basis.

  The user picks per proposal; `variant_choice=NULL` means "still needs user input" and the apply route refuses.
- **Ambiguous candidates** — multiple cash-sleeve rows match exact magnitude. User must pick the right pair manually.
- **No cash sleeve to synthesize into** (synthesize mode + missing sleeve) — the account doesn't have a cash sleeve in the target currency; user must create one first.

**Orphan handling** is gated by the per-run preflight mode (S8):
- `refuse_orphans`: orphan stock legs surface as `orphan_stock_leg` proposals at confidence `low`. The user fixes them manually.
- `synthesize_orphans`: each orphan gets a fabricated paired cash leg tagged `source='backfill_synth'`. Bank-side balance diverges by exactly the synthesized amount — this is the expected tradeoff when the brokerage's cash isn't tracked in Finlynq.

## Apply path

Per proposal, single DB transaction:

1. **Snapshot displaced rows** → INSERT into `backfill_audit` (full row JSON, keyed by proposal_id + tx_id).
2. **UPDATE-in-place** the existing `transactions` rows. Only `amount`, `kind`, `trade_link_id`, `link_id` are patched; `updated_at = NOW()` always (audit-trio invariant). `id`, `created_at`, `import_hash`, `bank_transaction_id`, `source`, `payee_ct`, `name_lookup` are preserved — load-bearing per [invariants.md](invariants.md).
3. **INSERT synthesized rows** (synthesize-mode cash legs, drift variant A fee rows) tagged `source='backfill_synth'`.
4. **Replay live lot hooks** by calling `applyLotEffectsForTx(row, ctx)` from [src/lib/portfolio/lots/write-hooks.ts:904](../../src/lib/portfolio/lots/write-hooks.ts) for every replaced + synthesized row. This satisfies the audit-invariants script's invariant #8 (portfolio-ops kinds only originate from the canonical lot module) — the backfill imports from `@/lib/portfolio/lots/write-hooks` rather than writing raw `kind: 'buy'` literals.
5. **`invalidateUser(userId)`** for the MCP per-user tx cache (MCP cache invariant from CLAUDE.md).

## Dependency graph

Computed at plan time by [dependencies.ts](../../src/lib/portfolio/backfill/dependencies.ts): a Sell proposal carries `depends_on_proposal_ids[]` listing every Buy proposal in the same `(holding, account)` whose lots it FIFO-closes from.

Enforcement:
- **UI**: checking a dependent without its parent auto-checks the parent + shows a callout.
- **Apply route**: server-side topological sort (Kahn's algorithm) before iterating proposals. Refuses with `dependencies_unapplied` if any parent is not yet `applied`.

## Undo path

`POST /api/settings/backfill/[runId]/undo/[proposalId]`:

1. Verify proposal belongs to this run + user, status='applied'.
2. **Check for child proposals** already applied — those depend on this one's lots; undoing would break them. Returns `409 { code: 'dependents_applied', blockingProposalIds[] }`.
3. **Check for downstream closures** via `canEditPortfolioRow(userId, txId)` from [operations.ts:1297](../../src/lib/portfolio/operations.ts) — same predicate as the live edit guard. Walks the row's lots, queries `holding_lot_closures` for any matching `lotId`. Returns `409 { code: 'portfolio_edit_blocked', blockingClosureTxIds[] }`.
4. **Reverse lots** via `reverseLotsForDeleteHook(userId, txId)` for each tx in the proposal's scope (existing + synthesized).
5. **Restore** existing rows from `backfill_audit.before_json` (UPDATE-in-place).
6. **DELETE** any `source='backfill_synth'` rows associated with this proposal.
7. Mark `proposal.status='undone'`, `invalidateUser`.

## Idempotency (S5)

Re-running the planner after apply returns `[]` — the `isAlreadyCanonical(tx)` filter in [types.ts](../../src/lib/portfolio/backfill/types.ts) skips rows where `kind IS NOT NULL AND (kind IN pair-less-set OR tradeLinkId IS NOT NULL OR linkId IS NOT NULL)`.

Partial-applied runs work too — only proposals with `status='approved'` get applied, leaving the rest in `pending` for a future review pass.

## Schema invariants for future contributors

When extending the backfill pipeline:

- **NEVER use DELETE+INSERT on existing rows** — UPDATE-in-place is load-bearing. Synthesis is the only path that creates net-new rows, and only with `source='backfill_synth'`.
- **NEVER write raw `kind: 'buy' | 'sell' | ...` literals** in apply.ts — always go through `applyLotEffectsForTx`. The audit-invariants script's #8 invariant will catch deviation.
- **NEVER skip `invalidateUser(userId)`** after a successful apply or undo — the MCP per-user tx cache will serve stale data.
- **Adding a new proposal kind** requires: (1) the planner detector in planner.ts, (2) test fixtures in tests/backfill-planner.test.ts, (3) any new replacement-payload shape documented in this file.
- **Adding a new refusal reason** requires: only updating the planner; the apply route reads `confidence='refused'` and refuses without case-by-case logic.

## Known issues — pending fix

Surfaced by a manual review session on the demo user (1,280 investment-account transactions) on 2026-06-02. Full hand-off: [HANDOVER_2026-06-02_BACKFILL_REVIEW_BUGS.md](../../../HANDOVER_2026-06-02_BACKFILL_REVIEW_BUGS.md).

1. **Wizard "Specific accounts" picker reads the wrong field name.** `/api/accounts` returns rows with `id` (from `db.select().from(accounts)` in [queries.ts:22-26](../../src/lib/queries.ts)), but the wizard at [src/app/(app)/settings/backfill/page.tsx](../../src/app/(app)/settings/backfill/page.tsx) reads `a.accountId` which is undefined. Symptom: empty picker, or (pre-strict-filter) clicking one checkbox marks them all. **Fix:** read `a.id`, alias locally as `accountId`.
2. **Coverage and planner predicates have diverged.** The planner's `isAlreadyCanonical` (commit `92ed3a6`) treats any non-null `kind` as canonical; the coverage endpoint at [coverage/route.ts](../../src/app/api/settings/backfill/coverage/route.ts) requires kind AND (pair-less kind OR pair link). Effect: dashboard reports N pending, planner returns 0 proposals. Root cause: `kind='buy'` without `trade_link_id` is ambiguous — could be an intentional opening balance OR a broken pair.
3. **Kind column tags vs. coverage count mismatch** (same root cause as #2). User sees all 4 Gold Coins rows tagged `buy` in the `/transactions` Kind column but coverage says 3/4 canonical.

**Recommended fix** (in the hand-off): introduce `kind='opening_balance'` as a distinct literal so the planner can stamp it on carry-in rows. Then both predicates count `'opening_balance'` as pair-less canonical; a row with `kind='buy'` + no pair is unambiguously a bug. Requires a small data migration on dev to re-tag existing `kind='buy'` + no-pair rows that came from the broken first-pass opening_balance flow.

**Known damage on dev:** one VWRD.L lot (32 shares, opened 2022-12-31 on IBKR Joint) is duplicated because the pre-fix opening_balance path re-applied the same proposal twice. The fix prevents new duplicates; the existing duplicate must be cleaned up manually by deleting one of the two `2022-12-31` VWRD.L buy rows from `/transactions` (the `reverseLotsForDeleteHook` handles lot cleanup).

## V2 work surfaced by stress testing (not yet shipped)

- **S1 cross-currency synthesis** — fabricate FX Conversion pair when the user supplies a known rate or accepts a historical lookup.
- **S2 N-row trade families** — generalize `operations.ts` to support combined-cash-leg structures so the user doesn't have to manually split.
- **DRIP normalization** — detect "dividend + same-day buy at dividend amount" as a single reinvestment proposal.
- **Stock split / corporate-action backfill** — separate concern; integrate with existing `add_split` MCP tool.
- **Direct CSV ingest from competitor exports** — new connector under `@finlynq/import-connectors` that lands rows into `transactions`, then the backfill pipeline canonicalizes them.

## Verification

```bash
cd pf-app
npx vitest run tests/backfill-planner.test.ts   # 10/10 PASS — all 8 stress scenarios + worked example
npx tsc --noEmit
npm run audit:invariants                         # 8/8 PASS — backfill imports applyLotEffectsForTx so invariant #8 holds
```

Integration (dev env):

1. Visit `dev.finlynq.com/settings/backfill`
2. Pick `synthesize_orphans` mode if Wealthfolio-style data lacks cash sleeve activity; otherwise `refuse_orphans`
3. Pick scope, click "Compute proposals"
4. Right-pane each proposal; confirm displaced→replacement rows + lot impact
5. For drift proposals, pick variant A or B
6. Click "Apply N approved" → 200 OK
7. Verify `/portfolio/realized-gains` now populates for historical sells
8. Verify `/portfolio` shows unchanged qty + balance
9. Click "Undo" on one proposal; verify restore
10. Re-run planner → empty proposal set (idempotency)
