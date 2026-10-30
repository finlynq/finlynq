// Built-in AI Chat Engine — keyword-based natural language query parser
// No external AI API required. Queries the local SQLite database directly.

import { db, schema } from "@/db";
import { eq, and, gte, lte, desc, sql, asc, inArray } from "drizzle-orm";
import { CASH_GROUP_NAMES } from "@/lib/accounts/groups";
import { formatCurrency, getCurrentMonth, getMonthLabel } from "@/lib/currency";
import { getDisplayCurrency, getRateMap, convertWithRateMap } from "@/lib/fx-service";
import { convertReportingSlice } from "@/lib/fx/reporting-amount";
import { getAccountBalances, getSpendingByCategoryWithReporting } from "@/lib/queries";
import { computeGoalProgress } from "@/lib/goals-progress";
import { getHoldingsValueByAccount, verifyHoldingDecryptHealth } from "@/lib/holdings-value";
import { applyInvestmentMarketOverlay } from "@/lib/accounts/investment-balance-overlay";
import { decryptField } from "@/lib/crypto/envelope";
import { decryptName, nameLookup } from "@/lib/crypto/encrypted-columns";
import { todayISO } from "@/lib/utils/date";

export type ChatResponse = {
  text: string;
  data?: unknown;
  chartType?: "bar" | "pie" | "line" | "table";
  chartData?: Record<string, unknown>[];
};

/**
 * Safe-decrypt a payee or note for display. Returns an empty string if the
 * value is unreadable (e.g. encrypted with a different user's DEK). Never
 * throws.
 */
