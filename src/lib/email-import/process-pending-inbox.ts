/**
 * DEK-bearing email-inbox sweep (Epic B5).
 *
 * Runs with the user's DEK in scope (login / MFA-verify / demo / Email-tab
 * GET). Two passes:
 *
 *   Pass A — service→user encryption upgrade for the user's email_inbox rows
 *            (decrypt sv1: from/subject/body, re-encrypt v1:, flip
 *            encryption_tier). Mirrors upgradeStagingEncryption; per-row
 *            try/catch + optimistic WHERE so concurrent sweeps are safe.
 *
 *   Pass B — for each `needs_review` BODY row: load its staged candidate, match
 *            the user's email-import rules (decrypted), and when exactly the
 *            top-priority rule resolves an account:
 *              - recompute import_hash with the RESOLVED accountId (never the
 *                accountId=0 staged sentinel),
 *              - dedup against bank_transactions (checkDuplicates) →
 *                duplicate_skipped on a hit,
 *              - mode='auto' + a category + clean guards → promote to the bank
 *                ledger (upsertBankTransaction) + materialize a `transactions`
 *                row + a primary `transaction_bank_links` row + invalidateUser
 *                → auto_recorded,
 *              - otherwise stay needs_review (the tab pre-fills the account).
 *
 * Idempotent: a row that's already auto_recorded/duplicate_skipped is skipped;
 * re-running on a needs_review row that still matches nothing is a cheap no-op.
 * Per-user in-flight lock prevents a login + tab-GET double-fire from
 * double-recording (belt-and-braces with the bank-ledger ON CONFLICT).
 *
 * Auto-record is gated on a SENDER/SUBJECT RULE MATCH — the v1 anti-spoof
 * posture (Mailpit doesn't verify SPF/DKIM). Without a matching auto-rule an
 * email stays needs_review for an explicit user click.
 */

import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { encryptField, tryDecryptField } from "@/lib/crypto/envelope";
import { decryptStaged } from "@/lib/crypto/staging-envelope";
import { generateImportHash, checkDuplicates } from "@/lib/import-hash";
import { upsertBankTransaction } from "@/lib/bank-ledger";
import { validateSignVsCategoryById } from "@/lib/transactions/sign-category-invariant";
import { invalidateUser } from "@/lib/mcp/user-tx-cache";
import { loadActiveEmailRules, firstMatchingRule } from "@/lib/email-rules/load";

export interface ProcessInboxResult {
  scanned: number;
  upgraded: number;
  autoRecorded: number;
  duplicateSkipped: number;
  needsReview: number;
  failed: number;
}

// Per-user in-flight guard (HMR-safe via globalThis), mirrors tryBeginRebuild.
const g = globalThis as unknown as { __pfInboxSweepInFlight?: Set<string> };
function tryBeginSweep(userId: string): boolean {
  if (!g.__pfInboxSweepInFlight) g.__pfInboxSweepInFlight = new Set();
  if (g.__pfInboxSweepInFlight.has(userId)) return false;
  g.__pfInboxSweepInFlight.add(userId);
  return true;
}
function endSweep(userId: string): void {
  g.__pfInboxSweepInFlight?.delete(userId);
}

/**
 * Fire-and-forget wrapper. Schedules the sweep on the next microtask so the
 * login/tab response returns immediately. Errors are logged + swallowed.
 */
