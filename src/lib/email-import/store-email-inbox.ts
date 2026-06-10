/**
 * Persist an inbound email to the per-user `email_inbox` (Epic B4).
 *
 * Service-tier encryption (sv1:, PF_STAGING_KEY) for from/subject/body — the
 * webhook has no user DEK at receive time. The DEK-bearing sweep (B5) upgrades
 * these to user-tier (v1:) on the user's next active session.
 *
 * Idempotent on `dedupe_key` (= provider message id + recipient): a
 * re-delivered webhook OR the poll backstop racing the webhook is a no-op.
 *
 * Distinct from `storeIncomingEmail` (admin inbox, plaintext, no user_id) —
 * this is the per-user, encrypted, action-tracked surface.
 */

import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { encryptStaged } from "@/lib/crypto/staging-envelope";

export type EmailInboxAction =
  | "pending"
  | "auto_recorded"
  | "duplicate_skipped"
  | "needs_review"
  | "unparseable"
  | "discarded"
  | "manually_recorded";

export type EmailSourceKind = "attachment" | "body";

export interface StoreEmailInboxInput {
  userId: string;
  /** Stable idempotency key — provider message id + recipient address. */
  dedupeKey: string;
  /** Provider message id (Resend id OR the DevManager push `message_id`). */
  messageId: string | null;
  fromAddress: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  sourceKind: EmailSourceKind;
  action: EmailInboxAction;
  stagedImportId?: string | null;
  parseConfidence?: "high" | "low" | null;
  matchedRuleId?: number | null;
}

export interface StoreEmailInboxResult {
  id: string;
  alreadyExisted: boolean;
}

/**
 * Default retention window for the stamped `expires_at`, in ms (60 days).
 *
 * ADVISORY / display-only (FINLYNQ-138): the cleanup sweep does NOT trust this
 * stamped value — it evaluates the user's LIVE retention setting at sweep time
 * (received_at + per-user window). We keep stamping a default-60d expires_at so
 * the column has a sane value for any consumer that reads it directly; the
 * inbox "next purge" UI derives its date from the live setting, not this stamp.
 *
 * This is the email_inbox default window, NOT the staged-import TTL — those are
 * different things (staged_imports keeps a separate fixed 14-day pending TTL).
 */
const INBOX_TTL_MS = 60 * 24 * 60 * 60 * 1000;

export async function storeEmailInbox(
  input: StoreEmailInboxInput,
): Promise<StoreEmailInboxResult> {
  // Idempotency gate — return the existing row if this email+recipient was
  // already stored (webhook retry / poll backstop / concurrent delivery).
  const existing = await db
    .select({ id: schema.emailInbox.id })
    .from(schema.emailInbox)
    .where(eq(schema.emailInbox.dedupeKey, input.dedupeKey))
    .limit(1);
  if (existing[0]?.id) {
    return { id: existing[0].id, alreadyExisted: true };
  }

  const expiresAt = new Date(Date.now() + INBOX_TTL_MS);

  // ON CONFLICT DO NOTHING guards the rare concurrent-delivery race; if it
  // hits, the RETURNING set is empty and we re-read the winner's id.
  const inserted = await db
    .insert(schema.emailInbox)
    .values({
      userId: input.userId,
      fromAddress: encryptStaged(input.fromAddress),
      subject: encryptStaged(input.subject),
      bodyText: encryptStaged(input.bodyText),
      bodyHtml: encryptStaged(input.bodyHtml),
      encryptionTier: "service",
      messageId: input.messageId,
      dedupeKey: input.dedupeKey,
      expiresAt,
      action: input.action,
      sourceKind: input.sourceKind,
      stagedImportId: input.stagedImportId ?? null,
      matchedRuleId: input.matchedRuleId ?? null,
      parseConfidence: input.parseConfidence ?? null,
    })
    .onConflictDoNothing({ target: schema.emailInbox.dedupeKey })
    .returning({ id: schema.emailInbox.id });

  if (inserted[0]?.id) {
    return { id: inserted[0].id, alreadyExisted: false };
  }

  // Lost the race — read the row the other writer inserted.
  const winner = await db
    .select({ id: schema.emailInbox.id })
    .from(schema.emailInbox)
    .where(eq(schema.emailInbox.dedupeKey, input.dedupeKey))
    .limit(1);
  return { id: winner[0]?.id ?? "", alreadyExisted: true };
}
