// Built-in AI Chat Engine — keyword-based natural language query parser
// No external AI API required. Queries the local SQLite database directly.

import { db, schema } from "@/db";
import { eq, and, gte, lte, desc, sql, asc } from "drizzle-orm";
import { formatCurrency, getCurrentMonth, getMonthLabel } from "@/lib/currency";

export type ChatResponse = {
  text: string;
  data?: unknown;
  chartType?: "bar" | "pie" | "line" | "table";
  chartData?: Record<string, unknown>[];
};

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

function findCategoryName(msg: string): string | null {
  const cats = db.select({ name: schema.categories.name }).from(schema.categories).all();
  const lower = msg.toLowerCase();
  // Match longest category name first to avoid partial matches
  const sorted = cats.sort((a, b) => String(b.name).length - String(a.name).length);
  for (const c of sorted) {
    if (lower.includes(String(c.name).toLowerCase())) return String(c.name);
  }
  return null;
}

function findAccountName(msg: string): string | null {
  const accs = db.select({ name: schema.accounts.name }).from(schema.accounts).all();
  const lower = msg.toLowerCase();
  const sorted = accs.sort((a, b) => String(b.name).length - String(a.name).length);
  for (const a of sorted) {
    if (lower.includes(String(a.name).toLowerCase())) return String(a.name);
  }
  return null;
}

// ─── Intent matchers ────────────────────────────────────────────────

type IntentHandler = (msg: string) => ChatResponse | null;

