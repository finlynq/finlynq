import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { sql, eq, and, gte, lte } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { getDEK } from "@/lib/crypto/dek-cache";
import { decryptName } from "@/lib/crypto/encrypted-columns";
import { getRateMap, convertWithRateMap, getDisplayCurrency } from "@/lib/fx-service";
import {
  computeAllAccountsUnrealizedPnL,
  summarizeUnrealizedPnL,
} from "@/lib/unrealized-pnl";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId, sessionId } = auth.context;
  const dek = sessionId ? getDEK(sessionId) : null;
  const params = request.nextUrl.searchParams;
  const type = params.get("type") ?? "income-statement";
  const startDate = params.get("startDate") ?? `${new Date().getFullYear()}-01-01`;
  const endDate = params.get("endDate") ?? new Date().toISOString().split("T")[0];
  const isBusiness = params.get("business") === "true";
  const displayCurrency = await getDisplayCurrency(userId, params.get("currency"));

  const rateMap = await getRateMap(displayCurrency, userId);

  if (type === "income-statement") {
    const conditions = [
      eq(schema.transactions.userId, userId),
      gte(schema.transactions.date, startDate),
      lte(schema.transactions.date, endDate),
    ];
    if (isBusiness) conditions.push(eq(schema.transactions.isBusiness, 1));

    // Stream D Phase 4 — plaintext name dropped. Group on stable id +
    // category metadata; decrypt name_ct in-memory after aggregation.
    const rows = await db
      .select({
        categoryId: schema.categories.id,
        categoryType: schema.categories.type,
        categoryGroup: schema.categories.group,
        categoryNameCt: schema.categories.nameCt,
        currency: schema.transactions.currency,
        total: sql<number>`SUM(${schema.transactions.amount})`,
        count: sql<number>`COUNT(*)`,
      })
      .from(schema.transactions)
      .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
      .where(and(...conditions))
      .groupBy(schema.categories.id, schema.categories.type, schema.categories.group, schema.categories.nameCt, schema.transactions.currency)
      .orderBy(schema.categories.type, schema.categories.group)
      .all();

    // Aggregate across currencies per category — keyed on categoryId so
    // rows with NULL plaintext (Phase-3 cutover) don't collide.
    const categoryTotals = new Map<string | number, { categoryType: string; categoryGroup: string; categoryName: string; total: number; count: number }>();
    for (const row of rows) {
      const catType = row.categoryType ?? "";
      const catGroup = row.categoryGroup ?? "";
      const catName = decryptName(row.categoryNameCt, dek, null) ?? "";
      const key = row.categoryId ?? `null:${catType}:${catGroup}:${catName}`;
      const converted = convertWithRateMap(row.total, row.currency, rateMap);
      const existing = categoryTotals.get(key);
      if (existing) {
        existing.total += converted;
        existing.count += row.count;
      } else {
        categoryTotals.set(key, {
          categoryType: catType,
          categoryGroup: catGroup,
          categoryName: catName,
          total: converted,
          count: row.count,
        });
      }
    }

    const aggregated = Array.from(categoryTotals.values());
    const income = aggregated.filter((r) => r.categoryType === "I");
    const expenses = aggregated.filter((r) => r.categoryType === "E");
    const totalIncome = income.reduce((s, r) => s + r.total, 0);
    const totalExpenses = expenses.reduce((s, r) => s + Math.abs(r.total), 0);

    // Unrealized P&L for the same period — decomposed into valuation
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
    const round2 = (n: number) => Math.round(n * 100) / 100;

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
            // costBasis + marketValue come from the periodEnd snapshot —
            // useful context for the drilldown.
            costBasis: round2(a.end.costBasis),
            marketValue: round2(a.end.marketValue),
            // Period delta — what moved during the period.
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
    // Stream D Phase 4 — plaintext name dropped.
    const balances = await db
      .select({
        accountId: schema.accounts.id,
        accountType: schema.accounts.type,
        accountGroup: schema.accounts.group,
        accountNameCt: schema.accounts.nameCt,
        currency: schema.accounts.currency,
        balance: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)`,
      })
      .from(schema.accounts)
      .leftJoin(schema.transactions, eq(schema.accounts.id, schema.transactions.accountId))
      .where(eq(schema.accounts.userId, userId))
      .groupBy(schema.accounts.id, schema.accounts.type, schema.accounts.group, schema.accounts.nameCt, schema.accounts.currency)
      .orderBy(schema.accounts.type, schema.accounts.group)
      .all();

    const converted = balances.map((b) => {
      const { accountNameCt: _ct, ...rest } = b;
      void _ct;
      return {
        ...rest,
        accountName: decryptName(b.accountNameCt, dek, null) ?? "",
        convertedBalance: convertWithRateMap(b.balance, b.currency, rateMap),
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
    // Stream D Phase 4 — plaintext name dropped.
    const rows = await db
      .select({
        categoryId: schema.categories.id,
        categoryGroup: schema.categories.group,
        categoryNameCt: schema.categories.nameCt,
        currency: schema.transactions.currency,
        total: sql<number>`SUM(${schema.transactions.amount})`,
      })
      .from(schema.transactions)
      .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
      .where(
        and(
          eq(schema.transactions.userId, userId),
          gte(schema.transactions.date, startDate),
          lte(schema.transactions.date, endDate),
          sql`${schema.categories.type} IN ('I', 'E')`
        )
      )
      .groupBy(schema.categories.id, schema.categories.group, schema.categories.nameCt, schema.transactions.currency)
      .all();

    // Aggregate across currencies per category — keyed on categoryId.
    const categoryTotals = new Map<string | number, { group: string; category: string; total: number; isIncome: boolean }>();
    for (const r of rows) {
      const group = r.categoryGroup ?? "";
      const category = decryptName(r.categoryNameCt, dek, null) ?? "";
      const key = r.categoryId ?? `null:${group}:${category}`;
      const converted = convertWithRateMap(r.total, r.currency, rateMap);
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
