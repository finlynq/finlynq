/**
 * Background sweep for `revoked_jtis` denylist (B7, 2026-05-07).
 *
 * Deletes rows whose `expires_at < NOW()`. Past that point the underlying
 * JWT signature validation would already reject the token, so keeping the
 * row in the denylist is wasted space.
 *
 * Daily interval, fire-and-forget. Safe to call repeatedly — each sweep is
 * idempotent. Wired in `instrumentation.ts` once the PostgresAdapter is ready.
 */

import { db, schema } from "@/db";
import { lt } from "drizzle-orm";

export type SweepResult = { deleted: number };

/**
 * Delete `revoked_jtis` rows whose `expires_at` has passed. Returns the
 * number of rows removed. Best-effort — a thrown error bubbles to the
 * caller, which logs and resumes on the next interval.
 */
export async function sweepRevokedJtis(): Promise<SweepResult> {
  const cutoff = new Date();
  const deleted = await db
    .delete(schema.revokedJtis)
    .where(lt(schema.revokedJtis.expiresAt, cutoff))
    .returning({ jti: schema.revokedJtis.jti });
  return { deleted: deleted.length };
}

let timer: NodeJS.Timeout | null = null;

/**
 * Start the daily sweep. Safe to call multiple times — second call is a
 * no-op.
 */
export function startRevokedJtisSweepTimer(): void {
  if (timer) return;
  const ONE_DAY = 24 * 60 * 60 * 1000;
  timer = setInterval(() => {
    sweepRevokedJtis().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[sweep-revoked-jtis] sweep failed:", err);
    });
  }, ONE_DAY);
  if (timer.unref) timer.unref();
}

/** Stop the sweep interval. For tests. */
export function stopRevokedJtisSweepTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
