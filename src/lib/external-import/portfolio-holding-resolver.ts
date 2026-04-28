/**
 * Portfolio-holding resolver — find-or-create a portfolio_holdings row for a
 * given (accountId, name) pair, returning its integer id.
 *
 * Used by:
 *   - import-pipeline.ts::executeImport — resolve before DB insert so each
 *     transaction row gets portfolio_holding_id set in the same write.
 *   - portfolio-holding-fk-backfill.ts — resolve existing transactions whose
 *     portfolio_holding text column is populated but FK is NULL.
 *
 * Why a dedicated resolver: portfolio_holdings rows under Stream D have BOTH
 * plaintext `name` AND encrypted `name_ct` + `name_lookup`. Legacy rows have
 * only plaintext; Phase-3-NULL'd prod rows have only the encrypted columns.
 * Looking up by either alone misses one of the two cohorts. The resolver
 * keys both indexes off the user's set in one pass:
 *   - byPlain:  Map<"accountId|trim+lowercase(name)", id>
 *   - byLookup: Map<"accountId|name_lookup", id>
 *
 * Mirrors the dual-index pattern from zip-orchestrator.ts:142-160 (used for
 * accounts and categories) — same cohort problem, same shape of fix.
 *
 * Auto-create semantics: on a miss, INSERT a new portfolio_holdings row
 * scoped to (userId, accountId, name) with both plaintext + encrypted name
 * populated when a DEK is available. Currency defaults to the parent
 * account's currency. note='auto-created from import' so ops can distinguish
 * resolver-created rows from user-created ones.
 *
 * Concurrency: relies on the partial UNIQUE index
 *   (user_id, account_id, name_lookup) WHERE name_lookup IS NOT NULL AND account_id IS NOT NULL
 * from scripts/migrate-tx-portfolio-holding-fk.sql. On conflict, the INSERT
 * raises 23505 and we re-SELECT to pick up the row the other writer just
 * created. When dek is null the lookup column is null too — the index
 * doesn't fire, so concurrent dek-less imports could create duplicates.
 * Acceptable: dek-less paths (stdio MCP) don't write portfolio_holding today.
 */

import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { decryptField } from "@/lib/crypto/envelope";
import { buildNameFields, nameLookup } from "@/lib/crypto/encrypted-columns";

export interface HoldingResolver {
  /**
   * Returns the portfolio_holdings.id for (accountId, name), creating one if
   * needed. Returns null when accountId or name is missing/empty (caller
   * leaves the FK NULL — orphan-fallback read paths handle it).
   */
  resolve: (accountId: number | null, name: string | null | undefined) => Promise<number | null>;
  /** Number of holdings auto-created during this resolver's lifetime. */
  createdCount: () => number;
}

function plainKey(accountId: number, name: string): string {
  return `${accountId}|${name.trim().toLowerCase()}`;
}

function lookupKey(accountId: number, lookup: string): string {
  return `${accountId}|${lookup}`;
}

/** Pre-load all of a user's holdings into the two indexes and return a
 *  resolver closed over those maps + the user's DEK. */
