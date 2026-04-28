/**
 * Portfolio-holding FK backfill — lazy population of transactions.portfolio_holding_id.
 *
 * On a successful login we have the user's DEK in memory. This module finds
 * every transaction whose portfolio_holding text column is populated but
 * whose FK is still NULL, decrypts the name, resolves it to a
 * portfolio_holdings.id (auto-creating the row if needed), and writes the
 * FK back to the row. The text column stays put through Phase 4 — Phase 5
 * is a separate later deploy that NULLs it.
 *
 * Called fire-and-forget from the login + mfa/verify paths — same shape as
 * enqueueStreamDBackfill. Errors swallowed so a backfill failure never
 * blocks login.
 */

import { db, schema } from "@/db";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { decryptField } from "./envelope";
import { buildHoldingResolver } from "../external-import/portfolio-holding-resolver";

export async function backfillPortfolioHoldingFk(
  userId: string,
  dek: Buffer,
): Promise<{ scanned: number; resolved: number; unresolved: number; createdHoldings: number }> {
  // Pull every tx that needs backfill. Bounded — typical user has a few
  // hundred investment txs at most. We do the UPDATE per row rather than
  // a single bulk UPDATE because (a) the resolver might auto-create
  // holdings in between, (b) errors on one row shouldn't roll back the
  // whole batch.
  const rows = await db
    .select({
      id: schema.transactions.id,
      accountId: schema.transactions.accountId,
      portfolioHolding: schema.transactions.portfolioHolding,
    })
    .from(schema.transactions)
    .where(and(
      eq(schema.transactions.userId, userId),
      isNotNull(schema.transactions.portfolioHolding),
      isNull(schema.transactions.portfolioHoldingId),
    ));

  if (rows.length === 0) {
    return { scanned: 0, resolved: 0, unresolved: 0, createdHoldings: 0 };
  }

  const resolver = await buildHoldingResolver(userId, dek);
  let resolved = 0;
  let unresolved = 0;

  for (const r of rows) {
    if (r.accountId == null || !r.portfolioHolding) {
      unresolved++;
      continue;
    }
    let name: string | null = null;
    try {
      name = decryptField(dek, r.portfolioHolding);
    } catch {
      name = null;
    }
    // DEK mismatch (encryptionV bumped, or pre-encryption row) leaves the
    // ciphertext intact — skip rather than auto-create a "v1:..." holding.
    if (!name || name.startsWith("v1:")) {
      unresolved++;
      continue;
    }
    const holdingId = await resolver.resolve(r.accountId, name);
    if (holdingId == null) {
      unresolved++;
      continue;
    }
    await db
      .update(schema.transactions)
      .set({ portfolioHoldingId: holdingId })
      .where(and(
        eq(schema.transactions.id, r.id),
        eq(schema.transactions.userId, userId),
      ));
    resolved++;
  }

  return {
    scanned: rows.length,
    resolved,
    unresolved,
    createdHoldings: resolver.createdCount(),
  };
}

/**
 * Admin-visible progress counter — how many tx rows still need their FK
 * populated, across all users. Zero means Phase 5 (NULL plaintext + drop
 * portfolio_holding from TX_ENCRYPTED_FIELDS) is safe to run.
 */
export async function portfolioHoldingFkProgress(): Promise<{
  withFk: number;
  withoutFk: number;
  total: number;
}> {
  const totalRow = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(schema.transactions)
    .where(isNotNull(schema.transactions.portfolioHolding))
    .get();
  const withoutFkRow = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(schema.transactions)
    .where(and(
      isNotNull(schema.transactions.portfolioHolding),
      isNull(schema.transactions.portfolioHoldingId),
    ))
    .get();
  const total = totalRow?.c ?? 0;
  const withoutFk = withoutFkRow?.c ?? 0;
  return { total, withoutFk, withFk: total - withoutFk };
}

/**
 * Fire-and-forget wrapper for the login + mfa/verify paths. Mirrors
 * enqueueStreamDBackfill — never blocks the caller, never throws, logs at
 * console.log when there's something to report.
 */
export function enqueuePortfolioHoldingFkBackfill(userId: string, dek: Buffer): void {
  void (async () => {
    try {
      const summary = await backfillPortfolioHoldingFk(userId, dek);
      if (summary.scanned > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[holding-fk] user=${userId} scanned=${summary.scanned} ` +
            `resolved=${summary.resolved} unresolved=${summary.unresolved} ` +
            `createdHoldings=${summary.createdHoldings}`,
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[holding-fk] backfill failed:", err);
    }
  })();
}
