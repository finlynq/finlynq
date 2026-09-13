/**
 * Cron job — roll portfolio snapshots forward for every enrolled user.
 *
 * Started by the root instrumentation.ts with a 24h setInterval. First run
 * fires 24h after server start; for the 21:00-UTC schedule called out
 * in the plan, follow up with a setTimeout-then-setInterval seed.
 *
 * Two passes:
 *   - INVESTMENT (DEK-bearing only): buildDailySnapshot no-ops without a DEK
 *     (encrypted holding symbols → $1/unit garbage), so the cron's investment
 *     pass is effectively inert; investment history is materialized by the
 *     DEK-bearing manual rebuild button + chart-load self-heal instead.
 *   - CASH (DEK-free): cash balance = cumulative SUM(tx.amount) + cached FX,
 *     needs no DEK, so this pass IS real work. It's per-user + incremental: a
 *     fresh user only gets today's row rolled forward; a user whose cash txns
 *     changed gets a bounded recent-window refresh that deliberately leaves the
 *     staleness watermark STALE so the full-history chart-load self-heal owns
 *     deep/back-dated edits. plan/net-worth-cash-snapshots.md Phase 4.
 *
 * Idempotent on the (user_id, snap_date, COALESCE(account_id, -1)) unique index.
 */

import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { buildDailySnapshot } from "@/lib/portfolio/snapshots/builder";
import { rebuildCashSnapshots } from "@/lib/portfolio/snapshots/cash-builder";
import {
  getCashSnapshotMeta,
  isCashStale,
} from "@/lib/portfolio/snapshots/cash-meta";
import { getCashTxFingerprint } from "@/lib/queries";
import {
  tryBeginCashRebuild,
  endCashRebuild,
} from "@/lib/portfolio/snapshots/rebuild";

export interface RunSnapshotsCronOpts {
  /** Override today's date for backfill / replay. */
  date?: string;
}

export interface RunSnapshotsCronResult {
  usersProcessed: number;
  perAccountRows: number;
  aggregateRows: number;
  cashUsersProcessed: number;
  cashRowsWritten: number;
  errors: Array<{ userId: string; error: string }>;
}

/** Subtract `days` from an ISO date via UTC. */
function subtractDaysUTC(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Recent-window width for the cron's stale-cash refresh. */
const CASH_CRON_WINDOW_DAYS = 90;

export async function runSnapshotsCron(
  opts: RunSnapshotsCronOpts = {},
): Promise<RunSnapshotsCronResult> {
  const date = opts.date ?? new Date().toISOString().slice(0, 10);

  // ─── Investment pass (DEK-bearing only — inert without a DEK) ───
  // Only enrolled users (portfolio_lots_status row present and enabled=TRUE).
  // Pre-rollout users with enabled=FALSE still get snapshots — the chart
  // is harmless on its own; we just don't gate on the lots feature here.
  const enrolled = await db
    .select({ userId: schema.portfolioLotsStatus.userId })
    .from(schema.portfolioLotsStatus);

  // Fall back to ANY user with portfolio_holdings rows if no enrolled
  // users exist (e.g. fresh install). Phase 1 backfill auto-enrolls.
  let userIds = enrolled.map((r) => r.userId);
  if (userIds.length === 0) {
    const withHoldings = await db
      .selectDistinct({ userId: schema.portfolioHoldings.userId })
      .from(schema.portfolioHoldings);
    userIds = withHoldings.map((r) => r.userId);
  }

  let perAccountRows = 0;
  let aggregateRows = 0;
  const errors: Array<{ userId: string; error: string }> = [];

  for (const userId of userIds) {
    try {
      const result = await buildDailySnapshot({ userId, date, dek: null });
      perAccountRows += result.perAccountRows;
      if (result.aggregateRow) aggregateRows++;
    } catch (err) {
      errors.push({
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─── Cash pass (DEK-free — real work, broadened to ALL cash users) ───
  // Archived accounts are NOT excluded: they still carry balances that belong
  // in the history series, and a user whose only cash accounts are archived
  // would otherwise never be picked up by the nightly roll-forward at all.
  const cashUsers = await db
    .selectDistinct({ userId: schema.accounts.userId })
    .from(schema.accounts)
    .where(eq(schema.accounts.isInvestment, false));

  const windowStart = subtractDaysUTC(date, CASH_CRON_WINDOW_DAYS);
  let cashUsersProcessed = 0;
  let cashRowsWritten = 0;

  for (const { userId } of cashUsers) {
    // Skip if a chart-load self-heal / rebuild button is already building cash.
    if (!tryBeginCashRebuild(userId)) continue;
    try {
      const fp = await getCashTxFingerprint(userId);
      if (fp.count === 0) continue; // no cash txns → nothing to roll forward
      const meta = await getCashSnapshotMeta(userId);
      if (isCashStale(fp, meta, date)) {
        // Recent-window refresh ONLY (keeps the last ~90d correct nightly).
        // Deliberately does NOT stamp the watermark, so a deep back-dated edit
        // stays stale and the full-history chart-load self-heal still fires.
        const r = await rebuildCashSnapshots({
          userId,
          fromDate: windowStart,
          toDate: date,
          stampMeta: false,
        });
        cashRowsWritten += r.rowsWritten;
      } else {
        // Fresh: nothing changed — just roll today's row forward and bump the
        // watermark's built_through (fingerprint unchanged).
        const r = await rebuildCashSnapshots({
          userId,
          fromDate: date,
          toDate: date,
          stampMeta: true,
        });
        cashRowsWritten += r.rowsWritten;
      }
      cashUsersProcessed++;
    } catch (err) {
      errors.push({
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      endCashRebuild(userId);
    }
  }

  return {
    usersProcessed: userIds.length,
    perAccountRows,
    aggregateRows,
    cashUsersProcessed,
    cashRowsWritten,
    errors,
  };
}