export function enqueueProcessPendingInbox(userId: string, dek: Buffer): void {
  queueMicrotask(() => {
    processPendingInboxEmails(userId, dek).catch((err) => {
      console.warn("[inbox-sweep] failed", {
        userId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  });
}

/** Awaitable form (production callers use the enqueue wrapper; the Email-tab
 *  GET awaits so the list reflects the sweep). */
export async function processPendingInboxEmails(
  userId: string,
  dek: Buffer,
): Promise<ProcessInboxResult> {
  const result: ProcessInboxResult = {
    scanned: 0,
    upgraded: 0,
    autoRecorded: 0,
    duplicateSkipped: 0,
    needsReview: 0,
    failed: 0,
  };
  if (!tryBeginSweep(userId)) return result;
  try {
    result.upgraded = await upgradeInboxEncryption(userId, dek);

    const rules = await loadActiveEmailRules(userId, dek);

    // Process needs_review BODY rows (attachments stay user-bound at the tab /
    // /import/pending; v1 auto-routes body only).
    const rows = await db
      .select({
        id: schema.emailInbox.id,
        fromAddress: schema.emailInbox.fromAddress,
        subject: schema.emailInbox.subject,
        encryptionTier: schema.emailInbox.encryptionTier,
        stagedImportId: schema.emailInbox.stagedImportId,
        parseConfidence: schema.emailInbox.parseConfidence,
      })
      .from(schema.emailInbox)
      .where(
        and(
          eq(schema.emailInbox.userId, userId),
          eq(schema.emailInbox.action, "needs_review"),
          eq(schema.emailInbox.sourceKind, "body"),
        ),
      )
      .all();

    result.scanned = rows.length;

    for (const row of rows) {
      try {
        const fromAddress = decodeInbox(row.encryptionTier, dek, row.fromAddress);
        const subject = decodeInbox(row.encryptionTier, dek, row.subject);

        // Only HIGH-confidence candidates auto-record; low/unparseable stay.
        if (row.parseConfidence !== "high") {
          result.needsReview += 1;
          continue;
        }

        const rule = firstMatchingRule(rules, { fromAddress, subject });
        if (!rule) {
          result.needsReview += 1;
          continue;
        }

        // Load the staged candidate (date/amount/currency plaintext, payee
        // encrypted tier-aware).
        if (!row.stagedImportId) {
          result.needsReview += 1;
          continue;
        }
        const staged = await db
          .select({
            id: schema.stagedTransactions.id,
            date: schema.stagedTransactions.date,
            amount: schema.stagedTransactions.amount,
            currency: schema.stagedTransactions.currency,
            payee: schema.stagedTransactions.payee,
            encryptionTier: schema.stagedTransactions.encryptionTier,
          })
          .from(schema.stagedTransactions)
          .where(eq(schema.stagedTransactions.stagedImportId, row.stagedImportId))
          .limit(1);
        const cand = staged[0];
        if (!cand) {
          result.needsReview += 1;
          continue;
        }
        const payee = decodeStaged(cand.encryptionTier, dek, cand.payee) ?? "";
        const currency = (cand.currency ?? "USD").toUpperCase();

        // Recompute the import_hash with the RESOLVED account (never the
        // accountId=0 staged sentinel).
        const hash = generateImportHash(cand.date, rule.accountId, cand.amount, payee);

        // Dedup against the bank ledger.
        const dup = await checkDuplicates([hash], userId);
        if (dup.has(hash)) {
          await db
            .update(schema.emailInbox)
            .set({ action: "duplicate_skipped", matchedRuleId: rule.id })
            .where(eq(schema.emailInbox.id, row.id));
          await markStagedRejected(row.stagedImportId, cand.id);
          result.duplicateSkipped += 1;
          continue;
        }

        // Decide whether we can auto-record. mode='review', no category, an
        // investment account, or a sign-vs-category mismatch all fall back to
        // needs_review (with the account resolved so the tab pre-fills).
        const canAuto = await canAutoRecord(userId, dek, rule, cand.amount);
        if (rule.mode !== "auto" || rule.categoryId == null || !canAuto.ok) {
          await db
            .update(schema.emailInbox)
            .set({ matchedRuleId: rule.id })
            .where(eq(schema.emailInbox.id, row.id));
          result.needsReview += 1;
          continue;
        }

        const txId = await materialize({
          userId,
          dek,
          accountId: rule.accountId,
          categoryId: rule.categoryId,
          date: cand.date,
          amount: cand.amount,
          currency,
          payee,
          importHash: hash,
        });

        await db
          .update(schema.emailInbox)
          .set({
            action: "auto_recorded",
            matchedRuleId: rule.id,
            recordedTransactionId: txId,
          })
          .where(eq(schema.emailInbox.id, row.id));
        await markStagedImported(row.stagedImportId, cand.id);
        result.autoRecorded += 1;
      } catch (err) {
        result.failed += 1;
        console.warn("[inbox-sweep] row failed", {
          id: row.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    endSweep(userId);
  }
  return result;
}

// ─── Pass A: encryption upgrade ──────────────────────────────────────────────

async function upgradeInboxEncryption(userId: string, dek: Buffer): Promise<number> {
  const rows = await db
    .select({
      id: schema.emailInbox.id,
      fromAddress: schema.emailInbox.fromAddress,
      subject: schema.emailInbox.subject,
      bodyText: schema.emailInbox.bodyText,
      bodyHtml: schema.emailInbox.bodyHtml,
    })
    .from(schema.emailInbox)
    .where(
      and(
        eq(schema.emailInbox.userId, userId),
        eq(schema.emailInbox.encryptionTier, "service"),
      ),
    )
    .all();

  let upgraded = 0;
  for (const r of rows) {
    try {
      const fromPt = decryptStaged(r.fromAddress);
      const subjPt = decryptStaged(r.subject);
      const textPt = decryptStaged(r.bodyText);
      const htmlPt = decryptStaged(r.bodyHtml);

      await db
        .update(schema.emailInbox)
        .set({
          fromAddress: fromPt != null ? encryptField(dek, fromPt) : null,
          subject: subjPt != null ? encryptField(dek, subjPt) : null,
          bodyText: textPt != null ? encryptField(dek, textPt) : null,
          bodyHtml: htmlPt != null ? encryptField(dek, htmlPt) : null,
          encryptionTier: "user",
        })
        .where(
          and(
            eq(schema.emailInbox.id, r.id),
            // Optimistic guard — concurrent sweep already flipped this row.
            eq(schema.emailInbox.encryptionTier, "service"),
          ),
        );
      upgraded++;
    } catch (err) {
      console.warn("[inbox-sweep] upgrade row failed", {
        id: r.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return upgraded;
}

// ─── Materialize (mirrors /api/bank-transactions/[bankId]/approve) ───────────

async function materialize(args: {
  userId: string;
  dek: Buffer;
  accountId: number;
  categoryId: number;
  date: string;
  amount: number;
  currency: string;
  payee: string;
  importHash: string;
}): Promise<number> {
  const { userId, dek, accountId, categoryId, date, amount, currency, payee, importHash } = args;

  // Promote to the bank ledger first (content-immutable, dedup source of truth).
  const { id: bankTxId } = await upsertBankTransaction(dek, {
    userId,
    accountId,
    importHash,
    occurrenceIndex: 0,
    date,
    amount,
    currency,
    payee,
    source: "import",
  });

  // Materialize the categorized transaction + primary link in one DB tx.
  const txId = await db.transaction(async (tx) => {
    const txRow = await tx
      .insert(schema.transactions)
      .values({
        userId,
        date,
        accountId,
        categoryId,
        currency,
        amount,
        payee: encryptField(dek, payee) ?? "",
        note: "",
        tags: "",
        importHash,
        bankTransactionId: bankTxId,
        // Email import → ledger materialization.
        source: "import",
      })
      .returning({ id: schema.transactions.id });

    await tx.insert(schema.transactionBankLinks).values({
      userId,
      transactionId: txRow[0].id,
      bankTransactionId: bankTxId,
      linkType: "primary",
      source: "import",
    });

    return txRow[0].id;
  });

  invalidateUser(userId);
  return txId;
}

async function canAutoRecord(
  userId: string,
  dek: Buffer,
  rule: { accountId: number; categoryId: number | null },
  amount: number,
): Promise<{ ok: boolean }> {
  if (rule.categoryId == null) return { ok: false };

  // Investment-account guard — the body surface doesn't collect a holding.
  const acct = await db
    .select({ isInvestment: schema.accounts.isInvestment })
    .from(schema.accounts)
    .where(
      and(eq(schema.accounts.id, rule.accountId), eq(schema.accounts.userId, userId)),
    )
    .limit(1);
  if (!acct[0] || acct[0].isInvestment) return { ok: false };

  // Cross-tenant FK guard on the category.
  const cat = await db
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(
      and(eq(schema.categories.id, rule.categoryId), eq(schema.categories.userId, userId)),
    )
    .limit(1);
  if (!cat[0]) return { ok: false };

  // Sign-vs-category — same enforcement as /approve. Mismatch → fall back to
  // needs_review so the user can pick a different category.
  const violation = await validateSignVsCategoryById(userId, dek, rule.categoryId, amount);
  if (violation) return { ok: false };

  return { ok: true };
}

// ─── Staged-import lifecycle helpers ─────────────────────────────────────────

async function markStagedImported(stagedImportId: string, stagedTxId: string): Promise<void> {
  await db
    .update(schema.stagedTransactions)
    .set({ rowStatus: "approved" })
    .where(eq(schema.stagedTransactions.id, stagedTxId));
  await db
    .update(schema.stagedImports)
    .set({ status: "imported" })
    .where(eq(schema.stagedImports.id, stagedImportId));
}

async function markStagedRejected(stagedImportId: string, stagedTxId: string): Promise<void> {
  await db
    .update(schema.stagedTransactions)
    .set({ rowStatus: "rejected" })
    .where(eq(schema.stagedTransactions.id, stagedTxId));
  await db
    .update(schema.stagedImports)
    .set({ status: "rejected" })
    .where(eq(schema.stagedImports.id, stagedImportId));
}

// ─── Tier-aware decrypt helpers ──────────────────────────────────────────────

function decodeInbox(tier: string | null, dek: Buffer, value: string | null): string | null {
  if (value == null || value === "") return value;
  if ((tier ?? "service") === "user") {
    return tryDecryptField(dek, value, "email_inbox");
  }
  try {
    return decryptStaged(value);
  } catch {
    return null;
  }
}

function decodeStaged(tier: string | null, dek: Buffer, value: string | null): string | null {
  if (value == null || value === "") return value;
  if ((tier ?? "service") === "user") {
    return tryDecryptField(dek, value, "staged_transactions.payee");
  }
  try {
    return decryptStaged(value);
  } catch {
    return null;
  }
}
