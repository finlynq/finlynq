/**
 * Simplified-mode upload helper (Phase 2 of the import-modes refactor,
 * 2026-05-25). Per [plan/import-modes-simplified-detailed.md](../../../../plan/import-modes-simplified-detailed.md).
 *
 * When `template.importMode === 'simplified'` the upload route routes the
 * parsed batch through this helper instead of the staged-then-approve
 * flow. The user skips `/import/pending` review entirely; rows land
 * directly in `bank_transactions` and surface on `/reconcile` for
 * categorization.
 *
 * Invariants preserved (all per CLAUDE.md):
 *   - `import_hash` over PLAINTEXT payee — supplied by the caller from the
 *     existing classifier output. Never recomputed here.
 *   - `upsertBankTransaction` is the canonical writer for `bank_transactions`.
 *     Encryption tier follows `dek != null` (user-tier `v1:` envelope).
 *   - Dedup via the ON CONFLICT (user_id, account_id, import_hash,
 *     occurrence_index) path — `wasInserted=false` rows are re-import hits
 *     and counted as `skippedDuplicates`. Content columns NEVER updated.
 *   - `upsertBankBalanceAnchors` validates the anchor sequence via the
 *     existing checkpoint-style validator — divergence warns but allows.
 *   - `bank_upload_batches` row written FIRST so a partial-failure scenario
 *     leaves a batch row that future bank_transactions can still reference
 *     (and Phase 4's batch undo can clean up).
 *
 * Refuses (returns null) when `accountId` is null — simplified mode requires
 * a bound account, since the bank-ledger uniqueness key is per-account.
 */

import { db, schema } from "@/db";
import { upsertBankTransaction } from "@/lib/bank-ledger";
import { encryptStagingMeta } from "@/lib/crypto/staging-metadata";
import {
  upsertBankBalanceAnchors,
  type BalanceAnchor,
} from "@/lib/bank-ledger-balance";

/** Shape supplied by the upload route's classifier (the `shaped` rows). */
export interface SimplifiedRow {
  rowIndex: number;
  date: string;          // YYYY-MM-DD
  amount: number;
  currency: string;
  payee: string;
  note?: string | null;
  tags?: string | null;
  accountName?: string | null;
  fitId?: string | null;
  enteredAmount?: number | null;
  enteredCurrency?: string | null;
  enteredFxRate?: number | null;
  quantity?: number | null;
  // FINLYNQ-195 — investment-import capture (v1). PLAINTEXT here; the
  // bank-ledger writer encrypts at the row's tier. NULL for cash-account rows.
  ticker?: string | null;
  securityName?: string | null;
  importHash: string;
}

export interface SimplifiedUploadParams {
  userId: string;
  /** REQUIRED — simplified path is user-tier only. */
  dek: Buffer;
  accountId: number;
  templateId: number | null;
  rows: SimplifiedRow[];
  anchors: BalanceAnchor[];
  filename: string | null;
  /** 'upload' | 'connector' — 'email' should stay on detailed (no DEK). */
  source: "upload" | "connector";
}

export interface SimplifiedUploadResult {
  mode: "simplified";
  batchId: string;
  created: number;
  skippedDuplicates: number;
  anchorsUpserted: number;
  redirectTo: string;
}

export async function simplifiedUpload(
  params: SimplifiedUploadParams,
): Promise<SimplifiedUploadResult> {
  const {
    userId,
    dek,
    accountId,
    templateId,
    rows,
    anchors,
    filename,
    source,
  } = params;

  // ─── 1. Create the upload-batch row ─────────────────────────────────────
  // FIRST, so we have a stable id to stamp on every bank_transactions row
  // and the anchor batch lineage.
  const inserted = await db
    .insert(schema.bankUploadBatches)
    .values({
      userId,
      accountId,
      templateId,
      source,
      mode: "simplified",
      // FINLYNQ-120 — bank_upload_batches rows are PERMANENT; encrypt the
      // filename under the user's DEK (this path always has one). The
      // plaintext filename still flows into bank_transactions.source_filenames
      // below (out of FINLYNQ-120 scope — that column is unchanged).
      filename: encryptStagingMeta(filename, "user", dek),
      encryptionTier: "user",
      rowCount: rows.length,
      anchorCount: anchors.length,
    })
    .returning({ id: schema.bankUploadBatches.id });

  if (inserted.length === 0) {
    throw new Error("simplifiedUpload: bank_upload_batches insert returned no row");
  }
  const batchId = inserted[0].id;

  // ─── 2. Upsert bank_transactions ────────────────────────────────────────
  // Same-batch occurrence_index: rows whose (date, amount, payee) collide
  // get distinct 0, 1, 2, … indexes so each lands as its own ledger entry.
  // Mirrors the ROW_NUMBER() partition used by the backfill migration.
  const occurrenceCounts = new Map<string, number>();
  let created = 0;
  let skippedDuplicates = 0;

  for (const row of rows) {
    const occ = occurrenceCounts.get(row.importHash) ?? 0;
    occurrenceCounts.set(row.importHash, occ + 1);

    const { wasInserted } = await upsertBankTransaction(dek, {
      userId,
      accountId,
      importHash: row.importHash,
      occurrenceIndex: occ,
      fitId: row.fitId ?? null,
      date: row.date,
      amount: row.amount,
      currency: row.currency,
      enteredAmount: row.enteredAmount ?? null,
      enteredCurrency: row.enteredCurrency ?? null,
      enteredFxRate: row.enteredFxRate ?? null,
      quantity: row.quantity ?? null,
      ticker: row.ticker ?? null,
      securityName: row.securityName ?? null,
      payee: row.payee,
      note: row.note ?? null,
      tags: row.tags ?? null,
      accountName: row.accountName ?? null,
      source: "import",
      filename,
      uploadBatchId: batchId,
    });

    if (wasInserted) {
      created += 1;
    } else {
      skippedDuplicates += 1;
    }
  }

  // ─── 3. Upsert anchors ──────────────────────────────────────────────────
  // upsertBankBalanceAnchors validates the checkpoint sequence internally
  // and warns-but-allows on divergence (per CLAUDE.md "Bank balance anchors").
  if (anchors.length > 0) {
    await upsertBankBalanceAnchors(userId, accountId, anchors, filename, batchId);
  }

  return {
    mode: "simplified",
    batchId,
    created,
    skippedDuplicates,
    anchorsUpserted: anchors.length,
    redirectTo: `/reconcile?account=${accountId}`,
  };
}