export async function buildHoldingResolver(
  userId: string,
  dek: Buffer | null | undefined,
): Promise<HoldingResolver> {
  // Pre-load every holding for the user. This is bounded (typical user has
  // <100 holdings) so a single pass is cheap. We need both columns since
  // the cohort split is per-row, not per-user.
  const rows = await db
    .select({
      id: schema.portfolioHoldings.id,
      accountId: schema.portfolioHoldings.accountId,
      name: schema.portfolioHoldings.name,
      nameCt: schema.portfolioHoldings.nameCt,
      nameLookup: schema.portfolioHoldings.nameLookup,
    })
    .from(schema.portfolioHoldings)
    .where(eq(schema.portfolioHoldings.userId, userId))
    .all();

  const byPlain = new Map<string, number>();
  const byLookup = new Map<string, number>();

  for (const r of rows) {
    if (r.accountId == null) continue;
    // Resolve a plaintext name to use for the byPlain map. Decryption
    // succeeds when (a) the row has nameCt and we have the DEK, or
    // (b) the row still has plaintext name (legacy / pre-Stream-D).
    let plain: string | null = null;
    if (r.nameCt && dek) {
      try {
        plain = decryptField(dek, r.nameCt);
      } catch {
        plain = null;
      }
    }
    if (!plain) plain = r.name;
    if (plain) {
      byPlain.set(plainKey(r.accountId, plain), r.id);
    }
    if (r.nameLookup) {
      byLookup.set(lookupKey(r.accountId, r.nameLookup), r.id);
    }
  }

  // Account-currency lookup so auto-created holdings inherit the right
  // currency. Same single-pass approach.
  const accountCurrency = new Map<number, string>();
  const accountRows = await db
    .select({ id: schema.accounts.id, currency: schema.accounts.currency })
    .from(schema.accounts)
    .where(eq(schema.accounts.userId, userId))
    .all();
  for (const a of accountRows) accountCurrency.set(a.id, a.currency);

  let created = 0;

  const resolve = async (
    accountId: number | null,
    name: string | null | undefined,
  ): Promise<number | null> => {
    if (accountId == null) return null;
    const trimmed = (name ?? "").trim();
    if (!trimmed) return null;

    // Try plaintext-keyed lookup first (handles legacy rows + dek-less calls).
    const pk = plainKey(accountId, trimmed);
    const hitPlain = byPlain.get(pk);
    if (hitPlain != null) return hitPlain;

    // Try lookup-keyed lookup (handles Stream D Phase 3 NULL-plaintext rows).
    let lk: string | null = null;
    if (dek) {
      lk = nameLookup(dek, trimmed);
      const hitLookup = byLookup.get(lookupKey(accountId, lk));
      if (hitLookup != null) {
        // Cache-warm the plaintext index so subsequent calls hit it directly.
        byPlain.set(pk, hitLookup);
        return hitLookup;
      }
    }

    // Auto-create. Build the encrypted name fields if we have a DEK.
    const enc = buildNameFields(dek ?? null, { name: trimmed });
    const currency = accountCurrency.get(accountId) ?? "CAD";
    try {
      const insertedRow = await db
        .insert(schema.portfolioHoldings)
        .values({
          userId,
          accountId,
          name: trimmed,
          symbol: null,
          currency,
          isCrypto: 0,
          note: "auto-created from import",
          ...enc,
        })
        .returning({ id: schema.portfolioHoldings.id });
      const inserted = Array.isArray(insertedRow) ? insertedRow[0] : insertedRow;
      const id = inserted?.id;
      if (id != null) {
        created++;
        byPlain.set(pk, id);
        if (lk) byLookup.set(lookupKey(accountId, lk), id);
        return id;
      }
    } catch (err) {
      // 23505 = unique_violation — concurrent writer beat us. Re-SELECT to
      // pick up their row. Other errors propagate.
      const code = (err as { code?: string }).code;
      if (code !== "23505") throw err;
    }

    // Fall through: either RETURNING was empty (shouldn't happen) or the
    // INSERT raced. Look up the row that's now there.
    if (lk) {
      const row = await db
        .select({ id: schema.portfolioHoldings.id })
        .from(schema.portfolioHoldings)
        .where(
          and(
            eq(schema.portfolioHoldings.userId, userId),
            eq(schema.portfolioHoldings.accountId, accountId),
            eq(schema.portfolioHoldings.nameLookup, lk),
          ),
        )
        .get();
      if (row?.id != null) {
        byPlain.set(pk, row.id);
        byLookup.set(lookupKey(accountId, lk), row.id);
        return row.id;
      }
    }
    return null;
  };

  return {
    resolve,
    createdCount: () => created,
  };
}
