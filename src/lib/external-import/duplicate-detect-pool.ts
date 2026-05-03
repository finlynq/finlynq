/**
 * Pool-builder for the cross-source duplicate detector (issue #65).
 *
 * Owns the DB side effects so {@link detectProbableDuplicates} stays a pure
 * function. One round trip pulls every candidate transaction in the union of
 * the import's account ids over a `[min(date) - tolerance .. max(date) +
 * tolerance]` window. A second round trip resolves transfer-pair siblings
 * for the cross-account hint.
 *
 * Stream D parity:
 * - `payee_ct` is decrypted with the standard `?? plaintext` fallback. If
 *   `tryDecryptField` returns null AND the plaintext column is also null,
 *   payeePlain falls through as null — the detector skips the payee-similarity
 *   hint for that candidate but can still match on amount/date/holding.
 *
 * Performance — for a 1k-row CSV across 5 accounts spanning 3 months, the
 * candidate pool is at most ~15k rows (well under MAX_RECONCILE_ROWS = 10k
 * the reconcile path already accepts). If imports get larger the pool query
 * can be batched per-account chunk; today the single-query path is fine.
 */

import { db, schema } from "@/db";
import { and, between, eq, inArray } from "drizzle-orm";
import { tryDecryptField } from "../crypto/envelope";
import type {
  DuplicateCandidatePool,
  DuplicateCandidateRow,
} from "./duplicate-detect";

export interface PoolBuildInput {
  userId: string;
  /** DEK for `payee_ct` decryption; pass null when no DEK is available. */
  dek: Buffer | null;
  /** Account ids the import touches. Union deduped by caller. */
  accountIds: number[];
  /** ISO YYYY-MM-DD; the helper window-pads by `dateToleranceDays`. */
  dateMin: string;
  dateMax: string;
  /** Default 7. Pads the date window on both sides. */
  dateToleranceDays?: number;
}

/**
 * Build the candidate pool used by {@link detectProbableDuplicates}.
 * Returns an empty pool when there are no account ids to search.
 */
