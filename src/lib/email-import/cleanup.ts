/**
 * Background cleanup for email-import artifacts + admin inbox trash.
 *
 * Runs three sweeps:
 *   1. email_inbox (per-user raw imported emails) — purged on a PER-USER
 *      retention window evaluated at SWEEP TIME against the live setting
 *      (FINLYNQ-138). Default 60 days; user-configurable to 7/30/60/90.
 *      `received_at + window < now` → hard delete. The stamped `expires_at`
 *      is display-only and NOT trusted as the source of truth here.
 *   2. staged_imports where expires_at < now AND status = 'pending'
 *      → rows deleted (cascade takes staged_transactions with them). This is a
 *        SEPARATE, fixed 14-day pending TTL — it is NOT governed by the
 *        per-user email-retention setting (raw email only, per FINLYNQ-138).
 *   3. incoming_emails where category = 'trash' AND expires_at < now
 *      → hard delete. 24-hour TTL (admin trash, not user-facing).
 *
 * The email_inbox purge is a tier-agnostic HARD DELETE — no DEK needed, so the
 * sweep stays DEK-free even though from/subject/body are two-tier encrypted.
 *
 * Bootstrapped by instrumentation.ts on the same 30-minute cadence as the
 * MCP upload cleanup. Kept dead simple — no job queue, no distributed lock;
 * a second instance will just run the same `DELETE WHERE expired` and both
 * will converge.
 */

import { db, schema } from "@/db";
import { and, eq, lt, sql } from "drizzle-orm";
import {
  EMAIL_RETENTION_SETTING_KEY,
  DEFAULT_EMAIL_RETENTION_DAYS,
} from "./retention";

export interface EmailCleanupResult {
  inboxDeleted: number;
  stagedDeleted: number;
  trashDeleted: number;
}

export async function cleanupExpiredEmailArtifacts(): Promise<EmailCleanupResult> {
  const now = new Date();

  // --- 1. Raw imported emails past their PER-USER retention window ---
  // Single-pass DELETE ... USING settings (LEFT JOIN so users with no setting
  // row still purge under the default). The window is read LIVE from the
  // settings table at sweep time, so a settings change immediately governs all
  // existing rows — NO re-stamp of email_inbox.expires_at happens. We compute
  // the cutoff in SQL from received_at + interval, never trusting the stamped
  // expires_at. COALESCE guards an unset OR non-numeric stored value down to
  // the 60-day default so a junk row can't disable the sweep.
  const inboxResult = await db.execute(sql`
    DELETE FROM email_inbox e
    USING (
      SELECT u.id AS user_id,
        COALESCE(
          NULLIF(regexp_replace(s.value, '\\D', '', 'g'), '')::int,
          ${DEFAULT_EMAIL_RETENTION_DAYS}
        ) AS window_days
      FROM users u
      LEFT JOIN settings s
        ON s.user_id = u.id
        AND s.key = ${EMAIL_RETENTION_SETTING_KEY}
    ) policy
    WHERE e.user_id = policy.user_id
      AND e.received_at < ${now} - (policy.window_days * INTERVAL '1 day')
  `);
  const inboxRc =
    (inboxResult as unknown as { rowCount?: number }).rowCount ?? 0;

  // --- 2. Staged imports past their FIXED 14-day pending TTL ---
  // NOT the per-user email-retention window — staged_imports/staged_transactions
  // keep their own staging TTL (FINLYNQ-138 scope = raw email only). Drizzle's
  // delete returns a driver-specific shape; we read rowCount for a portable
  // deleted-count.
  const stagedDeleted = await db
    .delete(schema.stagedImports)
    .where(and(
      lt(schema.stagedImports.expiresAt, now),
      eq(schema.stagedImports.status, "pending"),
    ));
  const stagedRc = (stagedDeleted as unknown as { rowCount?: number }).rowCount ?? 0;

  // --- 3. Trash emails past their 24-hour TTL ---
  // Mailbox rows have NULL expires_at and are skipped by the `<` compare.
  const trashDeleted = await db
    .delete(schema.incomingEmails)
    .where(and(
      eq(schema.incomingEmails.category, "trash"),
      lt(schema.incomingEmails.expiresAt, now),
    ));
  const trashRc = (trashDeleted as unknown as { rowCount?: number }).rowCount ?? 0;

  return { inboxDeleted: inboxRc, stagedDeleted: stagedRc, trashDeleted: trashRc };
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
