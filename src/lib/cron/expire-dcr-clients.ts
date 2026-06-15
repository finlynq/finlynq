/**
 * Background sweep for inactive Dynamic Client Registration (DCR) clients
 * (FINLYNQ-160, security audit #284 / M7, 2026-06-14).
 *
 * OAuth DCR (RFC 7591) is unauthenticated by spec — anyone can POST
 * `/api/oauth/register` and get a `client_id` (we rate-limit it 10/hr/IP).
 * Over time the `oauth_clients` table accumulates rows from one-shot
 * connection attempts, abandoned setups, and the audit's leftover test
 * clients. This sweep is hygiene: it deletes a client row once it has had
 * no token activity for `DCR_INACTIVE_DAYS` AND has no live (non-revoked,
 * unexpired) tokens.
 *
 * "Activity" = the most recent `oauth_access_tokens.created_at` for the
 * client, falling back to the client's own `created_at` when it never minted
 * a token. So a freshly-registered-but-never-used client is given the full
 * inactivity window before it can be reaped — a client registered <60d ago
 * is never reaped even if unused.
 *
 * "Live token" mirrors `listConnectedApps` in src/lib/oauth.ts: a token row
 * with `revoked_at IS NULL` AND `refresh_expires_at > now`. Refresh tokens
 * live 30 days, so "no live tokens" naturally clears once the last grant
 * lapses; this sweep then removes the orphaned client row.
 *
 * DEK-free: this is a tier-agnostic hard delete of plaintext OAuth metadata
 * — no encryption involved. There is NO FK from oauth_access_tokens /
 * oauth_authorization_codes to oauth_clients (client_id is a plain text
 * column on those tables, not a `.references()`), so deleting a client row is
 * never blocked by dependent rows. We still delete the client's dead token
 * rows and stale authorization codes in the same transaction so they don't
 * dangle pointing at a client_id that no longer exists.
 *
 * Daily interval, fire-and-forget. Safe to call repeatedly — each sweep is
 * idempotent. Wired in `instrumentation.ts` once the PostgresAdapter is ready.
 */

import { db } from "@/db";
import { normalizeDbRows } from "@/lib/db-utils";
import { sql } from "drizzle-orm";

/**
 * How many days of token inactivity (with no live tokens) before a DCR client
 * is eligible for reaping. Single source of truth — flipping to 30 is a
 * one-line change. 60 aligns with the email-retention default and avoids
 * reaping a client a user only connects monthly.
 */
export const DCR_INACTIVE_DAYS = 60;

export type SweepResult = { deleted: number };

/**
 * Pure decision: is this DCR client eligible for reaping?
 *
 * A client is reapable iff BOTH:
 *  - it has no live token (`hasLiveToken === false`), AND
 *  - its last activity (most recent token `created_at`, or the client's own
 *    `created_at` when it never minted a token) is older than the inactivity
 *    cutoff (`now − inactiveDays`).
 *
 * Kept pure + DB-free so it can be unit-tested in isolation and mirrors the
 * SQL the sweep issues exactly.
 */
export function isClientReapable(
  client: {
    /** ISO string — oauth_clients.created_at */
    clientCreatedAt: string;
    /** ISO string of the most recent token's created_at, or null if none */
    mostRecentTokenCreatedAt: string | null;
    /** true when at least one non-revoked, unexpired token exists */
    hasLiveToken: boolean;
  },
  now: Date,
  inactiveDays: number = DCR_INACTIVE_DAYS
): boolean {
  // A live token always protects the client, regardless of age.
  if (client.hasLiveToken) return false;

  const cutoff = now.getTime() - inactiveDays * 24 * 60 * 60 * 1000;

  // Last activity = most recent token, else the client's registration time.
  const activityIso = client.mostRecentTokenCreatedAt ?? client.clientCreatedAt;
  const activity = new Date(activityIso).getTime();

  // A malformed/unparseable timestamp degrades to "keep" — never reap on a
  // NaN comparison (NaN < cutoff is false, so this is belt-and-suspenders).
  if (Number.isNaN(activity)) return false;

  return activity < cutoff;
}

/**
 * Delete DCR clients that have been inactive for `DCR_INACTIVE_DAYS` and have
 * no live tokens. Returns the number of client rows removed. Best-effort —
 * a thrown error bubbles to the caller, which logs and resumes next interval.
 *
 * Runs as a single transaction:
 *  1. Compute the reapable client_id set (no live token AND last activity
 *     older than the cutoff — `GREATEST(client.created_at, MAX(token.created_at))`).
 *  2. Delete those clients' authorization codes + token rows (dead rows only —
 *     the live-token guard means none are live).
 *  3. Delete the client rows themselves.
 *
 * The cutoff and "live" boundary are computed in JS as ISO strings so the
 * comparison is portable across the text-typed `created_at` / `expires_at`
 * columns (no reliance on DB `now()` vs row text-cast semantics).
 */
export async function expireInactiveDcrClients(): Promise<SweepResult> {
  const now = new Date();
  const cutoffIso = new Date(
    now.getTime() - DCR_INACTIVE_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const nowIso = now.toISOString();

  return db.transaction(async (tx) => {
    // The reapable set: clients with NO live token whose last activity
    // (latest token created_at, else the client's own created_at) is older
    // than the inactivity cutoff. Computed once and reused for all 3 deletes.
    const reapableCte = sql`
      SELECT c.client_id
        FROM oauth_clients c
        LEFT JOIN oauth_access_tokens t ON t.client_id = c.client_id
       GROUP BY c.client_id, c.created_at
      HAVING
        -- no live token: none non-revoked AND with a future refresh expiry
        COUNT(*) FILTER (
          WHERE t.revoked_at IS NULL AND t.refresh_expires_at > ${nowIso}
        ) = 0
        -- last activity older than the cutoff (fall back to client created_at)
        AND GREATEST(c.created_at, COALESCE(MAX(t.created_at), c.created_at)) < ${cutoffIso}
    `;

    // 1. Stale authorization codes for reapable clients (no FK; avoid dangling).
    await tx.execute(sql`
      DELETE FROM oauth_authorization_codes
       WHERE client_id IN (${reapableCte})
    `);

    // 2. Dead token rows for reapable clients (the live-token guard above
    //    guarantees these are all revoked or past their refresh window).
    await tx.execute(sql`
      DELETE FROM oauth_access_tokens
       WHERE client_id IN (${reapableCte})
    `);

    // 3. The client rows themselves.
    const deleted = await tx.execute(sql`
      DELETE FROM oauth_clients
       WHERE client_id IN (${reapableCte})
      RETURNING client_id
    `);

    const rows = normalizeDbRows<{ client_id: string }>(deleted);
    return { deleted: rows.length };
  });
}

let timer: NodeJS.Timeout | null = null;

/**
 * Start the daily sweep. Safe to call multiple times — second call is a
 * no-op.
 */
export function startExpireDcrClientsTimer(): void {
  if (timer) return;
  const ONE_DAY = 24 * 60 * 60 * 1000;
  timer = setInterval(() => {
    expireInactiveDcrClients().catch((err) => {
      console.error("[expire-dcr-clients] sweep failed:", err);
    });
  }, ONE_DAY);
  if (timer.unref) timer.unref();
}

/** Stop the sweep interval. For tests. */
export function stopExpireDcrClientsTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
