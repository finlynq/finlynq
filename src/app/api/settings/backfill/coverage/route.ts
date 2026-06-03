/**
 * GET /api/settings/backfill/coverage
 *
 * Standalone coverage report for the user's investment-account ledger.
 * Counts canonical vs non-canonical transactions in aggregate AND
 * per-account. Used by the dashboard at the top of /settings/backfill[/runId]
 * so the user can see how much of their ledger is already in Phase 2
 * canonical shape vs how much still needs backfill.
 *
 * "Canonical" mirrors the planner's `isAlreadyCanonical` predicate:
 *   kind IS NOT NULL AND (
 *     kind IN PAIRLESS_CANONICAL_KINDS
 *     OR trade_link_id IS NOT NULL
 *     OR link_id IS NOT NULL
 *   )
 *
 * The PAIRLESS_CANONICAL_KINDS set is imported from
 * @/lib/portfolio/backfill/types so the SQL predicate here cannot drift
 * from the planner's TS predicate. See
 * HANDOVER_2026-06-02_BACKFILL_REVIEW_BUGS.md for the 2026-06-02 incident
 * where divergence between the two surfaced as "312 pending, 0 proposals".
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { safeErrorMessage, logApiError } from "@/lib/validate";
import { decryptName } from "@/lib/crypto/encrypted-columns";
import { PAIRLESS_CANONICAL_KINDS } from "@/lib/portfolio/backfill/types";

const PAIRLESS_CANONICAL_KINDS_ARR = Array.from(PAIRLESS_CANONICAL_KINDS);

export async function GET(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  try {
    // 1. List investment accounts.
    const investmentAccounts = await db
      .select({
        id: schema.accounts.id,
        nameCt: schema.accounts.nameCt,
        currency: schema.accounts.currency,
      })
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.userId, auth.userId),
          eq(schema.accounts.isInvestment, true),
        ),
      );

    if (investmentAccounts.length === 0) {
      return NextResponse.json({
        accountCount: 0,
        totalTxs: 0,
        canonicalTxs: 0,
        nonCanonicalTxs: 0,
        perAccount: [],
      });
    }

    const accountIds = investmentAccounts.map((a) => a.id);
    const accountNameById: Record<number, string> = {};
    for (const a of investmentAccounts) {
      accountNameById[a.id] = decryptName(a.nameCt, auth.dek, null) ?? `account #${a.id}`;
    }

    // 2. Aggregate counts in SQL — one query, grouped by account + canonical flag.
    //    Drizzle doesn't have a clean "case+group" builder; raw SQL is clearer here.
    const rows = await db.execute<{
      account_id: number;
      total_txs: number;
      canonical_txs: number;
    }>(
      sql`
        SELECT
          ${schema.transactions.accountId} AS account_id,
          COUNT(*)::int AS total_txs,
          SUM(
            CASE WHEN ${schema.transactions.kind} IS NOT NULL AND (
              ${schema.transactions.kind} IN (${sql.join(PAIRLESS_CANONICAL_KINDS_ARR.map((k) => sql`${k}`), sql`, `)})
              OR ${schema.transactions.tradeLinkId} IS NOT NULL
              OR ${schema.transactions.linkId} IS NOT NULL
            ) THEN 1 ELSE 0 END
          )::int AS canonical_txs
        FROM ${schema.transactions}
        WHERE ${schema.transactions.userId} = ${auth.userId}
          AND ${schema.transactions.accountId} IN (${sql.join(accountIds.map((id) => sql`${id}`), sql`, `)})
        GROUP BY ${schema.transactions.accountId}
      `,
    );

    // Drizzle's execute() returns either an array of rows or { rows: [...] }
    // depending on driver wrapping. Normalize.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw: Array<{ account_id: number; total_txs: number; canonical_txs: number }> = Array.isArray(rows) ? rows : ((rows as any).rows ?? []);

    // Phase 3 — count canonical rows whose lot rows are missing. Mirrors
    // the planner's Pass 0 predicate: stock-holding canonical buy/sell
    // with no matching `holding_lots.open_tx_id` (for qty>0) or
    // `holding_lot_closures.close_tx_id` (for qty<0). Cash-leg kinds
    // (`*_cash_leg`) excluded — they don't touch the stock lot table.
    const missingLotsRows = await db.execute<{
      account_id: number;
      missing_lots: number;
    }>(
      sql`
        SELECT
          t.account_id AS account_id,
          COUNT(*)::int AS missing_lots
        FROM ${schema.transactions} t
        JOIN ${schema.portfolioHoldings} h ON h.id = t.portfolio_holding_id
        WHERE t.user_id = ${auth.userId}
          AND t.account_id IN (${sql.join(accountIds.map((id) => sql`${id}`), sql`, `)})
          AND t.portfolio_holding_id IS NOT NULL
          AND t.quantity IS NOT NULL
          AND t.quantity <> 0
          AND h.is_cash = false
          AND t.kind IS NOT NULL
          AND (
            t.kind IN (${sql.join(PAIRLESS_CANONICAL_KINDS_ARR.map((k) => sql`${k}`), sql`, `)})
            OR t.trade_link_id IS NOT NULL
            OR t.link_id IS NOT NULL
          )
          AND t.kind NOT LIKE '%_cash_leg'
          AND (
            (t.quantity > 0 AND NOT EXISTS (
              SELECT 1 FROM ${schema.holdingLots} l
              WHERE l.user_id = t.user_id AND l.open_tx_id = t.id
            ))
            OR (t.quantity < 0 AND NOT EXISTS (
              SELECT 1 FROM ${schema.holdingLotClosures} c
              WHERE c.user_id = t.user_id AND c.close_tx_id = t.id
            ))
          )
        GROUP BY t.account_id
      `,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const missingRaw: Array<{ account_id: number; missing_lots: number }> = Array.isArray(missingLotsRows) ? missingLotsRows : ((missingLotsRows as any).rows ?? []);
    const missingLotsByAccount: Record<number, number> = {};
    let totalMissingLots = 0;
    for (const r of missingRaw) {
      const n = Number(r.missing_lots) || 0;
      missingLotsByAccount[r.account_id] = n;
      totalMissingLots += n;
    }

    // Non-investment rows: txs on investment accounts with NO
    // portfolio_holding_id. The invariant `is_investment=true ⇒ every tx
    // references a portfolio_holdings row` means a null-holding row is not an
    // investment transaction at all (a mis-filed expense/income/transfer).
    // Surfaced distinctly so the dashboard can explain WHY a chunk of `pending`
    // isn't real investment work. Mirrors the planner's Pass 2.9
    // (`non_investment_in_investment_account`).
    const nonInvestmentRows = await db.execute<{
      account_id: number;
      non_investment: number;
    }>(
      sql`
        SELECT
          ${schema.transactions.accountId} AS account_id,
          COUNT(*)::int AS non_investment
        FROM ${schema.transactions}
        WHERE ${schema.transactions.userId} = ${auth.userId}
          AND ${schema.transactions.accountId} IN (${sql.join(accountIds.map((id) => sql`${id}`), sql`, `)})
          AND ${schema.transactions.portfolioHoldingId} IS NULL
        GROUP BY ${schema.transactions.accountId}
      `,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nonInvRaw: Array<{ account_id: number; non_investment: number }> = Array.isArray(nonInvestmentRows) ? nonInvestmentRows : ((nonInvestmentRows as any).rows ?? []);
    const nonInvestmentByAccount: Record<number, number> = {};
    let totalNonInvestmentRows = 0;
    for (const r of nonInvRaw) {
      const n = Number(r.non_investment) || 0;
      nonInvestmentByAccount[r.account_id] = n;
      totalNonInvestmentRows += n;
    }

    let totalTxs = 0;
    let canonicalTxs = 0;
    const perAccount: Array<{ accountId: number; name: string; total: number; canonical: number; pending: number; pendingPct: number; missingLots: number; nonInvestmentRows: number }> = [];
    for (const r of raw) {
      const tot = Number(r.total_txs) || 0;
      const can = Number(r.canonical_txs) || 0;
      totalTxs += tot;
      canonicalTxs += can;
      const pending = tot - can;
      perAccount.push({
        accountId: r.account_id,
        name: accountNameById[r.account_id] ?? `account #${r.account_id}`,
        total: tot,
        canonical: can,
        pending,
        pendingPct: tot === 0 ? 0 : Math.round((pending / tot) * 100),
        missingLots: missingLotsByAccount[r.account_id] ?? 0,
        nonInvestmentRows: nonInvestmentByAccount[r.account_id] ?? 0,
      });
    }
    // Investment accounts with zero transactions: pad with empty entries.
    for (const a of investmentAccounts) {
      if (!perAccount.find((r) => r.accountId === a.id)) {
        perAccount.push({
          accountId: a.id,
          name: accountNameById[a.id] ?? `account #${a.id}`,
          total: 0,
          canonical: 0,
          pending: 0,
          pendingPct: 0,
          missingLots: 0,
          nonInvestmentRows: nonInvestmentByAccount[a.id] ?? 0,
        });
      }
    }
    perAccount.sort((a, b) => b.pending - a.pending);

    return NextResponse.json({
      accountCount: investmentAccounts.length,
      totalTxs,
      canonicalTxs,
      nonCanonicalTxs: totalTxs - canonicalTxs,
      canonicalPct: totalTxs === 0 ? 0 : Math.round((canonicalTxs / totalTxs) * 100),
      missingLots: totalMissingLots,
      nonInvestmentRows: totalNonInvestmentRows,
      perAccount,
    });
  } catch (err: unknown) {
    await logApiError("GET", "/api/settings/backfill/coverage", err, auth.userId);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Failed to compute coverage") },
      { status: 500 },
    );
  }
}