const handleNetWorth: IntentHandler = () => {
  const balances = db
    .select({
      accountName: schema.accounts.name,
      accountType: schema.accounts.type,
      accountGroup: schema.accounts.group,
      currency: schema.accounts.currency,
      balance: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)`,
    })
    .from(schema.accounts)
    .leftJoin(schema.transactions, eq(schema.accounts.id, schema.transactions.accountId))
    .groupBy(schema.accounts.id)
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
      name: b.accountName,
      value: Math.round(Math.abs(b.balance) * 100) / 100,
      type: b.accountType === "A" ? "Asset" : "Liability",
    }));

  return {
    text: `Your net worth is ${formatCurrency(netWorth, "CAD")}.\n\nAssets: ${formatCurrency(assets, "CAD")}\nLiabilities: ${formatCurrency(Math.abs(liabilities), "CAD")}`,
    chartType: "bar",
    chartData,
  };
};

const handleSpending: IntentHandler = (msg) => {
  const range = parseDateRange(msg);
  const categoryName = findCategoryName(msg);

  if (categoryName) {
    // Spending on a specific category
    const cat = db.select().from(schema.categories).where(eq(schema.categories.name, categoryName)).get();
    if (!cat) return { text: `I couldn't find a category named "${categoryName}".` };

    const result = db
      .select({ total: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)` })
      .from(schema.transactions)
      .where(
        and(
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

  // Overall spending by category
  const spending = db
    .select({
      categoryName: schema.categories.name,
      total: sql<number>`SUM(${schema.transactions.amount})`,
    })
    .from(schema.transactions)
    .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
    .where(
      and(
        eq(schema.categories.type, "E"),
        gte(schema.transactions.date, range.start),
        lte(schema.transactions.date, range.end)
      )
    )
    .groupBy(schema.categories.id)
    .orderBy(sql`SUM(${schema.transactions.amount}) ASC`)
    .all();

  const total = spending.reduce((s, c) => s + Math.abs(c.total), 0);
  const chartData = spending.map((c) => ({
    name: c.categoryName ?? "Uncategorized",
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

const handleBalance: IntentHandler = (msg) => {
  const accountName = findAccountName(msg);

  if (accountName) {
    const acc = db.select().from(schema.accounts).where(eq(schema.accounts.name, accountName)).get();
    if (!acc) return { text: `I couldn't find an account named "${accountName}".` };

    const result = db
      .select({ total: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)` })
      .from(schema.transactions)
      .where(eq(schema.transactions.accountId, acc.id))
      .get();

    return {
      text: `Your ${accountName} balance is ${formatCurrency(result?.total ?? 0, acc.currency)}.`,
    };
  }

  // All account balances
  const balances = db
    .select({
      accountName: schema.accounts.name,
      accountType: schema.accounts.type,
      currency: schema.accounts.currency,
      balance: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)`,
    })
    .from(schema.accounts)
    .leftJoin(schema.transactions, eq(schema.accounts.id, schema.transactions.accountId))
    .groupBy(schema.accounts.id)
    .orderBy(schema.accounts.type, schema.accounts.name)
    .all();

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

const handleBudget: IntentHandler = (msg) => {
  const month = getCurrentMonth();
  const categoryName = findCategoryName(msg);

  const budgetRows = db
    .select({
      categoryId: schema.budgets.categoryId,
      categoryName: schema.categories.name,
      budgeted: schema.budgets.amount,
    })
    .from(schema.budgets)
    .leftJoin(schema.categories, eq(schema.budgets.categoryId, schema.categories.id))
    .where(eq(schema.budgets.month, month))
    .all();

  if (budgetRows.length === 0) {
    return { text: `You don't have any budgets set for ${getMonthLabel(month)}.` };
  }

  // Get actual spending for each budgeted category
  const start = startOfMonth(0);
  const end = endOfMonth(0);

  const results = budgetRows.map((b) => {
    const spent = db
      .select({ total: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)` })
      .from(schema.transactions)
      .where(
        and(
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
  });

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

const handleTransactions: IntentHandler = (msg) => {
  const lower = msg.toLowerCase();

  // "largest expense" / "biggest purchase"
  if (lower.includes("largest") || lower.includes("biggest") || lower.includes("most expensive")) {
    const range = parseDateRange(msg);
    const result = db
      .select({
        date: schema.transactions.date,
        payee: schema.transactions.payee,
        amount: schema.transactions.amount,
        categoryName: schema.categories.name,
      })
      .from(schema.transactions)
      .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
      .where(
        and(
          eq(schema.categories.type, "E"),
          gte(schema.transactions.date, range.start),
          lte(schema.transactions.date, range.end)
        )
      )
      .orderBy(asc(schema.transactions.amount))
      .limit(5)
      .all();

    if (result.length === 0) return { text: `No expenses found during ${range.label}.` };

    const lines = result.map(
      (t) => `  ${t.date} — ${t.payee || "No payee"} — ${formatCurrency(Math.abs(t.amount), "CAD")} (${t.categoryName})`
    );

    const chartData = result.map((t) => ({
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
    gte(schema.transactions.date, range.start),
    lte(schema.transactions.date, range.end),
  ];

  if (searchTerm) {
    conditions.push(
      sql`(${schema.transactions.payee} LIKE ${"%" + searchTerm + "%"} OR ${schema.transactions.note} LIKE ${"%" + searchTerm + "%"})`
    );
  }

  const txns = db
    .select({
      date: schema.transactions.date,
      payee: schema.transactions.payee,
      amount: schema.transactions.amount,
      categoryName: schema.categories.name,
      accountName: schema.accounts.name,
    })
    .from(schema.transactions)
    .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
    .leftJoin(schema.accounts, eq(schema.transactions.accountId, schema.accounts.id))
    .where(and(...conditions))
    .orderBy(desc(schema.transactions.date))
    .limit(10)
    .all();

  if (txns.length === 0) {
    return { text: searchTerm ? `No transactions matching "${searchTerm}" found.` : `No transactions found for ${range.label}.` };
  }

  const tableData = txns.map((t) => ({
    date: t.date,
    payee: t.payee || "—",
    amount: formatCurrency(t.amount, "CAD"),
    category: t.categoryName ?? "—",
    account: t.accountName ?? "—",
  }));

  return {
    text: searchTerm
      ? `Found ${txns.length} transaction(s) matching "${searchTerm}":`
      : `Recent transactions for ${range.label}:`,
    chartType: "table",
    chartData: tableData,
  };
};

const handleTrends: IntentHandler = (msg) => {
  // Compare spending month over month
  const months = 6;
  const monthlyData: { month: string; income: number; expenses: number }[] = [];

  for (let i = months - 1; i >= 0; i--) {
    const start = startOfMonth(-i);
    const end = endOfMonth(-i);
    const label = monthLabel(-i);

    const result = db
      .select({
        type: schema.categories.type,
        total: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)`,
      })
      .from(schema.transactions)
      .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
      .where(
        and(
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

const handleGoals: IntentHandler = (msg) => {
  const goals = db
    .select({
      id: schema.goals.id,
      name: schema.goals.name,
      type: schema.goals.type,
      targetAmount: schema.goals.targetAmount,
      accountId: schema.goals.accountId,
      deadline: schema.goals.deadline,
      status: schema.goals.status,
    })
    .from(schema.goals)
    .where(eq(schema.goals.status, "active"))
    .all();

  if (goals.length === 0) {
    return { text: "You don't have any active goals. Head to the Goals page to create one!" };
  }

  const withProgress = goals.map((g) => {
    let currentAmount = 0;
    if (g.accountId) {
      const result = db
        .select({ total: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)` })
        .from(schema.transactions)
        .where(eq(schema.transactions.accountId, g.accountId))
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
  });

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

const handleForecast: IntentHandler = (msg) => {
  const lower = msg.toLowerCase();

  // "Can I afford [amount]?"
  const affordMatch = lower.match(/(?:can i afford|do i have enough for)\s*\$?([\d,]+(?:\.\d{2})?)/);
  if (affordMatch) {
    const amount = parseFloat(affordMatch[1].replace(/,/g, ""));
    // Get total balance across bank accounts
    const bankAccounts = db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(sql`${schema.accounts.group} IN ('Banks', 'Cash Accounts')`)
      .all();

    let currentBalance = 0;
    for (const ba of bankAccounts) {
      const result = db
        .select({ total: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)` })
        .from(schema.transactions)
        .where(eq(schema.transactions.accountId, ba.id))
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
  const recurring = db
    .select({
      payee: schema.recurringTransactions.payee,
      amount: schema.recurringTransactions.amount,
      frequency: schema.recurringTransactions.frequency,
      nextDate: schema.recurringTransactions.nextDate,
    })
    .from(schema.recurringTransactions)
    .where(eq(schema.recurringTransactions.active, 1))
    .orderBy(schema.recurringTransactions.nextDate)
    .all();

  if (recurring.length === 0) {
    return { text: "No upcoming recurring bills found. You can set them up on the Calendar page." };
  }

  const upcoming = recurring
    .filter((r) => r.nextDate && r.nextDate >= today())
    .slice(0, 10);

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

const handleSummary: IntentHandler = () => {
  const month = getCurrentMonth();
  const start = startOfMonth(0);
  const end = endOfMonth(0);

  // Net worth
  const balances = db
    .select({
      accountType: schema.accounts.type,
      balance: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)`,
    })
    .from(schema.accounts)
    .leftJoin(schema.transactions, eq(schema.accounts.id, schema.transactions.accountId))
    .groupBy(schema.accounts.id)
    .all();

  let assets = 0, liabilities = 0;
  for (const b of balances) {
    if (b.accountType === "A") assets += b.balance;
    else liabilities += b.balance;
  }
  const netWorth = assets + liabilities;

  // Month income vs expenses
  const monthResult = db
    .select({
      type: schema.categories.type,
      total: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)`,
    })
    .from(schema.transactions)
    .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
    .where(
      and(
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
  const goalCount = db
    .select({ count: sql<number>`count(*)` })
    .from(schema.goals)
    .where(eq(schema.goals.status, "active"))
    .get();

  // Budgets over
  const budgetRows = db.select().from(schema.budgets).where(eq(schema.budgets.month, month)).all();
  let overBudgetCount = 0;
  for (const b of budgetRows) {
    const spent = db
      .select({ total: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)` })
      .from(schema.transactions)
      .where(
        and(
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

export function processMessage(message: string): ChatResponse {
  const lower = message.toLowerCase().trim();

  if (!lower) {
    return { text: "Please ask me something about your finances!" };
  }

  // Match intent by keyword
  for (const intent of intents) {
    if (intent.keywords.some((kw) => lower.includes(kw))) {
      const result = intent.handler(message);
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
