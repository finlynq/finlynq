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
 *     kind IN ('dividend','interest','portfolio_income','portfolio_expense')
 *     OR trade_link_id IS NOT NULL
 *     OR link_id IS NOT NULL
 *   )
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { safeErrorMessage, logApiError } from "@/lib/validate";
import { decryptName } from "@/lib/crypto/encrypted-columns";

const PAIRLESS_CANONICAL_KINDS = ["dividend", "interest", "portfolio_income", "portfolio_expense"];

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
              ${schema.transactions.kind} IN (${sql.join(PAIRLESS_CANONICAL_KINDS.map((k) => sql`${k}`), sql`, `)})
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

    let totalTxs = 0;
    let canonicalTxs = 0;
    const perAccount: Array<{ accountId: number; name: string; total: number; canonical: number; pending: number; pendingPct: number }> = [];
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
