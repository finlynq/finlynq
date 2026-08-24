// Dashboard Spotlight Engine — aggregates attention items
//
// Stream D Phase 4 (2026-05-03): plaintext name columns dropped on accounts
// / categories / goals / subscriptions. The spotlight engine reads ct only
// and decrypts via the per-call DEK passed by the caller (or null when no
// DEK is available, in which case names render as "Unknown").

import { db, schema } from "@/db";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { decryptName } from "@/lib/crypto/encrypted-columns";
import { getDisplayCurrency, getRateMap, convertWithRateMap } from "@/lib/fx-service";
import { todayISO } from "@/lib/utils/date";
import { buildTxDrillUrl } from "@/lib/transactions/drill-url";
import { formatCurrency } from "@/lib/currency";
import { unrecordedBankRowSql } from "@/lib/reconcile/unrecorded-rows";
import { getReconcileHiddenAccountIds } from "@/lib/reconcile/hidden-accounts";

const { accounts, categories, transactions, budgets, goals, subscriptions } = schema;

export type SpotlightSeverity = "critical" | "warning" | "info";

export type SpotlightItem = {
  id: string;
  type: string;
  severity: SpotlightSeverity;
  title: string;
  description: string;
  actionUrl: string;
  amount?: number;
  /**
   * Currency of `amount` AND of every figure inside `description`, so the card
   * never has to guess (it used to hardcode "CAD", rendering `C$304.47` beside
   * a `$704.47` from the same row on a USD account).
   *
   * Always the user's display currency: every builder converts before emitting.
   * FINLYNQ-123 — flow figures (budget spend, anomalies, bills) and
   * point-in-time figures (balances, goal progress) are both converted, and a
   * native `SUM(amount)` across mixed currencies is never presented under one
   * label.
   */
  currency: string;
};

const SEVERITY_ORDER: Record<SpotlightSeverity, number> = { critical: 0, warning: 1, info: 2 };

type RateCtx = { displayCurrency: string; rateMap: Map<string, number> };

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function daysFromNow(dateStr: string): number {
  const t = new Date(todayISO() + "T00:00:00").getTime();
  const d = new Date(dateStr + "T00:00:00").getTime();
  return Math.round((d - t) / 86400000);
}

// 1. Overspent budgets
//
// FINLYNQ-123 — spend is grouped BY CURRENCY and each slice converted before
// summing. It used to be one `SUM(transactions.amount)` across every currency
// the category was billed in, compared against a budget in a possibly different
// currency and then printed with a bare "$" — a meaningless number under a
// confident label. Mirrors the conversion `/api/budgets` already does.
async function getOverspentBudgets(
  userId: string,
  dek: Buffer | null,
  fx: RateCtx,
): Promise<SpotlightItem[]> {
  const month = currentMonth();
  const [y, m] = month.split("-").map(Number);
  const startDate = `${month}-01`;
  const endDate = `${month}-${new Date(y, m, 0).getDate()}`;

  const rows = await db
    .select({
      budgetId: budgets.id,
      categoryNameCt: categories.nameCt,
      budgetAmount: budgets.amount,
      budgetCurrency: budgets.currency,
      txCurrency: transactions.currency,
      spent: sql<number>`COALESCE(ABS(SUM(CASE WHEN ${transactions.date} >= ${startDate} AND ${transactions.date} <= ${endDate} THEN ${transactions.amount} ELSE 0 END)), 0)`,
    })
    .from(budgets)
    .leftJoin(categories, eq(budgets.categoryId, categories.id))
    .leftJoin(transactions, eq(transactions.categoryId, budgets.categoryId))
    .where(and(eq(budgets.month, month), eq(budgets.userId, userId)))
    .groupBy(
      budgets.id,
      categories.nameCt,
      budgets.amount,
      budgets.currency,
      transactions.currency,
    )
    .all();

  // Fold the per-currency slices back into one budget row, in display currency.
  type Agg = { nameCt: string | null; budgetAmount: number; spent: number };
  const byBudget = new Map<number, Agg>();
  for (const row of rows) {
    const agg = byBudget.get(row.budgetId) ?? {
      nameCt: row.categoryNameCt,
      budgetAmount: convertWithRateMap(
        row.budgetAmount,
        row.budgetCurrency ?? fx.displayCurrency,
        fx.rateMap,
      ),
      spent: 0,
    };
    agg.spent += Math.abs(
      convertWithRateMap(row.spent, row.txCurrency ?? fx.displayCurrency, fx.rateMap),
    );
    byBudget.set(row.budgetId, agg);
  }

  const items: SpotlightItem[] = [];
  for (const [budgetId, agg] of byBudget) {
    if (agg.budgetAmount > 0 && agg.spent > agg.budgetAmount) {
      const pctOver = Math.round(((agg.spent - agg.budgetAmount) / agg.budgetAmount) * 100);
      const categoryName = decryptName(agg.nameCt, dek, null);
      items.push({
        id: `overspent-${budgetId}`,
        type: "overspent_budget",
        severity: pctOver > 20 ? "critical" : "warning",
        title: `${categoryName ?? "Unknown"} over budget`,
        description: `Spent ${formatCurrency(agg.spent, fx.displayCurrency)} of ${formatCurrency(agg.budgetAmount, fx.displayCurrency)} budget (${pctOver}% over)`,
        actionUrl: "/budgets",
        amount: agg.spent - agg.budgetAmount,
        currency: fx.displayCurrency,
      });
    }
  }
  return items;
}

