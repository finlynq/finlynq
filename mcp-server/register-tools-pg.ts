/**
 * MCP Tools — PostgreSQL / managed-cloud implementation
 *
 * All queries are async, user-scoped, and use Drizzle's `sql` template for
 * raw SQL so they work with either the pg or neon-http drivers.
 *
 * Row extraction: `db.execute()` returns `{ rows: [...] }` for pg/neon.
 * We normalise via `rows()` helper below.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sql } from "drizzle-orm";
import { z } from "zod";

// ─── types ────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = { execute: (q: ReturnType<typeof sql>) => Promise<any> };

// ─── helpers ──────────────────────────────────────────────────────────────────

function rows(result: unknown): Row[] {
  if (result && typeof result === "object") {
    // pg / neon: { rows: [...] }
    if ("rows" in result && Array.isArray((result as { rows: unknown }).rows)) {
      return (result as { rows: Row[] }).rows;
    }
    // drizzle-orm result arrays (some adapters return the array directly)
    if (Array.isArray(result)) return result as Row[];
  }
  return [];
}

async function q(db: DbLike, query: ReturnType<typeof sql>): Promise<Row[]> {
  return rows(await db.execute(query));
}

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(msg: string) {
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
}

// ─── registration ─────────────────────────────────────────────────────────────

export function registerPgTools(server: McpServer, db: DbLike, userId: string) {

  // ── get_account_balances ───────────────────────────────────────────────────
  server.tool(
    "get_account_balances",
    "Get current balances for all accounts, grouped by type (asset/liability)",
    { currency: z.enum(["CAD", "USD", "all"]).optional().describe("Filter by currency") },
    async ({ currency }) => {
      const rows = await q(db, sql`
        SELECT a.id, a.name, a.type, a."group", a.currency,
               COALESCE(SUM(t.amount), 0) AS balance
        FROM accounts a
        LEFT JOIN transactions t ON a.id = t.account_id AND t.user_id = ${userId}
        WHERE a.user_id = ${userId}
          ${currency && currency !== "all" ? sql`AND a.currency = ${currency}` : sql``}
        GROUP BY a.id, a.name, a.type, a."group", a.currency
        ORDER BY a.type, a."group", a.name
      `);
      return text(rows);
    }
  );

  // ── get_transactions ───────────────────────────────────────────────────────
  server.tool(
    "get_transactions",
    "Query transactions with filters. Returns up to 100 transactions.",
    {
      start_date: z.string().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().describe("End date (YYYY-MM-DD)"),
      category: z.string().optional().describe("Filter by category name"),
      account: z.string().optional().describe("Filter by account name"),
      min_amount: z.number().optional().describe("Minimum amount"),
      max_amount: z.number().optional().describe("Maximum amount"),
      limit: z.number().optional().describe("Max results (default 100)"),
    },
    async ({ start_date, end_date, category, account, min_amount, max_amount, limit }) => {
      const lim = limit ?? 100;
      const rows = await q(db, sql`
        SELECT t.date, a.name AS account, c.name AS category, c.type AS category_type,
               t.currency, t.amount, t.payee, t.note, t.tags
        FROM transactions t
        LEFT JOIN accounts a ON t.account_id = a.id
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.user_id = ${userId}
          AND t.date >= ${start_date}
          AND t.date <= ${end_date}
          ${category ? sql`AND c.name = ${category}` : sql``}
          ${account ? sql`AND a.name = ${account}` : sql``}
          ${min_amount !== undefined ? sql`AND t.amount >= ${min_amount}` : sql``}
          ${max_amount !== undefined ? sql`AND t.amount <= ${max_amount}` : sql``}
        ORDER BY t.date DESC
        LIMIT ${lim}
      `);
      return text(rows);
    }
  );

  // ── search_transactions ────────────────────────────────────────────────────
  server.tool(
    "search_transactions",
    "Flexible transaction search with partial payee match, amount range, date range, category, and tags",
    {
      payee: z.string().optional().describe("Partial payee/merchant name match"),
      min_amount: z.number().optional().describe("Minimum amount"),
      max_amount: z.number().optional().describe("Maximum amount"),
      start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
      category: z.string().optional().describe("Category name (exact)"),
      tags: z.string().optional().describe("Tag to search for (partial match)"),
      limit: z.number().optional().describe("Max results (default 50)"),
    },
    async ({ payee, min_amount, max_amount, start_date, end_date, category, tags, limit }) => {
      const lim = limit ?? 50;
      const rows = await q(db, sql`
        SELECT t.id, t.date, a.name AS account, c.name AS category, c.type AS category_type,
               t.currency, t.amount, t.payee, t.note, t.tags
        FROM transactions t
        LEFT JOIN accounts a ON t.account_id = a.id
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.user_id = ${userId}
          ${payee ? sql`AND t.payee ILIKE ${"%" + payee + "%"}` : sql``}
          ${min_amount !== undefined ? sql`AND t.amount >= ${min_amount}` : sql``}
          ${max_amount !== undefined ? sql`AND t.amount <= ${max_amount}` : sql``}
          ${start_date ? sql`AND t.date >= ${start_date}` : sql``}
          ${end_date ? sql`AND t.date <= ${end_date}` : sql``}
          ${category ? sql`AND c.name = ${category}` : sql``}
          ${tags ? sql`AND t.tags ILIKE ${"%" + tags + "%"}` : sql``}
        ORDER BY t.date DESC
        LIMIT ${lim}
      `);
      return text({ results: rows, count: rows.length });
    }
  );

  // ── get_budget_summary ─────────────────────────────────────────────────────
  server.tool(
    "get_budget_summary",
    "Get budget vs actual spending for a specific month",
    { month: z.string().describe("Month in YYYY-MM format") },
    async ({ month }) => {
      const [y, m] = month.split("-").map(Number);
      const startDate = `${month}-01`;
      const endDate = `${month}-${new Date(y, m, 0).getDate()}`;
      const rows = await q(db, sql`
        SELECT b.id, c.name AS category, c."group" AS category_group,
               b.amount AS budget,
               COALESCE(ABS(SUM(CASE WHEN t.date >= ${startDate} AND t.date <= ${endDate} THEN t.amount ELSE 0 END)), 0) AS spent
        FROM budgets b
        JOIN categories c ON b.category_id = c.id AND c.user_id = ${userId}
        LEFT JOIN transactions t ON t.category_id = c.id AND t.user_id = ${userId}
        WHERE b.month = ${month} AND b.user_id = ${userId}
        GROUP BY b.id, c.name, c."group", b.amount
        ORDER BY c."group", c.name
      `);
      return text(rows);
    }
  );

  // ── get_spending_trends ────────────────────────────────────────────────────
  server.tool(
    "get_spending_trends",
    "Get spending trends over time grouped by category",
    {
      period: z.enum(["weekly", "monthly", "yearly"]).describe("Aggregation period"),
      months: z.number().optional().describe("Months to look back (default 12)"),
    },
    async ({ period, months }) => {
      const lookback = months ?? 12;
      const startDate = new Date(new Date().getFullYear(), new Date().getMonth() - lookback, 1)
        .toISOString().split("T")[0];

      // Postgres date truncation
      const truncExpr = period === "weekly"
        ? sql`TO_CHAR(DATE_TRUNC('week', t.date::date), 'IYYY-IW')`
        : period === "yearly"
        ? sql`TO_CHAR(t.date::date, 'YYYY')`
        : sql`TO_CHAR(t.date::date, 'YYYY-MM')`;

      const rows = await q(db, sql`
        SELECT ${truncExpr} AS period, c.name AS category, c."group" AS category_group,
               SUM(t.amount) AS total
        FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.user_id = ${userId} AND t.date >= ${startDate} AND c.type = 'E'
        GROUP BY ${truncExpr}, c.name, c."group"
        ORDER BY period, total
      `);
      return text(rows);
    }
  );

  // ── get_income_statement ───────────────────────────────────────────────────
  server.tool(
    "get_income_statement",
    "Generate income statement for a period",
    {
      start_date: z.string().describe("Start date"),
      end_date: z.string().describe("End date"),
    },
    async ({ start_date, end_date }) => {
      const rows = await q(db, sql`
        SELECT c.type AS category_type, c."group" AS category_group, c.name AS category,
               SUM(t.amount) AS total, COUNT(*) AS count
        FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.user_id = ${userId}
          AND t.date >= ${start_date}
          AND t.date <= ${end_date}
          AND c.type IN ('I','E')
        GROUP BY c.id, c.type, c."group", c.name
        ORDER BY c.type, c."group"
      `);
      return text(rows);
    }
  );

  // ── get_net_worth ──────────────────────────────────────────────────────────
  server.tool(
    "get_net_worth",
    "Calculate total net worth across all accounts",
    { currency: z.enum(["CAD", "USD", "all"]).optional().describe("Filter by currency") },
    async ({ currency }) => {
      const rows = await q(db, sql`
        SELECT a.type, a.currency, COALESCE(SUM(t.amount), 0) AS total
        FROM accounts a
        LEFT JOIN transactions t ON a.id = t.account_id AND t.user_id = ${userId}
        WHERE a.user_id = ${userId}
          ${currency && currency !== "all" ? sql`AND a.currency = ${currency}` : sql``}
        GROUP BY a.type, a.currency
      `) as { type: string; currency: string; total: number }[];

      const summary: Record<string, { assets: number; liabilities: number; net: number }> = {};
      for (const row of rows) {
        const c = row.currency ?? "CAD";
        if (!summary[c]) summary[c] = { assets: 0, liabilities: 0, net: 0 };
        if (row.type === "A") summary[c].assets = Number(row.total);
        else summary[c].liabilities = Number(row.total);
        summary[c].net = summary[c].assets + summary[c].liabilities;
      }
      return text(summary);
    }
  );

  // ── get_net_worth_trend ────────────────────────────────────────────────────
  server.tool(
    "get_net_worth_trend",
    "Get net worth over the last N months",
    {
      months: z.number().optional().describe("Months to look back (default 12)"),
      currency: z.enum(["CAD", "USD", "all"]).optional().describe("Filter by currency"),
    },
    async ({ months, currency }) => {
      const lookback = months ?? 12;
      const startDate = new Date();
      startDate.setMonth(startDate.getMonth() - lookback);
      const startStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}-01`;

      const rows = await q(db, sql`
        SELECT TO_CHAR(t.date::date, 'YYYY-MM') AS month, a.currency, SUM(t.amount) AS total
        FROM transactions t
        LEFT JOIN accounts a ON t.account_id = a.id
        WHERE t.user_id = ${userId} AND t.date >= ${startStr}
          ${currency && currency !== "all" ? sql`AND a.currency = ${currency}` : sql``}
        GROUP BY TO_CHAR(t.date::date, 'YYYY-MM'), a.currency
        ORDER BY month
      `) as { month: string; currency: string; total: number }[];

      const baselines = await q(db, sql`
        SELECT a.currency, COALESCE(SUM(t.amount), 0) AS total
        FROM transactions t
        LEFT JOIN accounts a ON t.account_id = a.id
        WHERE t.user_id = ${userId} AND t.date < ${startStr}
          ${currency && currency !== "all" ? sql`AND a.currency = ${currency}` : sql``}
        GROUP BY a.currency
      `) as { currency: string; total: number }[];

      const running = new Map<string, number>();
      for (const b of baselines) running.set(b.currency, Number(b.total));

      const trend = rows.map(row => {
        const c = row.currency ?? "CAD";
        const prev = running.get(c) ?? 0;
        const newTotal = prev + Number(row.total);
        running.set(c, newTotal);
        return { month: row.month, currency: c, monthlyChange: Math.round(Number(row.total) * 100) / 100, cumulativeNetWorth: Math.round(newTotal * 100) / 100 };
      });

      return text({ months: lookback, trend });
    }
  );

  // ── get_goals ─────────────────────────────────────────────────────────────
  server.tool("get_goals", "Get all financial goals with progress", {}, async () => {
    const rows = await q(db, sql`
      SELECT g.id, g.name, g.type, g.target_amount, g.deadline, g.status, g.priority,
             a.name AS account
      FROM goals g
      LEFT JOIN accounts a ON g.account_id = a.id
      WHERE g.user_id = ${userId}
      ORDER BY g.priority
    `);
    return text(rows);
  });

  // ── get_portfolio_summary ──────────────────────────────────────────────────
  server.tool("get_portfolio_summary", "Get all investment holdings grouped by account", {}, async () => {
    const rows = await q(db, sql`
      SELECT ph.name AS holding, ph.symbol, ph.currency, a.name AS account
      FROM portfolio_holdings ph
      LEFT JOIN accounts a ON ph.account_id = a.id
      WHERE ph.user_id = ${userId}
      ORDER BY a.name, ph.name
    `);
    return text(rows);
  });

  // ── get_categories ─────────────────────────────────────────────────────────
  server.tool("get_categories", "List all available transaction categories", {}, async () => {
    const rows = await q(db, sql`
      SELECT name, type, "group"
      FROM categories
      WHERE user_id = ${userId}
      ORDER BY type, "group", name
    `);
    return text(rows);
  });

  // ── get_loans ─────────────────────────────────────────────────────────────
  server.tool("get_loans", "Get all loans with amortization summary", {}, async () => {
    const rows = await q(db, sql`
      SELECT id, name, type, principal, annual_rate, term_months, start_date,
             payment_frequency, extra_payment
      FROM loans
      WHERE user_id = ${userId}
    `);
    return text(rows);
  });

  // ── get_subscription_summary ───────────────────────────────────────────────
  server.tool(
    "get_subscription_summary",
    "Get all tracked subscriptions with total monthly cost and upcoming renewals",
    {},
    async () => {
      const subs = await q(db, sql`
        SELECT s.id, s.name, s.amount, s.currency, s.frequency, s.next_date, s.status,
               c.name AS category_name
        FROM subscriptions s
        LEFT JOIN categories c ON s.category_id = c.id
        WHERE s.user_id = ${userId}
        ORDER BY s.status, s.name
      `);

      const active = subs.filter(s => s.status === "active");
      const freqMult: Record<string, number> = { weekly: 4.33, monthly: 1, quarterly: 1/3, annual: 1/12, yearly: 1/12 };
      const totalMonthlyCost = active.reduce((sum, s) => sum + Number(s.amount) * (freqMult[s.frequency] ?? 1), 0);

      const today = new Date().toISOString().split("T")[0];
      const thirtyDays = new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];
      const upcoming = active
        .filter(s => s.next_date && s.next_date >= today && s.next_date <= thirtyDays)
        .map(s => ({ name: s.name, amount: s.amount, date: s.next_date, currency: s.currency }))
        .sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")));

      return text({ totalMonthlyCost: Math.round(totalMonthlyCost * 100) / 100, totalAnnualCost: Math.round(totalMonthlyCost * 12 * 100) / 100, activeCount: active.length, totalCount: subs.length, upcomingRenewals: upcoming, subscriptions: subs });
    }
  );

  // ── get_recurring_transactions ─────────────────────────────────────────────
  server.tool(
    "get_recurring_transactions",
    "Get detected recurring transactions (subscriptions, bills, salary)",
    {},
    async () => {
      const cutoff = new Date();
      cutoff.setFullYear(cutoff.getFullYear() - 1);
      const cutoffStr = cutoff.toISOString().split("T")[0];

      const txns = await q(db, sql`
        SELECT id, date, payee, amount FROM transactions
        WHERE user_id = ${userId} AND date >= ${cutoffStr} AND payee != ''
        ORDER BY date
      `) as { id: number; date: string; payee: string; amount: number }[];

      const groups = new Map<string, typeof txns>();
      for (const t of txns) {
        const key = t.payee.trim().toLowerCase();
        groups.set(key, [...(groups.get(key) ?? []), t]);
      }

      const recurring = [];
      for (const [, group] of groups) {
        if (group.length < 3) continue;
        const avg = group.reduce((s, t) => s + Number(t.amount), 0) / group.length;
        if (Math.abs(avg) < 0.01) continue;
        const consistent = group.every(t => Math.abs(Number(t.amount) - avg) / Math.abs(avg) < 0.2);
        if (consistent) {
          recurring.push({ payee: group[0].payee, avgAmount: Math.round(avg * 100) / 100, count: group.length, lastDate: group[group.length - 1].date });
        }
      }
      return text(recurring);
    }
  );

  // ── get_financial_health_score ─────────────────────────────────────────────
  server.tool(
    "get_financial_health_score",
    "Calculate a financial health score 0-100 with breakdown by component",
    {},
    async () => {
      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const threeAgo = new Date(now); threeAgo.setMonth(threeAgo.getMonth() - 3);
      const threeStart = `${threeAgo.getFullYear()}-${String(threeAgo.getMonth() + 1).padStart(2, "0")}-01`;

      const incomeExpenses = await q(db, sql`
        SELECT TO_CHAR(t.date::date, 'YYYY-MM') AS month, c.type AS cat_type, SUM(t.amount) AS total
        FROM transactions t LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.user_id = ${userId} AND t.date >= ${threeStart} AND c.type IN ('E','I')
        GROUP BY TO_CHAR(t.date::date, 'YYYY-MM'), c.type
      `) as { month: string; cat_type: string; total: number }[];

      let totalIncome = 0, totalExpenses = 0;
      for (const r of incomeExpenses) {
        if (r.cat_type === "I") totalIncome += Number(r.total);
        if (r.cat_type === "E") totalExpenses += Math.abs(Number(r.total));
      }

      const savingsRateScore = totalIncome > 0 ? Math.min(100, Math.max(0, ((totalIncome - totalExpenses) / totalIncome) * 500)) : 0;

      const balances = await q(db, sql`
        SELECT a.type, a."group", COALESCE(SUM(t.amount), 0) AS balance
        FROM accounts a LEFT JOIN transactions t ON a.id = t.account_id AND t.user_id = ${userId}
        WHERE a.user_id = ${userId}
        GROUP BY a.id, a.type, a."group"
      `) as { type: string; group: string; balance: number }[];

      const totalLiabilities = balances.filter(b => b.type === "L").reduce((s, b) => s + Math.abs(Number(b.balance)), 0);
      const annualIncome = totalIncome > 0 ? (totalIncome / 3) * 12 : 0;
      const dtiScore = annualIncome > 0 ? Math.min(100, Math.max(0, (1 - totalLiabilities / annualIncome) * 100)) : (totalLiabilities === 0 ? 100 : 0);

      const avgMonthlyExpenses = totalExpenses / 3;
      const liquidAssets = balances
        .filter(b => b.type === "A" && !b.group.toLowerCase().includes("invest") && !b.group.toLowerCase().includes("retire"))
        .reduce((s, b) => s + Number(b.balance), 0);
      const emergencyScore = avgMonthlyExpenses > 0 ? Math.min(100, Math.max(0, (liquidAssets / avgMonthlyExpenses / 6) * 100)) : (liquidAssets > 0 ? 50 : 0);

      const budgetsData = await q(db, sql`
        SELECT b.id, b.amount AS budget,
               COALESCE(ABS(SUM(CASE WHEN t.date >= ${currentMonth + "-01"} AND t.date <= ${currentMonth + "-31"} THEN t.amount ELSE 0 END)), 0) AS spent
        FROM budgets b
        JOIN categories c ON b.category_id = c.id AND c.user_id = ${userId}
        LEFT JOIN transactions t ON t.category_id = c.id AND t.user_id = ${userId}
        WHERE b.month = ${currentMonth} AND b.user_id = ${userId}
        GROUP BY b.id, b.amount
      `) as { budget: number; spent: number }[];

      const budgetScore = budgetsData.length > 0
        ? Math.round((budgetsData.filter(b => Number(b.spent) <= Math.abs(Number(b.budget))).length / budgetsData.length) * 100)
        : 50;

      const components = [
        { name: "Savings Rate", score: Math.round(savingsRateScore), weight: 0.3, weighted: Math.round(savingsRateScore * 0.3), detail: totalIncome > 0 ? `${Math.round(((totalIncome - totalExpenses) / totalIncome) * 100)}% savings rate` : "No income data" },
        { name: "Debt-to-Income", score: Math.round(dtiScore), weight: 0.2, weighted: Math.round(dtiScore * 0.2), detail: annualIncome > 0 ? `${Math.round((totalLiabilities / annualIncome) * 100)}% debt-to-income` : "No income data" },
        { name: "Emergency Fund", score: Math.round(emergencyScore), weight: 0.2, weighted: Math.round(emergencyScore * 0.2), detail: avgMonthlyExpenses > 0 ? `${(liquidAssets / avgMonthlyExpenses).toFixed(1)} months covered` : "No expense data" },
        { name: "Net Worth Trend", score: 50, weight: 0.15, weighted: 8, detail: "Tracking" },
        { name: "Budget Adherence", score: budgetScore, weight: 0.15, weighted: Math.round(budgetScore * 0.15), detail: budgetsData.length > 0 ? `${budgetsData.filter(b => Number(b.spent) <= Math.abs(Number(b.budget))).length}/${budgetsData.length} on track` : "No budgets set" },
      ];

      const totalScore = components.reduce((s, c) => s + c.weighted, 0);
      const grade = totalScore >= 80 ? "Excellent" : totalScore >= 60 ? "Good" : totalScore >= 40 ? "Fair" : "Needs Work";

      return text({ score: Math.min(100, Math.max(0, totalScore)), grade, components });
    }
  );

  // ── get_spending_anomalies ─────────────────────────────────────────────────
  server.tool(
    "get_spending_anomalies",
    "Find spending categories with >30% deviation from their 3-month average",
    {},
    async () => {
      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const sixAgo = new Date(now); sixAgo.setMonth(sixAgo.getMonth() - 6);
      const startDate = `${sixAgo.getFullYear()}-${String(sixAgo.getMonth() + 1).padStart(2, "0")}-01`;

      const rows = await q(db, sql`
        SELECT TO_CHAR(t.date::date, 'YYYY-MM') AS month, c.name AS category, SUM(t.amount) AS total
        FROM transactions t LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.user_id = ${userId} AND t.date >= ${startDate} AND c.type = 'E'
        GROUP BY TO_CHAR(t.date::date, 'YYYY-MM'), c.name
        ORDER BY month
      `) as { month: string; category: string; total: number }[];

      const byCategory = new Map<string, typeof rows>();
      for (const row of rows) {
        byCategory.set(row.category, [...(byCategory.get(row.category) ?? []), row]);
      }

      const anomalies = [];
      for (const [category, catRows] of byCategory) {
        const current = catRows.find(r => r.month === currentMonth);
        if (!current) continue;
        const previous = catRows.filter(r => r.month < currentMonth).slice(-3);
        if (previous.length < 2) continue;
        const avg = previous.reduce((s, r) => s + Math.abs(Number(r.total)), 0) / previous.length;
        if (avg <= 0) continue;
        const pctAbove = ((Math.abs(Number(current.total)) - avg) / avg) * 100;
        if (Math.abs(pctAbove) > 30) {
          anomalies.push({ category, currentMonthSpend: Math.round(Math.abs(Number(current.total)) * 100) / 100, threeMonthAvg: Math.round(avg * 100) / 100, percentDeviation: Math.round(pctAbove), direction: pctAbove > 0 ? "above_average" : "below_average", severity: Math.abs(pctAbove) > 75 ? "alert" : "warning" });
        }
      }

      anomalies.sort((a, b) => Math.abs(b.percentDeviation) - Math.abs(a.percentDeviation));
      return text({ month: currentMonth, anomalies, count: anomalies.length });
    }
  );

  // ── get_spotlight_items ────────────────────────────────────────────────────
  server.tool(
    "get_spotlight_items",
    "Get current attention items — overspent budgets, upcoming bills, uncategorized transactions",
    {},
    async () => {
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const [y, m] = [now.getFullYear(), now.getMonth() + 1];
      const monthStart = `${month}-01`;
      const monthEnd = `${month}-${new Date(y, m, 0).getDate()}`;
      const today = now.toISOString().split("T")[0];
      const weekAhead = new Date(now.getTime() + 7 * 86400000).toISOString().split("T")[0];

      const items: { type: string; severity: string; title: string; description: string; amount?: number }[] = [];

      const budgetRows = await q(db, sql`
        SELECT c.name AS cat, b.amount AS budget,
               COALESCE(ABS(SUM(CASE WHEN t.date >= ${monthStart} AND t.date <= ${monthEnd} THEN t.amount ELSE 0 END)), 0) AS spent
        FROM budgets b LEFT JOIN categories c ON b.category_id = c.id AND c.user_id = ${userId}
        LEFT JOIN transactions t ON t.category_id = b.category_id AND t.user_id = ${userId}
        WHERE b.month = ${month} AND b.user_id = ${userId}
        GROUP BY c.name, b.amount
      `) as { cat: string; budget: number; spent: number }[];

      for (const r of budgetRows) {
        if (r.budget > 0 && Number(r.spent) > Number(r.budget)) {
          const pct = Math.round(((Number(r.spent) - Number(r.budget)) / Number(r.budget)) * 100);
          items.push({ type: "overspent_budget", severity: pct > 20 ? "critical" : "warning", title: `${r.cat} over budget`, description: `$${Number(r.spent).toFixed(2)} of $${Number(r.budget).toFixed(2)} (${pct}% over)`, amount: Number(r.spent) - Number(r.budget) });
        }
      }

      const subs = await q(db, sql`
        SELECT name, amount, next_date, frequency FROM subscriptions
        WHERE user_id = ${userId} AND status = 'active' AND next_date >= ${today} AND next_date <= ${weekAhead}
      `) as { name: string; amount: number; next_date: string; frequency: string }[];

      for (const s of subs) {
        if (Math.abs(Number(s.amount)) >= 100) {
          items.push({ type: "large_bill", severity: "warning", title: `${s.name} due soon`, description: `$${Math.abs(Number(s.amount)).toFixed(2)} ${s.frequency}`, amount: Math.abs(Number(s.amount)) });
        }
      }

      const uncatRow = await q(db, sql`
        SELECT COUNT(*) AS cnt FROM transactions
        WHERE user_id = ${userId} AND date >= ${monthStart} AND date <= ${monthEnd} AND category_id IS NULL
      `) as { cnt: string | number }[];

      const uncatCnt = Number(uncatRow[0]?.cnt ?? 0);
      if (uncatCnt > 0) {
        items.push({ type: "uncategorized", severity: uncatCnt > 10 ? "warning" : "info", title: `${uncatCnt} uncategorized transaction(s)`, description: "Categorize for better tracking" });
      }

      const order: Record<string, number> = { critical: 0, warning: 1, info: 2 };
      items.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
      return text(items);
    }
  );

  // ── get_weekly_recap ───────────────────────────────────────────────────────
  server.tool(
    "get_weekly_recap",
    "Get a weekly financial recap: spending summary, income, net cash flow, notable transactions",
    { date: z.string().optional().describe("End date for the week (YYYY-MM-DD). Defaults to current week.") },
    async ({ date }) => {
      const end = date ? new Date(date + "T00:00:00") : new Date();
      const dayOfWeek = end.getDay();
      const weekEnd = new Date(end); weekEnd.setDate(weekEnd.getDate() + (6 - dayOfWeek));
      const weekStart = new Date(weekEnd); weekStart.setDate(weekStart.getDate() - 6);
      const prevEnd = new Date(weekStart); prevEnd.setDate(prevEnd.getDate() - 1);
      const prevStart = new Date(prevEnd); prevStart.setDate(prevStart.getDate() - 6);

      const ws = weekStart.toISOString().split("T")[0];
      const we = weekEnd.toISOString().split("T")[0];
      const ps = prevStart.toISOString().split("T")[0];
      const pe = prevEnd.toISOString().split("T")[0];

      const spending = await q(db, sql`
        SELECT c.name, ABS(SUM(t.amount)) AS total
        FROM transactions t LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.user_id = ${userId} AND c.type = 'E' AND t.date >= ${ws} AND t.date <= ${we}
        GROUP BY c.id, c.name ORDER BY total DESC
      `) as { name: string; total: number }[];

      const totalSpent = spending.reduce((s, r) => s + Number(r.total), 0);

      const prevRow = await q(db, sql`
        SELECT ABS(SUM(t.amount)) AS total FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.user_id = ${userId} AND c.type = 'E' AND t.date >= ${ps} AND t.date <= ${pe}
      `) as { total: number }[];
      const prevTotal = Number(prevRow[0]?.total ?? 0);
      const changePct = prevTotal > 0 ? Math.round(((totalSpent - prevTotal) / prevTotal) * 100) : 0;

      const incRow = await q(db, sql`
        SELECT COALESCE(SUM(t.amount), 0) AS total FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.user_id = ${userId} AND c.type = 'I' AND t.date >= ${ws} AND t.date <= ${we}
      `) as { total: number }[];
      const income = Number(incRow[0]?.total ?? 0);

      const notable = await q(db, sql`
        SELECT t.date, t.payee, c.name AS category, ABS(t.amount) AS amt
        FROM transactions t LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.user_id = ${userId} AND c.type = 'E' AND t.date >= ${ws} AND t.date <= ${we}
        ORDER BY ABS(t.amount) DESC LIMIT 5
      `);

      return text({
        weekStart: ws, weekEnd: we,
        spending: { total: Math.round(totalSpent * 100) / 100, previousWeekTotal: Math.round(prevTotal * 100) / 100, changePercent: changePct, topCategories: spending.slice(0, 3) },
        income: Math.round(income * 100) / 100,
        netCashFlow: Math.round((income - totalSpent) * 100) / 100,
        notableTransactions: notable,
      });
    }
  );

  // ── get_cash_flow_forecast ─────────────────────────────────────────────────
  server.tool(
    "get_cash_flow_forecast",
    "Project cash flow for the next 30, 60, or 90 days based on recurring transactions",
    { days: z.number().optional().describe("Forecast horizon in days (default 90)") },
    async ({ days }) => {
      const horizon = days ?? 90;
      const cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - 1);
      const cutoffStr = cutoff.toISOString().split("T")[0];

      const txns = await q(db, sql`
        SELECT id, date, payee, amount FROM transactions
        WHERE user_id = ${userId} AND date >= ${cutoffStr} AND payee != ''
        ORDER BY date
      `) as { id: number; date: string; payee: string; amount: number }[];

      const groups = new Map<string, typeof txns>();
      for (const t of txns) {
        const key = t.payee.trim().toLowerCase();
        groups.set(key, [...(groups.get(key) ?? []), t]);
      }

      const recurring: { payee: string; avgAmount: number; frequency: string; lastDate: string; nextDate: string }[] = [];
      for (const [, group] of groups) {
        if (group.length < 3) continue;
        const avg = group.reduce((s, t) => s + Number(t.amount), 0) / group.length;
        if (Math.abs(avg) < 0.01) continue;
        const consistent = group.every(t => Math.abs(Number(t.amount) - avg) / Math.abs(avg) < 0.2);
        if (!consistent) continue;
        const sorted = [...group].sort((a, b) => a.date.localeCompare(b.date));
        const intervals: number[] = [];
        for (let i = 1; i < sorted.length; i++) {
          const d1 = new Date(sorted[i - 1].date + "T00:00:00").getTime();
          const d2 = new Date(sorted[i].date + "T00:00:00").getTime();
          intervals.push(Math.round((d2 - d1) / 86400000));
        }
        const avgInterval = intervals.reduce((s, d) => s + d, 0) / intervals.length;
        const freq = avgInterval <= 10 ? "weekly" : avgInterval <= 20 ? "biweekly" : avgInterval <= 45 ? "monthly" : "yearly";
        const lastDate = sorted[sorted.length - 1].date;
        const nextDate = new Date(new Date(lastDate + "T00:00:00").getTime() + avgInterval * 86400000).toISOString().split("T")[0];
        recurring.push({ payee: group[0].payee, avgAmount: Math.round(avg * 100) / 100, frequency: freq, lastDate, nextDate });
      }

      const bankRows = await q(db, sql`
        SELECT a.id FROM accounts a WHERE a.user_id = ${userId} AND a."group" IN ('Banks', 'Cash Accounts')
      `) as { id: number }[];

      let currentBalance = 0;
      for (const ba of bankRows) {
        const r = await q(db, sql`SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE user_id = ${userId} AND account_id = ${ba.id}`);
        currentBalance += Number(r[0]?.total ?? 0);
      }

      const today = new Date();
      const milestones: { date: string; balance: number; events: string[] }[] = [];
      let balance = currentBalance;

      for (let d = 1; d <= horizon; d++) {
        const date = new Date(today.getTime() + d * 86400000);
        const dateStr = date.toISOString().split("T")[0];
        const events: string[] = [];
        for (const r of recurring) {
          if (r.nextDate === dateStr) {
            balance += r.avgAmount;
            events.push(`${r.payee}: ${r.avgAmount > 0 ? "+" : ""}${r.avgAmount}`);
            const intervalDays = r.frequency === "weekly" ? 7 : r.frequency === "biweekly" ? 14 : r.frequency === "monthly" ? 30 : 365;
            r.nextDate = new Date(date.getTime() + intervalDays * 86400000).toISOString().split("T")[0];
          }
        }
        if (d === 30 || d === 60 || d === 90 || events.length > 0) {
          milestones.push({ date: dateStr, balance: Math.round(balance * 100) / 100, events });
        }
      }

      return text({
        currentBalance: Math.round(currentBalance * 100) / 100,
        daysAhead: horizon,
        projectedBalance: milestones.length > 0 ? milestones[milestones.length - 1].balance : currentBalance,
        warnings: milestones.filter(p => p.balance < 500).map(p => ({ date: p.date, balance: p.balance })),
        milestones: milestones.filter(p => [30, 60, 90].includes(Math.round((new Date(p.date).getTime() - today.getTime()) / 86400000))),
        recurringItems: recurring.length,
      });
    }
  );

  // ── add_transaction ────────────────────────────────────────────────────────
  server.tool(
    "add_transaction",
    "Add a new transaction. Use negative amounts for expenses, positive for income.",
    {
      date: z.string().describe("Transaction date (YYYY-MM-DD)"),
      account: z.string().describe("Account name"),
      category: z.string().describe("Category name"),
      amount: z.number().describe("Amount (negative for expense, positive for income)"),
      payee: z.string().optional().describe("Payee/merchant name"),
      note: z.string().optional().describe("Optional note"),
      tags: z.string().optional().describe("Comma-separated tags"),
    },
    async ({ date, account, category, amount, payee, note, tags }) => {
      const acctRows = await q(db, sql`SELECT id, currency FROM accounts WHERE user_id = ${userId} AND name = ${account}`);
      if (!acctRows.length) return err(`Account "${account}" not found`);
      const acct = acctRows[0] as { id: number; currency: string };

      const catRows = await q(db, sql`SELECT id FROM categories WHERE user_id = ${userId} AND name = ${category}`);
      if (!catRows.length) return err(`Category "${category}" not found`);
      const cat = catRows[0] as { id: number };

      await db.execute(sql`
        INSERT INTO transactions (user_id, date, account_id, category_id, currency, amount, payee, note, tags)
        VALUES (${userId}, ${date}, ${acct.id}, ${cat.id}, ${acct.currency}, ${amount}, ${payee ?? ""}, ${note ?? ""}, ${tags ?? ""})
      `);

      return text({ success: true, message: `Transaction added: ${amount} to ${account} (${category}) on ${date}` });
    }
  );

  // ── set_budget ─────────────────────────────────────────────────────────────
  server.tool(
    "set_budget",
    "Set or update a budget for a category in a specific month",
    {
      category: z.string().describe("Category name"),
      month: z.string().describe("Month (YYYY-MM)"),
      amount: z.number().describe("Budget amount (positive number)"),
    },
    async ({ category, month, amount }) => {
      const catRows = await q(db, sql`SELECT id FROM categories WHERE user_id = ${userId} AND name = ${category}`);
      if (!catRows.length) return err(`Category "${category}" not found`);
      const cat = catRows[0] as { id: number };

      const existing = await q(db, sql`SELECT id FROM budgets WHERE user_id = ${userId} AND category_id = ${cat.id} AND month = ${month}`);
      if (existing.length) {
        await db.execute(sql`UPDATE budgets SET amount = ${amount} WHERE id = ${existing[0].id}`);
      } else {
        await db.execute(sql`INSERT INTO budgets (user_id, category_id, month, amount) VALUES (${userId}, ${cat.id}, ${month}, ${amount})`);
      }
      return text({ success: true, message: `Budget set: ${category} = $${amount} for ${month}` });
    }
  );

  // ── add_goal ───────────────────────────────────────────────────────────────
  server.tool(
    "add_goal",
    "Create a new financial goal",
    {
      name: z.string().describe("Goal name"),
      type: z.enum(["savings", "debt_payoff", "investment", "emergency_fund"]).describe("Goal type"),
      target_amount: z.number().describe("Target amount"),
      deadline: z.string().optional().describe("Deadline (YYYY-MM-DD)"),
      account: z.string().optional().describe("Account name to link"),
    },
    async ({ name, type, target_amount, deadline, account }) => {
      let accountId: number | null = null;
      if (account) {
        const acctRows = await q(db, sql`SELECT id FROM accounts WHERE user_id = ${userId} AND name = ${account}`);
        accountId = acctRows.length ? Number((acctRows[0] as { id: number }).id) : null;
      }
      await db.execute(sql`
        INSERT INTO goals (user_id, name, type, target_amount, deadline, account_id, status)
        VALUES (${userId}, ${name}, ${type}, ${target_amount}, ${deadline ?? null}, ${accountId}, 'active')
      `);
      return text({ success: true, message: `Goal created: "${name}" — target $${target_amount}${deadline ? ` by ${deadline}` : ""}` });
    }
  );

  // ── categorize_transaction ─────────────────────────────────────────────────
  server.tool(
    "categorize_transaction",
    "Update the category of a transaction by ID",
    {
      transaction_id: z.number().describe("Transaction ID"),
      category: z.string().describe("Category name to assign"),
    },
    async ({ transaction_id, category }) => {
      const catRows = await q(db, sql`SELECT id, name FROM categories WHERE user_id = ${userId} AND name = ${category}`);
      if (!catRows.length) return err(`Category "${category}" not found`);
      const cat = catRows[0] as { id: number; name: string };

      const txnRows = await q(db, sql`SELECT id, payee FROM transactions WHERE user_id = ${userId} AND id = ${transaction_id}`);
      if (!txnRows.length) return err(`Transaction #${transaction_id} not found`);
      const txn = txnRows[0] as { id: number; payee: string };

      await db.execute(sql`UPDATE transactions SET category_id = ${cat.id} WHERE id = ${transaction_id} AND user_id = ${userId}`);
      return text({ success: true, transactionId: transaction_id, newCategory: cat.name, message: `Transaction #${transaction_id} (${txn.payee}) categorized as "${cat.name}"` });
    }
  );

  // ── add_account ────────────────────────────────────────────────────────────
  server.tool(
    "add_account",
    "Create a new financial account (bank, investment, credit card, etc.)",
    {
      name: z.string().describe("Account name (must be unique)"),
      type: z.enum(["A", "L"]).describe("Account type: 'A' for asset, 'L' for liability"),
      group: z.string().optional().describe("Account group (e.g. 'Banks', 'Credit Cards', 'Investment')"),
      currency: z.enum(["CAD", "USD"]).optional().describe("Currency (default CAD)"),
      note: z.string().optional().describe("Optional note"),
    },
    async ({ name, type, group, currency, note }) => {
      const existing = await q(db, sql`SELECT id FROM accounts WHERE user_id = ${userId} AND name = ${name}`);
      if (existing.length) return err(`Account "${name}" already exists (id: ${existing[0].id})`);

      const result = await q(db, sql`
        INSERT INTO accounts (user_id, type, "group", name, currency, note)
        VALUES (${userId}, ${type}, ${group ?? ""}, ${name}, ${currency ?? "CAD"}, ${note ?? ""})
        RETURNING id
      `);

      return text({ success: true, accountId: result[0]?.id, message: `Account "${name}" created (${type === "A" ? "asset" : "liability"}, ${currency ?? "CAD"})` });
    }
  );
}
