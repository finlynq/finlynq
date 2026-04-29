/**
 * GET /api/admin/investment-orphans — Report transactions in investment
 * accounts that still don't reference a portfolio_holdings row. Admin-only.
 *
 * Zero rows means the application-layer constraint in
 * src/lib/investment-account.ts is fully satisfied across the database.
 * Non-zero rows are genuine orphans — typically legacy imports where the
 * connector failed to bind a holding. Surface them to the user so they
 * can assign a holding (or auto-assign to the account's Cash member).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/require-admin";
import { db, schema } from "@/db";
import { and, eq, isNull, sql } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;

  const countRow = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.transactions)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.transactions.accountId))
    .where(
      and(
        eq(schema.accounts.isInvestment, true),
        isNull(schema.transactions.portfolioHoldingId),
      ),
    )
    .get();

  // Capped sample so a giant orphan tail doesn't blow out the response.
  const sample = await db
    .select({
      id: schema.transactions.id,
      userId: schema.transactions.userId,
      accountId: schema.transactions.accountId,
      date: schema.transactions.date,
      amount: schema.transactions.amount,
      currency: schema.transactions.currency,
    })
    .from(schema.transactions)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.transactions.accountId))
    .where(
      and(
        eq(schema.accounts.isInvestment, true),
        isNull(schema.transactions.portfolioHoldingId),
      ),
    )
    .limit(200)
    .all();

  return NextResponse.json({
    complete: (countRow?.count ?? 0) === 0,
    orphanCount: countRow?.count ?? 0,
    sampleSize: sample.length,
    sample,
  });
}
