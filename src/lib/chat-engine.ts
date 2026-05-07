// Built-in AI Chat Engine — keyword-based natural language query parser
// No external AI API required. Queries the local SQLite database directly.

import { db, schema } from "@/db";
import { eq, and, gte, lte, desc, sql, asc } from "drizzle-orm";
import { formatCurrency, getCurrentMonth, getMonthLabel } from "@/lib/currency";
import { decryptField } from "@/lib/crypto/envelope";
import { decryptName, nameLookup } from "@/lib/crypto/encrypted-columns";

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

function today(): string {
  return new Date().toISOString().split("T")[0];
}

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
    return { start: `${y}-01-01`, end: today(), label: `${y} YTD` };
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

const handleNetWorth: IntentHandler = async (_msg, ctx) => {
  // Stream D Phase 4 — plaintext name dropped; ciphertext only.
  const balances = await db
    .select({
      accountNameCt: schema.accounts.nameCt,
      accountType: schema.accounts.type,
      accountGroup: schema.accounts.group,
      currency: schema.accounts.currency,
      balance: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)`,
    })
    .from(schema.accounts)
    .leftJoin(schema.transactions, eq(schema.accounts.id, schema.transactions.accountId))
    .where(eq(schema.accounts.userId, ctx.userId))
    .groupBy(schema.accounts.id, schema.accounts.nameCt, schema.accounts.type, schema.accounts.group, schema.accounts.currency)
    .orderBy(schema.accounts.type, schema.accounts.group)
    .all();

  let assets = 0;
  let liabilities = 0;
  for (const b of balances) {
    if (b.accountType === "A") assets += b.balance;
    else liabilities += b.balance;
  }
  const netWorth = assets + liabilities; // liabilities are negative

  const chartData = balances
    .filter((b) => Math.abs(b.balance) > 0)
    .map((b) => ({
      name: decryptName(b.accountNameCt, ctx.dek, null) ?? "Account",
      value: Math.round(Math.abs(b.balance) * 100) / 100,
      type: b.accountType === "A" ? "Asset" : "Liability",
    }));

  return {
    text: `Your net worth is ${formatCurrency(netWorth, "CAD")}.\n\nAssets: ${formatCurrency(assets, "CAD")}\nLiabilities: ${formatCurrency(Math.abs(liabilities), "CAD")}`,
    chartType: "bar",
    chartData,
  };
};

const handleSpending: IntentHandler = async (msg, ctx) => {
  const range = parseDateRange(msg);
  const categoryName = await findCategoryName(msg, ctx.userId, ctx.dek);

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

    const result = await db
      .select({ total: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)` })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, ctx.userId),
          eq(schema.transactions.categoryId, cat.id),
          gte(schema.transactions.date, range.start),
          lte(schema.transactions.date, range.end)
        )
      )
      .get();

    const total = Math.abs(result?.total ?? 0);
    return {
      text: `You spent ${formatCurrency(total, "CAD")} on ${categoryName} during ${range.label}.`,
    };
  }

  // Overall spending by category (Stream D Phase 4: ciphertext only)
  const rawSpending = await db
    .select({
      categoryNameCt: schema.categories.nameCt,
      total: sql<number>`SUM(${schema.transactions.amount})`,
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
    .groupBy(schema.categories.id, schema.categories.nameCt)
    .orderBy(sql`SUM(${schema.transactions.amount}) ASC`)
    .all();
  const spending = rawSpending.map((s) => ({
    categoryName: decryptName(s.categoryNameCt, ctx.dek, null) ?? "Uncategorized",
    total: s.total,
  }));

  const total = spending.reduce((s, c) => s + Math.abs(c.total), 0);
  const chartData = spending.map((c) => ({
    name: c.categoryName,
    value: Math.round(Math.abs(c.total) * 100) / 100,
  }));

  const top3 = spending.slice(0, 3).map(
    (c) => `  ${c.categoryName}: ${formatCurrency(Math.abs(c.total), "CAD")}`
  ).join("\n");

  return {
    text: `You spent ${formatCurrency(total, "CAD")} in total during ${range.label}.\n\nTop categories:\n${top3}`,
    chartType: "pie",
    chartData,
  };
};

const handleBalance: IntentHandler = async (msg, ctx) => {
  const accountName = await findAccountName(msg, ctx.userId, ctx.dek);

  if (accountName) {
    // Stream D Phase 4 — match by name_lookup HMAC.
    const lookup = ctx.dek ? nameLookup(ctx.dek, accountName) : null;
    const acc = lookup
      ? await db
          .select()
          .from(schema.accounts)
          .where(and(eq(schema.accounts.userId, ctx.userId), eq(schema.accounts.nameLookup, lookup)))
          .get()
      : null;
    if (!acc) return { text: `I couldn't find an account named "${accountName}".` };

    const result = await db
      .select({ total: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)` })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, ctx.userId),
          eq(schema.transactions.accountId, acc.id)
        )
      )
      .get();

    return {
      text: `Your ${accountName} balance is ${formatCurrency(result?.total ?? 0, acc.currency)}.`,
    };
  }

  // All account balances (Stream D Phase 4: ciphertext only)
  const rawBalances = await db
    .select({
      accountNameCt: schema.accounts.nameCt,
      accountType: schema.accounts.type,
      currency: schema.accounts.currency,
      balance: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)`,
    })
    .from(schema.accounts)
    .leftJoin(schema.transactions, eq(schema.accounts.id, schema.transactions.accountId))
    .where(eq(schema.accounts.userId, ctx.userId))
    .groupBy(schema.accounts.id, schema.accounts.nameCt, schema.accounts.type, schema.accounts.currency)
    .orderBy(schema.accounts.type)
    .all();
  const balances = rawBalances.map((b) => ({
    accountName: decryptName(b.accountNameCt, ctx.dek, null) ?? "Account",
    accountType: b.accountType,
    currency: b.currency,
    balance: b.balance,
  }));

  const lines = balances
    .filter((b) => Math.abs(b.balance) > 0.01)
    .map((b) => `  ${b.accountName}: ${formatCurrency(b.balance, b.currency)}`);

  const chartData = balances
    .filter((b) => Math.abs(b.balance) > 0.01)
    .map((b) => ({
      name: b.accountName,
      value: Math.round(b.balance * 100) / 100,
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

  // Stream D Phase 4 — ciphertext only.
  const rawBudgetRows = await db
    .select({
      categoryId: schema.budgets.categoryId,
      categoryNameCt: schema.categories.nameCt,
      budgeted: schema.budgets.amount,
    })
    .from(schema.budgets)
    .leftJoin(schema.categories, eq(schema.budgets.categoryId, schema.categories.id))
    .where(and(eq(schema.budgets.userId, ctx.userId), eq(schema.budgets.month, month)))
    .all();
  const budgetRows = rawBudgetRows.map((b) => ({
    categoryId: b.categoryId,
    categoryName: decryptName(b.categoryNameCt, ctx.dek, null),
    budgeted: b.budgeted,
  }));

  if (budgetRows.length === 0) {
    return { text: `You don't have any budgets set for ${getMonthLabel(month)}.` };
  }

  // Get actual spending for each budgeted category
  const start = startOfMonth(0);
  const end = endOfMonth(0);

  const results = await Promise.all(budgetRows.map(async (b) => {
    const spent = await db
      .select({ total: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)` })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, ctx.userId),
          eq(schema.transactions.categoryId, b.categoryId),
          gte(schema.transactions.date, start),
          lte(schema.transactions.date, end)
        )
      )
      .get();

    const actualSpent = Math.abs(spent?.total ?? 0);
    const pct = b.budgeted > 0 ? Math.round((actualSpent / b.budgeted) * 100) : 0;
    const status = pct > 100 ? "OVER" : pct > 80 ? "WARNING" : "OK";

    return {
      name: b.categoryName ?? "Unknown",
      budgeted: b.budgeted,
      spent: actualSpent,
      pct,
      status,
    };
  }));

  if (categoryName) {
    const match = results.find((r) => r.name.toLowerCase() === categoryName.toLowerCase());
    if (match) {
      const statusText = match.status === "OVER"
        ? `You're over budget by ${formatCurrency(match.spent - match.budgeted, "CAD")}!`
        : `You have ${formatCurrency(match.budgeted - match.spent, "CAD")} remaining.`;
      return {
        text: `${match.name} budget for ${getMonthLabel(month)}: ${formatCurrency(match.spent, "CAD")} of ${formatCurrency(match.budgeted, "CAD")} (${match.pct}%).\n${statusText}`,
      };
    }
  }

  const overBudget = results.filter((r) => r.status === "OVER");
  const warnings = results.filter((r) => r.status === "WARNING");

  let summary = `Budget overview for ${getMonthLabel(month)}:\n\n`;
  if (overBudget.length > 0) {
    summary += `Over budget (${overBudget.length}):\n${overBudget.map((r) => `  ${r.name}: ${r.pct}% (${formatCurrency(r.spent, "CAD")} / ${formatCurrency(r.budgeted, "CAD")})`).join("\n")}\n\n`;
  }
  if (warnings.length > 0) {
    summary += `Approaching limit (${warnings.length}):\n${warnings.map((r) => `  ${r.name}: ${r.pct}%`).join("\n")}\n\n`;
  }
  const okCount = results.filter((r) => r.status === "OK").length;
  summary += `On track: ${okCount} categories`;

  const chartData = results.map((r) => ({
    name: r.name,
    budgeted: r.budgeted,
    spent: r.spent,
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
      .orderBy(asc(schema.transactions.amount))
      .limit(5)
      .all();
    const result = rawResult.map((r) => ({
      ...r,
      categoryName: decryptName(r.categoryNameCt, ctx.dek, null),
    }));

    if (result.length === 0) return { text: `No expenses found during ${range.label}.` };

    const decrypted = result.map((t) => ({ ...t, payee: safeDecrypt(ctx.dek, t.payee) }));

    const lines = decrypted.map(
      (t) => `  ${t.date} — ${t.payee || "No payee"} — ${formatCurrency(Math.abs(t.amount), "CAD")} (${t.categoryName})`
    );

    const chartData = decrypted.map((t) => ({
      name: t.payee || "Unknown",
      value: Math.round(Math.abs(t.amount) * 100) / 100,
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

  const tableData = decrypted.map((t) => ({
    date: t.date,
    payee: t.payee || "—",
    amount: formatCurrency(t.amount, "CAD"),
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
  // Compare spending month over month
  const months = 6;
  const monthlyData: { month: string; income: number; expenses: number }[] = [];

  for (let i = months - 1; i >= 0; i--) {
    const start = startOfMonth(-i);
    const end = endOfMonth(-i);
    const label = monthLabel(-i);

    const result = await db
      .select({
        type: schema.categories.type,
        total: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)`,
      })
      .from(schema.transactions)
      .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
      .where(
        and(
          eq(schema.transactions.userId, ctx.userId),
          gte(schema.transactions.date, start),
          lte(schema.transactions.date, end),
          sql`${schema.categories.type} IN ('E', 'I')`
        )
      )
      .groupBy(schema.categories.type)
      .all();

    const income = result.find((r) => r.type === "I")?.total ?? 0;
    const expenses = Math.abs(result.find((r) => r.type === "E")?.total ?? 0);
    monthlyData.push({ month: label, income, expenses });
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
      accountId: schema.goals.accountId,
      deadline: schema.goals.deadline,
      status: schema.goals.status,
    })
    .from(schema.goals)
    .where(and(eq(schema.goals.userId, ctx.userId), eq(schema.goals.status, "active")))
    .all();
  const goals = rawGoals.map((g) => ({
    ...g,
    name: decryptName(g.nameCt, ctx.dek, null) ?? "Goal",
  }));

  if (goals.length === 0) {
    return { text: "You don't have any active goals. Head to the Goals page to create one!" };
  }

  const withProgress = await Promise.all(goals.map(async (g) => {
    let currentAmount = 0;
    if (g.accountId) {
      const result = await db
        .select({ total: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)` })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.userId, ctx.userId),
            eq(schema.transactions.accountId, g.accountId)
          )
        )
        .get();
      currentAmount = result?.total ?? 0;
    }
    const progress = g.targetAmount > 0 ? Math.min((currentAmount / g.targetAmount) * 100, 100) : 0;
    return {
      name: g.name,
      target: g.targetAmount,
      current: Math.round(currentAmount * 100) / 100,
      progress: Math.round(progress),
      deadline: g.deadline,
    };
  }));

  const lines = withProgress.map(
    (g) => `  ${g.name}: ${g.progress}% (${formatCurrency(g.current, "CAD")} / ${formatCurrency(g.target, "CAD")})${g.deadline ? ` — due ${g.deadline}` : ""}`
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
    // Get total balance across bank accounts
    const bankAccounts = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.userId, ctx.userId),
          sql`${schema.accounts.group} IN ('Banks', 'Cash Accounts')`
        )
      )
      .all();

    let currentBalance = 0;
    for (const ba of bankAccounts) {
      const result = await db
        .select({ total: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)` })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.userId, ctx.userId),
            eq(schema.transactions.accountId, ba.id)
          )
        )
        .get();
      currentBalance += result?.total ?? 0;
    }

    const canAfford = currentBalance >= amount;
    const remaining = currentBalance - amount;
    return {
      text: canAfford
        ? `Yes! Your bank balance is ${formatCurrency(currentBalance, "CAD")}. After spending ${formatCurrency(amount, "CAD")}, you'd have ${formatCurrency(remaining, "CAD")} left.`
        : `Not quite. Your bank balance is ${formatCurrency(currentBalance, "CAD")}, which is ${formatCurrency(amount - currentBalance, "CAD")} short of ${formatCurrency(amount, "CAD")}.`,
    };
  }

  // "Upcoming bills"
  const recurring = await db
    .select({
      payee: schema.recurringTransactions.payee,
      amount: schema.recurringTransactions.amount,
      frequency: schema.recurringTransactions.frequency,
      nextDate: schema.recurringTransactions.nextDate,
    })
    .from(schema.recurringTransactions)
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
    .filter((r) => r.nextDate && r.nextDate >= today())
    .slice(0, 10)
    .map((r) => ({ ...r, payee: safeDecrypt(ctx.dek, r.payee) }));

  const lines = upcoming.map(
    (r) => `  ${r.nextDate} — ${r.payee}: ${formatCurrency(Math.abs(r.amount), "CAD")} (${r.frequency})`
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
  const start = startOfMonth(0);
  const end = endOfMonth(0);

  // Net worth
  const balances = await db
    .select({
      accountType: schema.accounts.type,
      balance: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)`,
    })
    .from(schema.accounts)
    .leftJoin(schema.transactions, eq(schema.accounts.id, schema.transactions.accountId))
    .where(eq(schema.accounts.userId, ctx.userId))
    .groupBy(schema.accounts.id, schema.accounts.type)
    .all();

  let assets = 0, liabilities = 0;
  for (const b of balances) {
    if (b.accountType === "A") assets += b.balance;
    else liabilities += b.balance;
  }
  const netWorth = assets + liabilities;

  // Month income vs expenses
  const monthResult = await db
    .select({
      type: schema.categories.type,
      total: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)`,
    })
    .from(schema.transactions)
    .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
    .where(
      and(
        eq(schema.transactions.userId, ctx.userId),
        gte(schema.transactions.date, start),
        lte(schema.transactions.date, end),
        sql`${schema.categories.type} IN ('E', 'I')`
      )
    )
    .groupBy(schema.categories.type)
    .all();

  const income = monthResult.find((r) => r.type === "I")?.total ?? 0;
  const expenses = Math.abs(monthResult.find((r) => r.type === "E")?.total ?? 0);
  const savings = income - expenses;

  // Active goals count
  const goalCount = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.goals)
    .where(and(eq(schema.goals.userId, ctx.userId), eq(schema.goals.status, "active")))
    .get();

  // Budgets over
  const budgetRows = await db
    .select()
    .from(schema.budgets)
    .where(and(eq(schema.budgets.userId, ctx.userId), eq(schema.budgets.month, month)))
    .all();
  let overBudgetCount = 0;
  for (const b of budgetRows) {
    const spent = await db
      .select({ total: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)` })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, ctx.userId),
          eq(schema.transactions.categoryId, b.categoryId),
          gte(schema.transactions.date, start),
          lte(schema.transactions.date, end)
        )
      )
      .get();
    if (Math.abs(spent?.total ?? 0) > b.amount) overBudgetCount++;
  }

  const chartData = [
    { name: "Income", value: Math.round(income * 100) / 100 },
    { name: "Expenses", value: Math.round(expenses * 100) / 100 },
    { name: "Savings", value: Math.round(savings * 100) / 100 },
  ];

  return {
    text: [
      `Here's your financial summary for ${getMonthLabel(month)}:`,
      "",
      `Net worth: ${formatCurrency(netWorth, "CAD")}`,
      `Income this month: ${formatCurrency(income, "CAD")}`,
      `Expenses this month: ${formatCurrency(expenses, "CAD")}`,
      `Savings: ${formatCurrency(savings, "CAD")} (${income > 0 ? Math.round((savings / income) * 100) : 0}% savings rate)`,
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
