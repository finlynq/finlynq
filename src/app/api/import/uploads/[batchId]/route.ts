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
import { and, eq, inArray } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { safeErrorMessage } from "@/lib/validate";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ batchId: string }> },
) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  const { batchId } = await params;

  let deleteLinkedTransactions = false;
  try {
    const body = await request.json();
    if (body && typeof body === "object" && body.deleteLinkedTransactions === true) {
      deleteLinkedTransactions = true;
    }
  } catch {
    // No body / invalid JSON — default to false.
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
      !deleteLinkedTransactions
    ) {
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

    // ─── Cascade delete in a single transaction ─────────────────────────
    await db.transaction(async (tx) => {
      // 1. Optional: delete linked transactions when the user opts in.
      if (deleteLinkedTransactions && linkedTransactionIds.length > 0) {
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
        linkedTransactions: deleteLinkedTransactions ? linkedTransactionIds.length : 0,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: safeErrorMessage(err, "Failed to undo upload batch") },
      { status: 500 },
    );
  }
}