// 2. Upcoming large bills (>100 display-currency units in next 7 days)
//
// The threshold is applied to the CONVERTED amount, matching getLowBalances —
// otherwise a ¥5,000 subscription (~$33) trips a "large bill" alert while a
// £90 one (~$115) does not.
async function getUpcomingLargeBills(
  userId: string,
  dek: Buffer | null,
  fx: RateCtx,
): Promise<SpotlightItem[]> {
  const todayStr = todayISO();
  const weekAhead = new Date(new Date(todayStr + "T00:00:00").getTime() + 7 * 86400000)
    .toISOString()
    .split("T")[0];

  const subs = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.status, "active"),
        gte(subscriptions.nextDate, todayStr),
        lte(subscriptions.nextDate, weekAhead)
      )
    )
    .all();

  const items: SpotlightItem[] = [];
  for (const sub of subs) {
    const amount = Math.abs(
      convertWithRateMap(sub.amount, sub.currency ?? fx.displayCurrency, fx.rateMap),
    );
    if (amount >= 100) {
      const days = daysFromNow(sub.nextDate!);
      const subName = decryptName(sub.nameCt, dek, null) ?? "Subscription";
      items.push({
        id: `large-bill-sub-${sub.id}`,
        type: "large_bill",
        severity: "warning",
        title: `${subName} due${days <= 1 ? " tomorrow" : ` in ${days} days`}`,
        description: `${formatCurrency(amount, fx.displayCurrency)} ${sub.frequency} payment`,
        actionUrl: "/transactions",
        amount,
        currency: fx.displayCurrency,
      });
    }
  }
  return items;
}

// 3. Goal deadlines approaching (<30 days, <80% funded)
async function getGoalDeadlines(
  userId: string,
  dek: Buffer | null,
  fx: RateCtx,
): Promise<SpotlightItem[]> {
  const goalRows = await db
    .select({
      id: goals.id,
      nameCt: goals.nameCt,
      targetAmount: goals.targetAmount,
      currency: goals.currency,
      deadline: goals.deadline,
      accountId: goals.accountId,
    })
    .from(goals)
    .where(and(eq(goals.userId, userId), eq(goals.status, "active")))
    .all();

  const items: SpotlightItem[] = [];
  for (const goal of goalRows) {
    if (!goal.deadline) continue;
    const days = daysFromNow(goal.deadline);
    if (days < 0 || days > 30) continue;

    // Goal progress is a POINT-IN-TIME figure, so both legs convert at the
    // current rate (FINLYNQ-123). The balance is summed per account currency,
    // then converted, so a goal tracking a foreign-currency account no longer
    // compares a native balance against a converted target.
    let current = 0;
    if (goal.accountId) {
      const balRows = await db
        .select({
          currency: transactions.currency,
          total: sql<number>`COALESCE(SUM(${transactions.amount}), 0)`,
        })
        .from(transactions)
        .where(and(eq(transactions.accountId, goal.accountId), eq(transactions.userId, userId)))
        .groupBy(transactions.currency)
        .all();
      current = Math.abs(
        balRows.reduce(
          (sum, r) =>
            sum + convertWithRateMap(r.total, r.currency ?? fx.displayCurrency, fx.rateMap),
          0,
        ),
      );
    }

    const target = convertWithRateMap(
      goal.targetAmount,
      goal.currency ?? fx.displayCurrency,
      fx.rateMap,
    );
    const pct = target > 0 ? (current / target) * 100 : 0;
    if (pct < 80) {
      const goalName = decryptName(goal.nameCt, dek, null) ?? "Goal";
      items.push({
        id: `goal-deadline-${goal.id}`,
        type: "goal_deadline",
        severity: days <= 7 ? "critical" : "warning",
        title: `"${goalName}" deadline in ${days} days`,
        description: `${Math.round(pct)}% funded — need ${formatCurrency(target - current, fx.displayCurrency)} more`,
        actionUrl: "/goals",
        amount: target - current,
        currency: fx.displayCurrency,
      });
    }
  }
  return items;
}

