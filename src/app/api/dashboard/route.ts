import { NextRequest, NextResponse } from "next/server";
import {
  getAccountBalances,
  getIncomeVsExpenses,
  getSpendingByCategory,
  getNetWorthOverTime,
} from "@/lib/queries";
import { getRateMap, convertWithRateMap, getDisplayCurrency } from "@/lib/fx-service";
import { getHoldingsValueByAccount } from "@/lib/holdings-value";
import { requireAuth } from "@/lib/auth/require-auth";
import { getDEK } from "@/lib/crypto/dek-cache";
import { logApiError } from "@/lib/validate";
import { decryptNamedRows } from "@/lib/crypto/encrypted-columns";

export async function GET(request: NextRequest) {
  // Dashboard must stay accessible even when the session has no cached DEK
  // (e.g. first request after a server restart). `getDEK` returns null in
  // that case; downstream decryption falls through to plaintext/legacy rows.
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, sessionId } = auth.context;
  const dek = sessionId ? getDEK(sessionId) : null;
  const params = request.nextUrl.searchParams;
  const displayCurrency = await getDisplayCurrency(userId, params.get("currency"));
  const includeArchived = params.get("includeArchived") === "1";

  try {
    const now = new Date();
    const startDate =
      params.get("startDate") ??
      `${now.getFullYear() - 1}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const endDate =
      params.get("endDate") ??
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-31`;

    const rateMap = await getRateMap(displayCurrency, userId);

    const rawBalances = await getAccountBalances(userId, { includeArchived });
    // Stream D: decrypt accountName + alias before display / currency conversion.
    const balances = decryptNamedRows(rawBalances, dek, {
      accountNameCt: "accountName",
      aliasCt: "alias",
    });
    // For investment accounts (any account with holdings), balance = market
    // value of holdings (which already includes any cash sleeve via the
    // currency-as-holding pattern). Transactions still drive cash-flow /
    // income reports but no longer contribute to balance — this fixes the
    // double-count where a payroll deposit was added to balance AND the
    // ETF it was used to buy was also added.
    //
    // For pure-cash accounts (no holdings), balance = SUM(transactions.amount)
    // unchanged. cashFlowBasis is the transaction sum exposed separately so
    // the account detail page can display "Cash flow" alongside Market value.
    const holdingsByAccount = await getHoldingsValueByAccount(userId, dek);
    const convertedBalances = balances.map((b: any) => {
      const holdings = holdingsByAccount.get(b.accountId);
      const cashFlowBasis = b.balance;
      const totalBalance = holdings ? holdings.value : cashFlowBasis;
      return {
        ...b,
        balance: totalBalance,
        cashFlowBasis,
        holdingsValue: holdings?.value ?? 0,
        holdingsCostBasis: holdings?.costBasis ?? 0,
        convertedBalance: convertWithRateMap(totalBalance, b.currency, rateMap),
        displayCurrency,
      };
    });

    const incomeVsExpenses = await getIncomeVsExpenses(userId, startDate, endDate);
    const spendingByCategory = await getSpendingByCategory(userId, startDate, endDate);
    const netWorthRaw = await getNetWorthOverTime(userId);

    // Consolidate net worth across currencies into display currency
    const netWorthByMonth = new Map<string, number>();
    for (const row of netWorthRaw) {
      const converted = convertWithRateMap(row.cumulative, row.currency ?? displayCurrency, rateMap);
      netWorthByMonth.set(row.month, (netWorthByMonth.get(row.month) ?? 0) + converted);
    }
    const netWorthOverTime = Array.from(netWorthByMonth.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, cumulative]) => ({ month, cumulative: Math.round(cumulative * 100) / 100, currency: displayCurrency }));

    return NextResponse.json({
      displayCurrency,
      balances: convertedBalances,
      incomeVsExpenses,
      spendingByCategory,
      netWorthOverTime,
    });
  } catch (error: unknown) {
    await logApiError("GET", "/api/dashboard", error, userId);
    const message = error instanceof Error ? error.message : "Failed to load dashboard data";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
