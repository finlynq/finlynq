/**
 * Sibling-expansion for transaction link-id cascades (FINLYNQ-222).
 *
 * Paired rows from operations.ts / the transfer write path share a
 * `trade_link_id` (buy/sell cash-leg pairs), a `link_id` (in-kind
 * transfers, FX conversions, plain cash transfers), or a `swap_link_id`
 * (all 4 rows of a swap: sell pair + buy pair). Deleting one leg without
 * its siblings leaves an orphaned half-pair that breaks account-level
 * invariants (cash-sleeve sum drifts, lot bookkeeping desyncs, the other
 * account's balance shows a phantom in/outflow).
 *
 * This is the SINGLE source of truth for the "expand a delete set to the
 * full link-sibling closure" step. It is consumed by:
 *   - `DELETE /api/transactions?id=N` (the canonical cascade path)
 *   - `DELETE /api/bank-transactions/[bankId]` (bank-side delete cascade)
 *
 * It only EXPANDS the set — it does not delete anything. Callers run their
 * own delete loop (the canonical route also runs the lot edit-guard +
 * reallocation against the expanded set; the bank route does a plain
 * owner-scoped bulk delete). All queries are owner-scoped (`user_id`).
 */

import { db as defaultDb, schema } from "@/db";
import { and, eq, inArray } from "drizzle-orm";

// Minimal structural type for the Drizzle queryer so a transaction handle
// (`tx`) or the top-level `db` both satisfy it without importing pg types.
type SiblingQueryer = Pick<typeof defaultDb, "select">;

/**
 * Given one or more seed transaction ids belonging to `userId`, return the
 * full set of ids that must be deleted together — the seeds plus every row
 * sharing a `link_id` / `trade_link_id` / `swap_link_id` with any seed
 * (transitively, for swaps' nested trade-link pairs).
 *
 * The returned set always includes the seeds themselves (even seeds that
 * carry no link id — those expand to just themselves), so a non-transfer
 * single transaction passes through unchanged (no over-deletion).
 */
export async function expandLinkSiblings(
  userId: string,
  seedIds: number[],
  database: SiblingQueryer = defaultDb,
): Promise<number[]> {
  const idSet = new Set<number>(seedIds);
  if (seedIds.length === 0) return [];

  // Load each seed's three link ids in one pass.
  const seeds = await database
    .select({
      id: schema.transactions.id,
      tradeLinkId: schema.transactions.tradeLinkId,
      linkId: schema.transactions.linkId,
      swapLinkId: schema.transactions.swapLinkId,
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.userId, userId),
        inArray(schema.transactions.id, seedIds),
      ),
    );

  for (const target of seeds) {
    if (target.tradeLinkId) {
      const siblings = await database
        .select({ id: schema.transactions.id })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.userId, userId),
            eq(schema.transactions.tradeLinkId, target.tradeLinkId),
          ),
        );
      for (const r of siblings) idSet.add(r.id);
    }
    if (target.linkId) {
      const siblings = await database
        .select({ id: schema.transactions.id })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.userId, userId),
            eq(schema.transactions.linkId, target.linkId),
          ),
        );
      for (const r of siblings) idSet.add(r.id);
    }
    // Swaps share a swap_link_id across all 4 rows (sell pair + buy pair).
    // Each swap row also carries its own trade_link_id (the inner sell+buy
    // pair links), so pull those siblings too — all 4 stock+cash rows land
    // in the delete set.
    if (target.swapLinkId) {
      const siblings = await database
        .select({
          id: schema.transactions.id,
          tradeLinkId: schema.transactions.tradeLinkId,
        })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.userId, userId),
            eq(schema.transactions.swapLinkId, target.swapLinkId),
          ),
        );
      for (const r of siblings) idSet.add(r.id);
      const tradeLinks = new Set(
        siblings.map((r) => r.tradeLinkId).filter((v): v is string => !!v),
      );
      for (const tl of tradeLinks) {
        const more = await database
          .select({ id: schema.transactions.id })
          .from(schema.transactions)
          .where(
            and(
              eq(schema.transactions.userId, userId),
              eq(schema.transactions.tradeLinkId, tl),
            ),
          );
        for (const r of more) idSet.add(r.id);
      }
    }
  }

  return Array.from(idSet);
}
