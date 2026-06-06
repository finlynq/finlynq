/**
 * DEK-bearing email-inbox sweep + shared record path (Epic B5 / C1).
 *
 * Runs with the user's DEK in scope (login / MFA-verify / demo / Email-tab
 * GET). Two passes:
 *
 *   Pass A — service→user encryption upgrade for the user's email_inbox rows
 *            (decrypt sv1: from/subject/body, re-encrypt v1:, flip
 *            encryption_tier). Mirrors upgradeStagingEncryption; per-row
 *            try/catch + optimistic WHERE so concurrent sweeps are safe.
 *
 *   Pass B — for each high-confidence `needs_review` BODY row: match the user's
 *            email-import rules (decrypted). A matching `mode='auto'` rule
 *            delegates to `recordEmailInboxRow` (recompute account-bound hash →
 *            dedup → materialize); a `mode='review'` match just stamps the
 *            resolved rule and stays needs_review (the tab pre-fills); no match
 *            stays needs_review.
 *
 * `recordEmailInboxRow` is the SINGLE materialize path — the auto-sweep AND the
 * manual "Record" click in the Email tab both call it, so the dedup +
 * sign/investment/ownership guards + bank-ledger promotion can't diverge.
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
import { applyEmailTransform, type EmailTransform } from "@/lib/email-import/apply-transform";
import { htmlToText } from "@/lib/email-import/parse-body";

export interface ProcessInboxResult {
  scanned: number;
  upgraded: number;
  autoRecorded: number;
  duplicateSkipped: number;
  needsReview: number;
  failed: number;
}

export interface RecordEmailResult {
  status: "recorded" | "duplicate" | "not_found" | "invalid";
  transactionId?: number;
  reason?: string;
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

/** Awaitable form (the Email-tab GET awaits so the list reflects the sweep). */
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

    const rows = await db
      .select({
        id: schema.emailInbox.id,
        fromAddress: schema.emailInbox.fromAddress,
        subject: schema.emailInbox.subject,
        bodyText: schema.emailInbox.bodyText,
        bodyHtml: schema.emailInbox.bodyHtml,
        stagedImportId: schema.emailInbox.stagedImportId,
        encryptionTier: schema.emailInbox.encryptionTier,
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
        // Only HIGH-confidence candidates auto-record; low/unparseable stay.
        if (row.parseConfidence !== "high") {
          result.needsReview += 1;
          continue;
        }

        const fromAddress = decodeInbox(row.encryptionTier, dek, row.fromAddress);
        const subject = decodeInbox(row.encryptionTier, dek, row.subject);
        // body / payee / amount for the new condition fields.
        const bodyText = decodeInbox(row.encryptionTier, dek, row.bodyText);
        const bodyHtml = decodeInbox(row.encryptionTier, dek, row.bodyHtml);
        const body =
          bodyText && bodyText.trim() ? bodyText : bodyHtml ? htmlToText(bodyHtml) : "";

        let payee: string | null = null;
        let amount: number | null = null;
        if (row.stagedImportId) {
          const cand = await db
            .select({
              amount: schema.stagedTransactions.amount,
              payee: schema.stagedTransactions.payee,
              encryptionTier: schema.stagedTransactions.encryptionTier,
            })
            .from(schema.stagedTransactions)
            .where(eq(schema.stagedTransactions.stagedImportId, row.stagedImportId))
            .limit(1);
          if (cand[0]) {
            amount = cand[0].amount;
            payee = decodeStaged(cand[0].encryptionTier, dek, cand[0].payee);
          }
        }

        const rule = firstMatchingRule(rules, { fromAddress, subject, body, payee, amount });
        if (!rule) {
          result.needsReview += 1;
          continue;
        }

        if (rule.mode !== "auto" || rule.categoryId == null) {
          // Resolve the rule but wait for a user click (review mode, or an
          // auto rule with no category). Stamp the rule so the tab pre-fills.
          await db
            .update(schema.emailInbox)
            .set({ matchedRuleId: rule.id })
            .where(eq(schema.emailInbox.id, row.id));
          result.needsReview += 1;
          continue;
        }

        const recorded = await recordEmailInboxRow(userId, dek, row.id, {
          accountId: rule.accountId,
          categoryId: rule.categoryId,
          matchedRuleId: rule.id,
          finalAction: "auto_recorded",
          transform: {
            flipSign: rule.flipSign,
            dateSource: rule.dateSource,
            payeeOverride: rule.payeeOverride,
          },
        });
        if (recorded.status === "recorded") result.autoRecorded += 1;
        else if (recorded.status === "duplicate") result.duplicateSkipped += 1;
        else result.needsReview += 1;
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

/**
 * Materialize one body email into the ledger. Shared by the auto-sweep and the
 * manual "Record" click. Loads the staged candidate, recomputes the import_hash
 * with the resolved account, dedups against bank_transactions, runs the
 * sign/investment/ownership guards, promotes to the bank ledger, and writes the
 * categorized transaction + primary link. Updates the email_inbox action.
 */
export async function recordEmailInboxRow(
  userId: string,
  dek: Buffer,
  inboxId: string,
  opts: {
    accountId: number;
    categoryId: number | null;
    matchedRuleId?: number | null;
    finalAction: "auto_recorded" | "manually_recorded";
    /** Rule mapping + per-email manual overrides applied before hash/materialize. */
    transform?: EmailTransform;
  },
): Promise<RecordEmailResult> {
  const inboxRows = await db
    .select({
      id: schema.emailInbox.id,
      sourceKind: schema.emailInbox.sourceKind,
      stagedImportId: schema.emailInbox.stagedImportId,
      action: schema.emailInbox.action,
      receivedAt: schema.emailInbox.receivedAt,
    })
    .from(schema.emailInbox)
    .where(and(eq(schema.emailInbox.id, inboxId), eq(schema.emailInbox.userId, userId)))
    .limit(1);
  const inbox = inboxRows[0];
  if (!inbox) return { status: "not_found" };
  if (inbox.sourceKind !== "body" || !inbox.stagedImportId) {
    return { status: "invalid", reason: "not_a_body_email" };
  }

  // Stamp the matched rule early (a hint survives even a guard-fail).
  if (opts.matchedRuleId != null) {
    await db
      .update(schema.emailInbox)
      .set({ matchedRuleId: opts.matchedRuleId })
      .where(eq(schema.emailInbox.id, inboxId));
  }

  if (opts.categoryId == null) return { status: "invalid", reason: "no_category" };

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
    .where(eq(schema.stagedTransactions.stagedImportId, inbox.stagedImportId))
    .limit(1);
  const cand = staged[0];
  if (!cand) return { status: "invalid", reason: "no_candidate" };
  const rawPayee = decodeStaged(cand.encryptionTier, dek, cand.payee) ?? "";
  const currency = (cand.currency ?? "USD").toUpperCase();

  // Apply the rule mapping (flip-sign / date-source / payee-rename) + any
  // per-email manual overrides BEFORE guards/hash/materialize, so the bank
  // ledger + dedup key on exactly what the user records.
  const receivedDate = inbox.receivedAt
    ? inbox.receivedAt.toISOString().slice(0, 10)
    : null;
  const eff = applyEmailTransform(
    { date: cand.date, amount: cand.amount, payee: rawPayee },
    opts.transform ?? {},
    receivedDate,
  );

  const guard = await checkGuards(userId, dek, opts.accountId, opts.categoryId, eff.amount);
  if (!guard.ok) return { status: "invalid", reason: guard.reason };

  const hash = generateImportHash(eff.date, opts.accountId, eff.amount, eff.payee);
  const dup = await checkDuplicates([hash], userId);
  if (dup.has(hash)) {
    await db
      .update(schema.emailInbox)
      .set({ action: "duplicate_skipped" })
      .where(eq(schema.emailInbox.id, inboxId));
    await markStagedRejected(inbox.stagedImportId, cand.id);
    return { status: "duplicate" };
  }

  const txId = await materialize({
    userId,
    dek,
    accountId: opts.accountId,
    categoryId: opts.categoryId,
    date: eff.date,
    amount: eff.amount,
    currency,
    payee: eff.payee,
    importHash: hash,
  });

  await db
    .update(schema.emailInbox)
    .set({ action: opts.finalAction, recordedTransactionId: txId })
    .where(eq(schema.emailInbox.id, inboxId));
  await markStagedImported(inbox.stagedImportId, cand.id);
  return { status: "recorded", transactionId: txId };
}

/** Mark an inbox row discarded (user dismissed it) + reject its staged copy. */
export async function discardEmailInboxRow(
  userId: string,
  inboxId: string,
): Promise<boolean> {
  const rows = await db
    .select({
      id: schema.emailInbox.id,
      stagedImportId: schema.emailInbox.stagedImportId,
    })
    .from(schema.emailInbox)
    .where(and(eq(schema.emailInbox.id, inboxId), eq(schema.emailInbox.userId, userId)))
    .limit(1);
  if (!rows[0]) return false;
  await db
    .update(schema.emailInbox)
    .set({ action: "discarded" })
    .where(eq(schema.emailInbox.id, inboxId));
  if (rows[0].stagedImportId) {
    await db
      .update(schema.stagedImports)
      .set({ status: "rejected" })
      .where(eq(schema.stagedImports.id, rows[0].stagedImportId));
  }
  return true;
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

async function checkGuards(
  userId: string,
  dek: Buffer,
  accountId: number,
  categoryId: number,
  amount: number,
): Promise<{ ok: boolean; reason?: string }> {
  // Investment-account guard — the body surface doesn't collect a holding.
  const acct = await db
    .select({ isInvestment: schema.accounts.isInvestment })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.userId, userId)))
    .limit(1);
  if (!acct[0]) return { ok: false, reason: "account_not_found" };
  if (acct[0].isInvestment) return { ok: false, reason: "investment_account" };

  // Cross-tenant FK guard on the category.
  const cat = await db
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(and(eq(schema.categories.id, categoryId), eq(schema.categories.userId, userId)))
    .limit(1);
  if (!cat[0]) return { ok: false, reason: "category_not_found" };

  // Sign-vs-category — same enforcement as /approve.
  const violation = await validateSignVsCategoryById(userId, dek, categoryId, amount);
  if (violation) return { ok: false, reason: "sign_category_mismatch" };

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

// Exported for the Email-tab list/detail routes (tier-aware field decrypt).
export { decodeInbox, decodeStaged };
