import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { sql, eq, and, inArray } from "drizzle-orm";
import { detectRecurringTransactions, forecastCashFlow } from "@/lib/recurring-detector";
import { getDisplayCurrency, getRateMap, convertWithRateMap } from "@/lib/fx-service";
import { round2 } from "@/lib/utils/number";
import { CASH_GROUP_NAMES } from "@/lib/accounts/groups";
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
      // GH #307 — shared canonical cash-group set (was a hardcoded
      // "Banks"/"Cash Accounts" subset that missed Checking/Savings/Cash).
      inArray(schema.accounts.group, [...CASH_GROUP_NAMES])
    ))
    .all();

  // One GROUP BY pass instead of N per-account SUM queries (FINLYNQ-145). The
  // FINLYNQ-123 currency split is preserved EXACTLY: we still sum each account's
  // NATIVE amount on its own and convert per-account at the CURRENT rate via
  // convertWithRateMap — never SUM(amount) across mixed currencies.
  let currentBalance = 0;
  const accountIds = bankAccounts.map((ba) => ba.id);
  if (accountIds.length > 0) {
    const sums = await db
      .select({
        accountId: schema.transactions.accountId,
        total: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)`,
      })
      .from(schema.transactions)
      .where(and(
        eq(schema.transactions.userId, userId),
        inArray(schema.transactions.accountId, accountIds),
      ))
      .groupBy(schema.transactions.accountId)
      .all();

    const totalByAccount = new Map<number, number>(
      sums.map((r) => [r.accountId as number, Number(r.total) || 0]),
    );

    for (const ba of bankAccounts) {
      const total = totalByAccount.get(ba.id) ?? 0;
      currentBalance += convertWithRateMap(total, ba.currency ?? displayCurrency, rateMap);
    }
  }

  const activeRecurring = detected.map((r) => ({ ...r, active: true }));
  const forecast = forecastCashFlow(activeRecurring, currentBalance, days);

  // Find warning dates (balance below threshold)
  const warnings = forecast
    .filter((f) => f.balance < 500)
    .map((f) => ({ date: f.date, balance: f.balance }));

  return NextResponse.json({
    currentBalance: round2(currentBalance),
    forecast,
    warnings,
    daysAhead: days,
  });
}
