// MCP Tools v2 — Additional read and write tools
// Exported as registration functions to avoid conflicts with other team's changes to index.ts
//
// IMPORTANT: Every query in this file must be scoped to the current userId.
// The stdio transport has no HTTP auth, so `registerV2Tools` takes the
// userId from the environment (`PF_USER_ID`) at startup and threads it into
// every tool via closure. Tool handlers must NEVER accept a userId from
// tool arguments — the argument schemas explicitly don't expose one.
//
// Read tools: add `user_id = ?` to every WHERE clause (except global tables
// like price_cache and fx_rates). Write tools: ownership pre-check on the
// target row before UPDATE/DELETE; INSERTs always include user_id with the
// closure userId.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PgCompatDb } from "./pg-compat.js";

// ============ TYPES ============

type TransactionRow = {
  id: number;
  date: string;
  account: string;
  category: string;
  category_type: string;
  currency: string;
  amount: number;
  payee: string;
  note: string;
  tags: string;
  quantity: number | null;
};

type BudgetRow = {
  category: string;
  category_group: string;
  budget: number;
  spent: number;
};

type MonthlySpendRow = {
  month: string;
  category: string;
  total: number;
};

type SubscriptionRow = {
  id: number;
  name: string;
  amount: number;
  currency: string;
  frequency: string;
  next_date: string | null;
  status: string;
  category_name: string | null;
};

// ============ HELPERS ============

function mcpText(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function mcpError(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true as const };
}

// ============ REGISTER TOOLS ============

export interface V2ToolsOptions {
  userId: string;
}

