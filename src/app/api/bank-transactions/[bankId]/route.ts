/**
 * DELETE /api/bank-transactions/[bankId] (2026-05-27)
 *
 * Per-row counterpart to /api/import/uploads/[batchId]: removes ONE
 * bank-ledger row from `bank_transactions`. Surfaced by the trash icon
 * on /reconcile (BankPane) and /import/pending (DbPane) so a single
 * misclassified row can be removed without nuking its whole upload batch.
 *
 * Request body (optional JSON):
 *   { deleteLinkedTransactions?: boolean }
 *
 * Response shapes:
 *   200 — { success: true, data: { deletedBankId, deletedTransactionIds[] } }
 *   409 — { requiresConfirmation: true, linkedTransactionCount, bankPayee, amount }
 *   404 — { error: "Not found" }
 *
 * Cascade (single transaction):
 *   1. If linked primary tx(s) exist AND deleteLinkedTransactions=true:
 *      EXPAND those ids to their full link-id sibling closure
 *      (`expandLinkSiblings`, FINLYNQ-222) so deleting one leg of a
 *      transfer/trade/swap takes the other leg(s) with it — never leaving
 *      a half-pair orphan — then delete those `transactions` rows
 *      (transaction_bank_links cascades via the FK on the bank side in
 *      step 2). A single non-transfer tx expands to just itself.
 *   2. Delete the `bank_transactions` row. transaction_bank_links cascades.
 *
 * If deleteLinkedTransactions=false (or omitted with no primary links),
 * step 1 is skipped — the user chose to keep the materialized transactions.
 * Those transactions lose their bank-side lineage when step 2 runs
 * (`transactions.bank_transaction_id` flips to NULL via ON DELETE SET NULL).
 *
 * `bank_daily_balances` anchors are intentionally NOT touched: they're
 * keyed `(user_id, account_id, date)` and survive per-row deletion by
 * design (checkpoint-style non-compounding validation, cf. invariants.md
 * "Bank balance anchors"). The Calculated balance recomputes on next load.
 *
 * Calls `invalidateUser(userId)` after commit so the MCP per-user tx
 * cache doesn't serve stale joined data (CLAUDE.md "Every MCP tx-
 * mutating write must call `invalidateUser`").
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq, inArray } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { invalidateUser } from "@/lib/mcp/user-tx-cache";
import { expandLinkSiblings } from "@/lib/transactions/link-siblings";
import { safeErrorMessage } from "@/lib/validate";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ bankId: string }> },
) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  const { bankId } = await params;

  // Tri-state: null = "no opinion" (initial fetch, triggers 409 if linked),
  // true  = "delete the linked transactions too",
  // false = "keep them; just orphan the lineage".
  // Distinguishing null from false is load-bearing: the modal's
  // "Keep transactions" branch sends `false` and the route MUST treat
  // that as explicit consent to proceed without cascading.
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

  // Verify ownership + pull a friendly identifier for the 409 modal copy.
  const bankRow = await db
    .select({
      id: schema.bankTransactions.id,
      amount: schema.bankTransactions.amount,
      currency: schema.bankTransactions.currency,
      date: schema.bankTransactions.date,
    })
    .from(schema.bankTransactions)
    .where(
      and(
        eq(schema.bankTransactions.id, bankId),
        eq(schema.bankTransactions.userId, userId),
      ),
    )
    .limit(1);
  if (bankRow.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    // Pre-scan: every primary link to this bank row tells us which
    // `transactions` rows will lose their lineage (or be deleted along
    // with the bank row if the caller opted in).
    const linkedRows = await db
      .select({
        transactionId: schema.transactionBankLinks.transactionId,
      })
      .from(schema.transactionBankLinks)
      .where(
        and(
          eq(schema.transactionBankLinks.userId, userId),
          eq(schema.transactionBankLinks.bankTransactionId, bankId),
          eq(schema.transactionBankLinks.linkType, "primary"),
        ),
      );
    const linkedTransactionIds = Array.from(
      new Set(linkedRows.map((r) => r.transactionId)),
    );

    if (linkedTransactionIds.length > 0 && deleteLinkedTransactions === null) {
      // Refuse the destructive flow without explicit caller acknowledgment.
      // Mirrors the batch-undo route's 409 + requiresConfirmation pattern.
      // NOTE: `=== null` (not `!deleteLinkedTransactions`) so that an explicit
      // `false` from the modal's "Keep transactions" branch falls through to
      // the cascade below with `cascade=false`.
      return NextResponse.json(
        {
          requiresConfirmation: true,
          linkedTransactionCount: linkedTransactionIds.length,
          bankAmount: bankRow[0].amount,
          bankCurrency: bankRow[0].currency,
          bankDate: bankRow[0].date,
          hint: "Pass { deleteLinkedTransactions: true } to remove the linked transactions too, or false to keep them as bank-lineage-NULL orphans.",
        },
        { status: 409 },
      );
    }

    const cascadeLinkedTx = deleteLinkedTransactions === true;

    // FINLYNQ-222 — expand the linked transactions to their full link-id
    // sibling closure so deleting one leg of a transfer/trade/swap takes
    // the other leg(s) with it. Without this, the sibling leg is left
    // orphaned (link_id set, no sibling, no bank link) — a phantom
    // in/outflow that distorts the OTHER account's balance, violating the
    // "Cascade delete on link_id / trade_link_id siblings" invariant the
    // canonical DELETE /api/transactions path already honors. Reuses the
    // shared `expandLinkSiblings` helper so both routes cascade identically.
    // A single non-transfer tx expands to just itself (no over-deletion).
    let deleteIds = linkedTransactionIds;
    if (cascadeLinkedTx && linkedTransactionIds.length > 0) {
      deleteIds = await expandLinkSiblings(userId, linkedTransactionIds);
    }

    // ─── Cascade in a single transaction ────────────────────────────────
    await db.transaction(async (tx) => {
      // 1. Optional: delete linked transactions (+ their link siblings)
      //    when the caller opts in. `transaction_bank_links` rows on the
      //    tx side cascade via FK (ON DELETE CASCADE).
      if (cascadeLinkedTx && deleteIds.length > 0) {
        await tx
          .delete(schema.transactions)
          .where(
            and(
              eq(schema.transactions.userId, userId),
              inArray(schema.transactions.id, deleteIds),
            ),
          );
      }

      // 2. Delete the bank row itself. transaction_bank_links cascades on
      //    the bank side; transactions.bank_transaction_id flips to NULL
      //    via ON DELETE SET NULL for the "keep transactions" branch.
      await tx
        .delete(schema.bankTransactions)
        .where(
          and(
            eq(schema.bankTransactions.id, bankId),
            eq(schema.bankTransactions.userId, userId),
          ),
        );
    });

    invalidateUser(userId);

    return NextResponse.json({
      success: true,
      data: {
        deletedBankId: bankId,
        deletedTransactionIds: cascadeLinkedTx ? deleteIds : [],
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: safeErrorMessage(err, "Failed to delete bank transaction") },
      { status: 500 },
    );
  }
}
