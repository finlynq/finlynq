import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and, sql } from "drizzle-orm";
import { detectRecurringTransactions } from "@/lib/recurring-detector";
import { requireAuth } from "@/lib/auth/require-auth";
import { tryDecryptField } from "@/lib/crypto/envelope";
import { getDisplayCurrency, getRateMap, convertWithRateMap } from "@/lib/fx-service";
import { monthlyEquivalent } from "@/lib/subscriptions/schedule";
import { todayISO } from "@/lib/utils/date";
import { round2 } from "@/lib/utils/number";
import { dismissedLookups, withoutDismissed } from "@/lib/subscriptions/dismissals";

// 25 months, so a semi-annual or annual series can show its 3 occurrences
// (the detector's minimum) — 12 months could never detect anything yearly.
const LOOKBACK_MONTHS = 25;

// Not dev-mode gated: this feeds the Subscriptions page's calendar view and
// "detected from your transactions" suggestions, on web and mobile.
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, dek } = auth.context;
  const today = todayISO();
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - LOOKBACK_MONTHS);
  const cutoffStr = cutoff.toISOString().split("T")[0];

  // Transfer, trade and swap legs are excluded: a monthly "transfer to
  // savings" recurs, but it is neither a bill nor income, and suggesting it as
  // a subscription is noise. So are rows in a Reconciliation-type ('R')
  // category — the canonical "Transfer" category — which is how an imported
  // but never-paired transfer looks. Dividends (holding-linked, no pair id) stay.
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
    .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
    .where(and(
      eq(schema.transactions.userId, userId),
      sql`${schema.transactions.date} >= ${cutoffStr} AND ${schema.transactions.payee} != ''`,
      sql`${schema.transactions.linkId} IS NULL AND ${schema.transactions.tradeLinkId} IS NULL AND ${schema.transactions.swapLinkId} IS NULL`,
      sql`(${schema.categories.type} IS NULL OR ${schema.categories.type} <> 'R')`,
    ))
    .all();

  // Decrypt payees before grouping — the detector groups by normalized payee,
  // so it needs plaintext (ciphertext has a random IV per row). With no DEK the
  // passthrough leaves ciphertext, which never groups, so nothing is detected.
  const detected = detectRecurringTransactions(
    txns.map((t) => ({
      ...t,
      payee: (dek ? tryDecryptField(dek, t.payee, "transactions.payee") : t.payee) ?? "",
      accountId: t.accountId ?? 0,
      categoryId: t.categoryId,
    })),
    { asOf: today },
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
    .reduce((sum, r) => sum + monthlyEquivalent(toDisplay(r.avgAmount, r.currency), r.frequency), 0);

  // GH #428 — payees the user marked "Not a subscription" leave the list (the
  // Subscriptions suggestions + calendar on web and phone read it). The
  // dashboard's monthly recurring total above still counts them: they are
  // still regular payments, just not subscriptions.
  const listed = withoutDismissed(detected, (r) => r.payee, await dismissedLookups(userId), dek);

  return NextResponse.json({
    recurring: listed.map((r) => ({
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
    monthlyRecurringTotal: round2(Math.abs(monthlyRecurring)),
    count: listed.length,
    dismissedCount: detected.length - listed.length,
  });
}