// 4. Spending anomalies (>30% vs 3-month avg)
//
// Both windows group BY CURRENCY and convert each slice before comparing
// (FINLYNQ-123). Without it, a category billed in two currencies compared a
// native sum against a native average — and a shift in the currency MIX alone
// could manufacture or mask a "spike".
async function getSpendingAnomalies(
  userId: string,
  dek: Buffer | null,
  fx: RateCtx,
): Promise<SpotlightItem[]> {
  const month = currentMonth();
  const [y, m] = month.split("-").map(Number);
  const startDate = `${month}-01`;
  const endDate = `${month}-${new Date(y, m, 0).getDate()}`;

  const threeMonthsAgo = new Date(y, m - 4, 1);
  const prevStart = threeMonthsAgo.toISOString().split("T")[0];
  const prevEndMonth = new Date(y, m - 1, 0);
  const prevEnd = prevEndMonth.toISOString().split("T")[0];

  const currentSpend = await db
    .select({
      categoryId: categories.id,
      categoryNameCt: categories.nameCt,
      currency: transactions.currency,
      total: sql<number>`ABS(SUM(${transactions.amount}))`,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(
      and(
        eq(transactions.userId, userId),
        gte(transactions.date, startDate),
        lte(transactions.date, endDate),
        eq(categories.type, "E")
      )
    )
    .groupBy(categories.id, categories.nameCt, transactions.currency)
    .all();

  const prevSpend = await db
    .select({
      categoryId: categories.id,
      currency: transactions.currency,
      avgTotal: sql<number>`ABS(SUM(${transactions.amount})) / 3.0`,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(
      and(
        eq(transactions.userId, userId),
        gte(transactions.date, prevStart),
        lte(transactions.date, prevEnd),
        eq(categories.type, "E")
      )
    )
    .groupBy(categories.id, transactions.currency)
    .all();

  const convert = (amount: number, currency: string | null) =>
    convertWithRateMap(amount, currency ?? fx.displayCurrency, fx.rateMap);

  // Fold each category's per-currency slices into one display-currency figure.
  const currentMap = new Map<number | null, { nameCt: string | null; total: number }>();
  for (const r of currentSpend) {
    const agg = currentMap.get(r.categoryId) ?? { nameCt: r.categoryNameCt, total: 0 };
    agg.total += Math.abs(convert(r.total, r.currency));
    currentMap.set(r.categoryId, agg);
  }
  const prevMap = new Map<number | null, number>();
  for (const r of prevSpend) {
    prevMap.set(
      r.categoryId,
      (prevMap.get(r.categoryId) ?? 0) + Math.abs(convert(r.avgTotal, r.currency)),
    );
  }

  const items: SpotlightItem[] = [];
  for (const [categoryId, agg] of currentMap) {
    const avg = prevMap.get(categoryId) ?? 0;
    if (avg <= 0) continue;
    const pctAbove = ((agg.total - avg) / avg) * 100;
    if (pctAbove > 30) {
      const categoryName = decryptName(agg.nameCt, dek, null);
      items.push({
        id: `anomaly-${categoryId}`,
        type: "spending_anomaly",
        severity: pctAbove > 50 ? "warning" : "info",
        title: `${categoryName ?? "Unknown"} spending spike`,
        description: `${formatCurrency(agg.total, fx.displayCurrency)} this month vs ${formatCurrency(avg, fx.displayCurrency)} avg (+${Math.round(pctAbove)}%)`,
        actionUrl: "/transactions",
        amount: agg.total - avg,
        currency: fx.displayCurrency,
      });
    }
  }
  return items;
}

// 5. Uncategorized transactions
//
// Counts ONLY rows the user can actually act on. Two populations carry a NULL
// category by design and must be excluded, or the alert asks for work that is
// impossible to do and can never be cleared:
//
//   • Portfolio operations — trades are REQUIRED to keep `categoryId: null`
//     (see the investment auto-categorization invariant; only dividends and
//     portfolio income/expense get a category). A trade and its paired cash leg
//     are two rows, so one purchase used to read as "2 uncategorized".
//   • Transfer legs — plain cash transfers resolve to the canonical "Transfer"
//     category, but brokerage deposit/withdrawal legs and older imported pairs
//     do not. Any row carrying one of the three link ids is part of a pair
//     whose categorisation is decided by the pair, not by the user.
//
// Measured on pf_dev (a prod clone) across all 1,122 NULL-category rows: 265
// portfolio-linked and ~56 transfer-linked, leaving 801 genuinely uncategorised.
// For the current month on both active accounts the count was 100% excluded
// rows — the alert was pure false positive.
async function getUncategorizedTransactions(
  userId: string,
  fx: RateCtx,
): Promise<SpotlightItem[]> {
  const month = currentMonth();
  const [y, m] = month.split("-").map(Number);
  const startDate = `${month}-01`;
  const endDate = `${month}-${new Date(y, m, 0).getDate()}`;

  const result = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        gte(transactions.date, startDate),
        lte(transactions.date, endDate),
        sql`${transactions.categoryId} IS NULL`,
        sql`${transactions.portfolioHoldingId} IS NULL`,
        sql`${transactions.linkId} IS NULL`,
        sql`${transactions.tradeLinkId} IS NULL`,
        sql`${transactions.swapLinkId} IS NULL`,
      )
    )
    .get();

  const count = result?.count ?? 0;
  if (count > 0) {
    return [
      {
        id: "uncategorized",
        type: "uncategorized",
        severity: count > 10 ? "warning" : "info",
        title: `${count} uncategorized transaction${count > 1 ? "s" : ""}`,
        description: "Categorize them for better budget tracking",
        // Scope the drill-through to the month the count covers, via the
        // single-source helper (FINLYNQ-130) rather than a hand-rolled query
        // string. The transactions filter chain has no "uncategorized"
        // predicate today (`categoryId` is parsed as an int), so this lands on
        // the right period but not the exact rows — better than the bare
        // `/transactions` it replaces, which dropped the user into an
        // unfiltered list with no way to find them.
        actionUrl: buildTxDrillUrl({ startDate, endDate }),
        currency: fx.displayCurrency,
      },
    ];
  }
  return [];
}

// 6. Low account balances (<$500)
// FINLYNQ-123 — an account balance is a POINT-IN-TIME figure, so convert it to
// the user's display currency at the CURRENT rate before the (currency-agnostic)
// $500/$100 threshold check. Previously the raw native SUM(amount) was compared
// to a hardcoded ~$500: a C$600 account read as "low" against a $500 USD bar.
async function getLowBalances(userId: string, dek: Buffer | null, fx: RateCtx): Promise<SpotlightItem[]> {
  const rows = await db
    .select({
      accountId: accounts.id,
      accountNameCt: accounts.nameCt,
      accountType: accounts.type,
      currency: accounts.currency,
      balance: sql<number>`COALESCE(SUM(${transactions.amount}), 0)`,
    })
    .from(accounts)
    .leftJoin(transactions, eq(accounts.id, transactions.accountId))
    .where(and(eq(accounts.userId, userId), eq(accounts.type, "A"), eq(accounts.archived, false)))
    .groupBy(accounts.id, accounts.nameCt, accounts.type, accounts.currency)
    .all();

  const items: SpotlightItem[] = [];
  for (const row of rows) {
    const accountName = decryptName(row.accountNameCt, dek, null) ?? "";
    const group = accountName.toLowerCase();
    if (group.includes("rrsp") || group.includes("tfsa") || group.includes("invest")) continue;

    const balance = convertWithRateMap(row.balance, row.currency ?? fx.displayCurrency, fx.rateMap);
    if (balance >= 0 && balance < 500) {
      items.push({
        id: `low-balance-${row.accountId}`,
        type: "low_balance",
        severity: balance < 100 ? "critical" : "warning",
        title: `${accountName || "Account"} balance is low`,
        description: `Current balance: ${formatCurrency(balance, fx.displayCurrency)}`,
        actionUrl: "/accounts",
        amount: balance,
        currency: fx.displayCurrency,
      });
    }
  }
  return items;
}

// 7. Subscription renewals (next 7 days)
//
// The <100 cutoff is the complement of getUpcomingLargeBills' >=100, so both
// must test the CONVERTED amount or a subscription can fall in both buckets
// (or neither) depending on its native currency.
async function getUpcomingSubscriptions(
  userId: string,
  dek: Buffer | null,
  fx: RateCtx,
): Promise<SpotlightItem[]> {
  const todayStr = todayISO();
  const weekAhead = new Date(new Date(todayStr + "T00:00:00").getTime() + 7 * 86400000)
    .toISOString()
    .split("T")[0];

  const subs = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.status, "active"),
        gte(subscriptions.nextDate, todayStr),
        lte(subscriptions.nextDate, weekAhead)
      )
    )
    .all();

  return subs
    .map((s) => ({
      sub: s,
      amount: Math.abs(
        convertWithRateMap(s.amount, s.currency ?? fx.displayCurrency, fx.rateMap),
      ),
    }))
    .filter(({ amount }) => amount < 100)
    .map(({ sub: s, amount }) => {
      const days = daysFromNow(s.nextDate!);
      const subName = decryptName(s.nameCt, dek, null) ?? "Subscription";
      return {
        id: `sub-renewal-${s.id}`,
        type: "subscription_renewal",
        severity: "info" as SpotlightSeverity,
        title: `${subName} renewing${days <= 1 ? " tomorrow" : ` in ${days} days`}`,
        description: `${formatCurrency(amount, fx.displayCurrency)} ${s.frequency}`,
        actionUrl: "/transactions",
        amount,
        currency: fx.displayCurrency,
      };
    });
}

