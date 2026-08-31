import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and, sql } from "drizzle-orm";
import { detectRecurringTransactions, forecastCashFlow } from "@/lib/recurring-detector";
import { requireAuth } from "@/lib/auth/require-auth";
import { tryDecryptField } from "@/lib/crypto/envelope";
import { requireDevMode } from "@/lib/require-dev-mode";
import { getDisplayCurrency, getRateMap, convertWithRateMap } from "@/lib/fx-service";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const devGuard = await requireDevMode(request);
  if (devGuard) return devGuard;
  const { userId, dek } = auth.context;
  // Fetch last 12 months of transactions with payees
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);
  const cutoffStr = cutoff.toISOString().split("T")[0];

  const txns = await db
    .select({
      id: schema.transactions.id,
      date: schema.transactions.date,
      payee: schema.transactions.payee,
      amount: schema.transactions.amount,
      currency: schema.transactions.currency,
      accountId: schema.transactions.accountId,
      categoryId: schema.transactions.categoryId,
    })
    .from(schema.transactions)
    .where(and(
      eq(schema.transactions.userId, userId),
      sql`${schema.transactions.date} >= ${cutoffStr} AND ${schema.transactions.payee} != ''`
    ))
    .all();

  // Decrypt payees before grouping â€” detector groups by normalized payee, so
  // we must give it plaintext (ciphertext has a random IV per row). If no
  // DEK is available the passthrough keeps legacy plaintext rows working.
  const detected = detectRecurringTransactions(
    txns.map((t) => ({
      ...t,
      payee: (dek ? tryDecryptField(dek, t.payee, "transactions.payee") : t.payee) ?? "",
      accountId: t.accountId ?? 0,
      categoryId: t.categoryId,
    }))
  );

  // FINLYNQ-123 — the monthly recurring total is a forward-looking
  // point-in-time cost, so each series converts to the display currency at the
  // CURRENT rate before being summed. Previously native mixed-currency amounts
  // were added together and labelled with a single currency (feedback #7).
  const displayCurrency = await getDisplayCurrency(userId, request.nextUrl.searchParams.get("currency"));
  const rateMap = await getRateMap(displayCurrency, userId);
  const toDisplay = (amount: number, currency: string | null) =>
    convertWithRateMap(amount, currency ?? displayCurrency, rateMap);

  // Monthly total of recurring expenses
  const monthlyRecurring = detected
    .filter((r) => r.avgAmount < 0)
    .reduce((sum, r) => {
      const monthly = toDisplay(r.avgAmount, r.currency);
      switch (r.frequency) {
        case "weekly": return sum + monthly * 4.33;
        case "biweekly": return sum + monthly * 2.17;
        case "monthly": return sum + monthly;
        case "yearly": return sum + monthly / 12;
        default: return sum;
      }
    }, 0);

  return NextResponse.json({
    recurring: detected.map((r) => ({
      payee: r.payee,
      avgAmount: r.avgAmount,
      currency: r.currency,
      avgAmountDisplay: toDisplay(r.avgAmount, r.currency),
      frequency: r.frequency,
      count: r.count,
      lastDate: r.lastDate,
      nextDate: r.nextDate,
      accountId: r.accountId,
      categoryId: r.categoryId,
    })),
    displayCurrency,
    monthlyRecurringTotal: Math.round(Math.abs(monthlyRecurring) * 100) / 100,
    count: detected.length,
  });
}
