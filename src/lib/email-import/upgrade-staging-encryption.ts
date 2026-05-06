/**
 * Login-time staging encryption upgrade (2026-05-06).
 *
 * Flips a user's `staged_transactions` rows from service-tier (sv1: envelope
 * wrapped with PF_STAGING_KEY) to user-tier (v1: envelope wrapped with their
 * DEK). The webhook ingests at service-tier because no DEK is available at
 * receive time; the moment the user logs in we have their DEK and can drop
 * the service-key dependency for active users.
 *
 * Combined with the 60-day staging TTL, this means rows belonging to active
 * users sit user-DEK-encrypted for the bulk of their lifetime — only the
 * window between webhook arrival and the user's next login is service-tier.
 *
 * Idempotent: every login re-runs and skips rows that are already user-tier.
 * Concurrent logins are safe — the optimistic `WHERE encryption_tier='service'`
 * makes the second update a no-op for rows the first one already flipped.
 *
 * Failure handling: per-row try/catch. If decrypt-then-encrypt fails for one
 * row (corrupted ciphertext, DEK eviction race), the row stays at service-tier
 * and the next login retries. Never throws into the caller — fire-and-forget,
 * mirrors `enqueueCanonicalizePortfolioNames`.
 *
 * `import_hash` is NEVER touched. CLAUDE.md load-bearing rule: hash is computed
 * from plaintext payee at ingest and must remain stable across the upgrade so
 * dedup keeps working at approve time.
 */

import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { encryptField } from "@/lib/crypto/envelope";
import { decryptStaged } from "@/lib/crypto/staging-envelope";

/**
 * Fire-and-forget wrapper. Schedules the upgrade on the next microtask so
 * the login response returns immediately. Any error is logged and swallowed.
 */
export function enqueueUpgradeStagingEncryption(userId: string, dek: Buffer): void {
  queueMicrotask(() => {
    upgradeStagingEncryption(userId, dek).catch((err) => {
      console.warn("[staging-upgrade] failed", {
        userId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  });
}

export interface UpgradeStagingResult {
  scanned: number;
  upgraded: number;
  failed: number;
}

/**
 * Awaitable form for tests. Production callers should use the enqueue wrapper.
 */
export async function upgradeStagingEncryption(
  userId: string,
  dek: Buffer,
): Promise<UpgradeStagingResult> {
  const rows = await db
    .select({
      id: schema.stagedTransactions.id,
      payee: schema.stagedTransactions.payee,
      category: schema.stagedTransactions.category,
      accountName: schema.stagedTransactions.accountName,
      note: schema.stagedTransactions.note,
    })
    .from(schema.stagedTransactions)
    .innerJoin(
      schema.stagedImports,
      eq(schema.stagedImports.id, schema.stagedTransactions.stagedImportId),
    )
    .where(
      and(
        eq(schema.stagedTransactions.userId, userId),
        eq(schema.stagedTransactions.encryptionTier, "service"),
        eq(schema.stagedImports.status, "pending"),
      ),
    );

  let upgraded = 0;
  let failed = 0;

  for (const r of rows) {
    try {
      const payeePt = decryptStaged(r.payee);
      const categoryPt = decryptStaged(r.category);
      const acctPt = decryptStaged(r.accountName);
      const notePt = decryptStaged(r.note);

      const payeeCt = payeePt != null ? encryptField(dek, payeePt) : null;
      const categoryCt = categoryPt != null ? encryptField(dek, categoryPt) : null;
      const acctCt = acctPt != null ? encryptField(dek, acctPt) : null;
      const noteCt = notePt != null ? encryptField(dek, notePt) : null;

      await db
        .update(schema.stagedTransactions)
        .set({
          payee: payeeCt,
          category: categoryCt,
          accountName: acctCt,
          note: noteCt,
          encryptionTier: "user",
        })
        .where(
          and(
            eq(schema.stagedTransactions.id, r.id),
            // Optimistic guard — concurrent login already upgraded this row.
            eq(schema.stagedTransactions.encryptionTier, "service"),
          ),
        );
      upgraded++;
    } catch (err) {
      failed++;
      console.warn("[staging-upgrade] row failed", {
        id: r.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { scanned: rows.length, upgraded, failed };
}
