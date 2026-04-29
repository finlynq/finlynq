/**
 * GET /api/admin/phase3-null-progress — Per-user Stream D Phase 3 NULL state.
 *
 * Companion to /api/admin/stream-d-progress. Where stream-d-progress reports
 * how many rows still need backfill (plaintext-but-no-ct), this endpoint
 * reports per-user state for the lazy plaintext NULL cutover:
 *   - users.plaintext_nulled_at IS NOT NULL → user is Phase 3'd
 *   - users.plaintext_nulled_at IS NULL → user is pending; their blocking_rows
 *     count tells you why the next login won't auto-NULL them yet (rows
 *     where name IS NOT NULL AND name_ct IS NULL — i.e. backfill not done).
 *
 * Admin-only. See src/lib/crypto/stream-d-phase3-null.ts for the runtime
 * helper that flips the flag.
 *
 * Implementation note — uses raw SQL because the Drizzle schema in
 * src/db/schema-pg.ts intentionally does NOT track `plaintext_nulled_at`.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/require-admin";
import { db } from "@/db";
import { sql } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;

  const totals = await db.execute<{ total: number; done: number }>(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE plaintext_nulled_at IS NOT NULL)::int AS done
    FROM users
  `);

  // Per-user blockers — joined sum across the six Stream D tables. Capped at
  // 50 rows for response size; in practice most envs have <10 users.
  const blockers = await db.execute(sql`
    SELECT u.id, u.username, u.email, u.last_login_at,
      ((SELECT COUNT(*) FROM accounts            WHERE user_id = u.id AND name IS NOT NULL AND name_ct IS NULL)
     + (SELECT COUNT(*) FROM categories          WHERE user_id = u.id AND name IS NOT NULL AND name_ct IS NULL)
     + (SELECT COUNT(*) FROM goals               WHERE user_id = u.id AND name IS NOT NULL AND name_ct IS NULL)
     + (SELECT COUNT(*) FROM loans               WHERE user_id = u.id AND name IS NOT NULL AND name_ct IS NULL)
     + (SELECT COUNT(*) FROM subscriptions       WHERE user_id = u.id AND name IS NOT NULL AND name_ct IS NULL)
     + (SELECT COUNT(*) FROM portfolio_holdings  WHERE user_id = u.id AND name IS NOT NULL AND name_ct IS NULL))::int
        AS blocking_rows
    FROM users u
    WHERE u.plaintext_nulled_at IS NULL
    ORDER BY blocking_rows DESC, u.last_login_at DESC NULLS LAST
    LIMIT 50
  `);

  const total = totals.rows?.[0]?.total ?? 0;
  const done = totals.rows?.[0]?.done ?? 0;
  return NextResponse.json({
    usersTotal: total,
    usersDone: done,
    usersPending: total - done,
    pendingDetail: blockers.rows,
  });
}
