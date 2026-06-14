/**
 * FINLYNQ-166 — per-user last-active tracking (dormancy signal).
 *
 * `bumpLastActive(userId)` advances `users.last_active_at` to NOW() on ANY
 * authenticated access (web session, OAuth/MCP token validation, pf_ API-key).
 * Unlike `last_login_at` (web password logins only), this captures MCP-only and
 * API-key-only users so the admin "Last active" column reflects real activity.
 *
 * The throttle is DB-SIDE: the UPDATE's WHERE clause only matches when the
 * stored value is NULL or older than the throttle window. This avoids a
 * read-then-write race and a write-per-request storm — a second authed request
 * inside the window matches zero rows and writes nothing.
 *
 * Fire-and-forget: callers MUST NOT await this on the request critical path and
 * it NEVER throws into the auth path (errors are swallowed). It is a users-table
 * metadata write, NOT a transactions write, so it does NOT call invalidateUser.
 *
 * Kept generic so FINLYNQ-167 (oauth_access_tokens.last_used_at) can mirror the
 * same conditional-UPDATE throttle pattern.
 */

import { db } from "@/db";
import { sql } from "drizzle-orm";

/** Minimum staleness before another bump is written. Within FINLYNQ-166's 15–30 min budget. */
export const LAST_ACTIVE_THROTTLE_MINUTES = 15;

/**
 * Throttled, owner-scoped bump of `users.last_active_at`.
 *
 * Conditional UPDATE — only writes when the stored value is NULL or older than
 * LAST_ACTIVE_THROTTLE_MINUTES, so it is at most one write per user per window.
 * Returns a Promise that always resolves (never rejects); safe to call without
 * awaiting. Pass a falsy userId to no-op.
 */
export async function bumpLastActive(userId: string | null | undefined): Promise<void> {
  if (!userId) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any).execute(sql`
      UPDATE users
         SET last_active_at = NOW()
       WHERE id = ${userId}
         AND (
           last_active_at IS NULL
           OR last_active_at < NOW() - (${LAST_ACTIVE_THROTTLE_MINUTES} || ' minutes')::interval
         )
    `);
  } catch {
    // Never block or fail the auth path on a metadata-write error.
  }
}
