import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { sql, eq, and } from "drizzle-orm";
import { detectRecurringTransactions, forecastCashFlow } from "@/lib/recurring-detector";
import { getDisplayCurrency, getRateMap, convertWithRateMap } from "@/lib/fx-service";
import { requireAuth } from "@/lib/auth/require-auth";
import { getDEK } from "@/lib/crypto/dek-cache";
import { tryDecryptField } from "@/lib/crypto/envelope";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, sessionId } = auth.context;
  const dek = sessionId ? getDEK(sessionId, userId) : null;
  const days = parseInt(request.nextUrl.searchParams.get("days") ?? "90");

  // Detect recurring transactions
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);
  const cutoffStr = cutoff.toISOString().split("T")[0];

  const txns = await db
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
      payee: (dek ? tryDecryptField(dek, t.payee, "transactions.payee") : t.payee) ?? "",
      accountId: t.accountId ?? 0,
      categoryId: t.categoryId,
    }))
  );

  // Get current total balance across all bank/checking accounts.
  // FINLYNQ-123 — the forecast starting balance is a POINT-IN-TIME figure, so
  // convert each account's native balance to the user's display currency at the
  // CURRENT rate before summing. Previously raw mixed-currency SUM(amount) was
  // accumulated under one currency label.
  const displayCurrency = await getDisplayCurrency(userId);
  const rateMap = await getRateMap(displayCurrency, userId);
  const bankAccounts = await db
    .select({ id: schema.accounts.id, currency: schema.accounts.currency })
    .from(schema.accounts)
    .where(and(
      eq(schema.accounts.userId, userId),
      sql`${schema.accounts.group} IN ('Banks', 'Cash Accounts')`
    ))
    .all();

  let currentBalance = 0;
  for (const ba of bankAccounts) {
    const result = await db
      .select({ total: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)` })
      .from(schema.transactions)
      .where(and(eq(schema.transactions.accountId, ba.id), eq(schema.transactions.userId, userId)))
      .get();
    currentBalance += convertWithRateMap(result?.total ?? 0, ba.currency ?? displayCurrency, rateMap);
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
