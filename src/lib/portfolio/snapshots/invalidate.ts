/**
 * Full snapshot invalidation for one user — the code twin of the FINLYNQ-303
 * migration's one-time staleness trip (20260727c_portfolio_snapshots_native_currency.sql).
 *
 * Stored `portfolio_snapshots` are denominated in the reporting currency AT
 * BUILD TIME, so when the meaning of "reporting currency" changes
 * (settings.display_currency), every stored row goes stale at once: the
 * Performance / Net Worth charts keep serving values labeled in the OLD
 * currency until a rebuild. Rows are never rewritten in place here — dividing
 * `market_value` by a rate is exactly the backfill the FINLYNQ-303 migration
 * rules out (gaps_filled rows used a rate=1 fallback). Instead trip the
 * EXISTING staleness machinery so the normal rebuild paths re-materialize:
 *
 *   - CASH: delete the per-user watermark (`portfolio_cash_snapshot_meta`) —
 *     `isCashStale` reads a missing row as "never built", and the chart-load
 *     self-heal's null-meta path is a FULL-history rebuild. DEK-free, so it
 *     heals on the next chart load regardless of session state. The
 *     per-account `portfolio_cash_snapshot_dirty` rows are cleared FIRST: they
 *     scope the self-heal to a fast path that rebuilds only the dirty accounts
 *     and then stamps the watermark fresh, which would strand every OTHER
 *     account's history in the old currency. The full rebuild is a superset of
 *     whatever those rows tracked, so no edit signal is lost (and the ordering
 *     matters — if this dies between the two deletes, the surviving watermark
 *     still trips `isCashStale` off the tx fingerprint those rows implied).
 *
 *   - INVESTMENT: stamp `portfolio_snapshot_dirty` from the user's own
 *     earliest non-cash snapshot, mirroring the migration SQL. Needs a session
 *     DEK (holding symbols are encrypted — see builder.ts), so it fires on the
 *     next DEK-bearing chart load or manual rebuild. No stored investment
 *     snapshots → nothing to stamp: the initial backfill already builds in the
 *     new currency.
 *
 * Best-effort like `markSnapshotsDirty`: every step swallows its own error so
 * a failed stamp can never fail the caller's already-committed settings write.
 * Uses the global `db` (like the dirty-marker helpers), so it is safe to call
 * from inside a caller's transaction.
 */

import { db } from "@/db";
import { sql } from "drizzle-orm";
import { normalizeDbRows } from "@/lib/db-utils";
import { markSnapshotsDirty } from "./dirty";

export async function markAllSnapshotsStale(userId: string): Promise<void> {
  // ── Cash: per-account fast-path markers first, then the watermark ────────
  try {
    await db.execute(sql`
      DELETE FROM portfolio_cash_snapshot_dirty WHERE user_id = ${userId}
    `);
    await db.execute(sql`
      DELETE FROM portfolio_cash_snapshot_meta WHERE user_id = ${userId}
    `);
  } catch (err) {
    console.warn(
      "[markAllSnapshotsStale] cash invalidation non-fatal:",
      err instanceof Error ? err.message : err,
    );
  }

  // ── Investment: dirty-stamp from the earliest stored non-cash snapshot ───
  // (rebuildPortfolioSnapshots clamps to EARLIEST_REBUILD_DATE + the first
  // holding date anyway, but stamping the true MIN keeps the dirty row honest.)
  try {
    const result = await db.execute(sql`
      SELECT MIN(snap_date) AS min_date
        FROM portfolio_snapshots
       WHERE user_id = ${userId} AND source <> 'cash'
    `);
    const minDate = normalizeDbRows<{ min_date: string | null }>(result)[0]
      ?.min_date;
    if (minDate) await markSnapshotsDirty(userId, String(minDate));
  } catch (err) {
    console.warn(
      "[markAllSnapshotsStale] investment invalidation non-fatal:",
      err instanceof Error ? err.message : err,
    );
  }
}
