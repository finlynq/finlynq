import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { sql, eq, and, gte, lte, inArray } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { decryptName } from "@/lib/crypto/encrypted-columns";
import { getRateMap, convertWithRateMap, getDisplayCurrency } from "@/lib/fx-service";
import { selfHealReportingAmounts } from "@/lib/fx/reporting-amount";
import { todayISO } from "@/lib/utils/date";
import { parseAccountIdsParam, ACCOUNT_IDS_PARAM } from "@/lib/reports/account-filter";
import { round2 } from "@/lib/utils/number";
import {
  computeAllAccountsUnrealizedPnL,
  summarizeUnrealizedPnL,
} from "@/lib/unrealized-pnl";
import { getAccountBalances } from "@/lib/queries";
import { getHoldingsValueByAccount } from "@/lib/holdings-value";
import { applyInvestmentMarketOverlay } from "@/lib/accounts/investment-balance-overlay";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId, dek } = auth.context;
  const params = request.nextUrl.searchParams;
  const type = params.get("type") ?? "income-statement";
  const startDate = params.get("startDate") ?? `${new Date().getFullYear()}-01-01`;
  const endDate = params.get("endDate") ?? todayISO();
  const isBusiness = params.get("business") === "true";
  const displayCurrency = await getDisplayCurrency(userId, params.get("currency"));
  // Reports-page account scoping. `null` = every account (see account-filter.ts).
  const accountIds = parseAccountIdsParam(params.get(ACCOUNT_IDS_PARAM));

  const rateMap = await getRateMap(displayCurrency, userId);

  // Currency rework Phase 3 — flow reports (income-statement income/expense +
  // tax-summary) prefer the STORED per-row historical reporting_amount, falling
  // back to on-the-fly current-rate conversion for rows not yet (re)computed
  // into the current display currency. Balance-sheet intentionally stays on the
  // current-rate path below (a balance sheet is a point-in-time current value).
  const displayUpper = displayCurrency.toUpperCase();
  void selfHealReportingAmounts(userId, displayUpper);
  const convertGroup = (row: {
    currency: string | null;
    reportingCurrency: string | null;
    totalAmount: number | null;
    totalReporting: number | null;
  }): number => {
    if (
      row.reportingCurrency &&
      row.reportingCurrency.toUpperCase() === displayUpper &&
      row.totalReporting != null
    ) {
      return row.totalReporting;
    }
    return convertWithRateMap(row.totalAmount ?? 0, row.currency ?? displayUpper, rateMap);
  };

  if (type === "income-statement") {
    const conditions = [
      eq(schema.transactions.userId, userId),
      gte(schema.transactions.date, startDate),
      lte(schema.transactions.date, endDate),
    ];
    if (isBusiness) conditions.push(eq(schema.transactions.isBusiness, 1));
    if (accountIds) conditions.push(inArray(schema.transactions.accountId, accountIds));

    // Stream D Phase 4 â€” plaintext name dropped. Group on stable id +
    // category metadata; decrypt name_ct in-memory after aggregation.
    const rows = await db
      .select({
        categoryId: schema.categories.id,
        categoryType: schema.categories.type,
        categoryGroup: schema.categories.group,
        categoryNameCt: schema.categories.nameCt,
        currency: schema.transactions.currency,
        reportingCurrency: schema.transactions.reportingCurrency,
        total: sql<number>`SUM(${schema.transactions.amount})`,
        totalReporting: sql<number | null>`SUM(${schema.transactions.reportingAmount})`,
        count: sql<number>`COUNT(*)`,
      })
      .from(schema.transactions)
      .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
      .where(and(...conditions))
      .groupBy(schema.categories.id, schema.categories.type, schema.categories.group, schema.categories.nameCt, schema.transactions.currency, schema.transactions.reportingCurrency)
      .orderBy(schema.categories.type, schema.categories.group)
      .all();

    // Aggregate across currencies per category â€” keyed on categoryId so
    // rows with NULL plaintext (Phase-3 cutover) don't collide.
    const categoryTotals = new Map<string | number, { categoryType: string; categoryGroup: string; categoryName: string; total: number; count: number }>();
    for (const row of rows) {
      const catType = row.categoryType ?? "";
      const catGroup = row.categoryGroup ?? "";
      const catName = decryptName(row.categoryNameCt, dek, null) ?? "";
      const key = row.categoryId ?? `null:${catType}:${catGroup}:${catName}`;
      const converted = convertGroup({
        currency: row.currency,
        reportingCurrency: row.reportingCurrency,
        totalAmount: row.total,
        totalReporting: row.totalReporting,
      });
      const existing = categoryTotals.get(key);
      if (existing) {
        existing.total += converted;
        existing.count += Number(row.count);
      } else {
        categoryTotals.set(key, {
          categoryType: catType,
          categoryGroup: catGroup,
          categoryName: catName,
          total: converted,
          count: Number(row.count),
        });
      }
    }

    const aggregated = Array.from(categoryTotals.values());
    const income = aggregated.filter((r) => r.categoryType === "I");
    const expenses = aggregated.filter((r) => r.categoryType === "E");
    const totalIncome = income.reduce((s, r) => s + r.total, 0);
    const totalExpenses = expenses.reduce((s, r) => s + Math.abs(r.total), 0);

    // Unrealized P&L for the same period â€” decomposed into valuation
    // (asset price moves) and FX (account currency vs display currency).
    // periodStart maps to the income-statement startDate; periodEnd to
    // endDate. Computed on the fly per the architecture decision.
    const unrealized = await computeAllAccountsUnrealizedPnL(userId, {
      periodStart: startDate,
      periodEnd: endDate,
      displayCurrency,
      dek,
    });
    const unrealizedTotals = summarizeUnrealizedPnL(unrealized);

    return NextResponse.json({
      type: "income-statement",
      displayCurrency,
      period: { startDate, endDate },
      income: income.map((r) => ({ ...r, total: round2(r.total) })),
      expenses: expenses.map((r) => ({ ...r, total: round2(Math.abs(r.total)) })),
      totalIncome: round2(totalIncome),
      totalExpenses: round2(totalExpenses),
      netSavings: round2(totalIncome - totalExpenses),
      savingsRate: totalIncome > 0 ? Math.round(((totalIncome - totalExpenses) / totalIncome) * 10000) / 100 : 0,
      unrealized: {
        totals: {
          costBasis: round2(unrealizedTotals.costBasis),
          marketValue: round2(unrealizedTotals.marketValue),
          valuationGL: round2(unrealizedTotals.valuationGL),
          fxGL: round2(unrealizedTotals.fxGL),
          totalGL: round2(unrealizedTotals.totalGL),
        },
        accounts: unrealized
          .filter((a) => a.hasHoldings || Math.abs(a.fxGL) > 0.005 || Math.abs(a.valuationGL) > 0.005)
          .map((a) => ({
            accountId: a.accountId,
            accountName: a.accountName,
            accountCurrency: a.accountCurrency,
            // costBasis + marketValue come from the periodEnd snapshot â€”
            // useful context for the drilldown.
            costBasis: round2(a.end.costBasis),
            marketValue: round2(a.end.marketValue),
            // Period delta â€” what moved during the period.
            valuationGL: round2(a.valuationGL),
            fxGL: round2(a.fxGL),
            totalGL: round2(a.totalGL),
            // Snapshots so the UI can show start/end if it wants:
            startMarketValue: round2(a.start.marketValue),
            endMarketValue: round2(a.end.marketValue),
            hasHoldings: a.hasHoldings,
            costBasisMissing: a.costBasisMissing,
          })),
      },
    });
  }

  if (type === "balance-sheet") {
    // Stream D Phase 4 â€” plaintext name dropped.
    //
    // Account balances follow the load-bearing invariant "account with holdings
    // = holdings.value": investment accounts are marked to MARKET via the SAME
    // overlay the MCP balance tools + the reconcile summary use
    // (applyInvestmentMarketOverlay, FINLYNQ-151/196), NEVER a naive
    // SUM(transactions.amount) (which for an investment account is net
    // contributions, not market value). This is a web-session route
    // (requireAuth, DEK present) so the overlay can price holdings; a DEK-null
    // caller degrades to the ledger balance per the overlay's own guard. Cash
    // accounts keep their ledger balance. includeArchived preserves the prior
    // account set (the old bespoke query had no archived filter).
    const ledgerBalances = await getAccountBalances(userId, { includeArchived: true });
    const overlay = await applyInvestmentMarketOverlay(
      ledgerBalances.map((b) => ({
        id: b.accountId,
        currency: b.currency,
        isInvestment: b.isInvestment === true,
        ledgerBalance: Number(b.balance),
      })),
      dek,
      () => getHoldingsValueByAccount(userId, dek),
    );
    const balanceByAccount = new Map(overlay.rows.map((r) => [r.id, r.balance]));

    // Account scoping applies here too: a balance sheet restricted to one
    // account is a meaningful view, and leaving it unfiltered while the tiles
    // above it ARE filtered is the cross-endpoint disagreement this param
    // exists to avoid. Filtered BEFORE the totals so assets/liabilities/net
    // worth describe the same set the rows do.
    const scopedBalances = accountIds
      ? ledgerBalances.filter((b) => accountIds.includes(b.accountId))
      : ledgerBalances;

    const converted = scopedBalances.map((b) => {
      const balance = balanceByAccount.get(b.accountId) ?? Number(b.balance);
      return {
        accountId: b.accountId,
        accountType: b.accountType,
        accountGroup: b.accountGroup,
        currency: b.currency,
        balance,
        accountName: decryptName(b.accountNameCt, dek, null) ?? "",
        convertedBalance: convertWithRateMap(balance, b.currency, rateMap),
        displayCurrency,
      };
    });

    const assets = converted.filter((b) => b.accountType === "A");
    const liabilities = converted.filter((b) => b.accountType === "L");
    const totalAssets = assets.reduce((s, b) => s + b.convertedBalance, 0);
    const totalLiabilities = liabilities.reduce((s, b) => s + Math.abs(b.convertedBalance), 0);

    return NextResponse.json({
      type: "balance-sheet",
      displayCurrency,
      date: endDate,
      assets: assets.map((b) => ({
        ...b,
        balance: Math.round(b.balance * 100) / 100,
        convertedBalance: Math.round(b.convertedBalance * 100) / 100,
      })),
      liabilities: liabilities.map((b) => ({
        ...b,
        balance: Math.round(Math.abs(b.balance) * 100) / 100,
        convertedBalance: Math.round(Math.abs(b.convertedBalance) * 100) / 100,
      })),
      totalAssets: Math.round(totalAssets * 100) / 100,
      totalLiabilities: Math.round(totalLiabilities * 100) / 100,
      netWorth: Math.round((totalAssets - totalLiabilities) * 100) / 100,
    });
  }

  if (type === "tax-summary") {
    // Stream D Phase 4 â€” plaintext name dropped.
    const rows = await db
      .select({
        categoryId: schema.categories.id,
        categoryGroup: schema.categories.group,
        categoryNameCt: schema.categories.nameCt,
        currency: schema.transactions.currency,
        reportingCurrency: schema.transactions.reportingCurrency,
        total: sql<number>`SUM(${schema.transactions.amount})`,
        totalReporting: sql<number | null>`SUM(${schema.transactions.reportingAmount})`,
      })
      .from(schema.transactions)
      .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
      .where(
        and(
          eq(schema.transactions.userId, userId),
          gte(schema.transactions.date, startDate),
          lte(schema.transactions.date, endDate),
          sql`${schema.categories.type} IN ('I', 'E')`,
          ...(accountIds ? [inArray(schema.transactions.accountId, accountIds)] : []),
        )
      )
      .groupBy(schema.categories.id, schema.categories.group, schema.categories.nameCt, schema.transactions.currency, schema.transactions.reportingCurrency)
      .all();

    // Aggregate across currencies per category â€” keyed on categoryId.
    const categoryTotals = new Map<string | number, { group: string; category: string; total: number; isIncome: boolean }>();
    for (const r of rows) {
      const group = r.categoryGroup ?? "";
      const category = decryptName(r.categoryNameCt, dek, null) ?? "";
      const key = r.categoryId ?? `null:${group}:${category}`;
      const converted = convertGroup({
        currency: r.currency,
        reportingCurrency: r.reportingCurrency,
        totalAmount: r.total,
        totalReporting: r.totalReporting,
      });
      const existing = categoryTotals.get(key);
      if (existing) {
        existing.total += converted;
      } else {
        categoryTotals.set(key, {
          group,
          category,
          total: converted,
          isIncome: r.total > 0,
        });
      }
    }

    return NextResponse.json({
      type: "tax-summary",
      displayCurrency,
      period: { startDate, endDate },
      items: Array.from(categoryTotals.values()).map((r) => ({
        ...r,
        total: Math.round(Math.abs(r.total) * 100) / 100,
      })),
    });
  }

  return NextResponse.json({ error: "Invalid report type" }, { status: 400 });
}
