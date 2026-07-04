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
import { and, desc, eq } from "drizzle-orm";
import { encryptField, tryDecryptField } from "@/lib/crypto/envelope";
import { decryptStaged } from "@/lib/crypto/staging-envelope";
import { decryptName } from "@/lib/crypto/encrypted-columns";
import { safeAccountName } from "@/lib/safe-name";

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

/** A decrypted pending-charge row for the read surface (FINLYNQ-249). */
export interface PendingChargeRow {
  accountId: number | null;
  accountName: string;
  fitId: string;
  date: string;
  amount: number;
  currency: string;
  /** Plaintext payee after tier-aware decrypt; null on auth-tag failure. */
  payee: string | null;
  /** Plaintext description after tier-aware decrypt; null on auth-tag failure. */
  description: string | null;
  syncedAt: string;
}

/**
 * Tier-aware decrypt of a pending row's payee/description. The writer always
 * stamps `encryption_tier='user'` (DEK, v1:), but we branch defensively per the
 * staged-transactions-reads invariant: `'service'` → decryptStaged (PF_STAGING_KEY),
 * `'user'` → tryDecryptField(dek). Returns null on failure — NEVER ciphertext.
 */
function decryptPendingField(
  tier: string,
  dek: Buffer | null,
  value: string | null,
  label: string,
): string | null {
  if (value == null) return null;
  if (tier === "user") {
    if (!dek) return null;
    return tryDecryptField(dek, value, label);
  }
  try {
    return decryptStaged(value);
  } catch {
    return null;
  }
}

/**
 * Read the caller's CURRENT pending-charges snapshot (owner-scoped), decrypted.
 *
 * This is a LIVE snapshot, not history — the writer refreshes each account's
 * rows on every sync. Ordered date DESC (newest first). Account names are
 * decrypted at this boundary via the standard `decryptName` path; payee/
 * description are tier-aware. Empty array when the snapshot is empty.
 */
export async function listPendingTransactions(
  userId: string,
  dek: Buffer,
): Promise<PendingChargeRow[]> {
  const rows = await db
    .select({
      accountId: schema.simplefinPendingTransactions.accountId,
      accountNameCt: schema.accounts.nameCt,
      accountAliasCt: schema.accounts.aliasCt,
      fitId: schema.simplefinPendingTransactions.fitId,
      date: schema.simplefinPendingTransactions.date,
      amount: schema.simplefinPendingTransactions.amount,
      currency: schema.simplefinPendingTransactions.currency,
      payee: schema.simplefinPendingTransactions.payee,
      description: schema.simplefinPendingTransactions.description,
      encryptionTier: schema.simplefinPendingTransactions.encryptionTier,
      syncedAt: schema.simplefinPendingTransactions.syncedAt,
    })
    .from(schema.simplefinPendingTransactions)
    .leftJoin(
      schema.accounts,
      eq(schema.accounts.id, schema.simplefinPendingTransactions.accountId),
    )
    .where(eq(schema.simplefinPendingTransactions.userId, userId))
    .orderBy(desc(schema.simplefinPendingTransactions.date));

  return rows.map((r) => {
    const alias = decryptName(r.accountAliasCt, dek, null);
    const name = decryptName(r.accountNameCt, dek, null);
    return {
      accountId: r.accountId,
      accountName: safeAccountName({
        id: r.accountId ?? 0,
        name,
        alias,
      }),
      fitId: r.fitId,
      date: r.date,
      amount: r.amount,
      currency: r.currency,
      payee: decryptPendingField(
        r.encryptionTier,
        dek,
        r.payee,
        "simplefin_pending_transactions.payee",
      ),
      description: decryptPendingField(
        r.encryptionTier,
        dek,
        r.description,
        "simplefin_pending_transactions.description",
      ),
      syncedAt: r.syncedAt.toISOString(),
    };
  });
}