export async function buildDuplicateCandidatePool(
  input: PoolBuildInput,
): Promise<DuplicateCandidatePool> {
  const tolerance = input.dateToleranceDays ?? 7;
  const empty: DuplicateCandidatePool = {
    byAccount: new Map(),
    holdingSymbolByHoldingId: new Map(),
    siblingAccountByLinkId: new Map(),
  };
  if (input.accountIds.length === 0) return empty;
  const dateMin = shiftDate(input.dateMin, -tolerance);
  const dateMax = shiftDate(input.dateMax, tolerance);
  if (!dateMin || !dateMax) return empty;

  // Pool rows — all transactions in the import's accounts, in window.
  // LEFT JOIN categories so uncategorized rows still load (categoryType=null).
  const rawPool = await db
    .select({
      id: schema.transactions.id,
      accountId: schema.transactions.accountId,
      date: schema.transactions.date,
      amount: schema.transactions.amount,
      payee: schema.transactions.payee,
      importHash: schema.transactions.importHash,
      fitId: schema.transactions.fitId,
      linkId: schema.transactions.linkId,
      categoryType: schema.categories.type,
      source: schema.transactions.source,
      portfolioHoldingId: schema.transactions.portfolioHoldingId,
    })
    .from(schema.transactions)
    .leftJoin(
      schema.categories,
      eq(schema.transactions.categoryId, schema.categories.id),
    )
    .where(
      and(
        eq(schema.transactions.userId, input.userId),
        inArray(schema.transactions.accountId, input.accountIds),
        between(schema.transactions.date, dateMin, dateMax),
      ),
    )
    .all();

  const byAccount = new Map<number, DuplicateCandidateRow[]>();
  const linkIds: string[] = [];
  for (const r of rawPool) {
    if (r.accountId == null) continue;
    const payeePlain = decryptPayee(input.dek, r.payee);
    const row: DuplicateCandidateRow = {
      id: r.id,
      accountId: r.accountId,
      date: r.date,
      amount: r.amount,
      payeePlain,
      importHash: r.importHash,
      fitId: r.fitId,
      linkId: r.linkId,
      categoryType: r.categoryType,
      source: r.source,
      portfolioHoldingId: r.portfolioHoldingId,
    };
    const arr = byAccount.get(r.accountId) ?? [];
    arr.push(row);
    byAccount.set(r.accountId, arr);
    if (r.categoryType === "R" && r.linkId) linkIds.push(r.linkId);
  }

  // Sibling-account index: for every transfer-pair candidate found above,
  // resolve the OTHER leg so the detector can boost when a new row lands on
  // the sibling account. One round trip total — pull every leg of the
  // collected linkIds and pick the one whose accountId differs from the
  // candidate set we already loaded.
  const siblingAccountByLinkId = new Map<string, number>();
  if (linkIds.length > 0) {
    const siblingRows = await db
      .select({
        linkId: schema.transactions.linkId,
        accountId: schema.transactions.accountId,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, input.userId),
          inArray(schema.transactions.linkId, linkIds),
        ),
      )
      .all();
    // Group by linkId. The candidate-leg's accountId is in input.accountIds;
    // the sibling is whichever leg's accountId is NOT in that set. If both
    // legs are in the set (intra-import transfer), skip — the detector won't
    // add a boost in that case.
    const accountSet = new Set(input.accountIds);
    const byLink = new Map<string, number[]>();
    for (const sr of siblingRows) {
      if (!sr.linkId || sr.accountId == null) continue;
      const arr = byLink.get(sr.linkId) ?? [];
      arr.push(sr.accountId);
      byLink.set(sr.linkId, arr);
    }
    for (const [linkId, accs] of byLink) {
      // Pick the first account NOT in the candidate-account set.
      const sibling = accs.find((a) => !accountSet.has(a));
      if (sibling != null) siblingAccountByLinkId.set(linkId, sibling);
    }
  }

  // Holding symbol index — load lazily for any candidate that has a
  // portfolioHoldingId. This is small (one row per distinct holding the
  // user touches) and only used for the +0.1 cross-symbol soft hint.
  const holdingSymbolByHoldingId = new Map<number, string>();
  const holdingIds = Array.from(
    new Set(
      rawPool
        .map((r) => r.portfolioHoldingId)
        .filter((id): id is number => id != null),
    ),
  );
  if (holdingIds.length > 0) {
    // Stream D Phase 4 — plaintext symbol dropped; ciphertext only.
    const holdings = await db
      .select({
        id: schema.portfolioHoldings.id,
        symbolCt: schema.portfolioHoldings.symbolCt,
      })
      .from(schema.portfolioHoldings)
      .where(
        and(
          eq(schema.portfolioHoldings.userId, input.userId),
          inArray(schema.portfolioHoldings.id, holdingIds),
        ),
      )
      .all();
    for (const h of holdings) {
      // Stream D Phase 4 — plaintext symbol dropped; only the ciphertext.
      const sym = h.symbolCt && input.dek
        ? tryDecryptField(input.dek, h.symbolCt, "portfolio_holdings.symbol_ct")
        : null;
      if (sym) holdingSymbolByHoldingId.set(h.id, sym);
    }
  }

  return { byAccount, holdingSymbolByHoldingId, siblingAccountByLinkId };
}

function decryptPayee(dek: Buffer | null, value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith("v1:")) return value;
  if (!dek) return null;
  // tryDecryptField returns null on auth-tag failure. The `?? plaintext`
  // fallback in the read path expects this. We have no plaintext column
  // here (transactions.payee IS the dual-write home — it's been ct since
  // Stream D shipped) so on failure we just pass null.
  return tryDecryptField(dek, value, "transactions.payee");
}

function shiftDate(iso: string, deltaDays: number): string | null {
  const ms = Date.parse(iso + "T00:00:00Z");
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms + deltaDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}
