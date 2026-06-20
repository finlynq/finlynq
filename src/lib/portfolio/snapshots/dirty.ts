/**
 * Snapshot dirty-marker — auto-rebuild work queue (plan/net-worth-over-time.md
 * Part B).
 *
 * The nightly snapshot cron is forward-only, so a back-dated investment edit
 * leaves historical `portfolio_snapshots` stale. Every investment-affecting
 * transaction write stamps `portfolio_snapshot_dirty` (co-located with the
 * existing `invalidateUser` call). The snapshot-drain cron re-materializes the
 * dirty range and clears the row.
 *
 * `markSnapshotsDirty` swallows its own errors (logs + continues) so it can be
 * awaited in a write path's hot loop without risking the already-committed
 * operation's HTTP response — and so it's a no-op on environments where the
 * `20260612` migration hasn't run yet.
 */

import { db, schema } from "@/db";
import { sql } from "drizzle-orm";

/** ISO YYYY-MM-DD guard — falls back to today on anything malformed. */
function normalizeFromDate(fromDate: string): string {
  if (typeof fromDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fromDate.slice(0, 10))) {
    return fromDate.slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

/**
 * Mark a user's snapshot history dirty from `fromDate` forward. Idempotent:
 * repeated calls coalesce to the EARLIEST (widest) from_date via LEAST, and
 * always bump marked_at so an in-flight drain re-queues the row.
 */
export async function markSnapshotsDirty(userId: string, fromDate: string): Promise<void> {
  const from = normalizeFromDate(fromDate);
  try {
    await db.execute(sql`
      INSERT INTO portfolio_snapshot_dirty (user_id, from_date, marked_at)
      VALUES (${userId}, ${from}, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        from_date = LEAST(portfolio_snapshot_dirty.from_date, EXCLUDED.from_date),
        marked_at = NOW()
    `);
  } catch (err) {

    console.warn("[markSnapshotsDirty] non-fatal:", err instanceof Error ? err.message : err);
  }
}

export interface DirtySnapshotRow {
  userId: string;
  fromDate: string;
  /** Captured BEFORE a rebuild so the drain can detect concurrent writes. */
  markedAt: string;
}

/** All pending dirty rows (drain cron work-queue). */
export async function listDirtySnapshotUsers(): Promise<DirtySnapshotRow[]> {
  const rows = await db
    .select({
      userId: schema.portfolioSnapshotDirty.userId,
      fromDate: schema.portfolioSnapshotDirty.fromDate,
      markedAt: schema.portfolioSnapshotDirty.markedAt,
    })
    .from(schema.portfolioSnapshotDirty);
  return rows.map((r) => ({
    userId: r.userId,
    fromDate: r.fromDate,
    markedAt:
      r.markedAt instanceof Date ? r.markedAt.toISOString() : String(r.markedAt),
  }));
}

/**
 * Delete a dirty row ONLY if it hasn't been re-stamped since `markedAt` (the
 * value captured before the rebuild started). A write that arrived mid-rebuild
 * bumps marked_at to NOW() > markedAt, so the row survives and is re-drained
 * next tick — no lost edits.
 *
 * `marked_at` is `timestamptz` with MICROSECOND precision (e.g. `…45.010582`),
 * but `markedAt` is captured through `listDirtySnapshotUsers` → JS `Date` →
 * `.toISOString()`, which only has MILLISECOND precision (`…45.010Z`). A naive
 * `marked_at <= ${markedAt}` then compares `.010582 <= .010000` → FALSE, so the
 * row is NEVER deleted and the marker re-triggers a full self-heal on every
 * chart load forever (the bug this fixes). Truncate the stored value to
 * milliseconds before comparing so it matches the captured precision; a genuine
 * mid-rebuild re-stamp lands in a LATER millisecond and still survives.
 */
export async function clearDirtyIfUnchanged(userId: string, markedAt: string): Promise<void> {
  await db.execute(sql`
    DELETE FROM portfolio_snapshot_dirty
    WHERE user_id = ${userId}
      AND date_trunc('milliseconds', marked_at) <= ${markedAt}::timestamptz
  `);
}
