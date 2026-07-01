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
 */

import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { sendStagedRowsToBankLedger } from "@/lib/import/send-to-bank-ledger";
import { applyRulesToBankRows } from "@/lib/reconcile/match-engine";

export type AdvanceStage = "pending" | "loaded" | "recorded";
export type AccountMode = "manual" | "approve" | "auto";

export interface AdvanceByModeResult {
  /** Account mode that drove the advance. */
  mode: AccountMode;
  /** Furthest stage the rows reached. */
  stage: AdvanceStage;
  /** bank_upload_batches id created when promoted (approve/auto), else null. */
  bankBatchId: string | null;
  /** bank_transactions rows freshly inserted (approve/auto). */
  promoted: number;
  /** transactions rows recorded by rules (auto only). */
  recorded: number;
  /** Rows a rule matched (auto only). */
  rulesFired: number;
  /** Rows matched an existing unlinked ledger tx, left for manual link (auto). */
  possibleDuplicates: number;
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
  if (!promote.ok) return base; // nothing eligible (e.g. all dupes) — stays pending

  const loaded: AdvanceByModeResult = {
    ...base,
    stage: "loaded",
    bankBatchId: promote.batchId,
    promoted: promote.approved,
  };

  // approve → stop at the bank ledger; the user commits via /inbox.
  if (mode === "approve") return loaded;

  // auto → fire rules against the freshly-promoted bank rows → transactions.
  const bankRows = await db
    .select({ id: schema.bankTransactions.id })
    .from(schema.bankTransactions)
    .where(and(
      eq(schema.bankTransactions.userId, userId),
      eq(schema.bankTransactions.uploadBatchId, promote.batchId),
    ))
    .all();
  const bankRowIds = bankRows.map((r) => r.id);
  if (bankRowIds.length === 0) return loaded;

  const applied = await applyRulesToBankRows(userId, bankRowIds, dek, {
    autoMaterialize: true,
  });
  return {
    ...loaded,
    stage: "recorded",
    recorded: applied.materialized,
    rulesFired: applied.rulesFired,
    possibleDuplicates: applied.possibleDuplicates,
  };
}
