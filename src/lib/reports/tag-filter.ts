/**
 * SERVER ONLY. The Reports page's tag filter (GH #427).
 *
 * Tags are encrypted at rest, so SQL can't filter on them. Like the
 * Transactions page's `tag` filter, the matching runs on decrypted values:
 * `findMatchingTransactionIds` scans every transaction the date / account
 * limits allow and keeps the ones whose comma-separated tags include the tag
 * EXACTLY (search-match.ts). The report then sums only those transactions'
 * category rows (`transaction_category_flows.id` is the parent transaction id,
 * so a split transaction's parts all follow their transaction's tags).
 */
import { sql, type SQL } from "drizzle-orm";
import { schema } from "@/db";
import { findMatchingTransactionIds } from "@/lib/transactions/search-scan";

/** The `tag` query parameter, trimmed; null when absent or blank. */
export function parseTagParam(raw: string | null): string | null {
  const t = (raw ?? "").trim();
  return t ? t.slice(0, 200) : null;
}

/**
 * Ids of the user's transactions tagged `tag` in the window. Without a key
 * nothing can be decrypted, so nothing matches.
 */
export async function transactionIdsWithTag(
  userId: string,
  dek: Buffer | null,
  tag: string,
  limits: { startDate?: string; endDate?: string; accountIds?: number[] | null },
): Promise<number[]> {
  if (!dek) return [];
  return findMatchingTransactionIds(
    userId,
    dek,
    {
      startDate: limits.startDate,
      endDate: limits.endDate,
      accountIds: limits.accountIds ?? undefined,
    },
    { tag },
    { securitiesRead: false },
  );
}

/**
 * `transaction_category_flows.id IN (ids)` as ONE bind parameter (an int[]
 * literal of server-produced integer ids), so a tag on tens of thousands of
 * transactions can't run into Postgres's bind-parameter limit.
 */
export function flowIdIn(ids: number[]): SQL {
  if (ids.length === 0) return sql`1 = 0`;
  const literal = `{${ids.map((id) => Math.trunc(id)).join(",")}}`;
  return sql`${schema.transactionCategoryFlows.id} = ANY(${literal}::int[])`;
}
