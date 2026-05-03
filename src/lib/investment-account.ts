/**
 * Investment-account constraint helpers.
 *
 * accounts.is_investment marks an account as an investment account. Every
 * transaction in such an account must reference a portfolio_holdings row
 * (FK transactions.portfolio_holding_id). Trades point at their security;
 * cash legs (deposits, dividends-as-cash, fees, transfers) point at a
 * per-account 'Cash' holding using the existing currency-as-holding
 * pattern (src/lib/holdings-value.ts:42 isCurrencyCodeSymbol +
 * src/app/(app)/portfolio/page.tsx:1650 "Empty symbol → cash holding").
 *
 * Enforcement is application-layer (mirrors the four-check transfer-pair
 * pattern in src/lib/transfer.ts). Two complementary entry points cover
 * the spectrum of callers:
 *
 *   - {@link requireHoldingForInvestmentAccount} — strict, used by
 *     interactive REST + MCP HTTP write tools. Throws when the caller
 *     omitted the holding id, surfaced to the client as an actionable
 *     400.
 *   - {@link defaultHoldingForInvestmentAccount} — permissive, used by
 *     bulk import paths and transfer-pair construction. Falls back to
 *     the per-account Cash holding so a single unattributed cash leg
 *     doesn't fail the whole batch.
 *
 * Bulk callers (bulk_record_transactions, import-pipeline) should fetch
 * {@link getInvestmentAccountIds} once and use the in-memory Set to avoid
 * N round-trips.
 *
 * Stdio MCP runs without a DEK (CLAUDE.md gotcha: stdio writes plaintext);
 * the auto-create path tolerates `dek=null` and writes plaintext only,
 * matching the existing portfolio-holding-resolver behavior.
 */

import { db, schema } from "@/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { buildNameFields } from "@/lib/crypto/encrypted-columns";

export class InvestmentHoldingRequiredError extends Error {
  code = "investment_holding_required" as const;
  constructor(public accountId: number) {
    super(
      `transactions in investment account #${accountId} must reference a portfolio_holding — pick a holding or use the account's 'Cash' holding`,
    );
    this.name = "InvestmentHoldingRequiredError";
  }
}

/**
 * Returns the set of account_ids flagged is_investment for this user. The
 * accounts table is small (typically <30 rows) so a single SELECT is cheap;
 * callers that loop over many transactions should call this once and pass
 * the Set into {@link isInvestmentAccountSync}.
 */
export async function getInvestmentAccountIds(userId: string): Promise<Set<number>> {
  const rows = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.userId, userId), eq(schema.accounts.isInvestment, true)))
    .all();
  return new Set(rows.map((r) => r.id));
}

export function isInvestmentAccountSync(accountId: number | null | undefined, ids: Set<number>): boolean {
  return accountId != null && ids.has(accountId);
}

export async function isInvestmentAccount(userId: string, accountId: number | null | undefined): Promise<boolean> {
  if (accountId == null) return false;
  const row = await db
    .select({ isInvestment: schema.accounts.isInvestment })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.userId, userId)))
    .get();
  return Boolean(row?.isInvestment);
}

/**
 * Find or create the per-account cash sleeve holding. Match criteria
 * intentionally broad: any holding on (user, account) with `symbol IS NULL`
 * AND `currency = accounts.currency` qualifies. This covers both literal-
 * named 'Cash' rows AND currency-coded cash sleeves that import connectors
 * mint with the account currency (named after the account+currency rather
 * than 'Cash'). When multiple match, prefer the literally-named 'Cash' row,
 * tie-breaking on the lowest id for determinism (issue #30 — without this,
 * the insert path fires on every cash transfer, creating duplicate rows or
 * blowing up on partial-unique-index conflicts with stale soft-deletes).
 *
 * DEK is optional — when absent, name_ct/name_lookup stay NULL and get
 * filled lazily on next login via the resolver's DEK-backed pass.
 *
 * Concurrency: 23505 (unique_violation) on the insert means a concurrent
 * writer beat us; we re-SELECT with the same broad criteria.
 */
