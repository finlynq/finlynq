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
 *   - `deleteTransactionsCascade` ([delete-cascade.ts](./delete-cascade.ts)) —
 *     the ONE delete chokepoint behind the web single-row + bulk routes, MCP
 *     `manage_transactions(op:delete)` / `execute_bulk_delete`, and stdio
 *     `delete_transaction`.
 *   - `DELETE /api/bank-transactions/[bankId]` (bank-side delete cascade)
 *
 * It only EXPANDS the set — it does not delete anything. All queries are
 * owner-scoped (`user_id`) and written as raw `sql` templates rather than the
 * Drizzle query builder, so the MCP tool context's execute-only `DbLike`
 * satisfies the same helper.
 */

import { db as defaultDb } from "@/db";
import { sql } from "drizzle-orm";
import { normalizeDbRows } from "@/lib/db-utils";

/**
 * Minimal structural type satisfied by BOTH the app's Drizzle proxy (`@/db`),
 * a Drizzle transaction handle, and the MCP tool context's `DbLike`. Raw
 * `sql` templates (rather than the query builder) are what make that possible
 * — the MCP `DbLike` exposes `execute` and nothing else.
 */
type SiblingQueryer = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

type LinkRow = {
  id: number;
  trade_link_id: string | null;
  link_id: string | null;
  swap_link_id: string | null;
};

function intList(ids: number[]) {
  return sql.join(ids.map((n) => sql`${Number(n)}`), sql`, `);
}

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
  const seeds = normalizeDbRows<LinkRow>(
    await database.execute(sql`
      SELECT id, trade_link_id, link_id, swap_link_id
        FROM transactions
       WHERE user_id = ${userId} AND id = ANY(ARRAY[${intList(seedIds)}]::int[])
    `),
  );

  const byTradeLink = new Set<string>();
  const byLink = new Set<string>();
  const bySwapLink = new Set<string>();
  for (const t of seeds) {
    if (t.trade_link_id) byTradeLink.add(String(t.trade_link_id));
    if (t.link_id) byLink.add(String(t.link_id));
    if (t.swap_link_id) bySwapLink.add(String(t.swap_link_id));
  }

  async function idsWhere(column: "trade_link_id" | "link_id" | "swap_link_id", values: Set<string>) {
    if (values.size === 0) return [] as LinkRow[];
    const list = sql.join(Array.from(values).map((v) => sql`${v}`), sql`, `);
    const col = column === "trade_link_id" ? sql`trade_link_id`
      : column === "link_id" ? sql`link_id`
      : sql`swap_link_id`;
    return normalizeDbRows<LinkRow>(
      await database.execute(sql`
        SELECT id, trade_link_id, link_id, swap_link_id
          FROM transactions
         WHERE user_id = ${userId} AND ${col} = ANY(ARRAY[${list}]::text[])
      `),
    );
  }

  for (const r of await idsWhere("trade_link_id", byTradeLink)) idSet.add(Number(r.id));
  for (const r of await idsWhere("link_id", byLink)) idSet.add(Number(r.id));

  // Swaps share a swap_link_id across all 4 rows (sell pair + buy pair).
  // Each swap row also carries its own trade_link_id (the inner sell+buy
  // pair links), so pull those siblings too — all 4 stock+cash rows land
  // in the delete set.
  if (bySwapLink.size > 0) {
    const swapRows = await idsWhere("swap_link_id", bySwapLink);
    const nestedTradeLinks = new Set<string>();
    for (const r of swapRows) {
      idSet.add(Number(r.id));
      if (r.trade_link_id) nestedTradeLinks.add(String(r.trade_link_id));
    }
    for (const r of await idsWhere("trade_link_id", nestedTradeLinks)) idSet.add(Number(r.id));
  }

  return Array.from(idSet);
}
