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

/** Fuzzy name → row match: exact → startsWith → contains → reverse-contains */
function fuzzyFind(input: string, options: Row[]): Row | null {
  if (!input || !options.length) return null;
  const lo = input.toLowerCase().trim();
  return (
    options.find(o => String(o.name ?? "").toLowerCase() === lo) ??
    options.find(o => String(o.name ?? "").toLowerCase().startsWith(lo)) ??
    options.find(o => String(o.name ?? "").toLowerCase().includes(lo)) ??
    options.find(o => lo.includes(String(o.name ?? "").toLowerCase())) ??
    null
  );
}

/** Auto-categorize payee: transaction_rules → historical frequency */
async function autoCategory(db: DbLike, userId: string, payee: string): Promise<number | null> {
  if (!payee) return null;
  const lo = `%${payee.toLowerCase()}%`;
  const rules = await q(db, sql`
    SELECT assign_category_id FROM transaction_rules
    WHERE user_id = ${userId} AND is_active = 1
      AND (LOWER(match_payee) LIKE ${lo} OR LOWER(${payee}) LIKE LOWER(match_payee))
    ORDER BY priority DESC LIMIT 1
  `);
  if (rules.length && rules[0].assign_category_id) return Number(rules[0].assign_category_id);
  const hist = await q(db, sql`
    SELECT category_id, COUNT(*) as cnt FROM transactions
    WHERE user_id = ${userId} AND LOWER(payee) = LOWER(${payee}) AND category_id IS NOT NULL
    GROUP BY category_id ORDER BY cnt DESC LIMIT 1
  `);
  return hist.length ? Number(hist[0].category_id) : null;
}

/** Most-recently-used account for the user */
async function defaultAccount(db: DbLike, userId: string): Promise<Row | null> {
  const r = await q(db, sql`
    SELECT a.id, a.name, a.currency FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    WHERE t.user_id = ${userId}
    ORDER BY t.date DESC, t.id DESC LIMIT 1
  `);
  return r.length ? r[0] : null;
}

