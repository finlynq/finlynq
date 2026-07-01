/**
 * SimpleFIN pending-transactions snapshot writer.
 *
 * Holds / not-yet-posted charges from the feed aren't imported (too volatile).
 * We snapshot them into `simplefin_pending_transactions`, REFRESHED per-account
 * on every sync (delete + re-insert), so the table always reflects the CURRENT
 * pending set — ready for a report or notification. payee/description are
 * encrypted under the user's DEK (v1:) exactly like `bank_transactions.payee`.
 */

import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { encryptField } from "@/lib/crypto/envelope";

export interface PendingSnapshotRow {
  fitId: string;
  date: string;
  amount: number;
  currency: string;
  payee: string;
  description: string;
}

/**
 * Replace one account's pending snapshot with the latest sync's pending rows.
 * Always runs the delete (so a now-empty account clears its stale snapshot);
 * inserts only when there are rows.
 */
export async function replacePendingTransactions(
  userId: string,
  dek: Buffer,
  accountId: number,
  externalAccountId: string,
  pending: PendingSnapshotRow[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(schema.simplefinPendingTransactions)
      .where(
        and(
          eq(schema.simplefinPendingTransactions.userId, userId),
          eq(schema.simplefinPendingTransactions.accountId, accountId),
        ),
      );
    if (pending.length === 0) return;
    await tx.insert(schema.simplefinPendingTransactions).values(
      pending.map((p) => ({
        userId,
        accountId,
        externalAccountId,
        fitId: p.fitId,
        date: p.date,
        amount: p.amount,
        currency: p.currency,
        payee: encryptField(dek, p.payee) ?? null,
        description: encryptField(dek, p.description) ?? null,
        encryptionTier: "user",
      })),
    );
  });
}
