/**
 * Background cleanup for email-import staging queue + admin inbox trash.
 *
 * Runs two sweeps:
 *   1. staged_imports where expires_at < now AND status = 'pending'
 *      → status flipped to 'expired' AND rows deleted (cascade takes
 *        staged_transactions with them). 14-day TTL.
 *   2. incoming_emails where category = 'trash' AND expires_at < now
 *      → hard delete. 24-hour TTL.
 *
 * Bootstrapped by instrumentation.ts on the same 30-minute cadence as the
 * MCP upload cleanup. Kept dead simple — no job queue, no distributed lock;
 * a second instance will just run the same `DELETE WHERE expires_at < now`
 * and both will converge.
 */

import { db, schema } from "@/db";
import { and, eq, lt } from "drizzle-orm";

export interface EmailCleanupResult {
  stagedDeleted: number;
  trashDeleted: number;
}

export async function cleanupExpiredEmailArtifacts(): Promise<EmailCleanupResult> {
  const now = new Date();

  // --- 1. Staged imports past their 14-day TTL ---
  // Drizzle's delete returns a driver-specific shape; we count the returning
  // rows to get a portable deleted-count.
  const stagedDeleted = await db
    .delete(schema.stagedImports)
    .where(and(
      lt(schema.stagedImports.expiresAt, now),
      eq(schema.stagedImports.status, "pending"),
    ));
  const stagedRc = (stagedDeleted as unknown as { rowCount?: number }).rowCount ?? 0;

  // --- 2. Trash emails past their 24-hour TTL ---
  // Mailbox rows have NULL expires_at and are skipped by the `<` compare.
  const trashDeleted = await db
    .delete(schema.incomingEmails)
    .where(and(
      eq(schema.incomingEmails.category, "trash"),
      lt(schema.incomingEmails.expiresAt, now),
    ));
  const trashRc = (trashDeleted as unknown as { rowCount?: number }).rowCount ?? 0;

  return { stagedDeleted: stagedRc, trashDeleted: trashRc };
}

let timer: NodeJS.Timeout | null = null;

/** Start the cleanup interval. Safe to call multiple times. Interval: 30 minutes. */
export function startEmailCleanupTimer(): void {
  if (timer) return;
  const THIRTY_MIN = 30 * 60 * 1000;
  timer = setInterval(() => {
    cleanupExpiredEmailArtifacts().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[email-import-cleanup] sweep failed:", err);
    });
  }, THIRTY_MIN);
  if (timer.unref) timer.unref();
}

/** For tests. */
export function stopEmailCleanupTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
