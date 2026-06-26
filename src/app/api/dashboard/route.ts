import { NextRequest, NextResponse } from "next/server";
import {
  getAccountBalances,
  getIncomeVsExpenses,
  getIncomeExpenseByCategory,
  getSpendingByCategoryWithReporting,
  getNetWorthOverTime,
} from "@/lib/queries";
import { getRateMap, convertWithRateMap, getDisplayCurrency } from "@/lib/fx-service";
import { selfHealReportingAmounts, convertReportingSlice } from "@/lib/fx/reporting-amount";
import { getHoldingsValueByAccount } from "@/lib/holdings-value";
import { requireAuth } from "@/lib/auth/require-auth";
import { getDEK } from "@/lib/crypto/dek-cache";
import { logApiError } from "@/lib/validate";
import { decryptNamedRows, decryptName } from "@/lib/crypto/encrypted-columns";
import { safeName } from "@/lib/safe-name";
import { rankBreakdown, type BreakdownMember } from "@/lib/chart-breakdown";
import { withOp } from "@/lib/diagnostics/op-context";

export function GET(request: NextRequest) {
  return withOp("GET /api/dashboard", () => handleGet(request));
}

async function handleGet(request: NextRequest) {
  // Dashboard must stay accessible even when the session has no cached DEK
  // (e.g. first request after a server restart). `getDEK` returns null in
  // that case; downstream decryption falls through to plaintext/legacy rows.
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, sessionId } = auth.context;
  const dek = sessionId ? getDEK(sessionId, userId) : null;
  const params = request.nextUrl.searchParams;
  const displayCurrency = await getDisplayCurrency(userId, params.get("currency"));
  const includeArchived = params.get("includeArchived") === "1";

  // Currency rework Phase 3 — the dashboard is the post-login landing page, so
  // proactively backfill any transaction whose stored reporting_amount is
  // missing/stale (fire-and-forget, guarded, DEK-free). This warms the data
  // before the user opens Reports. The dashboard itself doesn't read
  // reporting_amount; this is purely a backfill trigger.
  void selfHealReportingAmounts(userId, displayCurrency.toUpperCase());

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
    // Per-account balance branches on `accounts.is_investment`, NOT on map
    // presence (issue #204). Investment accounts always report holdings value
    // (or 0 when the aggregator emits nothing); cash accounts report the
    // transaction sum unchanged. Mirrors the canonical pattern from goals API
    // (#151, src/app/api/goals/route.ts:244-247).
    //
    // Pre-#204 the ternary keyed on map presence — when the holdings
    // aggregator dropped every position for an investment account (orphan
    // holding_accounts row, FX outage, freshly-imported snapshot before any
    // transaction), the dashboard silently fell back to SUM(transactions.amount),
    // which for an investment account is just the cash legs of buys/sells/
    // dividends — meaningless as a "balance." Surfacing 0 instead is visible
    // and diagnosable.
    //
    // For investment accounts the cash sleeve is already inside holdings.value
    // via the currency-as-holding pattern, so we never sum (CLAUDE.md
    // "Account balance for accounts with holdings" gotcha).
    //
    // cashFlowBasis is the transaction sum exposed separately so the account
    // detail page can display "Cash flow" alongside Market value.
    const holdingsByAccount = await getHoldingsValueByAccount(userId, dek);
    const convertedBalances = balances.map((b: any) => {
      const holdings = holdingsByAccount.get(b.accountId);
      const cashFlowBasis = b.balance;
      const isInvestment = Boolean(b.isInvestment);
      const totalBalance = isInvestment
        ? (holdings?.value ?? 0)
        : cashFlowBasis;
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

    // Currency rework Phase 3 — income/expense + spending are flow figures, so
    // convert each (currency, reporting_currency) slice to the display currency
    // (stored historical reporting_amount when it matches, else an on-the-fly
    // current-rate fallback) and re-aggregate to the shapes the client expects.
    // FINLYNQ-123 single-sourced this convention as `convertReportingSlice`.
    const convertGroup = (row: {
      currency: string | null;
      reportingCurrency: string | null;
      totalAmount: number | null;
      totalReporting: number | null;
    }): number => convertReportingSlice(row, displayCurrency, rateMap);

    const iveSlices = await getIncomeVsExpenses(userId, startDate, endDate);
    const iveMap = new Map<string, { month: string; type: string | null; total: number }>();
    for (const r of iveSlices) {
      const key = `${r.month}|${r.type}`;
      const cur = iveMap.get(key) ?? { month: r.month, type: r.type, total: 0 };
      cur.total += convertGroup(r);
      iveMap.set(key, cur);
    }
    const incomeVsExpenses = Array.from(iveMap.values())
      .map((r) => ({ ...r, total: Math.round(r.total * 100) / 100 }))
      .sort((a, b) => a.month.localeCompare(b.month));

    // FINLYNQ-128 — per-(month, type) category breakdown for the Income vs
    // Expenses tooltip. Convert each currency/reporting slice to the display
    // currency (same convertGroup path), accumulate per category, then rank into
    // a top-10 + "Other" residual via the shared rankBreakdown helper. Expenses
    // are normalized to magnitude (abs) so the breakdown ties to the chart's
    // positive expense area.
    const ieCatSlices = await getIncomeExpenseByCategory(userId, startDate, endDate);
    type CatAccum = { categoryId: number | null; nameCt: string | null; total: number };
    const ieCatMap = new Map<string, CatAccum>(); // key = `${month}|${type}|${categoryId}`
    for (const r of ieCatSlices) {
      const key = `${r.month}|${r.type}|${r.categoryId ?? "null"}`;
      const cur = ieCatMap.get(key) ?? { categoryId: r.categoryId, nameCt: r.categoryNameCt, total: 0 };
      cur.total += convertGroup(r);
      ieCatMap.set(key, cur);
    }
    // Re-group into month → { income: members[], expenses: members[] }.
    const ieMembers = new Map<string, { income: BreakdownMember[]; expenses: BreakdownMember[] }>();
    for (const [key, acc] of ieCatMap) {
      const [month, type] = key.split("|");
      const slot = ieMembers.get(month) ?? { income: [], expenses: [] };
      const name = safeName(
        decryptName(acc.nameCt, dek, null),
        "Category",
        acc.categoryId ?? 0,
      );
      const member: BreakdownMember = {
        id: acc.categoryId,
        name: acc.categoryId == null ? "Uncategorized" : name,
        value: type === "E" ? Math.abs(acc.total) : acc.total,
      };
      if (type === "I") slot.income.push(member);
      else slot.expenses.push(member);
      ieMembers.set(month, slot);
    }
    const rankRows = (members: BreakdownMember[]) => {
      const { rows, other } = rankBreakdown(members, { maxMembers: 10 });
      const list = (other ? [...rows, other] : rows).map((m) => ({ name: m.name, value: m.value }));
      return list;
    };
    const incomeExpenseBreakdown = Object.fromEntries(
      Array.from(ieMembers.entries()).map(([month, slot]) => [
        month,
        { income: rankRows(slot.income), expenses: rankRows(slot.expenses) },
      ]),
    );

    const spendSlices = await getSpendingByCategoryWithReporting(userId, startDate, endDate);
    const spendMap = new Map<string | number, {
      categoryId: number | null;
      categoryNameCt: string | null;
      categoryGroup: string | null;
      categoryType: string | null;
      total: number;
    }>();
    for (const r of spendSlices) {
      const key = r.categoryId ?? `null:${r.categoryGroup}`;
      const cur = spendMap.get(key) ?? {
        categoryId: r.categoryId,
        categoryNameCt: r.categoryNameCt,
        categoryGroup: r.categoryGroup,
        categoryType: r.categoryType,
        total: 0,
      };
      cur.total += convertGroup(r);
      spendMap.set(key, cur);
    }
    const spendingByCategory = Array.from(spendMap.values())
      .map((r) => ({ ...r, total: Math.round(r.total * 100) / 100 }))
      .sort((a, b) => a.total - b.total);

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
      incomeExpenseBreakdown,
      spendingByCategory,
      netWorthOverTime,
    });
  } catch (error: unknown) {
    await logApiError("GET", "/api/dashboard", error, userId);
    const message = error instanceof Error ? error.message : "Failed to load dashboard data";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
