/**
 * Write a non-import email (mailbox or trash) to the admin inbox.
 *
 * - `mailbox`: info@/admin@/support@/etc. or a named-human match. Kept
 *   indefinitely, admin triages at /admin/inbox.
 * - `trash`: unknown/random/probing addresses. Kept 24 hours, then auto-
 *   deleted by the cleanup cron.
 *
 * Both categories fire a single admin notification per batch so the admin
 * sees new mail land without inbox spam. See
 * Research/email-import-resend-plan.md.
 */

import { randomUUID } from "crypto";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import type { AddressCategory } from "./address-router";

export interface StoreIncomingInput {
  category: Exclude<AddressCategory, "import">;
  toAddress: string;
  fromAddress: string;
  subject?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
  attachmentCount: number;
  svixId?: string | null;
}

/** Trash auto-expires in 24 hours; mailbox is kept indefinitely (null expires_at). */
const TRASH_TTL_MS = 24 * 60 * 60 * 1000;

export async function storeIncomingEmail(input: StoreIncomingInput): Promise<string | null> {
  const {
    category,
    toAddress,
    fromAddress,
    subject,
    bodyText,
    bodyHtml,
    attachmentCount,
    svixId,
  } = input;

  // Idempotency — skip if we've already stored this svix_id.
  if (svixId) {
    const existing = await db
      .select({ id: schema.incomingEmails.id })
      .from(schema.incomingEmails)
      .where(eq(schema.incomingEmails.svixId, svixId))
      .get();
    if (existing?.id) return existing.id;
  }

  const id = randomUUID();
  const expiresAt = category === "trash" ? new Date(Date.now() + TRASH_TTL_MS) : null;

  await db.insert(schema.incomingEmails).values({
    id,
    category,
    toAddress,
    fromAddress,
    subject: subject ?? null,
    bodyText: bodyText ?? null,
    bodyHtml: bodyHtml ?? null,
    attachmentCount,
    svixId: svixId ?? null,
    expiresAt,
  });

  return id;
}

/**
 * Notify all admin users about new inbox/trash activity. One notification per
 * admin per call — the count rolls up so we don't blast on every email.
 */
export async function notifyAdminsOfIncoming(
  category: Exclude<AddressCategory, "import">,
  toAddress: string,
): Promise<void> {
  const admins = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.role, "admin"))
    .all();

  if (admins.length === 0) return;

  const title = category === "mailbox"
    ? `New mail: ${toAddress}`
    : `Unknown address: ${toAddress}`;
  const message = category === "mailbox"
    ? `Routed to admin inbox — review at /admin/inbox`
    : `Held for 24h then auto-deleted — review at /admin/inbox`;

  const now = new Date().toISOString();
  await db.insert(schema.notifications).values(
    admins.map((a) => ({
      type: "admin-email",
      title,
      message,
      read: 0,
      createdAt: now,
      userId: a.id,
    })),
  );
}
