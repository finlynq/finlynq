/**
 * Stamp the snapshot-dirty markers for a set of transaction ids (2026-07-30).
 *
 * The web `PUT /api/transactions` marks net-worth history stale after every
 * edit — per-user (`markSnapshotsDirty`) for rows bound to an investment
 * holding, per-account (`markCashSnapshotsDirty`) for cash rows. The MCP
 * update paths (`manage_transactions(op:update)`, `execute_bulk_update`) never
 * did, so a balance edited through an AI assistant left the Net Worth chart
 * showing the pre-edit history until something else happened to dirty it
 * (review finding MCP-M1).
 *
 * Call it TWICE around a date/account-moving update — once before with the
 * pre-edit position and once after — so a row that moved between accounts or
 * back in time dirties BOTH ends. `LEAST` coalescing in the marker tables makes
 * double-stamping free.
 *
 * Best-effort by construction: both markers swallow their own errors, and a
 * failed read here is skipped rather than failing the write that already
 * committed.
 */

import { db, schema } from "@/db";
import { and, eq, inArray } from "drizzle-orm";
import { markSnapshotsDirty } from "@/lib/portfolio/snapshots/dirty";
import { markCashSnapshotsDirty } from "@/lib/portfolio/snapshots/cash-dirty";

export async function stampSnapshotDirtyForTxIds(
  userId: string,
  txIds: number[],
): Promise<void> {
  const ids = Array.from(new Set(txIds.filter((n) => Number.isInteger(n))));
  if (ids.length === 0) return;
  try {
    const rows = await db
      .select({
        date: schema.transactions.date,
        accountId: schema.transactions.accountId,
        portfolioHoldingId: schema.transactions.portfolioHoldingId,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, userId),
          inArray(schema.transactions.id, ids),
        ),
      );
    let investmentFrom: string | null = null;
    const cashByAccount = new Map<number, string>();
    for (const r of rows) {
      if (r.portfolioHoldingId != null) {
        if (investmentFrom == null || r.date < investmentFrom) investmentFrom = r.date;
      } else if (r.accountId != null) {
        const cur = cashByAccount.get(r.accountId);
        if (cur == null || r.date < cur) cashByAccount.set(r.accountId, r.date);
      }
    }
    if (investmentFrom) await markSnapshotsDirty(userId, investmentFrom);
    for (const [accountId, date] of cashByAccount) {
      await markCashSnapshotsDirty(userId, accountId, date);
    }
  } catch (err) {
    console.warn(
      "[stampSnapshotDirtyForTxIds] non-fatal:",
      err instanceof Error ? err.message : err,
    );
  }
}
