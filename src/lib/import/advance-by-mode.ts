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
 * 2026-09-17 fix: the rule-firing sweep below used to run ONLY when
 * `sendStagedRowsToBankLedger` found something NEW to promote in the current
 * batch. On a re-sync that finds nothing new — the common case for a live
 * bank feed re-pulling mostly-already-known transactions — the function
 * returned early and never re-checked for OLDER `bank_transactions` rows
 * still missing a `transaction_bank_links` row (stuck there for any reason —
 * a transient bug, a rule added after the fact). The sweep now always runs
 * for `mode=auto`, independent of whether the current batch had anything new,
 * capped at 500 rows per call (matches `/api/reconcile/apply-rules`'s own
 * cap) so it stays bounded on an account with a large backlog. Its outcome is
 * reported separately (`sweptStaleRows`) rather than folded into
 * `stage`/`bankBatchId`/`promoted` — those three keep describing ONLY what
 * the current batch did, unchanged, because two existing callers depend on
 * that: `staging/upload/route.ts`'s `reachedLedger` redirect check
 * (`stage !== "pending"`) and the Auto-pilot toast's `total: advance.promoted`
 * — both would misreport if a promote-nothing-new batch started claiming
 * `stage:"loaded"` or a nonzero `recorded` with `promoted:0`.
 */

import { db, schema } from "@/db";
import { and, eq, isNull, notInArray } from "drizzle-orm";
import { sendStagedRowsToBankLedger } from "@/lib/import/send-to-bank-ledger";
import { applyRulesToBankRows } from "@/lib/reconcile/match-engine";

/** Cap per sweep call — mirrors /api/reconcile/apply-rules's own cap so an
 *  account with a large stuck backlog can't turn one sync into an unbounded
 *  rule-firing pass. Anything left over is picked up on the next sync. */
const SWEEP_MAX_ROWS = 500;

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
   *  materialized this call, up to SWEEP_MAX_ROWS. Always 0 outside auto mode. */
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
        .where(eq(schema.bankTransactions.uploadBatchId, promote.batchId))
        .all()
    : [];
  const batchIds = batchBankRows.map((r) => r.id);
  const batchIdSet = new Set(batchIds);

  // Every OTHER unlinked bank row on THIS account (not "every unlinked row
  // for the user"), excluding the current batch, capped at SWEEP_MAX_ROWS so
  // a large backlog can't turn one sync into an unbounded rule-firing pass —
  // the current batch is never truncated by this cap since it's queried
  // separately above. Joining on `user_id` too (not just
  // `bank_transaction_id`) so the anti-join can use
  // `transaction_bank_links_user_bank_idx` — every index on that table leads
  // with `user_id`, so a bank-id-only join condition can't use one.
  const staleRowsQuery = db
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
      batchIds.length > 0 ? notInArray(schema.bankTransactions.id, batchIds) : undefined,
    ))
    .limit(SWEEP_MAX_ROWS);
  const staleBankRows = await staleRowsQuery.all();
  const staleIds = staleBankRows.map((r) => r.id);

  const allIds = [...batchIds, ...staleIds];
  if (allIds.length === 0) return promote.ok ? loaded : base;

  const applied = await applyRulesToBankRows(userId, allIds, dek, {
    autoMaterialize: true,
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
    stage: batchRecorded > 0 ? "recorded" : "loaded",
    recorded: batchRecorded,
    rulesFired: batchRulesFired,
    possibleDuplicates: batchPossibleDuplicates,
    sweptStaleRows: staleRecorded,
  };
}