export function registerV2Tools(server: McpServer, sqlite: PgCompatDb, opts: V2ToolsOptions) {
  const userId = opts.userId;

  // ---- READ TOOLS ----

  server.tool(
    "get_financial_health_score",
    "Calculate a financial health score 0-100 with breakdown by component (savings rate, debt-to-income, emergency fund, net worth trend, budget adherence)",
    {},
    async () => {
      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const threeMonthsAgo = new Date(now);
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
      const twelveMonthsAgo = new Date(now);
      twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
      const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;

      // Income vs expenses over past 12 months
      const incomeExpenses = await sqlite.prepare(
        `SELECT strftime('%Y-%m', t.date) as month, c.type as category_type, SUM(t.amount) as total
         FROM transactions t LEFT JOIN categories c ON t.category_id = c.id
         WHERE t.user_id = ? AND t.date >= ? AND t.date <= ? AND c.type IN ('E','I')
         GROUP BY strftime('%Y-%m', t.date), c.type
         ORDER BY month`
      ).all(userId, fmt(twelveMonthsAgo), `${currentMonth}-31`) as { month: string; category_type: string; total: number }[];

      const monthIncome = new Map<string, number>();
      const monthExpenses = new Map<string, number>();
      const allMonths = new Set<string>();

      for (const row of incomeExpenses) {
        allMonths.add(row.month);
        if (row.category_type === "I") monthIncome.set(row.month, (monthIncome.get(row.month) ?? 0) + row.total);
        if (row.category_type === "E") monthExpenses.set(row.month, (monthExpenses.get(row.month) ?? 0) + Math.abs(row.total));
      }

      const sortedMonths = Array.from(allMonths).sort().slice(-3);
      let totalIncome = 0, totalExpenses = 0;
      for (const m of sortedMonths) {
        totalIncome += monthIncome.get(m) ?? 0;
        totalExpenses += monthExpenses.get(m) ?? 0;
      }

      // 1. Savings Rate (30%)
      let savingsRateScore = 0, savingsRateDetail = "No income data";
      if (totalIncome > 0) {
        const rate = (totalIncome - totalExpenses) / totalIncome;
        savingsRateScore = Math.min(100, Math.max(0, rate * 500));
        savingsRateDetail = `${Math.round(rate * 100)}% savings rate`;
      }

      // 2. Debt-to-Income (20%)
      const balances = await sqlite.prepare(
        `SELECT a.type, a."group", a.currency, COALESCE(SUM(t.amount), 0) as balance
         FROM accounts a LEFT JOIN transactions t ON a.id = t.account_id AND t.user_id = ?
         WHERE a.user_id = ?
         GROUP BY a.id`
      ).all(userId, userId) as { type: string; group: string; currency: string; balance: number }[];

      const totalLiabilities = balances.filter(b => b.type === "L").reduce((s, b) => s + Math.abs(b.balance), 0);
      const annualIncome = totalIncome > 0 ? (totalIncome / sortedMonths.length) * 12 : 0;

      let dtiScore = 0, dtiDetail = "No income data";
      if (annualIncome > 0) {
        const dtiRatio = totalLiabilities / annualIncome;
        dtiScore = Math.min(100, Math.max(0, (1 - dtiRatio) * 100));
        dtiDetail = `${Math.round(dtiRatio * 100)}% debt-to-income`;
      } else if (totalLiabilities === 0) {
        dtiScore = 100;
        dtiDetail = "No debt";
      }

      // 3. Emergency Fund (20%)
      const avgMonthlyExpenses = sortedMonths.length > 0 ? totalExpenses / sortedMonths.length : 0;
      const liquidAssets = balances
        .filter(b => b.type === "A" && !b.group.toLowerCase().includes("investment") && !b.group.toLowerCase().includes("portfolio") && !b.group.toLowerCase().includes("retirement"))
        .reduce((s, b) => s + b.balance, 0);

      let emergencyScore = 0, emergencyDetail = "No expense data";
      if (avgMonthlyExpenses > 0) {
        const monthsCovered = liquidAssets / avgMonthlyExpenses;
        emergencyScore = Math.min(100, Math.max(0, (monthsCovered / 6) * 100));
        emergencyDetail = `${monthsCovered.toFixed(1)} months covered`;
      } else if (liquidAssets > 0) {
        emergencyScore = 50;
        emergencyDetail = "Has liquid assets";
      }

      // 4. Net Worth Trend (15%)
      const nwData = await sqlite.prepare(
        `SELECT strftime('%Y-%m', t.date) as month, SUM(t.amount) as total
         FROM transactions t LEFT JOIN accounts a ON t.account_id = a.id
         WHERE t.user_id = ? AND a.currency = 'CAD'
         GROUP BY strftime('%Y-%m', t.date)
         ORDER BY month`
      ).all(userId) as { month: string; total: number }[];

      let running = 0;
      const nwByMonth: [string, number][] = [];
      for (const row of nwData) { running += row.total; nwByMonth.push([row.month, running]); }

      let nwTrendScore = 50, nwTrendDetail = "Insufficient data";
      if (nwByMonth.length >= 3) {
        const recent = nwByMonth.slice(-3);
        const older = nwByMonth.slice(-6, -3);
        const recentAvg = recent.reduce((s, [, v]) => s + v, 0) / recent.length;
        const olderAvg = older.length > 0 ? older.reduce((s, [, v]) => s + v, 0) / older.length : recentAvg;
        if (olderAvg !== 0) {
          const growthPct = ((recentAvg - olderAvg) / Math.abs(olderAvg)) * 100;
          nwTrendScore = Math.min(100, Math.max(0, 50 + growthPct * 10));
          nwTrendDetail = growthPct >= 0 ? `Growing ${growthPct.toFixed(1)}%` : `Declining ${Math.abs(growthPct).toFixed(1)}%`;
        }
      }

      // 5. Budget Adherence (15%)
      const budgetsData = await sqlite.prepare(
        `SELECT b.id, c.name as category, b.amount as budget,
         COALESCE(ABS(SUM(CASE WHEN t.date >= ? AND t.date <= ? AND t.user_id = ? THEN t.amount ELSE 0 END)), 0) as spent
         FROM budgets b JOIN categories c ON b.category_id = c.id
         LEFT JOIN transactions t ON t.category_id = c.id
         WHERE b.user_id = ? AND b.month = ?
         GROUP BY b.id`
      ).all(`${currentMonth}-01`, `${currentMonth}-31`, userId, userId, currentMonth) as BudgetRow[];

      let budgetScore = 50, budgetDetail = "No budgets set";
      if (budgetsData.length > 0) {
        const onTrack = budgetsData.filter(b => b.spent <= Math.abs(b.budget)).length;
        budgetScore = Math.round((onTrack / budgetsData.length) * 100);
        budgetDetail = `${onTrack}/${budgetsData.length} budgets on track`;
      }

      // Composite
      const components = [
        { name: "Savings Rate", score: Math.round(savingsRateScore), weight: 0.3, weighted: Math.round(savingsRateScore * 0.3), detail: savingsRateDetail },
        { name: "Debt-to-Income", score: Math.round(dtiScore), weight: 0.2, weighted: Math.round(dtiScore * 0.2), detail: dtiDetail },
        { name: "Emergency Fund", score: Math.round(emergencyScore), weight: 0.2, weighted: Math.round(emergencyScore * 0.2), detail: emergencyDetail },
        { name: "Net Worth Trend", score: Math.round(nwTrendScore), weight: 0.15, weighted: Math.round(nwTrendScore * 0.15), detail: nwTrendDetail },
        { name: "Budget Adherence", score: Math.round(budgetScore), weight: 0.15, weighted: Math.round(budgetScore * 0.15), detail: budgetDetail },
      ];

      const totalScore = components.reduce((s, c) => s + c.weighted, 0);
      const grade = totalScore >= 80 ? "Excellent" : totalScore >= 60 ? "Good" : totalScore >= 40 ? "Fair" : "Needs Work";

      return mcpText({ score: Math.min(100, Math.max(0, totalScore)), grade, components });
    }
  );

  server.tool(
    "get_spending_anomalies",
    "Find spending categories with >30% deviation from their 3-month average. Highlights unusual spending patterns.",
    {},
    async () => {
      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const sixMonthsAgo = new Date(now);
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      const startDate = `${sixMonthsAgo.getFullYear()}-${String(sixMonthsAgo.getMonth() + 1).padStart(2, "0")}-01`;

      const rows = await sqlite.prepare(
        `SELECT strftime('%Y-%m', t.date) as month, c.name as category, SUM(t.amount) as total
         FROM transactions t LEFT JOIN categories c ON t.category_id = c.id
         WHERE t.user_id = ? AND t.date >= ? AND c.type = 'E'
         GROUP BY strftime('%Y-%m', t.date), c.name
         ORDER BY month`
      ).all(userId, startDate) as MonthlySpendRow[];

      const byCategory = new Map<string, MonthlySpendRow[]>();
      for (const row of rows) {
        byCategory.set(row.category, [...(byCategory.get(row.category) ?? []), row]);
      }

      const anomalies = [];
      for (const [category, catRows] of byCategory) {
        const current = catRows.find(r => r.month === currentMonth);
        if (!current) continue;

        const previous = catRows.filter(r => r.month !== currentMonth && r.month < currentMonth).slice(-3);
        if (previous.length < 2) continue;

        const avg = previous.reduce((s, r) => s + Math.abs(r.total), 0) / previous.length;
        const currentAbs = Math.abs(current.total);

        if (avg > 0) {
          const pctAbove = ((currentAbs - avg) / avg) * 100;
          if (Math.abs(pctAbove) > 30) {
            anomalies.push({
              category,
              currentMonthSpend: Math.round(currentAbs * 100) / 100,
              threeMonthAvg: Math.round(avg * 100) / 100,
              percentDeviation: Math.round(pctAbove),
              direction: pctAbove > 0 ? "above_average" : "below_average",
              severity: Math.abs(pctAbove) > 75 ? "alert" : "warning",
            });
          }
        }
      }

      anomalies.sort((a, b) => Math.abs(b.percentDeviation) - Math.abs(a.percentDeviation));
      return mcpText({ month: currentMonth, anomalies, count: anomalies.length });
    }
  );

  server.tool(
    "get_subscription_summary",
    "Get all tracked subscriptions with total monthly cost and upcoming renewals",
    {},
    async () => {
      const subs = await sqlite.prepare(
        `SELECT s.id, s.name, s.amount, s.currency, s.frequency, s.next_date, s.status,
         c.name as category_name
         FROM subscriptions s
         LEFT JOIN categories c ON s.category_id = c.id
         WHERE s.user_id = ?
         ORDER BY s.status, s.name`
      ).all(userId) as SubscriptionRow[];

      const active = subs.filter(s => s.status === "active");

      // Calculate monthly cost (normalize all frequencies to monthly)
      const freqMultiplier: Record<string, number> = {
        weekly: 4.33,
        monthly: 1,
        quarterly: 1 / 3,
        annual: 1 / 12,
        yearly: 1 / 12,
      };

      const totalMonthlyCost = active.reduce((sum, s) => {
        const mult = freqMultiplier[s.frequency] ?? 1;
        return sum + s.amount * mult;
      }, 0);

      const totalAnnualCost = totalMonthlyCost * 12;

      // Upcoming renewals (next 30 days)
      const today = new Date().toISOString().split("T")[0];
      const thirtyDaysLater = new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];
      const upcoming = active
        .filter(s => s.next_date && s.next_date >= today && s.next_date <= thirtyDaysLater)
        .map(s => ({ name: s.name, amount: s.amount, date: s.next_date, currency: s.currency }))
        .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));

      return mcpText({
        totalMonthlyCost: Math.round(totalMonthlyCost * 100) / 100,
        totalAnnualCost: Math.round(totalAnnualCost * 100) / 100,
        activeCount: active.length,
        totalCount: subs.length,
        upcomingRenewals: upcoming,
        subscriptions: subs.map(s => ({
          id: s.id,
          name: s.name,
          amount: s.amount,
          currency: s.currency,
          frequency: s.frequency,
          status: s.status,
          nextDate: s.next_date,
          category: s.category_name,
        })),
      });
    }
  );

  server.tool(
    "get_cash_flow_forecast",
    "Project cash flow for the next 30, 60, or 90 days based on recurring transactions and current balances",
    {
      days: z.number().optional().describe("Forecast horizon in days (default 90)"),
    },
    async ({ days }) => {
      const horizon = days ?? 90;
      const cutoff = new Date();
      cutoff.setFullYear(cutoff.getFullYear() - 1);
      const cutoffStr = cutoff.toISOString().split("T")[0];

      // Detect recurring transactions
      const txns = await sqlite.prepare(
        `SELECT id, date, payee, amount, account_id, category_id
         FROM transactions
         WHERE user_id = ? AND date >= ? AND payee != ''
         ORDER BY date`
      ).all(userId, cutoffStr) as { id: number; date: string; payee: string; amount: number; account_id: number; category_id: number }[];

      // Group by payee to find recurring
      const groups = new Map<string, typeof txns>();
      for (const t of txns) {
        const key = t.payee.trim().toLowerCase();
        groups.set(key, [...(groups.get(key) ?? []), t]);
      }

      const recurring: { payee: string; avgAmount: number; frequency: string; lastDate: string; nextDate: string }[] = [];
      for (const [, group] of groups) {
        if (group.length < 3) continue;
        const avg = group.reduce((s, t) => s + t.amount, 0) / group.length;
        const consistent = group.every(t => Math.abs(t.amount - avg) / Math.abs(avg) < 0.2);
        if (!consistent) continue;

        // Estimate frequency from intervals
        const sorted = group.sort((a, b) => a.date.localeCompare(b.date));
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

      // Get current bank balance
      const bankAccounts = await sqlite.prepare(
        `SELECT a.id FROM accounts a WHERE a.user_id = ? AND a."group" IN ('Banks', 'Cash Accounts')`
      ).all(userId) as { id: number }[];

      let currentBalance = 0;
      for (const ba of bankAccounts) {
        const result = await sqlite.prepare(
          `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND account_id = ?`
        ).get(userId, ba.id) as { total: number };
        currentBalance += result.total;
      }

      // Project forward
      const today = new Date();
      const projection: { date: string; balance: number; events: string[] }[] = [];
      let balance = currentBalance;

      for (let d = 1; d <= horizon; d++) {
        const date = new Date(today.getTime() + d * 86400000);
        const dateStr = date.toISOString().split("T")[0];
        const events: string[] = [];

        for (const r of recurring) {
          // Simple: if next_date matches, apply and advance
          if (r.nextDate === dateStr) {
            balance += r.avgAmount;
            events.push(`${r.payee}: ${r.avgAmount > 0 ? "+" : ""}${r.avgAmount}`);
            // Advance next date
            const intervalDays = r.frequency === "weekly" ? 7 : r.frequency === "biweekly" ? 14 : r.frequency === "monthly" ? 30 : 365;
            r.nextDate = new Date(date.getTime() + intervalDays * 86400000).toISOString().split("T")[0];
          }
        }

        // Record milestones at 30, 60, 90 day marks or if events happened
        if (d === 30 || d === 60 || d === 90 || events.length > 0) {
          projection.push({ date: dateStr, balance: Math.round(balance * 100) / 100, events });
        }
      }

      const warnings = projection.filter(p => p.balance < 500).map(p => ({ date: p.date, balance: p.balance }));

      return mcpText({
        currentBalance: Math.round(currentBalance * 100) / 100,
        daysAhead: horizon,
        projectedBalance: projection.length > 0 ? projection[projection.length - 1].balance : currentBalance,
        warnings,
        milestones: projection.filter(p => [30, 60, 90].includes(Math.round((new Date(p.date).getTime() - today.getTime()) / 86400000))),
        recurringItems: recurring.length,
      });
    }
  );

  server.tool(
    "search_transactions",
    "Flexible transaction search with partial payee match, amount range, date range, category, and tags. For dedup workflows on blank-payee imports, pass `account_id` (FK fast-path) — a year of activity in one account easily exceeds the default 50-row limit, so raise `limit` accordingly. Each row includes `quantity` (nullable; positive for buys, negative for sells; null for cash-proxy and non-investment transactions).",
    {
      payee: z.string().optional().describe("Partial payee/merchant name match"),
      min_amount: z.number().optional().describe("Minimum amount"),
      max_amount: z.number().optional().describe("Maximum amount"),
      start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
      category: z.string().optional().describe("Category name (exact)"),
      tags: z.string().optional().describe("Tag to search for (partial match)"),
      account_id: z.number().int().optional().describe("Filter to transactions in this accounts.id (FK fast-path; useful for dedup against blank-payee bank-imported transfers where text search misses)."),
      limit: z.number().optional().describe("Max results (default 50)"),
    },
    async ({ payee, min_amount, max_amount, start_date, end_date, category, tags, account_id, limit }) => {
      let query = `SELECT t.id, t.date, a.name as account, c.name as category, c.type as category_type,
                   t.currency, t.amount, t.payee, t.note, t.tags, t.quantity
                   FROM transactions t
                   LEFT JOIN accounts a ON t.account_id = a.id
                   LEFT JOIN categories c ON t.category_id = c.id
                   WHERE t.user_id = ?`;
      const params: (string | number)[] = [userId];

      if (payee) { query += " AND t.payee LIKE ?"; params.push(`%${payee}%`); }
      if (min_amount !== undefined) { query += " AND t.amount >= ?"; params.push(min_amount); }
      if (max_amount !== undefined) { query += " AND t.amount <= ?"; params.push(max_amount); }
      if (start_date) { query += " AND t.date >= ?"; params.push(start_date); }
      if (end_date) { query += " AND t.date <= ?"; params.push(end_date); }
      if (category) { query += " AND c.name = ?"; params.push(category); }
      if (tags) { query += " AND t.tags LIKE ?"; params.push(`%${tags}%`); }
      if (account_id !== undefined) { query += " AND t.account_id = ?"; params.push(account_id); }

      query += ` ORDER BY t.date DESC LIMIT ?`;
      params.push(limit ?? 50);

      const rows = await sqlite.prepare(query).all(...params) as TransactionRow[];
      return mcpText({ results: rows, count: rows.length });
    }
  );

  // ---- WRITE TOOLS ----

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
      // Check for duplicate name (per-user)
      const existing = await sqlite.prepare(
        "SELECT id FROM accounts WHERE user_id = ? AND name = ?"
      ).get(userId, name) as { id: number } | undefined;
      if (existing) return mcpError(`Account "${name}" already exists (id: ${existing.id})`);

      const result = await sqlite.prepare(
        "INSERT INTO accounts (user_id, type, \"group\", name, currency, note) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(userId, type, group ?? "", name, currency ?? "CAD", note ?? "");

      return mcpText({
        success: true,
        accountId: result.lastInsertRowid,
        message: `Account "${name}" created (${type === "A" ? "asset" : "liability"}, ${currency ?? "CAD"})`,
      });
    }
  );
}
