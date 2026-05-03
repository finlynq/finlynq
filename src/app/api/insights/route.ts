import { NextRequest, NextResponse } from "next/server";
import { getMonthlySpending, getTransactions } from "@/lib/queries";
import { detectAnomalies, analyzeTrends, analyzeMerchants, spendingByDayOfWeek } from "@/lib/spending-insights";
import { getCurrentMonth } from "@/lib/currency";
import { requireAuth } from "@/lib/auth/require-auth";
import { getDEK } from "@/lib/crypto/dek-cache";
import { tryDecryptField } from "@/lib/crypto/envelope";
import { requireDevMode } from "@/lib/require-dev-mode";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const devGuard = await requireDevMode(request);
  if (devGuard) return devGuard;
  const { userId, sessionId } = auth.context;
  const dek = sessionId ? getDEK(sessionId) : null;
  const now = new Date();
  const startDate = `${now.getFullYear() - 1}-01-01`;
  const endDate = `${now.getFullYear()}-12-31`;
  const currentMonth = getCurrentMonth();

  // Stream D Phase 4 — getMonthlySpending now returns categoryNameCt; decrypt
  // before feeding the analyzers (they need plaintext labels).
  const { decryptName } = await import("@/lib/crypto/encrypted-columns");
  const monthlySpending = await getMonthlySpending(userId, startDate, endDate);
  const monthlyNorm = monthlySpending.map((r) => ({
    month: r.month,
    categoryName: decryptName(r.categoryNameCt, dek, null) ?? "",
    categoryGroup: r.categoryGroup ?? "",
    total: r.total,
  }));
  const anomalies = detectAnomalies(monthlyNorm, currentMonth);
  const trends = analyzeTrends(monthlyNorm);

  // Merchant analysis (last 6 months)
  const sixMonthsAgo = new Date(now);
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const recentTxns = await getTransactions(userId, {
    startDate: sixMonthsAgo.toISOString().split("T")[0],
    endDate: endDate,
    limit: 5000,
  });

  // Decrypt payee in memory so merchant grouping works (ciphertext has a
  // random IV per row, so SQL-side grouping on ciphertext would be wrong).
  const merchants = analyzeMerchants(
    recentTxns.map((t) => ({ payee: (dek ? tryDecryptField(dek, t.payee, "transactions.payee") : t.payee) ?? "", amount: t.amount }))
  );

  const dayOfWeek = spendingByDayOfWeek(
    recentTxns.map((t) => ({ date: t.date, amount: t.amount }))
  );

  return NextResponse.json({
    anomalies,
    trends: trends.slice(0, 15),
    topMerchants: merchants.slice(0, 20),
    spendingByDay: dayOfWeek,
  });
}
