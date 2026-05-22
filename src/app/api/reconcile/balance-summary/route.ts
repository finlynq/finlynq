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
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireEncryption } from "@/lib/auth/require-encryption";
import {
  getLatestBankAnchor,
  sumBankAmountsAfter,
} from "@/lib/bank-ledger-balance";
import { getHoldingsValueByAccount } from "@/lib/holdings-value";

export const dynamic = "force-dynamic";

/** Float tolerance for the "balanced" check. Mirrors the threshold used
 *  by the validation helper + queries.ts account-balance code. */
const EPSILON = 0.005;

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

  const latestAnchor = await getLatestBankAnchor(userId, accountId);

  // Bank-side: anchor + sum-after, or null when no anchor exists.
  // The previous fallback (Σ over all bank rows) silently rendered a
  // misleading number that drifted further from reality with every
  // import; nulling it out + showing "—" in the UI is the honest signal
  // that no anchor has been loaded.
  let bankSideLatest: number | null;
  if (latestAnchor) {
    const after = await sumBankAmountsAfter(
      userId,
      accountId,
      latestAnchor.date,
    );
    bankSideLatest = latestAnchor.balance + after;
  } else {
    bankSideLatest = null;
  }

  // System-side: canonical account balance per CLAUDE.md
  // "Account balance for accounts with holdings = holdings.value".
  let systemSideLatest: number;
  if (acct.isInvestment) {
    const holdingsByAccount = await getHoldingsValueByAccount(userId, dek);
    systemSideLatest = holdingsByAccount.get(acct.id)?.value ?? 0;
  } else {
    const sumRow = await db
      .select({
        balance: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)`,
      })
      .from(schema.transactions)
      .where(and(
        eq(schema.transactions.userId, userId),
        eq(schema.transactions.accountId, acct.id),
      ))
      .get();
    systemSideLatest = Number(sumRow?.balance ?? 0);
  }

  const delta: number | null =
    bankSideLatest === null ? null : systemSideLatest - bankSideLatest;
  const status: "balanced" | "mismatch" | "no_anchor" = (() => {
    if (!latestAnchor || delta === null) return "no_anchor";
    if (Math.abs(delta) > EPSILON) return "mismatch";
    return "balanced";
  })();

  return NextResponse.json({
    success: true,
    data: {
      accountId,
      currency: acct.currency,
      latestAnchor,
      bankSideLatest,
      systemSideLatest,
      delta,
      status,
    },
  });
}
