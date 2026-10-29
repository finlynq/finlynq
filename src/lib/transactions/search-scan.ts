/**
 * Whole-history matching for the transactions list's encrypted-text filters
 * (`search`, `tag`, `filter_*`; the matching itself is search-match.ts).
 *
 * They used to run over the newest 1,000 rows only, so a search silently
 * missed every older transaction and reported the matches inside that window
 * as the total (in-app feedback #28, 2026-10-29: a payee search on Android
 * listed 3 transactions while the user's assistant found more). Now:
 *   1. a light scan of EVERY row the SQL filters allow: id, payee / note /
 *      tags, account + holding ids. Account and holding names are decrypted
 *      once each from their own (small) tables, not once per row.
 *   2. full rows for the requested page only (`getTransactionsByIds`).
 *
 * SERVER ONLY.
 */
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { getTransactions, getTransactionSearchRows, type TxSortFilter } from "@/lib/queries";
import { decryptName, decryptTxRow } from "@/lib/crypto/encrypted-columns";
import {
  filterTextRows,
  holdingDisplayName,
  readsAccountNames,
  readsHoldingNames,
  readsTransactionText,
  type TextFilterCriteria,
  type TextFilterRow,
} from "./search-match";

/** Ids per page query: keeps the IN list far below Postgres's bind limit
 *  (the CSV export asks for every match in one request). */
export const PAGE_CHUNK = 1000;

/** Ids of every transaction that matches, in the list's sort order. */
export async function findMatchingTransactionIds(
  userId: string,
  dek: Buffer | null,
  filters: TxSortFilter,
  criteria: TextFilterCriteria,
  opts: { securitiesRead: boolean },
): Promise<number[]> {
  const rows = await getTransactionSearchRows(userId, filters);
  if (rows.length === 0) return [];

  const accountNames = readsAccountNames(criteria)
    ? await loadAccountNames(userId, dek)
    : new Map<number, { name: string | null; alias: string | null }>();
  const holdingNames = readsHoldingNames(criteria)
    ? await loadHoldingNames(userId, dek, opts.securitiesRead)
    : new Map<number, string | null>();
  const withText = readsTransactionText(criteria);

  const candidates: TextFilterRow[] = rows.map((r) => {
    const text = withText
      ? decryptTxRow(dek, { payee: r.payee, note: r.note, tags: r.tags })
      : { payee: null, note: null, tags: null };
    const account = r.accountId != null ? accountNames.get(r.accountId) : undefined;
    return {
      id: r.id,
      payee: text.payee ?? null,
      note: text.note ?? null,
      tags: text.tags ?? null,
      accountName: account?.name ?? null,
      accountAlias: account?.alias ?? null,
      portfolioHolding:
        r.portfolioHoldingId != null ? holdingNames.get(r.portfolioHoldingId) ?? null : null,
    };
  });
  return filterTextRows(candidates, criteria).map((r) => r.id);
}

/** Full rows for `ids`, in the same order (each chunk is a contiguous slice
 *  of an already-sorted id list, fetched with the same ORDER BY). */
export async function getTransactionsByIds(
  userId: string,
  filters: TxSortFilter,
  ids: number[],
): Promise<Awaited<ReturnType<typeof getTransactions>>> {
  const out: Awaited<ReturnType<typeof getTransactions>> = [];
  for (let i = 0; i < ids.length; i += PAGE_CHUNK) {
    const chunk = ids.slice(i, i + PAGE_CHUNK);
    const rows = await getTransactions(userId, { ...filters, ids: chunk, limit: chunk.length, offset: 0 });
    out.push(...rows);
  }
  return out;
}

async function loadAccountNames(userId: string, dek: Buffer | null) {
  const rows = await db
    .select({ id: schema.accounts.id, nameCt: schema.accounts.nameCt, aliasCt: schema.accounts.aliasCt })
    .from(schema.accounts)
    .where(eq(schema.accounts.userId, userId));
  return new Map(
    rows.map((a) => [a.id, { name: decryptName(a.nameCt, dek, null), alias: decryptName(a.aliasCt, dek, null) }]),
  );
}

async function loadHoldingNames(userId: string, dek: Buffer | null, securitiesRead: boolean) {
  const rows = await db
    .select({
      id: schema.portfolioHoldings.id,
      nameCt: schema.portfolioHoldings.nameCt,
      securityNameCt: schema.securities.nameCt,
    })
    .from(schema.portfolioHoldings)
    .leftJoin(schema.securities, eq(schema.portfolioHoldings.securityId, schema.securities.id))
    .where(eq(schema.portfolioHoldings.userId, userId));
  return new Map(rows.map((h) => [h.id, holdingDisplayName(h.securityNameCt, h.nameCt, dek, securitiesRead)]));
}
