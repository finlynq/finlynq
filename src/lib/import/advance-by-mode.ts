/**
 * advanceStagedImportByMode — the SINGLE mode-driven "advance" step shared by
 * the statement-upload route and the SimpleFIN connector.
 *
 * Every ingest now follows ONE pipeline: parse/pull → `writeStagedImport`
 * (rows land in `staged_imports`, i.e. /import/pending) → this step, which
 * advances the staged import as far as the account's `mode` dictates:
 *
 *   manual  → leave in /import/pending (the user reviews + approves manually)
 *   approve → promote to `bank_transactions` (awaits an /inbox click → tx)
 *   auto    → promote to `bank_transactions` + fire rules → `transactions`
 *
 * Because every row always passes through the staged stage first, the user can
 * see rows at each stage and flip an account's mode without losing visibility —
 * the mode only changes how far NEW imports auto-advance. (Replaces the old
 * simplified-vs-detailed split + `simplifiedUpload`.)
 *
 * Reuse-only: promotion is `sendStagedRowsToBankLedger` (the same bank-only
 * promote the manual approve route + MCP `send_to_bank_ledger` use), and the
 * auto rule-firing is `applyRulesToBankRows({autoMaterialize:true})` (the same
 * Auto-pilot chokepoint the upload route used). No new write logic here.
 *
 * 2026-09-17 fix (GH #349, contributed by @amityweb): the rule-firing sweep
 * below used to run ONLY when `sendStagedRowsToBankLedger` found something NEW
 * to promote in the current batch. On a re-sync that finds nothing new — the
 * common case for a live bank feed re-pulling mostly-already-known
 * transactions — the function returned early and never re-checked for OLDER
 * `bank_transactions` rows still missing a `transaction_bank_links` row (stuck
 * there for any reason: a transient bug, or a rule the user added AFTER those
 * rows arrived). GH #332 is the same rows seen from the other end — the Action
 * Center counts them, but nothing was ever going to retry them. The sweep now
 * always runs for `mode=auto`, independent of whether the current batch had
 * anything new.
 *
 * Its outcome is reported separately (`sweptStaleRows`) rather than folded
 * into `stage`/`bankBatchId`/`promoted` — those three keep describing ONLY
 * what the current batch did, unchanged, because two existing callers depend
 * on that: `staging/upload/route.ts`'s `reachedLedger` redirect check
 * (`stage !== "pending"`) and the Auto-pilot toast's `total: advance.promoted`
 * — both would misreport if a promote-nothing-new batch started claiming
 * `stage:"loaded"` or a nonzero `recorded` with `promoted:0`.
 *
 * TWO RULES GOVERN THE SWEEP, and both are load-bearing:
 *
 *   1. It is PAGED BY A PERSISTENT KEYSET CURSOR, not by a bare `LIMIT`.
 *      A cap with no `ORDER BY` lets the planner hand back the same page every
 *      sync, so rows past the cap are NEVER revisited — a rule added later
 *      would reach the first 500 rows and no others, forever. The cursor
 *      (`settings.auto_sweep_cursor:<accountId>`) advances past the last id
 *      of each full page and resets when a page comes back short, so
 *      successive syncs walk the whole account and wrap. A cap is still
 *      wanted: `POST /api/import/staging/upload` AWAITS this function, and
 *      every matched row costs a `transactions` INSERT, so an uncapped pass
 *      over a large backlog would turn one upload into a multi-minute
 *      request. Measured on the dev clone of prod, the largest single account
 *      holds 8,423 unlinked bank rows.
 *
 *   2. Stale rows run CATEGORIZE-ONLY. `record_investment_op` and
 *      `create_transfer` write into somewhere other than the bank row's own
 *      account, which the `possible_ledger_duplicate` guard never scans.
 *      Firing those retroactively at rows the user already saw and left alone
 *      would create portfolio ops and transfer pairs behind their back, so
 *      those rows come back `skipReason:'sweep_side_effect_skipped'` and stay
 *      unlinked. The CURRENT batch keeps today's full behaviour.
 */

