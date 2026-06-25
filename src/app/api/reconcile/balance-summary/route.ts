/**
 * GET /api/reconcile/balance-summary?accountId=<int>
 *
 * Final bank-vs-system balance comparison for the standalone /reconcile
 * page header (2026-05-24). Returns:
 *   - latestAnchor: the most recent bank_daily_balances row for the
 *     account, or null when the account has no anchors yet
 *   - bankSideLatest: latestAnchor.balance + Σ(bank_tx.amount where
 *     date > latestAnchor.date). Null when no anchor exists — the naive
 *     sum-from-zero is meaningless and misleads the user (CLAUDE.md "Bank
 *     balance anchors": anchors are the truth source for the bank side).
 *   - systemSideLatest: canonical account-balance per CLAUDE.md
 *     "Account balance for accounts with holdings = holdings.value":
 *       investment accounts → getHoldingsValueByAccount[id].value
 *       cash accounts       → SUM(transactions.amount)
 *   - delta: systemSideLatest - bankSideLatest, or null when bankSide is
 *     null (no anchor)
 *   - status: 'balanced' | 'mismatch' | 'no_anchor'
 *   - currency: the account currency (anchor display unit)
 *
 * No daily compare — user decision 2026-05-22. Only the latest matters.
 *
 * Cross-tenant attacks return 404 (no existence leak), mirroring the
 * pattern at /api/reconcile/suggestions and /api/import/bank-ledger.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { computeAccountBalanceSummary } from "@/lib/reconcile/balance-summary";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;

  const accountIdRaw = request.nextUrl.searchParams.get("accountId");
  if (!accountIdRaw) {
    return NextResponse.json(
      { success: false, error: "Missing required query param: accountId" },
      { status: 400 },
    );
  }
  const accountId = parseInt(accountIdRaw, 10);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    return NextResponse.json(
      { success: false, error: "Invalid accountId" },
      { status: 400 },
    );
  }

  // Cross-tenant 404 — never 403.
  const acct = await db
    .select({
      id: schema.accounts.id,
      currency: schema.accounts.currency,
      isInvestment: schema.accounts.isInvestment,
    })
    .from(schema.accounts)
    .where(and(
      eq(schema.accounts.id, accountId),
      eq(schema.accounts.userId, userId),
    ))
    .get();
  if (!acct) {
    return NextResponse.json(
      { success: false, error: "Not found" },
      { status: 404 },
    );
  }

  // Shared with the MCP get_reconciliation_summary tool (FINLYNQ-215) so the
  // header delta + the tool's balanceDelta are computed by the same code.
  const summary = await computeAccountBalanceSummary(userId, dek, {
    id: acct.id,
    currency: acct.currency,
    isInvestment: acct.isInvestment,
  });

  return NextResponse.json({
    success: true,
    data: summary,
  });
}
