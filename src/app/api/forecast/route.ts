import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { sql, eq, and } from "drizzle-orm";
import { detectRecurringTransactions, forecastCashFlow } from "@/lib/recurring-detector";
import { requireAuth } from "@/lib/auth/require-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  const days = parseInt(request.nextUrl.searchParams.get("days") ?? "90");

  // Detect recurring transactions
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);
  const cutoffStr = cutoff.toISOString().split("T")[0];

  const txns = db
    .select({
      id: schema.transactions.id,
      date: schema.transactions.date,
      payee: schema.transactions.payee,
      amount: schema.transactions.amount,
      accountId: schema.transactions.accountId,
      categoryId: schema.transactions.categoryId,
    })
    .from(schema.transactions)
    .where(and(
      eq(schema.transactions.userId, userId),
      sql`${schema.transactions.date} >= ${cutoffStr} AND ${schema.transactions.payee} != ''`
    ))
    .all();

  const detected = detectRecurringTransactions(
    txns.map((t) => ({
      ...t,
      payee: t.payee ?? "",
      accountId: t.accountId ?? 0,
      categoryId: t.categoryId,
    }))
  );

  // Get current total balance across all bank/checking accounts
  const bankAccounts = db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(and(
      eq(schema.accounts.userId, userId),
      sql`${schema.accounts.group} IN ('Banks', 'Cash Accounts')`
    ))
    .all();

  let currentBalance = 0;
  for (const ba of bankAccounts) {
    const result = db
      .select({ total: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)` })
      .from(schema.transactions)
      .where(and(eq(schema.transactions.accountId, ba.id), eq(schema.transactions.userId, userId)))
      .get();
    currentBalance += result?.total ?? 0;
  }

  const activeRecurring = detected.map((r) => ({ ...r, active: true }));
  const forecast = forecastCashFlow(activeRecurring, currentBalance, days);

  // Find warning dates (balance below threshold)
  const warnings = forecast
    .filter((f) => f.balance < 500)
    .map((f) => ({ date: f.date, balance: f.balance }));

  return NextResponse.json({
    currentBalance: Math.round(currentBalance * 100) / 100,
    forecast,
    warnings,
    daysAhead: days,
  });
}
