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
 * mirrors `enqueueBackfillSecurities`.
 *
 * `import_hash` is NEVER touched. CLAUDE.md load-bearing rule: hash is computed
 * from plaintext payee at ingest and must remain stable across the upgrade so
 * dedup keeps working at approve time.
 */

import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { encryptField } from "@/lib/crypto/envelope";
import { decryptStaged } from "@/lib/crypto/staging-envelope";
import {
  encryptStagingMeta,
  encryptSampleRows,
  decryptStagingMeta,
  decryptSampleRows,
} from "@/lib/crypto/staging-metadata";

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
  /** Two-ledger refactor (2026-05-22) — same shape, scoped to bank_transactions. */
  bankLedger?: { scanned: number; upgraded: number; failed: number };
  /** FINLYNQ-120 — staged_imports metadata (from/subject/filename/sample_rows). */
  stagedImportsMeta?: { scanned: number; upgraded: number; failed: number };
  /** FINLYNQ-120 — bank_upload_batches.filename (permanent rows). */
  uploadBatches?: { scanned: number; upgraded: number; failed: number };
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
      // FINLYNQ-195 — investment-import capture columns also flip service→user.
      ticker: schema.stagedTransactions.ticker,
      securityName: schema.stagedTransactions.securityName,
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
      const tickerPt = decryptStaged(r.ticker);
      const securityNamePt = decryptStaged(r.securityName);

      const payeeCt = payeePt != null ? encryptField(dek, payeePt) : null;
      const categoryCt = categoryPt != null ? encryptField(dek, categoryPt) : null;
      const acctCt = acctPt != null ? encryptField(dek, acctPt) : null;
      const noteCt = notePt != null ? encryptField(dek, notePt) : null;
      const tickerCt = tickerPt != null ? encryptField(dek, tickerPt) : null;
      const securityNameCt = securityNamePt != null ? encryptField(dek, securityNamePt) : null;

      await db
        .update(schema.stagedTransactions)
        .set({
          payee: payeeCt,
          category: categoryCt,
          accountName: acctCt,
          note: noteCt,
          ticker: tickerCt,
          securityName: securityNameCt,
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

  // ─── Bank-ledger upgrade pass (2026-05-22 two-ledger refactor) ───────
  //
  // Bank_transactions written by the email-webhook ingest path land at
  // service-tier (no DEK at receive time). Same logic as staged_transactions:
  // login-time decrypt under PF_STAGING_KEY, re-encrypt under the user's
  // DEK, flip the column. `import_hash` and `fit_id` are NEVER touched —
  // both are plaintext and dedup-stable across the upgrade.
  //
  // Per-row try/catch + optimistic WHERE guard mirrors the staging pass.
  const bankLedger = await upgradeBankLedgerEncryption(userId, dek);

  // ─── FINLYNQ-120 — staged_imports metadata + bank_upload_batches.filename ──
  // Same service→user flip for the staging-metadata columns the email webhook
  // wrote at service-tier (and for any legacy plaintext rows from before this
  // shipped). Each pass is per-row try/catch + optimistic WHERE guard.
  const stagedImportsMeta = await upgradeStagedImportsMetaEncryption(userId, dek);
  const uploadBatches = await upgradeUploadBatchEncryption(userId, dek);

  return {
    scanned: rows.length,
    upgraded,
    failed,
    bankLedger,
    stagedImportsMeta,
    uploadBatches,
  };
}

async function upgradeStagedImportsMetaEncryption(
  userId: string,
  dek: Buffer,
): Promise<{ scanned: number; upgraded: number; failed: number }> {
  const rows = await db
    .select({
      id: schema.stagedImports.id,
      fromAddress: schema.stagedImports.fromAddress,
      subject: schema.stagedImports.subject,
      originalFilename: schema.stagedImports.originalFilename,
      sampleRows: schema.stagedImports.sampleRows,
      encryptionTier: schema.stagedImports.encryptionTier,
    })
    .from(schema.stagedImports)
    .where(
      and(
        eq(schema.stagedImports.userId, userId),
        eq(schema.stagedImports.encryptionTier, "service"),
      ),
    );

  let upgraded = 0;
  let failed = 0;

  for (const r of rows) {
    try {
      // Decrypt at the CURRENT (service) tier, re-encrypt under the DEK.
      const fromPt = decryptStagingMeta(r.fromAddress, "service", null);
      const subjPt = decryptStagingMeta(r.subject, "service", null);
      const filePt = decryptStagingMeta(r.originalFilename, "service", null);
      const samplePt = decryptSampleRows(r.sampleRows, "service", null);

      await db
        .update(schema.stagedImports)
        .set({
          fromAddress: encryptStagingMeta(fromPt, "user", dek),
          subject: encryptStagingMeta(subjPt, "user", dek),
          originalFilename: encryptStagingMeta(filePt, "user", dek),
          sampleRows: encryptSampleRows(samplePt, "user", dek),
          encryptionTier: "user",
        })
        .where(
          and(
            eq(schema.stagedImports.id, r.id),
            eq(schema.stagedImports.encryptionTier, "service"),
          ),
        );
      upgraded++;
    } catch (err) {
      failed++;
      console.warn("[staging-upgrade] staged_imports meta row failed", {
        id: r.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { scanned: rows.length, upgraded, failed };
}

async function upgradeUploadBatchEncryption(
  userId: string,
  dek: Buffer,
): Promise<{ scanned: number; upgraded: number; failed: number }> {
  const rows = await db
    .select({
      id: schema.bankUploadBatches.id,
      filename: schema.bankUploadBatches.filename,
    })
    .from(schema.bankUploadBatches)
    .where(
      and(
        eq(schema.bankUploadBatches.userId, userId),
        eq(schema.bankUploadBatches.encryptionTier, "service"),
      ),
    );

  let upgraded = 0;
  let failed = 0;

  for (const r of rows) {
    try {
      const filePt = decryptStagingMeta(r.filename, "service", null);
      await db
        .update(schema.bankUploadBatches)
        .set({
          filename: encryptStagingMeta(filePt, "user", dek),
          encryptionTier: "user",
        })
        .where(
          and(
            eq(schema.bankUploadBatches.id, r.id),
            eq(schema.bankUploadBatches.encryptionTier, "service"),
          ),
        );
      upgraded++;
    } catch (err) {
      failed++;
      console.warn("[staging-upgrade] bank_upload_batches row failed", {
        id: r.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { scanned: rows.length, upgraded, failed };
}

async function upgradeBankLedgerEncryption(
  userId: string,
  dek: Buffer,
): Promise<{ scanned: number; upgraded: number; failed: number }> {
  const rows = await db
    .select({
      id: schema.bankTransactions.id,
      payee: schema.bankTransactions.payee,
      note: schema.bankTransactions.note,
      tags: schema.bankTransactions.tags,
      accountName: schema.bankTransactions.accountName,
      // FINLYNQ-195 — investment-import capture columns flip service→user too.
      ticker: schema.bankTransactions.ticker,
      securityName: schema.bankTransactions.securityName,
      // FINLYNQ-132 — source_filenames is encrypted per-element at the row's
      // tier. Decrypt each service-tier element under PF_STAGING_KEY, re-encrypt
      // under the user DEK alongside the scalar fields.
      sourceFilenames: schema.bankTransactions.sourceFilenames,
    })
    .from(schema.bankTransactions)
    .where(
      and(
        eq(schema.bankTransactions.userId, userId),
        eq(schema.bankTransactions.encryptionTier, "service"),
      ),
    );

  let upgraded = 0;
  let failed = 0;

  for (const r of rows) {
    try {
      const payeePt = decryptStaged(r.payee);
      const notePt = decryptStaged(r.note);
      const tagsPt = decryptStaged(r.tags);
      const acctPt = decryptStaged(r.accountName);
      const tickerPt = decryptStaged(r.ticker);
      const securityNamePt = decryptStaged(r.securityName);

      // payee is NOT NULL on bank_transactions; fall back to empty string
      // if decrypt returns null (shouldn't happen, but the type is text
      // not text|null).
      const payeeCt = encryptField(dek, payeePt ?? "") ?? "";
      const noteCt = notePt != null ? encryptField(dek, notePt) : null;
      const tagsCt = tagsPt != null ? encryptField(dek, tagsPt) : null;
      const acctCt = acctPt != null ? encryptField(dek, acctPt) : null;
      const tickerCt = tickerPt != null ? encryptField(dek, tickerPt) : null;
      const securityNameCt = securityNamePt != null ? encryptField(dek, securityNamePt) : null;

      // FINLYNQ-132 — re-encrypt each filename element service→user. decryptStaged
      // passes legacy plaintext through unchanged; encryptField re-wraps under
      // the DEK. Null/empty elements are dropped.
      const filenamesCt: string[] = Array.isArray(r.sourceFilenames)
        ? r.sourceFilenames.flatMap((el) => {
            if (typeof el !== "string" || el === "") return [];
            const pt = decryptStaged(el);
            if (pt == null || pt === "") return [];
            const ct = encryptField(dek, pt);
            return ct ? [ct] : [];
          })
        : [];

      await db
        .update(schema.bankTransactions)
        .set({
          payee: payeeCt,
          note: noteCt,
          tags: tagsCt,
          accountName: acctCt,
          ticker: tickerCt,
          securityName: securityNameCt,
          sourceFilenames: filenamesCt,
          encryptionTier: "user",
        })
        .where(
          and(
            eq(schema.bankTransactions.id, r.id),
            // Optimistic guard — concurrent login already upgraded this row.
            eq(schema.bankTransactions.encryptionTier, "service"),
          ),
        );
      upgraded++;
    } catch (err) {
      failed++;
      console.warn("[staging-upgrade] bank_transactions row failed", {
        id: r.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { scanned: rows.length, upgraded, failed };
}