// 8. Imported bank rows that were never recorded as transactions (GH #332)
//
// The gap this closes: in `auto` mode a sync promotes rows into
// `bank_transactions` and fires the rules engine, but rows that match NO rule
// simply stay there. Nothing retried them and nothing said so, so from the
// user's side the transactions never arrived — reported as 17 rows / ~$654
// accumulating silently across two syncs, noticed only because a trip-spend
// report came up short.
//
// This is deliberately a SURFACING fix, not a behaviour change: the count
// already existed as `pendingCount` on the /import reconcile panel, but the
// user had to go look at a screen that auto mode implies they don't need. The
// card is the thing that goes and finds them.
//
// Fires for EVERY mode, not just auto: `approve` mode parks rows in the same
// place awaiting an /inbox click, and in `manual` mode rows are still in
// `staged_imports` (not yet in the bank ledger), so the count is naturally 0 —
// no mode branching is needed or wanted.
/**
 * Which /import tab lists an account's un-recorded bank-ledger rows, per its
 * pipeline mode. Mirrors `visibleTabs` + `defaultTabFor` in
 * [import/page.tsx](../app/(app)/import/page.tsx) — the page renders a
 * DIFFERENT tab set per lens and snaps an out-of-set `?tab=` back to that
 * lens's default, so naming a tab the lens doesn't have is the same as naming
 * none. `manual` is the one lens whose default (`staging`, i.e. rows not yet
 * in the bank ledger) is NOT where these rows live, so it must be named
 * explicitly. Keep in lockstep with that page.
 */