function safeDecrypt(dek: Buffer | null | undefined, v: string | null | undefined): string {
  if (v == null || v === "") return "";
  if (!dek) return v;
  try {
    return decryptField(dek, v) ?? "";
  } catch {
    return "";
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function startOfMonth(offset = 0): string {
  const d = new Date();
  d.setMonth(d.getMonth() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function endOfMonth(offset = 0): string {
  const d = new Date();
  d.setMonth(d.getMonth() + 1 + offset, 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function monthLabel(offset: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() + offset);
  return d.toLocaleDateString("en-CA", { year: "numeric", month: "long" });
}

function parseDateRange(msg: string): { start: string; end: string; label: string } {
  const lower = msg.toLowerCase();
  if (lower.includes("last month") || lower.includes("previous month")) {
    return { start: startOfMonth(-1), end: endOfMonth(-1), label: monthLabel(-1) };
  }
  if (lower.includes("this year") || lower.includes("year to date") || lower.includes("ytd")) {
    const y = new Date().getFullYear();
    return { start: `${y}-01-01`, end: todayISO(), label: `${y} YTD` };
  }
  if (lower.includes("last year")) {
    const y = new Date().getFullYear() - 1;
    return { start: `${y}-01-01`, end: `${y}-12-31`, label: `${y}` };
  }
  if (lower.includes("last 3 months") || lower.includes("past 3 months")) {
    return { start: startOfMonth(-3), end: endOfMonth(0), label: "last 3 months" };
  }
  if (lower.includes("last 6 months") || lower.includes("past 6 months")) {
    return { start: startOfMonth(-6), end: endOfMonth(0), label: "last 6 months" };
  }
  // Default: this month
  return { start: startOfMonth(0), end: endOfMonth(0), label: monthLabel(0) };
}

async function findCategoryName(msg: string, userId: string, dek: Buffer | null): Promise<string | null> {
  // Stream D Phase 4 — decrypt name_ct on the fly. Returns null when no DEK
  // (chat features degrade to "I couldn't find that").
  const cats = await db
    .select({ nameCt: schema.categories.nameCt })
    .from(schema.categories)
    .where(eq(schema.categories.userId, userId))
    .all();
  const decrypted = cats
    .map((c) => decryptName(c.nameCt, dek, null))
    .filter((n): n is string => Boolean(n));
  const lower = msg.toLowerCase();
  const sorted = decrypted.sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    if (lower.includes(name.toLowerCase())) return name;
  }
  return null;
}

async function findAccountName(msg: string, userId: string, dek: Buffer | null): Promise<string | null> {
  const accs = await db
    .select({ nameCt: schema.accounts.nameCt })
    .from(schema.accounts)
    .where(eq(schema.accounts.userId, userId))
    .all();
  const decrypted = accs
    .map((a) => decryptName(a.nameCt, dek, null))
    .filter((n): n is string => Boolean(n));
  const lower = msg.toLowerCase();
  const sorted = decrypted.sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    if (lower.includes(name.toLowerCase())) return name;
  }
  return null;
}

// ─── Intent matchers ────────────────────────────────────────────────

type IntentCtx = { userId: string; dek: Buffer | null };
type IntentHandler = (msg: string, ctx: IntentCtx) => Promise<ChatResponse | null>;

// ─── Money in the display currency ──────────────────────────────────
// FINLYNQ-183: ONE user-facing currency, resolved per user, never a literal.
// FINLYNQ-123: a BALANCE (point in time) converts at the current rate; a FLOW
// (income, spending) converts slice by slice through the stored historical
// reporting amount. Never a raw SUM(amount) across currencies.

type Money = { displayCurrency: string; rateMap: Map<string, number> };

async function moneyContext(userId: string): Promise<Money> {
  const displayCurrency = await getDisplayCurrency(userId);
  return { displayCurrency, rateMap: await getRateMap(displayCurrency, userId) };
}

type AccountBalance = {
  accountId: number;
  name: string;
  accountType: string;
  group: string | null;
  currency: string;
  /** In the account's own currency. */
  native: number;
  /** In the display currency, at the current rate. */
  display: number;
};

/**
 * Every account's balance, native and in the display currency. Reuses the
 * canonical balance query, and values investment accounts at MARKET through
 * the ONE shared overlay every net-worth surface uses (FINLYNQ-151): an
 * investment account's SUM(transactions.amount) is only the cash legs of its
 * trades, which net to ~0. The overlay also owns the DEK gate and the
 * FINLYNQ-281 stale-DEK probe, so a bad key degrades to ledger instead of
 * pricing undecryptable symbols at qty×1. Archived accounts are included:
 * archiving hides an account from pickers, it does not remove its money.
 */
async function accountBalances(ctx: IntentCtx, money: Money): Promise<AccountBalance[]> {
  const balances = await getAccountBalances(ctx.userId, { includeArchived: true });
  const marked = await applyInvestmentMarketOverlay(
    balances.map((b) => ({
      id: b.accountId,
      currency: b.currency,
      isInvestment: b.isInvestment === true,
      ledgerBalance: Number(b.balance),
    })),
    ctx.dek,
    () => getHoldingsValueByAccount(ctx.userId, ctx.dek),
    () => verifyHoldingDecryptHealth(ctx.userId, ctx.dek),
  );
  return balances.map((b, i) => {
    const native = marked.rows[i]?.balance ?? Number(b.balance);
    return {
      accountId: b.accountId,
      name: decryptName(b.accountNameCt, ctx.dek, null) ?? "Account",
      accountType: b.accountType,
      group: b.accountGroup ?? null,
      currency: b.currency,
      native,
      display: convertWithRateMap(native, b.currency, money.rateMap),
    };
  });
}

/** Assets, liabilities (negative) and net worth, in the display currency. */
function netWorthOf(rows: AccountBalance[]): { assets: number; liabilities: number; netWorth: number } {
  let assets = 0;
  let liabilities = 0;
  for (const r of rows) {
    if (r.accountType === "A") assets += r.display;
    else liabilities += r.display;
  }
  return { assets, liabilities, netWorth: assets + liabilities };
}

/** Income and spending between two dates, in the display currency. */
async function flowTotals(
  userId: string,
  start: string,
  end: string,
  money: Money,
): Promise<{ income: number; expenses: number }> {
  const slices = await db
    .select({
      type: schema.categories.type,
      currency: schema.transactions.currency,
      reportingCurrency: schema.transactions.reportingCurrency,
      totalAmount: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)`,
      totalReporting: sql<number | null>`SUM(${schema.transactions.reportingAmount})`,
    })
    .from(schema.transactions)
    .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
    .where(
      and(
        eq(schema.transactions.userId, userId),
        gte(schema.transactions.date, start),
        lte(schema.transactions.date, end),
        sql`${schema.categories.type} IN ('E', 'I')`
      )
    )
    .groupBy(schema.categories.type, schema.transactions.currency, schema.transactions.reportingCurrency)
    .all();
  let income = 0;
  let spending = 0;
  for (const s of slices) {
    const value = convertReportingSlice(s, money.displayCurrency, money.rateMap);
    if (s.type === "I") income += value;
    else spending += value;
  }
  // Expenses are stored negative; refunds in the same categories net out.
  return { income, expenses: Math.abs(spending) };
}

type BudgetStatus = {
  categoryId: number;
  name: string;
  budgeted: number;
  spent: number;
  pct: number;
  status: "OVER" | "WARNING" | "OK";
};

/**
 * This month's budgets against what was spent, both in the display currency:
 * a budget's amount at the current rate, spending through the flow rules.
 */
async function budgetStatuses(ctx: IntentCtx, month: string, money: Money): Promise<BudgetStatus[]> {
  // Stream D Phase 4 — ciphertext only.
  const rows = await db
    .select({
      categoryId: schema.budgets.categoryId,
      categoryNameCt: schema.categories.nameCt,
      budgeted: schema.budgets.amount,
      currency: schema.budgets.currency,
    })
    .from(schema.budgets)
    .leftJoin(schema.categories, eq(schema.budgets.categoryId, schema.categories.id))
    // Spending budgets only (income can be budgeted since Budget v2).
    .where(and(eq(schema.budgets.userId, ctx.userId), eq(schema.budgets.month, month), eq(schema.categories.type, "E")))
    .all();
  if (rows.length === 0) return [];

  const slices = await db
    .select({
      categoryId: schema.transactions.categoryId,
      currency: schema.transactions.currency,
      reportingCurrency: schema.transactions.reportingCurrency,
      totalAmount: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)`,
      totalReporting: sql<number | null>`SUM(${schema.transactions.reportingAmount})`,
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.userId, ctx.userId),
        inArray(schema.transactions.categoryId, rows.map((r) => r.categoryId)),
        gte(schema.transactions.date, startOfMonth(0)),
        lte(schema.transactions.date, endOfMonth(0))
      )
    )
    .groupBy(schema.transactions.categoryId, schema.transactions.currency, schema.transactions.reportingCurrency)
    .all();
  const spentBy = new Map<number, number>();
  for (const s of slices) {
    if (s.categoryId == null) continue;
    spentBy.set(
      s.categoryId,
      (spentBy.get(s.categoryId) ?? 0) + convertReportingSlice(s, money.displayCurrency, money.rateMap),
    );
  }

  return rows.map((b) => {
    const budgeted = convertWithRateMap(b.budgeted, b.currency, money.rateMap);
    const spent = Math.abs(spentBy.get(b.categoryId) ?? 0);
    const pct = budgeted > 0 ? Math.round((spent / budgeted) * 100) : 0;
    const status: BudgetStatus["status"] = pct > 100 ? "OVER" : pct > 80 ? "WARNING" : "OK";
    return {
      categoryId: b.categoryId,
      name: decryptName(b.categoryNameCt, ctx.dek, null) ?? "Unknown",
      budgeted,
      spent,
      pct,
      status,
    };
  });
}

const handleNetWorth: IntentHandler = async (_msg, ctx) => {
  const money = await moneyContext(ctx.userId);
  const rows = await accountBalances(ctx, money);
  const { assets, liabilities, netWorth } = netWorthOf(rows);

  const chartData = rows
    .filter((r) => Math.abs(r.display) > 0)
    .map((r) => ({
      name: r.name,
      value: Math.round(Math.abs(r.display) * 100) / 100,
      type: r.accountType === "A" ? "Asset" : "Liability",
    }));

  const cur = money.displayCurrency;
  return {
    text: `Your net worth is ${formatCurrency(netWorth, cur)}.\n\nAssets: ${formatCurrency(assets, cur)}\nLiabilities: ${formatCurrency(Math.abs(liabilities), cur)}`,
    chartType: "bar",
    chartData,
  };
};

const handleSpending: IntentHandler = async (msg, ctx) => {
  const range = parseDateRange(msg);
  const categoryName = await findCategoryName(msg, ctx.userId, ctx.dek);
  // FINLYNQ-183 / FINLYNQ-123 — spending is a FLOW figure: each
  // (currency, reporting_currency) slice converts through the shared
  // `convertReportingSlice` (stored historical reporting_amount when it
  // matches the display currency, else a current-rate fallback) BEFORE the
  // slices are added together. Never `SUM(amount)` across currencies.
  const displayCurrency = await getDisplayCurrency(ctx.userId);
  const rateMap = await getRateMap(displayCurrency, ctx.userId);

  if (categoryName) {
    // Stream D Phase 4 — match by name_lookup HMAC.
    const lookup = ctx.dek ? nameLookup(ctx.dek, categoryName) : null;
    const cat = lookup
      ? await db
          .select()
          .from(schema.categories)
          .where(and(eq(schema.categories.userId, ctx.userId), eq(schema.categories.nameLookup, lookup)))
          .get()
      : null;
    if (!cat) return { text: `I couldn't find a category named "${categoryName}".` };

    const slices = await db
      .select({
        currency: schema.transactions.currency,
        reportingCurrency: schema.transactions.reportingCurrency,
        totalAmount: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)`,
        totalReporting: sql<number | null>`SUM(${schema.transactions.reportingAmount})`,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, ctx.userId),
          eq(schema.transactions.categoryId, cat.id),
          gte(schema.transactions.date, range.start),
          lte(schema.transactions.date, range.end)
        )
      )
      .groupBy(schema.transactions.currency, schema.transactions.reportingCurrency)
      .all();

    const total = Math.abs(
      slices.reduce((sum, s) => sum + convertReportingSlice(s, displayCurrency, rateMap), 0)
    );
    return {
      text: `You spent ${formatCurrency(total, displayCurrency)} on ${categoryName} during ${range.label}.`,
    };
  }

  // Overall spending by category. `getSpendingByCategoryWithReporting` is the
  // shared per-(category, currency, reporting_currency) slice query the
  // dashboard already converts through — reuse it rather than re-deriving a
  // cross-currency sum here. Stream D Phase 4: ciphertext only.
  const spendingSlices = await getSpendingByCategoryWithReporting(ctx.userId, range.start, range.end);
  const byCategory = new Map<string, { nameCt: string | null; total: number }>();
  for (const s of spendingSlices) {
    const key = String(s.categoryId ?? "null");
    const cur = byCategory.get(key) ?? { nameCt: s.categoryNameCt, total: 0 };
    cur.total += convertReportingSlice(s, displayCurrency, rateMap);
    byCategory.set(key, cur);
  }
  const spending = Array.from(byCategory.values())
    .map((c) => ({
      categoryName: decryptName(c.nameCt, ctx.dek, null) ?? "Uncategorized",
      total: c.total,
    }))
    // Expenses are stored negative — most-spent first (ascending, as before).
    .sort((a, b) => a.total - b.total);

  const total = spending.reduce((s, c) => s + Math.abs(c.total), 0);
  const chartData = spending.map((c) => ({
    name: c.categoryName,
    value: Math.round(Math.abs(c.total) * 100) / 100,
  }));

  const top3 = spending.slice(0, 3).map(
    (c) => `  ${c.categoryName}: ${formatCurrency(Math.abs(c.total), displayCurrency)}`
  ).join("\n");

  return {
    text: `You spent ${formatCurrency(total, displayCurrency)} in total during ${range.label}.\n\nTop categories:\n${top3}`,
    chartType: "pie",
    chartData,
  };
};

const handleBalance: IntentHandler = async (msg, ctx) => {
  const accountName = await findAccountName(msg, ctx.userId, ctx.dek);
  const money = await moneyContext(ctx.userId);
  const rows = await accountBalances(ctx, money);

  if (accountName) {
    const acc = rows.find((r) => r.name.toLowerCase() === accountName.toLowerCase());
    if (!acc) return { text: `I couldn't find an account named "${accountName}".` };
    // In the account's own currency; an investment account at market value.
    return { text: `Your ${accountName} balance is ${formatCurrency(acc.native, acc.currency)}.` };
  }

  const shown = rows.filter((r) => Math.abs(r.native) > 0.01);
  const lines = shown.map((r) => `  ${r.name}: ${formatCurrency(r.native, r.currency)}`);
  // The chart compares accounts, so every bar is in the one display currency.
  const chartData = shown.map((r) => ({
    name: r.name,
    value: Math.round(r.display * 100) / 100,
  }));

  return {
    text: `Here are your account balances:\n\n${lines.join("\n")}`,
    chartType: "bar",
    chartData,
  };
};

const handleBudget: IntentHandler = async (msg, ctx) => {
  const month = getCurrentMonth();
  const categoryName = await findCategoryName(msg, ctx.userId, ctx.dek);
  const money = await moneyContext(ctx.userId);
  const results = await budgetStatuses(ctx, month, money);

  if (results.length === 0) {
    return { text: `You don't have any budgets set for ${getMonthLabel(month)}.` };
  }

  const fmt = (n: number) => formatCurrency(n, money.displayCurrency);
  if (categoryName) {
    const match = results.find((r) => r.name.toLowerCase() === categoryName.toLowerCase());
    if (match) {
      const statusText = match.status === "OVER"
        ? `You're over budget by ${fmt(match.spent - match.budgeted)}!`
        : `You have ${fmt(match.budgeted - match.spent)} remaining.`;
      return {
        text: `${match.name} budget for ${getMonthLabel(month)}: ${fmt(match.spent)} of ${fmt(match.budgeted)} (${match.pct}%).\n${statusText}`,
      };
    }
  }

  const overBudget = results.filter((r) => r.status === "OVER");
  const warnings = results.filter((r) => r.status === "WARNING");

  let summary = `Budget overview for ${getMonthLabel(month)}:\n\n`;
  if (overBudget.length > 0) {
    summary += `Over budget (${overBudget.length}):\n${overBudget.map((r) => `  ${r.name}: ${r.pct}% (${fmt(r.spent)} / ${fmt(r.budgeted)})`).join("\n")}\n\n`;
  }
  if (warnings.length > 0) {
    summary += `Approaching limit (${warnings.length}):\n${warnings.map((r) => `  ${r.name}: ${r.pct}%`).join("\n")}\n\n`;
  }
  const okCount = results.filter((r) => r.status === "OK").length;
  summary += `On track: ${okCount} categories`;

  const chartData = results.map((r) => ({
    name: r.name,
    budgeted: Math.round(r.budgeted * 100) / 100,
    spent: Math.round(r.spent * 100) / 100,
  }));

  return {
    text: summary,
    chartType: "bar",
    chartData,
  };
};

const handleTransactions: IntentHandler = async (msg, ctx) => {
  const lower = msg.toLowerCase();

  // "largest expense" / "biggest purchase"
  if (lower.includes("largest") || lower.includes("biggest") || lower.includes("most expensive")) {
    const range = parseDateRange(msg);
    // Stream D Phase 4 — ciphertext only.
    const rawResult = await db
      .select({
        date: schema.transactions.date,
        payee: schema.transactions.payee,
        amount: schema.transactions.amount,
        currency: schema.transactions.currency,
        categoryNameCt: schema.categories.nameCt,
      })
      .from(schema.transactions)
      .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
      .where(
        and(
          eq(schema.transactions.userId, ctx.userId),
          eq(schema.categories.type, "E"),
          gte(schema.transactions.date, range.start),
          lte(schema.transactions.date, range.end)
        )
      )
      // "Largest" across currencies is ranked on the stored reporting amount
      // (FINLYNQ-123); a row without one falls back to its own amount.
      .orderBy(asc(sql`COALESCE(${schema.transactions.reportingAmount}, ${schema.transactions.amount})`))
      .limit(5)
      .all();
    const result = rawResult.map((r) => ({
      ...r,
      categoryName: decryptName(r.categoryNameCt, ctx.dek, null),
    }));

    if (result.length === 0) return { text: `No expenses found during ${range.label}.` };

    const decrypted = result.map((t) => ({ ...t, payee: safeDecrypt(ctx.dek, t.payee) }));
    const money = await moneyContext(ctx.userId);

    // Each expense in its own currency; the chart compares them, so its bars
    // are in the display currency.
    const lines = decrypted.map(
      (t) => `  ${t.date} — ${t.payee || "No payee"} — ${formatCurrency(Math.abs(t.amount), t.currency || money.displayCurrency)} (${t.categoryName})`
    );

    const chartData = decrypted.map((t) => ({
      name: t.payee || "Unknown",
      value: Math.round(Math.abs(convertWithRateMap(t.amount, t.currency, money.rateMap)) * 100) / 100,
      date: t.date,
      category: t.categoryName,
    }));

    return {
      text: `Largest expenses during ${range.label}:\n\n${lines.join("\n")}`,
      chartType: "bar",
      chartData,
    };
  }

  // "show [payee] transactions" / "recent transactions"
  let searchTerm = "";
  const payeeMatch = lower.match(/(?:show|find|search|list)\s+(.+?)\s+transactions/);
  if (payeeMatch) searchTerm = payeeMatch[1].trim();

  const range = parseDateRange(msg);
  const conditions = [
    eq(schema.transactions.userId, ctx.userId),
    gte(schema.transactions.date, range.start),
    lte(schema.transactions.date, range.end),
  ];

  // Substring LIKE against encrypted payee/note doesn't match; fetch a wider
  // window and filter in memory after decryption when a DEK is present.
  const wideFetch = !!(searchTerm && ctx.dek);

  // Stream D Phase 4 — ciphertext only.
  const rawTxns = await db
    .select({
      date: schema.transactions.date,
      payee: schema.transactions.payee,
      note: schema.transactions.note,
      amount: schema.transactions.amount,
      currency: schema.transactions.currency,
      categoryNameCt: schema.categories.nameCt,
      accountNameCt: schema.accounts.nameCt,
    })
    .from(schema.transactions)
    .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
    .leftJoin(schema.accounts, eq(schema.transactions.accountId, schema.accounts.id))
    .where(and(...conditions))
    .orderBy(desc(schema.transactions.date))
    .limit(wideFetch ? 500 : 10)
    .all();

  let decrypted = rawTxns.map((t) => ({
    ...t,
    payee: safeDecrypt(ctx.dek, t.payee),
    note: safeDecrypt(ctx.dek, t.note),
    categoryName: decryptName(t.categoryNameCt, ctx.dek, null),
    accountName: decryptName(t.accountNameCt, ctx.dek, null),
  }));

  if (searchTerm) {
    const q = searchTerm.toLowerCase();
    decrypted = decrypted.filter(
      (t) => t.payee.toLowerCase().includes(q) || t.note.toLowerCase().includes(q)
    );
  }
  decrypted = decrypted.slice(0, 10);

  if (decrypted.length === 0) {
    return { text: searchTerm ? `No transactions matching "${searchTerm}" found.` : `No transactions found for ${range.label}.` };
  }

  const displayCurrency = await getDisplayCurrency(ctx.userId);
  const tableData = decrypted.map((t) => ({
    date: t.date,
    payee: t.payee || "—",
    // Each row in its own currency.
    amount: formatCurrency(t.amount, t.currency || displayCurrency),
    category: t.categoryName ?? "—",
    account: t.accountName ?? "—",
  }));

  return {
    text: searchTerm
      ? `Found ${decrypted.length} transaction(s) matching "${searchTerm}":`
      : `Recent transactions for ${range.label}:`,
    chartType: "table",
    chartData: tableData,
  };
};

const handleTrends: IntentHandler = async (_msg, ctx) => {
  // Compare spending month over month, every month in the display currency.
  const months = 6;
  const money = await moneyContext(ctx.userId);
  const monthlyData: { month: string; income: number; expenses: number }[] = [];

  for (let i = months - 1; i >= 0; i--) {
    const { income, expenses } = await flowTotals(ctx.userId, startOfMonth(-i), endOfMonth(-i), money);
    monthlyData.push({ month: monthLabel(-i), income, expenses });
  }

  const recent = monthlyData[monthlyData.length - 1];
  const prev = monthlyData[monthlyData.length - 2];
  let trendText = "";
  if (recent && prev && prev.expenses > 0) {
    const change = ((recent.expenses - prev.expenses) / prev.expenses) * 100;
    if (change > 5) trendText = `Spending is up ${Math.round(change)}% compared to the previous month.`;
    else if (change < -5) trendText = `Spending is down ${Math.round(Math.abs(change))}% compared to the previous month.`;
    else trendText = "Spending is roughly flat compared to the previous month.";
  }

  const chartData = monthlyData.map((m) => ({
    name: m.month,
    income: Math.round(m.income * 100) / 100,
    expenses: Math.round(m.expenses * 100) / 100,
  }));

  return {
    text: `Here's your income vs. expenses over the last ${months} months.\n\n${trendText}`,
    chartType: "line",
    chartData,
  };
};

const handleGoals: IntentHandler = async (_msg, ctx) => {
  // Stream D Phase 4 — ciphertext only.
  const rawGoals = await db
    .select({
      id: schema.goals.id,
      nameCt: schema.goals.nameCt,
      type: schema.goals.type,
      targetAmount: schema.goals.targetAmount,
      currency: schema.goals.currency,
      deadline: schema.goals.deadline,
    })
    .from(schema.goals)
    .where(and(eq(schema.goals.userId, ctx.userId), eq(schema.goals.status, "active")))
    .all();

  if (rawGoals.length === 0) {
    return { text: "You don't have any active goals. Head to the Goals page to create one!" };
  }

  // Progress is the SAME figure the Goals page and MCP show: the shared
  // aggregator sums every account in `goal_accounts` (issue #130), values
  // investment accounts at market and converts each into the goal's currency.
  // The old code read only the legacy single `goals.account_id`, at ledger.
  const links = await db
    .select({ goalId: schema.goalAccounts.goalId, accountId: schema.goalAccounts.accountId })
    .from(schema.goalAccounts)
    .where(eq(schema.goalAccounts.userId, ctx.userId))
    .all();
  const accountsByGoal = new Map<number, number[]>();
  for (const l of links) accountsByGoal.set(l.goalId, [...(accountsByGoal.get(l.goalId) ?? []), l.accountId]);
  const progressByGoal = await computeGoalProgress(
    ctx.userId,
    ctx.dek,
    rawGoals.map((g) => ({
      id: g.id,
      type: g.type,
      currency: g.currency ?? null,
      targetAmount: g.targetAmount,
      deadline: g.deadline ?? null,
      accountIds: accountsByGoal.get(g.id) ?? [],
    })),
  );
  const displayCurrency = await getDisplayCurrency(ctx.userId);

  const withProgress = rawGoals.map((g) => {
    const p = progressByGoal.get(g.id);
    return {
      name: decryptName(g.nameCt, ctx.dek, null) ?? "Goal",
      currency: g.currency || displayCurrency,
      target: g.targetAmount,
      current: Math.round((p?.currentAmount ?? 0) * 100) / 100,
      progress: Math.round(p?.progress ?? 0),
      deadline: g.deadline,
    };
  });

  // Each goal in its own currency.
  const lines = withProgress.map(
    (g) => `  ${g.name}: ${g.progress}% (${formatCurrency(g.current, g.currency)} / ${formatCurrency(g.target, g.currency)})${g.deadline ? ` — due ${g.deadline}` : ""}`
  );

  const chartData = withProgress.map((g) => ({
    name: g.name,
    current: g.current,
    target: g.target,
    progress: g.progress,
  }));

  return {
    text: `Your goal progress:\n\n${lines.join("\n")}`,
    chartType: "bar",
    chartData,
  };
};

const handleForecast: IntentHandler = async (msg, ctx) => {
  const lower = msg.toLowerCase();

  // "Can I afford [amount]?"
  const affordMatch = lower.match(/(?:can i afford|do i have enough for)\s*\$?([\d,]+(?:\.\d{2})?)/);
  if (affordMatch) {
    const amount = parseFloat(affordMatch[1].replace(/,/g, ""));
    // The cash in bank accounts (GH #307 — the shared canonical cash-group
    // set), each converted to the display currency before it is added up.
    const money = await moneyContext(ctx.userId);
    const cashGroups = new Set<string>(CASH_GROUP_NAMES);
    const rows = await accountBalances(ctx, money);
    const currentBalance = rows
      .filter((r) => r.group != null && cashGroups.has(r.group))
      .reduce((sum, r) => sum + r.display, 0);

    const fmt = (n: number) => formatCurrency(n, money.displayCurrency);
    const canAfford = currentBalance >= amount;
    const remaining = currentBalance - amount;
    return {
      text: canAfford
        ? `Yes! Your bank balance is ${fmt(currentBalance)}. After spending ${fmt(amount)}, you'd have ${fmt(remaining)} left.`
        : `Not quite. Your bank balance is ${fmt(currentBalance)}, which is ${fmt(amount - currentBalance)} short of ${fmt(amount)}.`,
    };
  }

  // "Upcoming bills"
  const recurring = await db
    .select({
      payee: schema.recurringTransactions.payee,
      amount: schema.recurringTransactions.amount,
      frequency: schema.recurringTransactions.frequency,
      nextDate: schema.recurringTransactions.nextDate,
      // A recurring row has no currency of its own: it is its account's.
      currency: schema.accounts.currency,
    })
    .from(schema.recurringTransactions)
    .leftJoin(schema.accounts, eq(schema.recurringTransactions.accountId, schema.accounts.id))
    .where(
      and(
        eq(schema.recurringTransactions.userId, ctx.userId),
        eq(schema.recurringTransactions.active, 1)
      )
    )
    .orderBy(schema.recurringTransactions.nextDate)
    .all();

  if (recurring.length === 0) {
    return { text: "No upcoming recurring bills found. You can set them up on the Calendar page." };
  }

  const upcoming = recurring
    .filter((r) => r.nextDate && r.nextDate >= todayISO())
    .slice(0, 10)
    .map((r) => ({ ...r, payee: safeDecrypt(ctx.dek, r.payee) }));

  const billCurrency = await getDisplayCurrency(ctx.userId);
  const lines = upcoming.map(
    (r) => `  ${r.nextDate} — ${r.payee}: ${formatCurrency(Math.abs(r.amount), r.currency || billCurrency)} (${r.frequency})`
  );

  const chartData = upcoming.map((r) => ({
    name: r.payee,
    value: Math.round(Math.abs(r.amount) * 100) / 100,
    date: r.nextDate,
    frequency: r.frequency,
  }));

  return {
    text: `Upcoming bills:\n\n${lines.join("\n")}`,
    chartType: "table",
    chartData,
  };
};

const handleSummary: IntentHandler = async (_msg, ctx) => {
  const month = getCurrentMonth();
  const money = await moneyContext(ctx.userId);

  // Net worth: the same figure the "net worth" answer gives.
  const { netWorth } = netWorthOf(await accountBalances(ctx, money));
  // This month's income and expenses.
  const { income, expenses } = await flowTotals(ctx.userId, startOfMonth(0), endOfMonth(0), money);
  const savings = income - expenses;

  // Active goals count
  const goalCount = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.goals)
    .where(and(eq(schema.goals.userId, ctx.userId), eq(schema.goals.status, "active")))
    .get();

  const overBudgetCount = (await budgetStatuses(ctx, month, money)).filter((b) => b.status === "OVER").length;

  const chartData = [
    { name: "Income", value: Math.round(income * 100) / 100 },
    { name: "Expenses", value: Math.round(expenses * 100) / 100 },
    { name: "Savings", value: Math.round(savings * 100) / 100 },
  ];

  const fmt = (n: number) => formatCurrency(n, money.displayCurrency);
  return {
    text: [
      `Here's your financial summary for ${getMonthLabel(month)}:`,
      "",
      `Net worth: ${fmt(netWorth)}`,
      `Income this month: ${fmt(income)}`,
      `Expenses this month: ${fmt(expenses)}`,
      `Savings: ${fmt(savings)} (${income > 0 ? Math.round((savings / income) * 100) : 0}% savings rate)`,
      "",
      `Active goals: ${goalCount?.count ?? 0}`,
      overBudgetCount > 0 ? `Budgets over limit: ${overBudgetCount}` : "All budgets on track!",
    ].join("\n"),
    chartType: "bar",
    chartData,
  };
};

// ─── Intent router ──────────────────────────────────────────────────

type IntentPattern = {
  keywords: string[];
  handler: IntentHandler;
};

const intents: IntentPattern[] = [
  {
    keywords: ["net worth"],
    handler: handleNetWorth,
  },
  {
    keywords: ["summary", "overview", "how am i doing", "financial summary"],
    handler: handleSummary,
  },
  {
    keywords: ["budget", "over budget", "under budget"],
    handler: handleBudget,
  },
  {
    keywords: ["goal", "goals", "goal progress", "how close"],
    handler: handleGoals,
  },
  {
    keywords: ["trend", "going up", "going down", "compare months", "month over month", "spending over time"],
    handler: handleTrends,
  },
  {
    keywords: ["upcoming bill", "upcoming bills", "forecast", "can i afford", "do i have enough"],
    handler: handleForecast,
  },
  {
    keywords: ["balance", "how much in", "account balance", "accounts"],
    handler: handleBalance,
  },
  {
    keywords: [
      "spend", "spent", "spending", "how much did", "how much this month",
      "expense", "expenses", "cost", "what did i pay",
    ],
    handler: handleSpending,
  },
  {
    keywords: [
      "transaction", "transactions", "show", "largest", "biggest",
      "most expensive", "recent", "find", "search",
    ],
    handler: handleTransactions,
  },
];

export async function processMessage(
  message: string,
  userId: string,
  dek: Buffer | null = null,
): Promise<ChatResponse> {
  const lower = message.toLowerCase().trim();

  if (!lower) {
    return { text: "Please ask me something about your finances!" };
  }

  const ctx: IntentCtx = { userId, dek };

  // Match intent by keyword
  for (const intent of intents) {
    if (intent.keywords.some((kw) => lower.includes(kw))) {
      const result = await intent.handler(message, ctx);
      if (result) return result;
    }
  }

  // Fallback
  return {
    text: "I'm not sure how to answer that. Try asking about:\n\n" +
      "  - Net worth\n" +
      "  - Spending (by category or overall)\n" +
      "  - Account balances\n" +
      "  - Budget status\n" +
      "  - Goal progress\n" +
      "  - Spending trends\n" +
      "  - Upcoming bills\n" +
      "  - Recent transactions\n" +
      "  - Financial summary\n\n" +
      'For example: "How much did I spend on groceries?" or "What\'s my net worth?"',
  };
}