import { db, schema } from "@/db";
import { and, asc, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import { sendStagedRowsToBankLedger } from "@/lib/import/send-to-bank-ledger";
import { applyRulesToBankRows } from "@/lib/reconcile/match-engine";

/** Rows visited per sweep call — mirrors /api/reconcile/apply-rules's own cap.
 *  The cursor below guarantees the NEXT call starts where this one stopped, so
 *  the cap bounds one call's work without bounding total coverage. */
const SWEEP_PAGE_SIZE = 500;

/** Per-account keyset cursor: the last `bank_transactions.id` the sweep
 *  visited. Empty/absent = start from the beginning. */
const sweepCursorKey = (accountId: number) => `auto_sweep_cursor:${accountId}`;

async function readSweepCursor(userId: string, accountId: number): Promise<string> {
  const rows = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(
      and(
        eq(schema.settings.userId, userId),
        eq(schema.settings.key, sweepCursorKey(accountId)),
      ),
    )
    .all();
  return rows[0]?.value ?? "";
}

/** `""` means "wrapped — start from the beginning next time". */
async function writeSweepCursor(
  userId: string,
  accountId: number,
  cursor: string,
): Promise<void> {
  await db
    .insert(schema.settings)
    .values({ key: sweepCursorKey(accountId), userId, value: cursor })
    .onConflictDoUpdate({
      target: [schema.settings.key, schema.settings.userId],
      set: { value: cursor },
    });
}

export type AdvanceStage = "pending" | "loaded" | "recorded";
export type AccountMode = "manual" | "approve" | "auto";

export interface AdvanceByModeResult {
  /** Account mode that drove the advance. */
  mode: AccountMode;
  /** Furthest stage the CURRENT BATCH reached — unaffected by the stale-row
   *  sweep (see `sweptStaleRows`). */
  stage: AdvanceStage;
  /** bank_upload_batches id created when promoted (approve/auto), else null. */
  bankBatchId: string | null;
  /** bank_transactions rows freshly inserted from the CURRENT BATCH (approve/auto). */
  promoted: number;
  /** transactions rows recorded by rules from the CURRENT BATCH (auto only). */
  recorded: number;
  /** Rows a rule matched in the CURRENT BATCH (auto only). */
  rulesFired: number;
  /** Rows matched an existing unlinked ledger tx, left for manual link (auto). */
  possibleDuplicates: number;
  /** Older, previously-unlinked bank rows on this account (NOT part of the
   *  current batch) that the retroactive sweep additionally rule-matched and
   *  materialized this call, from a page of at most SWEEP_PAGE_SIZE. Always 0
   *  outside auto mode. */
  sweptStaleRows: number;
}

export interface AdvanceByModeParams {
  userId: string;
  dek: Buffer;
  /** staged_imports.id just created by writeStagedImport. */
  stagedImportId: string;
  /** Bound account (required — approve/auto need a per-account bank ledger). */
  accountId: number;
  /** Explicit mode; when omitted it's read from the account row. */
  mode?: AccountMode;
}

export async function advanceStagedImportByMode(
  params: AdvanceByModeParams,
): Promise<AdvanceByModeResult> {
  const { userId, dek, stagedImportId, accountId } = params;

  let mode = params.mode;
  if (!mode) {
    const acct = await db
      .select({ mode: schema.accounts.mode })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.userId, userId)))
      .get();
    mode = (acct?.mode as AccountMode | undefined) ?? "manual";
  }

  const base: AdvanceByModeResult = {
    mode,
    stage: "pending",
    bankBatchId: null,
    promoted: 0,
    recorded: 0,
    rulesFired: 0,
    possibleDuplicates: 0,
    sweptStaleRows: 0,
  };

  // manual → rows stay in /import/pending for review.
  if (mode === "manual") return base;

  // approve + auto → promote non-skipped staged rows into the bank ledger.
  // `sendStagedRowsToBankLedger` already excludes reconcile_state=
  // 'skipped_duplicate' rows (exact + fuzzy dupes), so known-duplicate rows
  // never load. Mirrors the manual approve route (skipExistingMatches:false).
  const promote = await sendStagedRowsToBankLedger({
    userId,
    dek,
    stagedImportId,
    skipExistingMatches: false,
  });
  // `!promote.ok` means nothing in THIS batch was eligible (e.g. all dupes) —
  // the batch itself stays "pending" exactly as before. For `auto` mode we
  // still fall through to the sweep below (a stale-row catch-up is a
  // DIFFERENT action from "did this batch load anything"), but the returned
  // stage/bankBatchId/promoted for the batch remain `base`'s.
  if (!promote.ok && mode !== "auto") return base;

  const loaded: AdvanceByModeResult = promote.ok
    ? { ...base, stage: "loaded", bankBatchId: promote.batchId, promoted: promote.approved }
    : base;

  // approve → stop at the bank ledger; the user commits via /inbox.
  if (mode === "approve") return loaded;

  // The current batch's own bank rows (empty when !promote.ok) — kept
  // separate from the stale sweep below so the batch's own counts are never
  // diluted by the cap or mixed with rows the user left alone on purpose.
  const batchBankRows = promote.ok
    ? await db
        .select({ id: schema.bankTransactions.id })
        .from(schema.bankTransactions)
        .where(and(
          // Tenancy: the batch id is minted for this user, so this is hygiene
          // rather than a hole — but every read of `bank_transactions` in this
          // file filters on `user_id`, and this one must not be the exception.
          eq(schema.bankTransactions.userId, userId),
          eq(schema.bankTransactions.uploadBatchId, promote.batchId),
        ))
        .all()
    : [];
  const batchIds = batchBankRows.map((r) => r.id);
  const batchIdSet = new Set(batchIds);

  // One page of OTHER unlinked bank rows on THIS account (not "every unlinked
  // row for the user"), walked in id order from the persisted cursor.
  //
  // Excluding the current batch is `upload_batch_id IS DISTINCT FROM <batchId>`,
  // NOT `id NOT IN (<every batch id>)`: the column is nullable
  // (`schema-pg.ts` bankTransactions.uploadBatchId) and `upsertBankTransaction`
  // never rewrites it on a re-seen row (`bank-ledger.ts`, the ON CONFLICT DO
  // UPDATE sets last_seen_at/seen_count/source_filenames and leaves batch id
  // alone), so a row's batch id is stable and the predicate is exactly
  // equivalent — without binding one parameter per batch row. `IS DISTINCT
  // FROM` is what handles the NULLs: plain `<>` would drop every legacy row
  // that has no batch id at all, which is most of the backlog.
  //
  // Joining on `user_id` too (not just `bank_transaction_id`) so the anti-join
  // can use `transaction_bank_links_user_bank_idx` — every index on that table
  // leads with `user_id`, so a bank-id-only join condition can't use one.
  const cursor = await readSweepCursor(userId, accountId);
  const staleBankRows = await db
    .select({ id: schema.bankTransactions.id })
    .from(schema.bankTransactions)
    .leftJoin(
      schema.transactionBankLinks,
      and(
        eq(schema.transactionBankLinks.bankTransactionId, schema.bankTransactions.id),
        eq(schema.transactionBankLinks.userId, userId),
      ),
    )
    .where(and(
      eq(schema.bankTransactions.userId, userId),
      eq(schema.bankTransactions.accountId, accountId),
      isNull(schema.transactionBankLinks.id),
      promote.ok
        ? or(
            isNull(schema.bankTransactions.uploadBatchId),
            ne(schema.bankTransactions.uploadBatchId, promote.batchId),
          )
        : undefined,
      cursor ? gt(schema.bankTransactions.id, sql`${cursor}::uuid`) : undefined,
    ))
    .orderBy(asc(schema.bankTransactions.id))
    .limit(SWEEP_PAGE_SIZE)
    .all();
  const staleIds = staleBankRows.map((r) => r.id);

  // Advance the cursor past this page, or wrap when the page came back short
  // (end of the account reached). Written BEFORE the rule pass so a crash
  // mid-materialize can't re-run the same page forever; the pass is idempotent
  // (`applyRulesToBankRows` skips already-linked rows) and anything missed is
  // picked up on the next wrap.
  await writeSweepCursor(
    userId,
    accountId,
    staleIds.length === SWEEP_PAGE_SIZE ? staleIds[staleIds.length - 1] : "",
  );

  const allIds = [...batchIds, ...staleIds];
  if (allIds.length === 0) return promote.ok ? loaded : base;

  // ONE call, not two: `computeReconcileForAccount` runs once per account per
  // call (match-engine.ts), so splitting batch and stale rows into separate
  // calls would double the most expensive thing in the pass. The per-row
  // `categorizeOnly` set is what keeps their behaviour different.
  const applied = await applyRulesToBankRows(userId, allIds, dek, {
    autoMaterialize: true,
    categorizeOnly: new Set(staleIds),
  });

  // Split the combined result back into "this batch" vs "stale sweep" so the
  // batch's own recorded/rulesFired/possibleDuplicates stay exactly what
  // they'd have been without the sweep — only sweptStaleRows carries the
  // catch-up contribution.
  let batchRecorded = 0;
  let batchRulesFired = 0;
  let batchPossibleDuplicates = 0;
  let staleRecorded = 0;
  for (const row of applied.perRow) {
    const isBatchRow = batchIdSet.has(row.bankRowId);
    const materialized = row.matched && row.transactionId != null;
    if (isBatchRow) {
      if (materialized) batchRecorded += 1;
      if (row.matched) batchRulesFired += 1;
      if (row.skipReason === "possible_ledger_duplicate") batchPossibleDuplicates += 1;
    } else if (materialized) {
      staleRecorded += 1;
    }
  }

  if (!promote.ok) {
    // Nothing new this batch — only the sweep ran. Report it separately;
    // stage/promoted/recorded stay exactly `base`'s.
    return { ...base, sweptStaleRows: staleRecorded };
  }

  return {
    ...loaded,
    // Pre-PR semantics, restored verbatim: "recorded" means the rules pass RAN
    // over this batch's rows, not that any of them matched. A batch that
    // promoted nothing kept "loaded" because the old code returned early on an
    // empty id list. Making it depend on the match count instead would be a
    // silent contract change for every caller reading `stage`, and this PR is
    // supposed to leave the batch's own reporting untouched.
    stage: batchIds.length > 0 ? "recorded" : "loaded",
    recorded: batchRecorded,
    rulesFired: batchRulesFired,
    possibleDuplicates: batchPossibleDuplicates,
    sweptStaleRows: staleRecorded,
  };
}