function importTabForMode(mode: string | null): string {
  if (mode === "auto") return "to-categorize";
  if (mode === "approve") return "to-approve";
  // 'manual' — and a NULL/unknown mode, which the page also treats as manual.
  return "reconcile";
}

async function getUnrecordedBankRows(
  userId: string,
  dek: Buffer | null,
  fx: RateCtx,
): Promise<SpotlightItem[]> {
  const hidden = new Set(await getReconcileHiddenAccountIds(userId));

  const rows = await db
    .select({
      accountId: schema.bankTransactions.accountId,
      accountNameCt: accounts.nameCt,
      currency: accounts.currency,
      mode: accounts.mode,
      count: sql<number>`COUNT(*)`,
      total: sql<number>`COALESCE(SUM(ABS(${schema.bankTransactions.amount})), 0)`,
    })
    .from(schema.bankTransactions)
    .innerJoin(accounts, eq(accounts.id, schema.bankTransactions.accountId))
    .where(
      and(
        eq(schema.bankTransactions.userId, userId),
        eq(accounts.archived, false),
        unrecordedBankRowSql(),
      ),
    )
    .groupBy(
      schema.bankTransactions.accountId,
      accounts.nameCt,
      accounts.currency,
      accounts.mode,
    )
    .all();

  const items: SpotlightItem[] = [];
  for (const row of rows) {
    if (row.accountId == null || hidden.has(row.accountId)) continue;
    const count = Number(row.count) || 0;
    if (count === 0) continue;

    const accountName = decryptName(row.accountNameCt, dek, null) ?? "";
    // FINLYNQ-123 — the row amounts are native to the account; convert before
    // presenting them under the display currency's symbol.
    const total = convertWithRateMap(
      Number(row.total) || 0,
      row.currency ?? fx.displayCurrency,
      fx.rateMap,
    );

    items.push({
      id: `unrecorded-bank-rows-${row.accountId}`,
      type: "unrecorded_bank_rows",
      // Money that is missing from every report is worse than a nudge: at 10+
      // rows a spend report is materially wrong, which is exactly how #332 was
      // found.
      severity: count >= 10 ? "warning" : "info",
      title: `${count} imported row${count > 1 ? "s" : ""} awaiting recording`,
      description: `${accountName || "Account"} · ${formatCurrency(total, fx.displayCurrency)} imported but not yet recorded as transactions`,
      // Deep-links to the tab that actually LISTS these rows, which depends on
      // the account's pipeline mode — /import shows a different tab set per
      // lens and silently snaps an out-of-set `?tab=` back to the lens default,
      // so a hardcoded `tab=reconcile` is discarded on every auto/approve
      // account (i.e. exactly the accounts GH #332 was reported against).
      // `window=all` is consumed by the manual-lens Reconcile tab alone, which
      // is the only one that imposes a client-side lookback (60 days) — the
      // other two already fetch full history. Without it a card reading
      // "304 rows" opened a screen rendering none of them, which is what the
      // phantom-alert report actually was. Both params matter: the card has to
      // land on the rows it just counted.
      actionUrl: `/import?account=${row.accountId}&tab=${importTabForMode(row.mode)}&window=all`,
      amount: total,
      currency: fx.displayCurrency,
    });
  }
  return items;
}

