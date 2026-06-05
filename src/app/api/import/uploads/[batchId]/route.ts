/**
 * DELETE /api/import/uploads/[batchId] (Phase 4 of import-modes refactor, 2026-05-25)
 *
 * Undoes an upload batch — removes the bank_transactions rows + anchors
 * that arrived with it. If any of those bank rows already have a primary
 * link to a `transactions` row (the user materialized them via /reconcile),
 * the route refuses with 409 + `requiresConfirmation` unless the body
 * carries `deleteLinkedTransactions: true`.
 *
 * Request body (optional JSON):
 *   { deleteLinkedTransactions?: boolean }
 *
 * Response shapes:
 *   200 — { success: true, deleted: { bankRows, anchors, linkedTransactions } }
 *   409 — { requiresConfirmation: true, bankRowCount, linkedTransactionCount, anchorCount }
 *   404 — { error: "Not found" }
 *
 * Cascade order (single transaction):
 *   1. If deleteLinkedTransactions: delete the linked `transactions` rows.
 *      The transaction_bank_links FK on the bank side cascades; the link
 *      rows go away with the bank rows in step 3.
 *   2. Delete bank_daily_balances anchored to this batch.
 *   3. Delete bank_transactions in this batch (transaction_bank_links
 *      cascades via its FK).
 *   4. Delete the bank_upload_batches row itself.
 *
 * If `deleteLinkedTransactions` is false (default), step 1 is skipped —
 * the user explicitly chose to keep the materialized transactions. Those
 * transactions lose their bank-side lineage when step 3 runs (the link
 * rows cascade-delete; `transactions.bank_transaction_id` flips to NULL
 * via its ON DELETE SET NULL rule from the original two-ledger migration).
 *
 * Load-bearing rules (CLAUDE.md):
 *   - Single transaction wrapping so partial failures don't leave dangling
 *     bank rows pointing at a deleted batch row (the FK on
 *     bank_transactions.upload_batch_id is ON DELETE SET NULL, so the
 *     ordering above is correct in practice; the transaction is belt-and-
 *     suspenders).
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { tryDecryptField } from "@/lib/crypto/envelope";
import { decryptStaged } from "@/lib/crypto/staging-envelope";
import { safeErrorMessage } from "@/lib/validate";

export const dynamic = "force-dynamic";

/**
 * GET /api/import/uploads/[batchId]
 *
 * Returns the bank_transactions a single upload batch loaded — so the
 * "Loaded into the bank ledger" section on /import can let the user click a
 * processed batch and see exactly what it brought in (decrypted payee /
 * amount / date + whether each row is now materialized in the ledger).
 *
 * Shows the CURRENT rows still linked to the batch (drops as the user deletes
 * individual rows or runs batch-undo), matching the panel's
 * `currentRowCount`. Tier-aware decrypt mirrors /api/import/bank-ledger:
 * 'user' rows via the session DEK, 'service' rows via PF_STAGING_KEY.
 *
 * Cross-tenant batchId → 404 (consistent with the rest of the import surface).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ batchId: string }> },
) {
  // Decryption needs a DEK — 423 if the session is locked (the panel surfaces
  // a "unlock to view" hint). Mirrors the bank-ledger read.
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;
  const { batchId } = await params;

  const batch = await db
    .select({
      id: schema.bankUploadBatches.id,
      accountId: schema.bankUploadBatches.accountId,
      filename: schema.bankUploadBatches.filename,
      mode: schema.bankUploadBatches.mode,
      source: schema.bankUploadBatches.source,
      uploadedAt: schema.bankUploadBatches.uploadedAt,
      rowCount: schema.bankUploadBatches.rowCount,
      anchorCount: schema.bankUploadBatches.anchorCount,
    })
    .from(schema.bankUploadBatches)
    .where(and(
      eq(schema.bankUploadBatches.id, batchId),
      eq(schema.bankUploadBatches.userId, userId),
    ))
    .get();
  if (!batch) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const rows = await db
    .select({
      id: schema.bankTransactions.id,
      date: schema.bankTransactions.date,
      amount: schema.bankTransactions.amount,
      currency: schema.bankTransactions.currency,
      payee: schema.bankTransactions.payee,
      note: schema.bankTransactions.note,
      encryptionTier: schema.bankTransactions.encryptionTier,
      txId: schema.transactions.id,
      txCategoryNameCt: schema.categories.nameCt,
    })
    .from(schema.bankTransactions)
    .leftJoin(
      schema.transactions,
      and(
        eq(schema.transactions.bankTransactionId, schema.bankTransactions.id),
        eq(schema.transactions.userId, schema.bankTransactions.userId),
      ),
    )
    .leftJoin(
      schema.categories,
      eq(schema.transactions.categoryId, schema.categories.id),
    )
    .where(and(
      eq(schema.bankTransactions.userId, userId),
      eq(schema.bankTransactions.uploadBatchId, batchId),
    ))
    .orderBy(desc(schema.bankTransactions.date), desc(schema.bankTransactions.id))
    .all();

  // Dedup by bank id (the leftJoin can fan out a row if it ever linked to
  // more than one transaction — defensive, matches the bank-ledger read).
  const seen = new Set<string>();
  const out: Array<{
    id: string;
    date: string;
    amount: number;
    currency: string;
    payee: string | null;
    note: string | null;
    category: string | null;
    linkedTransactionId: number | null;
  }> = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const tier = r.encryptionTier ?? "user";
    const decode = (v: string | null): string | null => {
      if (v == null) return null;
      return tier === "user" ? tryDecryptField(dek, v) : decryptStaged(v);
    };
    out.push({
      id: r.id,
      date: r.date,
      amount: Number(r.amount),
      currency: r.currency,
      payee: decode(r.payee),
      note: decode(r.note),
      category: r.txCategoryNameCt
        ? tryDecryptField(dek, r.txCategoryNameCt, "categories.name_ct")
        : null,
      linkedTransactionId: r.txId ?? null,
    });
  }

  return NextResponse.json({ batch, rows: out });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ batchId: string }> },
) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  const { batchId } = await params;

  // Tri-state: null = "no opinion" (initial fetch, triggers 409 if linked),
  // true  = "delete the linked transactions too",
  // false = "keep them; just orphan the lineage".
  // Distinguishing null from false is load-bearing — the modal's
  // "Keep transactions" branch sends `false` and the route MUST treat
  // that as explicit consent to proceed without cascading. Pre-2026-05-27
  // this code conflated null with false and the "Keep" branch couldn't
  // complete; fixed alongside the same bug in the per-row delete route.
  let deleteLinkedTransactions: boolean | null = null;
  try {
    const body = await request.json();
    if (
      body &&
      typeof body === "object" &&
      typeof body.deleteLinkedTransactions === "boolean"
    ) {
      deleteLinkedTransactions = body.deleteLinkedTransactions;
    }
  } catch {
    // No body / invalid JSON — stays null (will trigger 409 when linked).
  }

  // Verify ownership.
  const batch = await db
    .select({ id: schema.bankUploadBatches.id, accountId: schema.bankUploadBatches.accountId })
    .from(schema.bankUploadBatches)
    .where(and(
      eq(schema.bankUploadBatches.id, batchId),
      eq(schema.bankUploadBatches.userId, userId),
    ))
    .get();
  if (!batch) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    // Pre-scan: bank rows + linked transaction ids
    const bankRows = await db
      .select({ id: schema.bankTransactions.id })
      .from(schema.bankTransactions)
      .where(and(
        eq(schema.bankTransactions.userId, userId),
        eq(schema.bankTransactions.uploadBatchId, batchId),
      ))
      .all();
    const bankIds = bankRows.map((r) => r.id);

    let linkedTransactionIds: number[] = [];
    if (bankIds.length > 0) {
      const linkedRows = await db
        .select({ transactionId: schema.transactionBankLinks.transactionId })
        .from(schema.transactionBankLinks)
        .where(and(
          eq(schema.transactionBankLinks.userId, userId),
          eq(schema.transactionBankLinks.linkType, "primary"),
          inArray(schema.transactionBankLinks.bankTransactionId, bankIds),
        ))
        .all();
      linkedTransactionIds = Array.from(new Set(linkedRows.map((r) => r.transactionId)));
    }

    const anchorRows = await db
      .select({
        userId: schema.bankDailyBalances.userId,
        accountId: schema.bankDailyBalances.accountId,
        date: schema.bankDailyBalances.date,
      })
      .from(schema.bankDailyBalances)
      .where(and(
        eq(schema.bankDailyBalances.userId, userId),
        eq(schema.bankDailyBalances.uploadBatchId, batchId),
      ))
      .all();

    if (
      linkedTransactionIds.length > 0 &&
      deleteLinkedTransactions === null
    ) {
      // `=== null` (not `!deleteLinkedTransactions`) so that an explicit
      // `false` from the modal's "Keep transactions" branch falls through
      // to the cascade below with `cascade=false`.
      return NextResponse.json(
        {
          requiresConfirmation: true,
          bankRowCount: bankIds.length,
          linkedTransactionCount: linkedTransactionIds.length,
          anchorCount: anchorRows.length,
          hint: "Pass { deleteLinkedTransactions: true } to remove the linked transactions too, or false to keep them as bank-lineage-NULL orphans.",
        },
        { status: 409 },
      );
    }

    const cascadeLinkedTx = deleteLinkedTransactions === true;

    // ─── Cascade delete in a single transaction ─────────────────────────
    await db.transaction(async (tx) => {
      // 1. Optional: delete linked transactions when the user opts in.
      if (cascadeLinkedTx && linkedTransactionIds.length > 0) {
        await tx
          .delete(schema.transactions)
          .where(and(
            eq(schema.transactions.userId, userId),
            inArray(schema.transactions.id, linkedTransactionIds),
          ));
      }

      // 2. Anchors stamped with this batch.
      if (anchorRows.length > 0) {
        // bank_daily_balances has a composite PK (user, account, date) so
        // delete by the filter rather than by id.
        await tx
          .delete(schema.bankDailyBalances)
          .where(and(
            eq(schema.bankDailyBalances.userId, userId),
            eq(schema.bankDailyBalances.uploadBatchId, batchId),
          ));
      }

      // 3. Bank rows for this batch (transaction_bank_links cascades via FK).
      if (bankIds.length > 0) {
        await tx
          .delete(schema.bankTransactions)
          .where(and(
            eq(schema.bankTransactions.userId, userId),
            eq(schema.bankTransactions.uploadBatchId, batchId),
          ));
      }

      // 4. The batch row itself.
      await tx
        .delete(schema.bankUploadBatches)
        .where(and(
          eq(schema.bankUploadBatches.id, batchId),
          eq(schema.bankUploadBatches.userId, userId),
        ));
    });

    return NextResponse.json({
      success: true,
      deleted: {
        bankRows: bankIds.length,
        anchors: anchorRows.length,
        linkedTransactions: cascadeLinkedTx ? linkedTransactionIds.length : 0,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: safeErrorMessage(err, "Failed to undo upload batch") },
      { status: 500 },
    );
  }
}