export async function getOrCreateCashHolding(
  userId: string,
  accountId: number,
  dek: Buffer | null,
): Promise<number> {
  // Inherit the account's currency so isCurrencyCodeSymbol-based cash
  // detection in the portfolio aggregator routes the holding through the
  // cash branch instead of Yahoo Finance.
  const acct = await db
    .select({ currency: schema.accounts.currency })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.userId, userId)))
    .get();
  const currency = acct?.currency ?? "CAD";

  // Stream D Phase 4 — plaintext name/symbol dropped. Match the cash sleeve
  // by accountId + symbol_ct IS NULL + matching currency. Identify the
  // canonical cash row via its (currency, symbol_ct IS NULL) combo. Order
  // is now arbitrary across multiple cash candidates — pick lowest id.
  const matchCashSleeve = and(
    eq(schema.portfolioHoldings.userId, userId),
    eq(schema.portfolioHoldings.accountId, accountId),
    sql`${schema.portfolioHoldings.symbolCt} IS NULL`,
    eq(schema.portfolioHoldings.currency, currency),
  );

  const existing = await db
    .select({ id: schema.portfolioHoldings.id })
    .from(schema.portfolioHoldings)
    .where(matchCashSleeve)
    .orderBy(schema.portfolioHoldings.id)
    .limit(1)
    .get();
  if (existing?.id != null) return existing.id;

  const enc = buildNameFields(dek, { name: "Cash" });
  try {
    const inserted = await db
      .insert(schema.portfolioHoldings)
      .values({
        userId,
        accountId,
        currency,
        isCrypto: 0,
        note: "auto-created for cash sleeve",
        ...enc,
      })
      .returning({ id: schema.portfolioHoldings.id });
    const id = Array.isArray(inserted) ? inserted[0]?.id : (inserted as { id?: number } | undefined)?.id;
    if (id != null) return id;
  } catch (err) {
    // 23505 = unique_violation — concurrent writer beat us. Re-SELECT.
    const code = (err as { code?: string }).code;
    if (code !== "23505") throw err;
  }

  const after = await db
    .select({ id: schema.portfolioHoldings.id })
    .from(schema.portfolioHoldings)
    .where(matchCashSleeve)
    .orderBy(schema.portfolioHoldings.id)
    .limit(1)
    .get();
  if (after?.id == null) {
    throw new Error(`failed to find-or-create Cash holding for account ${accountId}`);
  }
  return after.id;
}

/**
 * Strict path — throws {@link InvestmentHoldingRequiredError} when the
 * account is flagged investment and no holding id was supplied. Callers
 * surface this as a 400.
 */
export async function requireHoldingForInvestmentAccount(
  userId: string,
  accountId: number | null | undefined,
  holdingId: number | null | undefined,
): Promise<void> {
  if (accountId == null) return;
  if (holdingId != null) return;
  if (await isInvestmentAccount(userId, accountId)) {
    throw new InvestmentHoldingRequiredError(accountId);
  }
}

/**
 * Permissive path — returns the explicit holding id when provided;
 * otherwise the per-account Cash holding when the account is investment;
 * otherwise null. Used by import + transfer-pair paths so unattributed
 * cash legs land on Cash instead of failing the whole batch.
 */
export async function defaultHoldingForInvestmentAccount(
  userId: string,
  accountId: number | null | undefined,
  dek: Buffer | null,
  explicit: number | null | undefined,
): Promise<number | null> {
  if (explicit != null) return explicit;
  if (accountId == null) return null;
  if (!(await isInvestmentAccount(userId, accountId))) return null;
  return getOrCreateCashHolding(userId, accountId, dek);
}

/**
 * Run the same backfill the SQL migration does, scoped to a single
 * account. Called from the PATCH /api/accounts/[id] handler when a user
 * toggles is_investment from false → true so the constraint becomes
 * satisfiable immediately. Idempotent — re-running is a no-op.
 *
 * Returns the number of transactions reassigned to the Cash holding.
 */
export async function backfillInvestmentAccount(
  userId: string,
  accountId: number,
  dek: Buffer | null,
): Promise<{ cashHoldingId: number; reassignedCount: number }> {
  const cashHoldingId = await getOrCreateCashHolding(userId, accountId, dek);
  const result = await db
    .update(schema.transactions)
    .set({ portfolioHoldingId: cashHoldingId, updatedAt: sql`NOW()` })
    .where(
      and(
        eq(schema.transactions.userId, userId),
        eq(schema.transactions.accountId, accountId),
        sql`${schema.transactions.portfolioHoldingId} IS NULL`,
      ),
    )
    .returning({ id: schema.transactions.id });
  const reassignedCount = Array.isArray(result) ? result.length : 0;
  return { cashHoldingId, reassignedCount };
}

// inArray is re-exported so callers don't need a second drizzle-orm import
// just to filter by a Set of account ids.
export { inArray };