export async function getSpotlightItems(userId: string, dek: Buffer | null = null): Promise<SpotlightItem[]> {
  // FINLYNQ-123 — resolve the display currency + current-rate map ONCE and hand
  // it to every builder. Each converts its own figures before emitting, so an
  // item's `amount` and every number inside its `description` are already in
  // `displayCurrency` and the card never has to guess (it used to assume CAD).
  const displayCurrency = await getDisplayCurrency(userId);
  const rateMap = await getRateMap(displayCurrency, userId);
  const fx: RateCtx = { displayCurrency, rateMap };

  const [
    overspent,
    largeBills,
    goalDeadlines,
    anomalies,
    uncategorized,
    lowBalances,
    upcomingSubs,
    unrecordedBankRows,
  ] = await Promise.all([
    getOverspentBudgets(userId, dek, fx),
    getUpcomingLargeBills(userId, dek, fx),
    getGoalDeadlines(userId, dek, fx),
    getSpendingAnomalies(userId, dek, fx),
    getUncategorizedTransactions(userId, fx),
    getLowBalances(userId, dek, fx),
    getUpcomingSubscriptions(userId, dek, fx),
    getUnrecordedBankRows(userId, dek, fx),
  ]);

  const items: SpotlightItem[] = [
    ...overspent,
    ...largeBills,
    ...goalDeadlines,
    ...anomalies,
    ...uncategorized,
    ...lowBalances,
    ...upcomingSubs,
    ...unrecordedBankRows,
  ];

  return items.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