const PORTFOLIO_DISCLAIMER =
  "⚠️ DISCLAIMER: This analysis is for informational purposes only and does not constitute financial advice. Past performance is not indicative of future results. Consult a qualified financial advisor before making investment decisions.";

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

  // ── record_transaction ─────────────────────────────────────────────────────
  server.tool(
    "record_transaction",
    "Record a transaction with smart defaults: fuzzy account/category matching, auto-categorize from payee, defaults to most-recent account.",
    {
      amount: z.number().describe("Amount (negative=expense, positive=income/transfer-in)"),
      payee: z.string().describe("Payee or merchant name"),
      date: z.string().optional().describe("YYYY-MM-DD (default: today)"),
      account: z.string().optional().describe("Account name (default: most-recently-used)"),
      category: z.string().optional().describe("Category name (auto-detected from payee if omitted)"),
      note: z.string().optional().describe("Optional note"),
      tags: z.string().optional().describe("Comma-separated tags"),
    },
    async ({ amount, payee, date, account, category, note, tags }) => {
      const today = new Date().toISOString().split("T")[0];
      const txDate = date ?? today;

      // Resolve account (fuzzy or MRU)
      const allAccounts = await q(db, sql`SELECT id, name, currency FROM accounts WHERE user_id = ${userId}`);
      let acct: Row | null = account ? fuzzyFind(account, allAccounts) : await defaultAccount(db, userId);
      if (!acct) return err(account ? `Account "${account}" not found. Available: ${allAccounts.map(a => a.name).join(", ")}` : "No accounts found — create an account first.");

      // Resolve category (fuzzy or auto)
      let catId: number | null = null;
      if (category) {
        const allCats = await q(db, sql`SELECT id, name FROM categories WHERE user_id = ${userId}`);
        const cat = fuzzyFind(category, allCats);
        if (!cat) return err(`Category "${category}" not found. Available: ${allCats.map(c => c.name).join(", ")}`);
        catId = Number(cat.id);
      } else {
        catId = await autoCategory(db, userId, payee);
      }

      const result = await q(db, sql`
        INSERT INTO transactions (user_id, date, account_id, category_id, currency, amount, payee, note, tags)
        VALUES (${userId}, ${txDate}, ${acct.id}, ${catId}, ${acct.currency}, ${amount}, ${payee}, ${note ?? ""}, ${tags ?? ""})
        RETURNING id
      `);

      const catName = catId ? (await q(db, sql`SELECT name FROM categories WHERE id = ${catId}`))[0]?.name : "uncategorized";
      return text({
        success: true,
        transactionId: result[0]?.id,
        message: `Recorded: ${amount > 0 ? "+" : ""}${amount} on ${txDate} — "${payee}" → ${acct.name} (${catName})`,
      });
    }
  );

  // ── bulk_record_transactions ───────────────────────────────────────────────
  server.tool(
    "bulk_record_transactions",
    "Record multiple transactions at once. Same smart defaults as record_transaction.",
    {
      transactions: z.array(z.object({
        amount: z.number(),
        payee: z.string(),
        date: z.string().optional(),
        account: z.string().optional(),
        category: z.string().optional(),
        note: z.string().optional(),
        tags: z.string().optional(),
      })).describe("Array of transactions to record"),
    },
    async ({ transactions }) => {
      const today = new Date().toISOString().split("T")[0];
      const allAccounts = await q(db, sql`SELECT id, name, currency FROM accounts WHERE user_id = ${userId}`);
      const allCats = await q(db, sql`SELECT id, name FROM categories WHERE user_id = ${userId}`);
      const mru = await defaultAccount(db, userId);

      const results: { index: number; success: boolean; message: string }[] = [];
      for (let i = 0; i < transactions.length; i++) {
        const t = transactions[i];
        try {
          const acct = t.account ? fuzzyFind(t.account, allAccounts) : mru;
          if (!acct) { results.push({ index: i, success: false, message: `Account not found: "${t.account}"` }); continue; }

          let catId: number | null = null;
          if (t.category) {
            const cat = fuzzyFind(t.category, allCats);
            catId = cat ? Number(cat.id) : null;
          } else {
            catId = await autoCategory(db, userId, t.payee);
          }

          await db.execute(sql`
            INSERT INTO transactions (user_id, date, account_id, category_id, currency, amount, payee, note, tags)
            VALUES (${userId}, ${t.date ?? today}, ${acct.id}, ${catId}, ${acct.currency}, ${t.amount}, ${t.payee}, ${t.note ?? ""}, ${t.tags ?? ""})
          `);
          results.push({ index: i, success: true, message: `${t.payee}: ${t.amount}` });
        } catch (e) {
          results.push({ index: i, success: false, message: String(e) });
        }
      }

      const ok = results.filter(r => r.success).length;
      return text({ imported: ok, failed: results.length - ok, results });
    }
  );

  // ── update_transaction ─────────────────────────────────────────────────────
  server.tool(
    "update_transaction",
    "Update fields of an existing transaction by ID",
    {
      id: z.number().describe("Transaction ID"),
      date: z.string().optional(),
      amount: z.number().optional(),
      payee: z.string().optional(),
      category: z.string().optional().describe("Category name (fuzzy matched)"),
      note: z.string().optional(),
      tags: z.string().optional(),
    },
    async ({ id, date, amount, payee, category, note, tags }) => {
      const existing = await q(db, sql`SELECT id FROM transactions WHERE user_id = ${userId} AND id = ${id}`);
      if (!existing.length) return err(`Transaction #${id} not found`);

      let catId: number | undefined;
      if (category !== undefined) {
        const allCats = await q(db, sql`SELECT id, name FROM categories WHERE user_id = ${userId}`);
        const cat = fuzzyFind(category, allCats);
        if (!cat) return err(`Category "${category}" not found`);
        catId = Number(cat.id);
      }

      // Build SET clause dynamically
      const updates: string[] = [];
      if (date !== undefined) updates.push(`date = '${date}'`);
      if (amount !== undefined) updates.push(`amount = ${amount}`);
      if (payee !== undefined) updates.push(`payee = '${payee.replace(/'/g, "''")}'`);
      if (catId !== undefined) updates.push(`category_id = ${catId}`);
      if (note !== undefined) updates.push(`note = '${note.replace(/'/g, "''")}'`);
      if (tags !== undefined) updates.push(`tags = '${tags.replace(/'/g, "''")}'`);

      if (!updates.length) return err("No fields to update");

      await db.execute(sql`UPDATE transactions SET ${sql.raw(updates.join(", "))} WHERE id = ${id} AND user_id = ${userId}`);
      return text({ success: true, message: `Transaction #${id} updated (${updates.length} field(s))` });
    }
  );

  // ── delete_transaction ─────────────────────────────────────────────────────
  server.tool(
    "delete_transaction",
    "Permanently delete a transaction by ID",
    {
      id: z.number().describe("Transaction ID to delete"),
    },
    async ({ id }) => {
      const existing = await q(db, sql`SELECT id, payee, amount, date FROM transactions WHERE user_id = ${userId} AND id = ${id}`);
      if (!existing.length) return err(`Transaction #${id} not found`);
      const t = existing[0];
      await db.execute(sql`DELETE FROM transactions WHERE id = ${id} AND user_id = ${userId}`);
      return text({ success: true, message: `Deleted transaction #${id}: "${t.payee}" ${t.amount} on ${t.date}` });
    }
  );

  // ── delete_budget ──────────────────────────────────────────────────────────
  server.tool(
    "delete_budget",
    "Delete a budget entry for a category/month",
    {
      category: z.string().describe("Category name"),
      month: z.string().describe("Month (YYYY-MM)"),
    },
    async ({ category, month }) => {
      const allCats = await q(db, sql`SELECT id, name FROM categories WHERE user_id = ${userId}`);
      const cat = fuzzyFind(category, allCats);
      if (!cat) return err(`Category "${category}" not found`);

      const existing = await q(db, sql`SELECT id FROM budgets WHERE user_id = ${userId} AND category_id = ${cat.id} AND month = ${month}`);
      if (!existing.length) return err(`No budget found for "${cat.name}" in ${month}`);

      await db.execute(sql`DELETE FROM budgets WHERE id = ${existing[0].id} AND user_id = ${userId}`);
      return text({ success: true, message: `Budget deleted: ${cat.name} for ${month}` });
    }
  );

  // ── update_account ─────────────────────────────────────────────────────────
  server.tool(
    "update_account",
    "Update name, group, currency, or note of an account",
    {
      account: z.string().describe("Current account name (fuzzy matched)"),
      name: z.string().optional().describe("New name"),
      group: z.string().optional().describe("New group"),
      currency: z.enum(["CAD", "USD"]).optional().describe("New currency"),
      note: z.string().optional().describe("New note"),
    },
    async ({ account, name, group, currency, note }) => {
      const allAccounts = await q(db, sql`SELECT id, name FROM accounts WHERE user_id = ${userId}`);
      const acct = fuzzyFind(account, allAccounts);
      if (!acct) return err(`Account "${account}" not found`);

      const updates: string[] = [];
      if (name !== undefined) updates.push(`name = '${name.replace(/'/g, "''")}'`);
      if (group !== undefined) updates.push(`"group" = '${group.replace(/'/g, "''")}'`);
      if (currency !== undefined) updates.push(`currency = '${currency}'`);
      if (note !== undefined) updates.push(`note = '${note.replace(/'/g, "''")}'`);
      if (!updates.length) return err("No fields to update");

      await db.execute(sql`UPDATE accounts SET ${sql.raw(updates.join(", "))} WHERE id = ${acct.id} AND user_id = ${userId}`);
      return text({ success: true, message: `Account "${acct.name}" updated` });
    }
  );

  // ── delete_account ─────────────────────────────────────────────────────────
  server.tool(
    "delete_account",
    "Delete an account (only if it has no transactions)",
    {
      account: z.string().describe("Account name (fuzzy matched)"),
      force: z.boolean().optional().describe("Delete even if transactions exist (moves them to uncategorized)"),
    },
    async ({ account, force }) => {
      const allAccounts = await q(db, sql`SELECT id, name FROM accounts WHERE user_id = ${userId}`);
      const acct = fuzzyFind(account, allAccounts);
      if (!acct) return err(`Account "${account}" not found`);

      const txnCount = await q(db, sql`SELECT COUNT(*) as cnt FROM transactions WHERE user_id = ${userId} AND account_id = ${acct.id}`);
      const count = Number(txnCount[0]?.cnt ?? 0);
      if (count > 0 && !force) {
        return err(`Account "${acct.name}" has ${count} transaction(s). Pass force=true to delete anyway.`);
      }

      await db.execute(sql`DELETE FROM accounts WHERE id = ${acct.id} AND user_id = ${userId}`);
      return text({ success: true, message: `Account "${acct.name}" deleted${count > 0 ? ` (${count} transactions also removed)` : ""}` });
    }
  );

  // ── update_goal ────────────────────────────────────────────────────────────
  server.tool(
    "update_goal",
    "Update a financial goal's target, deadline, or status",
    {
      goal: z.string().describe("Goal name (fuzzy matched)"),
      target_amount: z.number().optional(),
      deadline: z.string().optional().describe("YYYY-MM-DD"),
      status: z.enum(["active", "completed", "paused"]).optional(),
      name: z.string().optional().describe("Rename the goal"),
    },
    async ({ goal, target_amount, deadline, status, name }) => {
      const allGoals = await q(db, sql`SELECT id, name FROM goals WHERE user_id = ${userId}`);
      const g = fuzzyFind(goal, allGoals);
      if (!g) return err(`Goal "${goal}" not found`);

      const updates: string[] = [];
      if (name !== undefined) updates.push(`name = '${name.replace(/'/g, "''")}'`);
      if (target_amount !== undefined) updates.push(`target_amount = ${target_amount}`);
      if (deadline !== undefined) updates.push(`deadline = '${deadline}'`);
      if (status !== undefined) updates.push(`status = '${status}'`);
      if (!updates.length) return err("No fields to update");

      await db.execute(sql`UPDATE goals SET ${sql.raw(updates.join(", "))} WHERE id = ${g.id} AND user_id = ${userId}`);
      return text({ success: true, message: `Goal "${g.name}" updated` });
    }
  );

  // ── delete_goal ────────────────────────────────────────────────────────────
  server.tool(
    "delete_goal",
    "Delete a financial goal by name",
    {
      goal: z.string().describe("Goal name (fuzzy matched)"),
    },
    async ({ goal }) => {
      const allGoals = await q(db, sql`SELECT id, name FROM goals WHERE user_id = ${userId}`);
      const g = fuzzyFind(goal, allGoals);
      if (!g) return err(`Goal "${goal}" not found`);

      await db.execute(sql`DELETE FROM goals WHERE id = ${g.id} AND user_id = ${userId}`);
      return text({ success: true, message: `Goal "${g.name}" deleted` });
    }
  );

  // ── create_category ────────────────────────────────────────────────────────
  server.tool(
    "create_category",
    "Create a new transaction category",
    {
      name: z.string().describe("Category name (must be unique)"),
      type: z.enum(["E", "I", "T"]).describe("Type: 'E'=expense, 'I'=income, 'T'=transfer"),
      group: z.string().optional().describe("Group label (e.g. 'Housing', 'Food')"),
      note: z.string().optional(),
    },
    async ({ name, type, group, note }) => {
      const existing = await q(db, sql`SELECT id FROM categories WHERE user_id = ${userId} AND name = ${name}`);
      if (existing.length) return err(`Category "${name}" already exists`);

      const result = await q(db, sql`
        INSERT INTO categories (user_id, name, type, "group", note)
        VALUES (${userId}, ${name}, ${type}, ${group ?? ""}, ${note ?? ""})
        RETURNING id
      `);
      return text({ success: true, categoryId: result[0]?.id, message: `Category "${name}" created (${type === "E" ? "expense" : type === "I" ? "income" : "transfer"})` });
    }
  );

  // ── create_rule ────────────────────────────────────────────────────────────
  server.tool(
    "create_rule",
    "Create an auto-categorization rule for future imports",
    {
      match_payee: z.string().describe("Payee pattern to match (supports LIKE wildcards: %)"),
      assign_category: z.string().describe("Category name to assign (fuzzy matched)"),
      rename_to: z.string().optional().describe("Optionally rename matched payee to this"),
      assign_tags: z.string().optional().describe("Tags to assign (comma-separated)"),
      priority: z.number().optional().describe("Rule priority (higher = checked first, default 0)"),
    },
    async ({ match_payee, assign_category, rename_to, assign_tags, priority }) => {
      const allCats = await q(db, sql`SELECT id, name FROM categories WHERE user_id = ${userId}`);
      const cat = fuzzyFind(assign_category, allCats);
      if (!cat) return err(`Category "${assign_category}" not found`);

      await db.execute(sql`
        INSERT INTO transaction_rules (user_id, match_payee, assign_category_id, rename_to, assign_tags, priority, is_active)
        VALUES (${userId}, ${match_payee}, ${cat.id}, ${rename_to ?? null}, ${assign_tags ?? null}, ${priority ?? 0}, 1)
      `);
      return text({ success: true, message: `Rule created: "${match_payee}" → ${cat.name}${rename_to ? ` (rename to "${rename_to}")` : ""}` });
    }
  );

  // ── add_snapshot ───────────────────────────────────────────────────────────
  server.tool(
    "add_snapshot",
    "Record a net-worth snapshot for tracking wealth over time",
    {
      date: z.string().optional().describe("YYYY-MM-DD (default: today)"),
      note: z.string().optional(),
    },
    async ({ date, note }) => {
      const snapshotDate = date ?? new Date().toISOString().split("T")[0];
      const balances = await q(db, sql`
        SELECT a.currency, COALESCE(SUM(t.amount), 0) as balance
        FROM accounts a
        LEFT JOIN transactions t ON t.account_id = a.id AND t.user_id = ${userId}
        WHERE a.user_id = ${userId}
        GROUP BY a.id, a.currency
      `);
      const totalByCurrency: Record<string, number> = {};
      for (const b of balances) {
        totalByCurrency[b.currency] = (totalByCurrency[b.currency] ?? 0) + Number(b.balance);
      }
      await db.execute(sql`
        INSERT INTO net_worth_snapshots (user_id, date, balances, note)
        VALUES (${userId}, ${snapshotDate}, ${JSON.stringify(totalByCurrency)}, ${note ?? ""})
      `);
      return text({ success: true, date: snapshotDate, balances: totalByCurrency });
    }
  );

  // ── apply_rules_to_uncategorized ───────────────────────────────────────────
  server.tool(
    "apply_rules_to_uncategorized",
    "Run all active categorization rules against uncategorized transactions",
    {
      dry_run: z.boolean().optional().describe("Preview matches without saving (default false)"),
      limit: z.number().optional().describe("Max transactions to process (default 500)"),
    },
    async ({ dry_run, limit }) => {
      const maxRows = limit ?? 500;
      const txns = await q(db, sql`
        SELECT id, payee, amount FROM transactions
        WHERE user_id = ${userId} AND (category_id IS NULL OR category_id = 0)
        ORDER BY date DESC LIMIT ${maxRows}
      `);
      if (!txns.length) return text({ message: "No uncategorized transactions found", updated: 0 });

      const rules = await q(db, sql`
        SELECT match_payee, assign_category_id, rename_to, assign_tags, priority
        FROM transaction_rules WHERE user_id = ${userId} AND is_active = 1
        ORDER BY priority DESC
      `);

      let updated = 0;
      const preview: { id: number; payee: string; categoryId: number }[] = [];

      for (const txn of txns) {
        for (const rule of rules) {
          const pattern = String(rule.match_payee ?? "").toLowerCase().replace(/%/g, "");
          if (String(txn.payee).toLowerCase().includes(pattern)) {
            if (!dry_run) {
              await db.execute(sql`
                UPDATE transactions SET category_id = ${rule.assign_category_id}
                ${rule.rename_to ? sql`, payee = ${rule.rename_to}` : sql``}
                ${rule.assign_tags ? sql`, tags = ${rule.assign_tags}` : sql``}
                WHERE id = ${txn.id} AND user_id = ${userId}
              `);
            }
            preview.push({ id: Number(txn.id), payee: String(txn.payee), categoryId: Number(rule.assign_category_id) });
            updated++;
            break;
          }
        }
      }

      return text({
        dry_run: dry_run ?? false,
        updated,
        scanned: txns.length,
        matches: preview.slice(0, 20),
        message: dry_run ? `Would update ${updated} of ${txns.length} transactions` : `Updated ${updated} of ${txns.length} transactions`,
      });
    }
  );

  // ── finlynq_help ───────────────────────────────────────────────────────────
  server.tool(
    "finlynq_help",
    "Discover available tools, schema, and usage examples",
    {
      topic: z.enum(["tools", "schema", "examples", "write", "portfolio"]).optional().describe("Help topic (default: tools)"),
      tool_name: z.string().optional().describe("Get help for a specific tool"),
    },
    async ({ topic, tool_name }) => {
      if (tool_name) {
        const docs: Record<string, string> = {
          record_transaction: "record_transaction(amount, payee, date?, account?, category?, note?, tags?) — Smart defaults: account defaults to MRU, category auto-detected from payee rules/history.",
          bulk_record_transactions: "bulk_record_transactions(transactions[]) — Same smart defaults. Returns per-item success/failure.",
          update_transaction: "update_transaction(id, date?, amount?, payee?, category?, note?, tags?) — Update any field by transaction ID.",
          delete_transaction: "delete_transaction(id) — Permanently delete. Cannot be undone.",
          set_budget: "set_budget(category, month, amount) — Upsert budget. month=YYYY-MM.",
          delete_budget: "delete_budget(category, month) — Remove budget entry.",
          add_account: "add_account(name, type, group?, currency?, note?) — type: 'A'=asset, 'L'=liability.",
          update_account: "update_account(account, name?, group?, currency?, note?) — Fuzzy account name.",
          delete_account: "delete_account(account, force?) — force=true to delete with transactions.",
          add_goal: "add_goal(name, type, target_amount, deadline?, account?) — type: savings|debt_payoff|investment|emergency_fund.",
          update_goal: "update_goal(goal, target_amount?, deadline?, status?, name?) — status: active|completed|paused.",
          delete_goal: "delete_goal(goal) — Fuzzy goal name.",
          create_category: "create_category(name, type, group?, note?) — type: 'E'=expense, 'I'=income, 'T'=transfer.",
          create_rule: "create_rule(match_payee, assign_category, rename_to?, assign_tags?, priority?) — match_payee supports % wildcards.",
          apply_rules_to_uncategorized: "apply_rules_to_uncategorized(dry_run?, limit?) — Batch-apply rules to uncategorized transactions.",
          get_portfolio_analysis: "get_portfolio_analysis() — Holdings + allocation by asset class/currency. Includes disclaimer.",
          compare_to_benchmark: "compare_to_benchmark(benchmark?) — Compare portfolio vs index. benchmark: SP500|TSX|MSCI_WORLD.",
        };
        return text({ tool: tool_name, usage: docs[tool_name] ?? "No specific docs. Use topic='tools' for full list." });
      }

      const t = topic ?? "tools";

      if (t === "tools") {
        return text({
          read_tools: ["get_account_balances", "get_transactions", "search_transactions", "get_budget_summary", "get_spending_trends", "get_income_statement", "get_net_worth", "get_net_worth_trend", "get_goals", "get_portfolio_summary", "get_categories", "get_loans", "get_subscription_summary", "get_recurring_transactions", "get_financial_health_score", "get_spending_anomalies", "get_spotlight_items", "get_weekly_recap", "get_cash_flow_forecast"],
          write_tools: ["record_transaction", "bulk_record_transactions", "update_transaction", "delete_transaction", "add_transaction", "set_budget", "delete_budget", "add_account", "update_account", "delete_account", "add_goal", "update_goal", "delete_goal", "create_category", "create_rule", "add_snapshot", "apply_rules_to_uncategorized", "categorize_transaction"],
          portfolio_tools: ["get_portfolio_analysis", "get_portfolio_performance", "analyze_holding", "get_rebalancing_suggestions", "get_investment_insights", "compare_to_benchmark"],
          tip: "Use tool_name='record_transaction' for detailed usage of any tool",
        });
      }

      if (t === "write") {
        return text({
          primary_add: "record_transaction — smart defaults, fuzzy matching",
          bulk_add: "bulk_record_transactions — array of transactions",
          edits: ["update_transaction(id, ...fields)", "delete_transaction(id)", "categorize_transaction(id, category)"],
          budget: ["set_budget(category, month, amount)", "delete_budget(category, month)"],
          accounts: ["add_account(name, type)", "update_account(account, ...)", "delete_account(account)"],
          goals: ["add_goal(name, type, amount)", "update_goal(goal, ...)", "delete_goal(goal)"],
          categories: ["create_category(name, type)", "create_rule(match_payee, assign_category)"],
          note: "All name inputs use fuzzy matching — partial names work",
        });
      }

      if (t === "schema") {
        return text({
          key_tables: {
            transactions: "id, user_id, date, account_id, category_id, currency, amount, payee, note, tags, import_hash, fit_id",
            accounts: "id, user_id, type(A/L), group, name, currency, note",
            categories: "id, user_id, type(E/I/T), group, name, note",
            budgets: "id, user_id, category_id, month(YYYY-MM), amount, currency",
            goals: "id, user_id, name, type, target_amount, current_amount, deadline, status, account_id",
            transaction_rules: "id, user_id, match_payee, assign_category_id, rename_to, assign_tags, priority, is_active",
            portfolio_holdings: "id, user_id, account_id, name, symbol, currency, note",
          },
          amount_convention: "Negative=expense/debit, Positive=income/credit",
          date_format: "YYYY-MM-DD strings",
        });
      }

      if (t === "examples") {
        return text({
          examples: [
            { task: "Log a coffee purchase", call: 'record_transaction(amount=-5.50, payee="Tim Hortons")' },
            { task: "Log salary deposit", call: 'record_transaction(amount=3500, payee="Employer", category="Salary")' },
            { task: "Import bank statement rows", call: "bulk_record_transactions([{amount, payee, date, account}, ...])" },
            { task: "Set grocery budget", call: 'set_budget(category="Groceries", month="2026-04", amount=600)' },
            { task: "Fix wrong category", call: 'categorize_transaction(transaction_id=42, category="Restaurants")' },
            { task: "Auto-categorize backlog", call: "apply_rules_to_uncategorized(dry_run=true)" },
            { task: "Create savings goal", call: 'add_goal(name="Emergency Fund", type="emergency_fund", target_amount=10000)' },
            { task: "Analyze investments", call: "get_portfolio_analysis()" },
          ],
        });
      }

      if (t === "portfolio") {
        return text({
          tools: ["get_portfolio_analysis", "get_portfolio_performance", "analyze_holding", "get_rebalancing_suggestions", "get_investment_insights", "compare_to_benchmark"],
          disclaimer: PORTFOLIO_DISCLAIMER,
          note: "All portfolio tools return a disclaimer field. Not financial advice.",
        });
      }

      return text({ error: "Unknown topic" });
    }
  );

  // ── get_portfolio_analysis ─────────────────────────────────────────────────
  server.tool(
    "get_portfolio_analysis",
    "Portfolio holdings with all investment metrics: quantity, cost basis, avg cost, unrealized/realized gain, dividends, total return, % of portfolio",
    {},
    async () => {
      const metrics = await q(db, sql`
        SELECT
          portfolio_holding as name,
          SUM(CASE WHEN amount < 0 THEN quantity ELSE 0 END) as buy_qty,
          SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as buy_amount,
          SUM(CASE WHEN amount > 0 AND quantity < 0 THEN ABS(quantity) ELSE 0 END) as sell_qty,
          SUM(CASE WHEN amount > 0 AND quantity < 0 THEN amount ELSE 0 END) as sell_amount,
          SUM(CASE WHEN amount > 0 AND (quantity = 0 OR quantity IS NULL) THEN amount ELSE 0 END) as dividends,
          MIN(CASE WHEN amount < 0 THEN date ELSE NULL END) as first_purchase
        FROM transactions
        WHERE user_id = ${userId} AND portfolio_holding IS NOT NULL AND portfolio_holding != ''
        GROUP BY portfolio_holding
      `);

      const ph = await q(db, sql`
        SELECT ph.name, ph.symbol, ph.currency, a.name as account_name
        FROM portfolio_holdings ph
        JOIN accounts a ON a.id = ph.account_id
        WHERE ph.user_id = ${userId}
      `);
      const phMap = new Map(ph.map(p => [String(p.name), p]));

      const today = new Date();
      type HoldingResult = {
        name: unknown; symbol: unknown; account: unknown; currency: string;
        quantity: number; avgCostPerShare: number | null; totalCostBasis: number | null;
        lifetimeCostBasis: number; realizedGain: number; dividendsReceived: number;
        totalReturn: number | null; totalReturnPct: number | null;
        firstPurchaseDate: unknown; daysHeld: number | null;
      };
      const results: HoldingResult[] = [];

      for (const m of metrics) {
        const buyQty = Number(m.buy_qty ?? 0);
        const buyAmt = Number(m.buy_amount ?? 0);
        const sellQty = Number(m.sell_qty ?? 0);
        const sellAmt = Number(m.sell_amount ?? 0);
        const divs = Number(m.dividends ?? 0);
        const remainingQty = buyQty - sellQty;
        const avgCost = buyQty > 0 ? buyAmt / buyQty : null;
        const costBasis = avgCost !== null && remainingQty > 0 ? remainingQty * avgCost : null;
        const realizedGain = avgCost !== null ? sellAmt - (sellQty * avgCost) : 0;
        const totalReturn = realizedGain + divs; // unrealized excluded (no live prices in MCP)
        const totalReturnPct = buyAmt > 0 ? (totalReturn / buyAmt) * 100 : null;
        const fpDate = m.first_purchase ?? null;
        const daysHeld = fpDate ? Math.floor((today.getTime() - new Date(String(fpDate)).getTime()) / 86400000) : null;
        const info = phMap.get(String(m.name));

        results.push({
          name: m.name,
          symbol: info?.symbol ?? null,
          account: info?.account_name ?? null,
          currency: String(info?.currency ?? "CAD"),
          quantity: Math.round(remainingQty * 10000) / 10000,
          avgCostPerShare: avgCost ? Math.round(avgCost * 100) / 100 : null,
          totalCostBasis: costBasis ? Math.round(costBasis * 100) / 100 : null,
          lifetimeCostBasis: Math.round(buyAmt * 100) / 100,
          realizedGain: Math.round(realizedGain * 100) / 100,
          dividendsReceived: Math.round(divs * 100) / 100,
          totalReturn: Math.round(totalReturn * 100) / 100,
          totalReturnPct: totalReturnPct ? Math.round(totalReturnPct * 100) / 100 : null,
          firstPurchaseDate: fpDate,
          daysHeld,
        });
      }

      results.sort((a, b) => (b.lifetimeCostBasis ?? 0) - (a.lifetimeCostBasis ?? 0));

      const totalCostBasis = results.reduce((s, r) => s + (r.totalCostBasis ?? 0), 0);
      const totalLifetime = results.reduce((s, r) => s + r.lifetimeCostBasis, 0);
      const totalRealized = results.reduce((s, r) => s + r.realizedGain, 0);
      const totalDivs = results.reduce((s, r) => s + r.dividendsReceived, 0);
      const totalReturn = totalRealized + totalDivs;

      return text({
        disclaimer: PORTFOLIO_DISCLAIMER,
        note: "marketValue and unrealizedGain require live prices — not available in MCP. Use the portfolio page for full metrics.",
        totalHoldings: results.length,
        summary: {
          totalCostBasis: Math.round(totalCostBasis * 100) / 100,
          lifetimeCostBasis: Math.round(totalLifetime * 100) / 100,
          totalRealizedGain: Math.round(totalRealized * 100) / 100,
          totalDividends: Math.round(totalDivs * 100) / 100,
          totalReturn: Math.round(totalReturn * 100) / 100,
          totalReturnPct: totalLifetime > 0 ? Math.round((totalReturn / totalLifetime) * 10000) / 100 : null,
        },
        holdings: results,
      });
    }
  );

  // ── get_portfolio_performance ──────────────────────────────────────────────
  server.tool(
    "get_portfolio_performance",
    "Portfolio performance with avg-cost method: realized P&L, dividends, total return, days held per holding",
    {
      period: z.enum(["1m", "3m", "6m", "1y", "all"]).optional().describe("Lookback period (default: all)"),
    },
    async ({ period }) => {
      const cutoff: Record<string, string> = {
        "1m": new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0],
        "3m": new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0],
        "6m": new Date(Date.now() - 180 * 86400000).toISOString().split("T")[0],
        "1y": new Date(Date.now() - 365 * 86400000).toISOString().split("T")[0],
        "all": "1900-01-01",
      };
      const since = cutoff[period ?? "all"];
      const today = new Date();

      const perf = await q(db, sql`
        SELECT
          portfolio_holding as holding,
          COUNT(*) as tx_count,
          SUM(CASE WHEN amount < 0 THEN quantity ELSE 0 END) as buy_qty,
          SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as buy_amount,
          SUM(CASE WHEN amount > 0 AND quantity < 0 THEN ABS(quantity) ELSE 0 END) as sell_qty,
          SUM(CASE WHEN amount > 0 AND quantity < 0 THEN amount ELSE 0 END) as sell_amount,
          SUM(CASE WHEN amount > 0 AND (quantity = 0 OR quantity IS NULL) THEN amount ELSE 0 END) as dividends,
          SUM(quantity) as net_quantity,
          MIN(CASE WHEN amount < 0 THEN date ELSE NULL END) as first_purchase,
          MAX(date) as last_activity
        FROM transactions
        WHERE user_id = ${userId}
          AND portfolio_holding IS NOT NULL AND portfolio_holding != ''
          AND date >= ${since}
        GROUP BY portfolio_holding
        ORDER BY buy_amount DESC
      `);

      const results = perf.map(p => {
        const buyQty = Number(p.buy_qty ?? 0);
        const buyAmt = Number(p.buy_amount ?? 0);
        const sellQty = Number(p.sell_qty ?? 0);
        const sellAmt = Number(p.sell_amount ?? 0);
        const divs = Number(p.dividends ?? 0);
        const avgCost = buyQty > 0 ? buyAmt / buyQty : null;
        const remainingQty = Number(p.net_quantity ?? 0);
        const costBasis = avgCost !== null && remainingQty > 0 ? remainingQty * avgCost : null;
        const realizedGain = avgCost !== null ? sellAmt - (sellQty * avgCost) : 0;
        const totalReturn = realizedGain + divs;
        const fpDate = p.first_purchase ?? null;
        const daysHeld = fpDate ? Math.floor((today.getTime() - new Date(String(fpDate)).getTime()) / 86400000) : null;
        return {
          holding: p.holding,
          txCount: Number(p.tx_count),
          quantity: Math.round(remainingQty * 10000) / 10000,
          lifetimeCostBasis: Math.round(buyAmt * 100) / 100,
          currentCostBasis: costBasis ? Math.round(costBasis * 100) / 100 : null,
          avgCostPerShare: avgCost ? Math.round(avgCost * 100) / 100 : null,
          realizedGain: Math.round(realizedGain * 100) / 100,
          realizedGainPct: buyAmt > 0 ? Math.round((realizedGain / buyAmt) * 10000) / 100 : null,
          dividendsReceived: Math.round(divs * 100) / 100,
          totalReturn: Math.round(totalReturn * 100) / 100,
          totalReturnPct: buyAmt > 0 ? Math.round((totalReturn / buyAmt) * 10000) / 100 : null,
          firstPurchase: fpDate,
          lastActivity: p.last_activity,
          daysHeld,
        };
      });

      const totLifetime = results.reduce((s, r) => s + r.lifetimeCostBasis, 0);
      const totRealized = results.reduce((s, r) => s + r.realizedGain, 0);
      const totDivs = results.reduce((s, r) => s + r.dividendsReceived, 0);
      const totReturn = totRealized + totDivs;

      return text({
        disclaimer: PORTFOLIO_DISCLAIMER,
        note: "unrealizedGain requires live prices. Use the portfolio page for full metrics.",
        period: period ?? "all",
        since,
        summary: {
          holdings: results.length,
          lifetimeCostBasis: Math.round(totLifetime * 100) / 100,
          totalRealizedGain: Math.round(totRealized * 100) / 100,
          totalDividends: Math.round(totDivs * 100) / 100,
          totalReturn: Math.round(totReturn * 100) / 100,
          totalReturnPct: totLifetime > 0 ? Math.round((totReturn / totLifetime) * 10000) / 100 : null,
        },
        holdings: results,
      });
    }
  );

  // ── analyze_holding ────────────────────────────────────────────────────────
  server.tool(
    "analyze_holding",
    "Deep-dive on a single holding: avg cost, realized gain, dividends, days held, full transaction history",
    {
      symbol: z.string().describe("Holding name or symbol (fuzzy matched)"),
    },
    async ({ symbol }) => {
      const lo = `%${symbol.toLowerCase()}%`;
      const txns = await q(db, sql`
        SELECT t.id, t.date, t.amount, t.quantity, t.payee, t.note, t.tags, t.portfolio_holding,
               a.name as account_name, a.currency
        FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        WHERE t.user_id = ${userId}
          AND (LOWER(t.portfolio_holding) LIKE ${lo} OR LOWER(t.payee) LIKE ${lo})
        ORDER BY t.date ASC
      `);

      if (!txns.length) return err(`No transactions found for holding matching "${symbol}"`);

      const holdingName = txns[0].portfolio_holding || txns[0].payee;
      const today = new Date();

      let buyQty = 0, buyAmt = 0, sellQty = 0, sellAmt = 0, divAmt = 0;
      const purchases: typeof txns = [];
      const sales: typeof txns = [];
      const dividends: typeof txns = [];

      for (const t of txns) {
        const qty = Number(t.quantity ?? 0);
        const amt = Number(t.amount);
        if (amt < 0) {
          buyQty += qty; buyAmt += Math.abs(amt); purchases.push(t);
        } else if (amt > 0 && qty < 0) {
          sellQty += Math.abs(qty); sellAmt += amt; sales.push(t);
        } else if (amt > 0 && (qty === 0 || qty === null)) {
          divAmt += amt; dividends.push(t);
        }
      }

      const avgCost = buyQty > 0 ? buyAmt / buyQty : null;
      const remainingQty = buyQty - sellQty;
      const costBasis = avgCost !== null && remainingQty > 0 ? remainingQty * avgCost : null;
      const realizedGain = avgCost !== null ? sellAmt - (sellQty * avgCost) : 0;
      const totalReturn = realizedGain + divAmt; // no live price = no unrealized
      const firstDate = txns[0].date;
      const daysHeld = firstDate
        ? Math.floor((today.getTime() - new Date(String(firstDate)).getTime()) / 86400000)
        : null;

      return text({
        disclaimer: PORTFOLIO_DISCLAIMER,
        note: "unrealizedGain requires live prices — not available in MCP.",
        holding: holdingName,
        // Position
        currentShares: Math.round(remainingQty * 10000) / 10000,
        avgCostPerShare: avgCost ? Math.round(avgCost * 100) / 100 : null,
        currentCostBasis: costBasis ? Math.round(costBasis * 100) / 100 : null,
        lifetimeCostBasis: Math.round(buyAmt * 100) / 100,
        // Performance
        realizedGain: Math.round(realizedGain * 100) / 100,
        realizedGainPct: buyAmt > 0 ? Math.round((realizedGain / buyAmt) * 10000) / 100 : null,
        dividendsReceived: Math.round(divAmt * 100) / 100,
        totalReturn: Math.round(totalReturn * 100) / 100,
        totalReturnPct: buyAmt > 0 ? Math.round((totalReturn / buyAmt) * 10000) / 100 : null,
        // Time
        firstPurchaseDate: firstDate,
        lastActivity: txns[txns.length - 1].date,
        daysHeld,
        // Transaction counts
        purchases: purchases.length,
        sales: sales.length,
        dividendPayments: dividends.length,
        totalTransactions: txns.length,
        // Recent history
        recentTransactions: txns.slice(-8).map(t => ({
          date: t.date,
          amount: t.amount,
          quantity: t.quantity,
          type: Number(t.amount) < 0 ? "buy" : (Number(t.quantity ?? 0) < 0 ? "sell" : "dividend"),
          account: t.account_name,
          note: t.note || undefined,
        })),
      });
    }
  );

  // ── get_holding_metrics ────────────────────────────────────────────────────
  server.tool(
    "get_holding_metrics",
    "Compact metrics table for all holdings (or specified symbols): quantity, avg cost, cost basis, realized P&L, dividends, total return",
    {
      symbols: z.array(z.string()).optional().describe("Filter to specific holding names/symbols (omit for all)"),
    },
    async ({ symbols }) => {
      const metrics = await q(db, sql`
        SELECT
          portfolio_holding as name,
          SUM(CASE WHEN amount < 0 THEN quantity ELSE 0 END) as buy_qty,
          SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as buy_amount,
          SUM(CASE WHEN amount > 0 AND quantity < 0 THEN ABS(quantity) ELSE 0 END) as sell_qty,
          SUM(CASE WHEN amount > 0 AND quantity < 0 THEN amount ELSE 0 END) as sell_amount,
          SUM(CASE WHEN amount > 0 AND (quantity = 0 OR quantity IS NULL) THEN amount ELSE 0 END) as dividends,
          MIN(CASE WHEN amount < 0 THEN date ELSE NULL END) as first_purchase
        FROM transactions
        WHERE user_id = ${userId} AND portfolio_holding IS NOT NULL AND portfolio_holding != ''
        GROUP BY portfolio_holding
        ORDER BY buy_amount DESC
      `);

      const ph = await q(db, sql`
        SELECT ph.name, ph.symbol, ph.currency, a.name as account_name
        FROM portfolio_holdings ph
        JOIN accounts a ON a.id = ph.account_id
        WHERE ph.user_id = ${userId}
      `);
      const phMap = new Map(ph.map(p => [String(p.name), p]));

      const today = new Date();
      const rows = [];
      let totCostBasis = 0, totRealized = 0, totDivs = 0;

      for (const m of metrics) {
        const name = String(m.name);
        // Filter if symbols specified
        if (symbols?.length) {
          const lo = symbols.map(s => s.toLowerCase());
          const info2 = phMap.get(name);
          const sym = String(info2?.symbol ?? "").toLowerCase();
          if (!lo.some(s => name.toLowerCase().includes(s) || sym.includes(s))) continue;
        }

        const buyQty = Number(m.buy_qty ?? 0);
        const buyAmt = Number(m.buy_amount ?? 0);
        const sellQty = Number(m.sell_qty ?? 0);
        const sellAmt = Number(m.sell_amount ?? 0);
        const divs = Number(m.dividends ?? 0);
        const avgCost = buyQty > 0 ? buyAmt / buyQty : null;
        const remainQty = buyQty - sellQty;
        const costBasis = avgCost !== null && remainQty > 0 ? remainQty * avgCost : null;
        const realGain = avgCost !== null ? sellAmt - (sellQty * avgCost) : 0;
        const totalRet = realGain + divs;
        const fpDate = m.first_purchase ?? null;
        const daysHeld = fpDate ? Math.floor((today.getTime() - new Date(String(fpDate)).getTime()) / 86400000) : null;
        const info = phMap.get(name);

        totCostBasis += costBasis ?? 0;
        totRealized += realGain;
        totDivs += divs;

        rows.push({
          name,
          symbol: info?.symbol ?? null,
          account: info?.account_name ?? null,
          qty: Math.round(remainQty * 10000) / 10000,
          avgCost: avgCost ? Math.round(avgCost * 100) / 100 : null,
          costBasis: costBasis ? Math.round(costBasis * 100) / 100 : null,
          lifetimeCost: Math.round(buyAmt * 100) / 100,
          realizedGain: Math.round(realGain * 100) / 100,
          dividends: Math.round(divs * 100) / 100,
          totalReturn: Math.round(totalRet * 100) / 100,
          returnPct: buyAmt > 0 ? Math.round((totalRet / buyAmt) * 10000) / 100 : null,
          firstPurchase: fpDate,
          daysHeld,
        });
      }

      const totReturn = totRealized + totDivs;
      const totLifetime = rows.reduce((s, r) => s + r.lifetimeCost, 0);

      return text({
        disclaimer: PORTFOLIO_DISCLAIMER,
        note: "currentPrice and unrealizedGain require live prices — not available in MCP.",
        totalHoldings: rows.length,
        summary: {
          totalCostBasis: Math.round(totCostBasis * 100) / 100,
          totalRealizedGain: Math.round(totRealized * 100) / 100,
          totalDividends: Math.round(totDivs * 100) / 100,
          totalReturn: Math.round(totReturn * 100) / 100,
          returnPct: totLifetime > 0 ? Math.round((totReturn / totLifetime) * 10000) / 100 : null,
        },
        holdings: rows,
      });
    }
  );

  // ── get_rebalancing_suggestions ────────────────────────────────────────────
  server.tool(
    "get_rebalancing_suggestions",
    "Suggest rebalancing based on target allocations vs current book-value weights",
    {
      targets: z.array(z.object({
        holding: z.string().describe("Holding name or symbol"),
        target_pct: z.number().describe("Target allocation percentage (0-100)"),
      })).describe("Target allocations (must sum to ~100)"),
    },
    async ({ targets }) => {
      const holdings = await q(db, sql`
        SELECT t.portfolio_holding as name,
               SUM(ABS(t.amount)) as book_value,
               a.currency
        FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        WHERE t.user_id = ${userId}
          AND t.portfolio_holding IS NOT NULL AND t.portfolio_holding != ''
          AND t.amount < 0
        GROUP BY t.portfolio_holding, a.currency
      `);

      const totalBV = holdings.reduce((s, h) => s + Number(h.book_value), 0);
      if (totalBV === 0) return err("No portfolio holdings found");

      const currentAlloc = new Map(holdings.map(h => [
        String(h.name).toLowerCase(),
        { name: h.name, value: Number(h.book_value), pct: (Number(h.book_value) / totalBV) * 100 }
      ]));

      const suggestions = targets.map(t => {
        const lo = t.holding.toLowerCase();
        const current = [...currentAlloc.entries()].find(([k]) => k.includes(lo) || lo.includes(k))?.[1];
        const currentPct = current?.pct ?? 0;
        const currentValue = current?.value ?? 0;
        const targetValue = (t.target_pct / 100) * totalBV;
        const diff = targetValue - currentValue;
        return {
          holding: t.holding,
          currentPct: Math.round(currentPct * 10) / 10,
          targetPct: t.target_pct,
          currentValue: Math.round(currentValue * 100) / 100,
          targetValue: Math.round(targetValue * 100) / 100,
          action: diff > 0 ? "BUY" : diff < 0 ? "SELL" : "HOLD",
          amount: Math.round(Math.abs(diff) * 100) / 100,
        };
      });

      return text({
        disclaimer: PORTFOLIO_DISCLAIMER,
        totalPortfolioValue: Math.round(totalBV * 100) / 100,
        suggestions,
        note: "Values based on book cost, not market price. Get current prices for accurate rebalancing.",
      });
    }
  );

  // ── get_investment_insights ────────────────────────────────────────────────
  server.tool(
    "get_investment_insights",
    "Investment patterns: contribution frequency, largest positions, diversification score",
    {},
    async () => {
      const contributions = await q(db, sql`
        SELECT DATE_TRUNC('month', date::date) as month, SUM(ABS(amount)) as invested
        FROM transactions
        WHERE user_id = ${userId} AND portfolio_holding IS NOT NULL AND portfolio_holding != '' AND amount < 0
        GROUP BY DATE_TRUNC('month', date::date)
        ORDER BY month DESC LIMIT 12
      `);

      const positions = await q(db, sql`
        SELECT portfolio_holding as name, SUM(ABS(amount)) as book_value, COUNT(*) as purchases
        FROM transactions
        WHERE user_id = ${userId} AND portfolio_holding IS NOT NULL AND portfolio_holding != '' AND amount < 0
        GROUP BY portfolio_holding
        ORDER BY book_value DESC
      `);

      const totalInvested = positions.reduce((s, p) => s + Number(p.book_value), 0);
      const top3Pct = positions.slice(0, 3).reduce((s, p) => s + Number(p.book_value), 0) / (totalInvested || 1);
      const diversificationScore = Math.max(0, Math.round((1 - top3Pct) * 100));

      const avgMonthlyContrib = contributions.length > 0
        ? contributions.reduce((s, c) => s + Number(c.invested), 0) / contributions.length
        : 0;

      return text({
        disclaimer: PORTFOLIO_DISCLAIMER,
        summary: {
          totalPositions: positions.length,
          totalInvested: Math.round(totalInvested * 100) / 100,
          avgMonthlyContribution: Math.round(avgMonthlyContrib * 100) / 100,
          diversificationScore,
          diversificationLabel: diversificationScore > 70 ? "Well diversified" : diversificationScore > 40 ? "Moderately diversified" : "Concentrated",
          concentration: `Top 3 positions = ${Math.round(top3Pct * 1000) / 10}% of portfolio`,
        },
        topPositions: positions.slice(0, 5).map(p => ({
          name: p.name,
          bookValue: Math.round(Number(p.book_value) * 100) / 100,
          pct: Math.round((Number(p.book_value) / totalInvested) * 1000) / 10,
          purchases: Number(p.purchases),
        })),
        monthlyContributions: contributions.slice(0, 6).map(c => ({
          month: c.month,
          invested: Math.round(Number(c.invested) * 100) / 100,
        })),
      });
    }
  );

  // ── compare_to_benchmark ───────────────────────────────────────────────────
  server.tool(
    "compare_to_benchmark",
    "Compare portfolio book-value growth to a reference benchmark (informational only)",
    {
      benchmark: z.enum(["SP500", "TSX", "MSCI_WORLD", "BONDS_CA"]).optional().describe("Benchmark to compare against (default SP500)"),
    },
    async ({ benchmark }) => {
      const bm = benchmark ?? "SP500";
      // Approximate annualized returns (10-year historical averages, informational only)
      const bmReturns: Record<string, { label: string; annualizedReturn: number; description: string }> = {
        SP500:      { label: "S&P 500",           annualizedReturn: 10.5, description: "US large-cap equities (USD)" },
        TSX:        { label: "S&P/TSX Composite",  annualizedReturn: 8.2,  description: "Canadian equities (CAD)" },
        MSCI_WORLD: { label: "MSCI World",          annualizedReturn: 9.4,  description: "Global developed markets (USD)" },
        BONDS_CA:   { label: "Canadian Bonds",      annualizedReturn: 3.8,  description: "Canadian aggregate bonds (CAD)" },
      };
      const bmInfo = bmReturns[bm];

      const firstTxn = await q(db, sql`
        SELECT MIN(date) as first_date, MAX(date) as last_date,
               SUM(ABS(amount)) as total_invested,
               SUM(amount) as net_cashflow
        FROM transactions
        WHERE user_id = ${userId}
          AND portfolio_holding IS NOT NULL AND portfolio_holding != ''
          AND amount < 0
      `);

      if (!firstTxn.length || !firstTxn[0].first_date) {
        return text({ disclaimer: PORTFOLIO_DISCLAIMER, message: "No investment transactions found" });
      }

      const info = firstTxn[0];
      const firstDate = new Date(String(info.first_date));
      const lastDate = new Date(String(info.last_date));
      const yearsHeld = Math.max(0.1, (lastDate.getTime() - firstDate.getTime()) / (365.25 * 86400000));
      const totalInvested = Number(info.total_invested);

      // What totalInvested would be worth today at benchmark's annualized return
      const benchmarkFinalValue = totalInvested * Math.pow(1 + bmInfo.annualizedReturn / 100, yearsHeld);
      const benchmarkGain = benchmarkFinalValue - totalInvested;

      return text({
        disclaimer: PORTFOLIO_DISCLAIMER,
        note: "Comparison uses book cost (not market value) and historical average returns. This is illustrative only.",
        yourPortfolio: {
          totalInvested: Math.round(totalInvested * 100) / 100,
          investingSince: info.first_date,
          yearsInvesting: Math.round(yearsHeld * 10) / 10,
        },
        benchmark: {
          name: bmInfo.label,
          description: bmInfo.description,
          historicalAnnualizedReturn: `${bmInfo.annualizedReturn}%`,
          period: "10-year historical average (approximate)",
        },
        hypothetical: {
          message: `If your total invested ($${Math.round(totalInvested)} over ${Math.round(yearsHeld * 10) / 10} years) had earned ${bmInfo.annualizedReturn}% annually:`,
          finalValue: Math.round(benchmarkFinalValue * 100) / 100,
          gain: Math.round(benchmarkGain * 100) / 100,
          gainPct: Math.round((benchmarkGain / totalInvested) * 1000) / 10,
        },
        limitations: [
          "Book cost ≠ market value — add current prices for real comparison",
          "Dollar-cost averaging timing not accounted for precisely",
          "Benchmark returns exclude fees, taxes, and currency conversion",
        ],
      });
    }
  );
}
