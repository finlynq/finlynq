import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and, sql } from "drizzle-orm";
import { detectRecurringTransactions, forecastCashFlow } from "@/lib/recurring-detector";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireDevMode } from "@/lib/require-dev-mode";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const devGuard = await requireDevMode(request); if (devGuard) return devGuard;
  const { userId } = auth.context;
  // Fetch last 12 months of transactions with payees
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

  // Monthly total of recurring expenses
  const monthlyRecurring = detected
    .filter((r) => r.avgAmount < 0)
    .reduce((sum, r) => {
      switch (r.frequency) {
        case "weekly": return sum + r.avgAmount * 4.33;
        case "biweekly": return sum + r.avgAmount * 2.17;
        case "monthly": return sum + r.avgAmount;
        case "yearly": return sum + r.avgAmount / 12;
        default: return sum;
      }
    }, 0);

  return NextResponse.json({
    recurring: detected.map((r) => ({
      payee: r.payee,
      avgAmount: r.avgAmount,
      frequency: r.frequency,
      count: r.count,
      lastDate: r.lastDate,
      nextDate: r.nextDate,
      accountId: r.accountId,
      categoryId: r.categoryId,
    })),
    monthlyRecurringTotal: Math.round(Math.abs(monthlyRecurring) * 100) / 100,
    count: detected.length,
  });
}
