// MCP Core Tools — extracted for reuse across stdio and HTTP transports

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type BetterSqlite3 from "better-sqlite3";

// Helper for MCP rule matching
function matchesRule(
  txn: { payee: string; amount: number; tags: string },
  rule: { match_field: string; match_type: string; match_value: string },
): boolean {
  const { match_field, match_type, match_value } = rule;

  if (match_field === "amount") {
    const ruleAmount = parseFloat(match_value);
    if (isNaN(ruleAmount)) return false;
    switch (match_type) {
      case "greater_than": return txn.amount > ruleAmount;
      case "less_than": return txn.amount < ruleAmount;
      case "exact": return Math.abs(txn.amount - ruleAmount) < 0.01;
      default: return false;
    }
  }

  const fieldValue = match_field === "payee" ? (txn.payee ?? "") : (txn.tags ?? "");
  const fieldLower = fieldValue.toLowerCase();
  const valueLower = match_value.toLowerCase();

  switch (match_type) {
    case "contains": return fieldLower.includes(valueLower);
    case "exact": return fieldLower === valueLower;
    case "regex":
      try { return new RegExp(match_value, "i").test(fieldValue); }
      catch { return false; }
    default: return false;
  }
}

export function registerCoreTools(server: McpServer, sqlite: BetterSqlite3.Database) {
  // ============ READ TOOLS ============

  server.tool(
    "get_account_balances",
    "Get current balances for all accounts, grouped by type (asset/liability)",
    { currency: z.enum(["CAD", "USD", "all"]).optional().describe("Filter by currency") },
    async ({ currency }) => {
      let query = `SELECT a.id, a.name, a.type, a."group", a.currency, COALESCE(SUM(t.amount), 0) as balance FROM accounts a LEFT JOIN transactions t ON a.id = t.account_id`;
      const params: string[] = [];
      if (currency && currency !== "all") { query += " WHERE a.currency = ?"; params.push(currency); }
      query += ` GROUP BY a.id ORDER BY a.type, a."group", a.name`;
      const rows = sqlite.prepare(query).all(...params);
      return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
    }
  );

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
      let query = `SELECT t.date, a.name as account, c.name as category, c.type as category_type, t.currency, t.amount, t.payee, t.note, t.tags FROM transactions t LEFT JOIN accounts a ON t.account_id = a.id LEFT JOIN categories c ON t.category_id = c.id WHERE t.date >= ? AND t.date <= ?`;
      const params: (string | number)[] = [start_date, end_date];
      if (category) { query += " AND c.name = ?"; params.push(category); }
      if (account) { query += " AND a.name = ?"; params.push(account); }
      if (min_amount !== undefined) { query += " AND t.amount >= ?"; params.push(min_amount); }
      if (max_amount !== undefined) { query += " AND t.amount <= ?"; params.push(max_amount); }
      query += ` ORDER BY t.date DESC LIMIT ?`;
      params.push(limit ?? 100);
      const rows = sqlite.prepare(query).all(...params);
      return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
    }
  );

  server.tool(
    "get_budget_summary",
    "Get budget vs actual spending for a specific month",
    { month: z.string().describe("Month in YYYY-MM format") },
    async ({ month }) => {
      const [y, m] = month.split("-").map(Number);
      const startDate = `${month}-01`;
      const endDate = `${month}-${new Date(y, m, 0).getDate()}`;
      const rows = sqlite.prepare(`SELECT b.id, c.name as category, c."group" as category_group, b.amount as budget, COALESCE(ABS(SUM(CASE WHEN t.date >= ? AND t.date <= ? THEN t.amount ELSE 0 END)), 0) as spent FROM budgets b JOIN categories c ON b.category_id = c.id LEFT JOIN transactions t ON t.category_id = c.id WHERE b.month = ? GROUP BY b.id ORDER BY c."group", c.name`).all(startDate, endDate, month);
      return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
    }
  );

  server.tool(
    "get_spending_trends",
    "Get spending trends over time grouped by category",
    { period: z.enum(["weekly", "monthly", "yearly"]).describe("Aggregation period"), months: z.number().optional().describe("Months to look back (default 12)") },
    async ({ period, months }) => {
      const lookback = months ?? 12;
      const startDate = new Date(new Date().getFullYear(), new Date().getMonth() - lookback, 1).toISOString().split("T")[0];
      const groupExpr = period === "weekly" ? "strftime('%Y-W%W', t.date)" : period === "yearly" ? "strftime('%Y', t.date)" : "strftime('%Y-%m', t.date)";
      const rows = sqlite.prepare(`SELECT ${groupExpr} as period, c.name as category, c."group" as category_group, SUM(t.amount) as total FROM transactions t LEFT JOIN categories c ON t.category_id = c.id WHERE t.date >= ? AND c.type = 'E' GROUP BY ${groupExpr}, c.name ORDER BY ${groupExpr}, total`).all(startDate);
      return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
    }
  );

  server.tool("get_portfolio_summary", "Get all investment holdings grouped by account", {}, async () => {
    const rows = sqlite.prepare(`SELECT ph.name as holding, ph.symbol, ph.currency, a.name as account FROM portfolio_holdings ph LEFT JOIN accounts a ON ph.account_id = a.id ORDER BY a.name, ph.name`).all();
    return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
  });

  server.tool(
    "get_net_worth",
    "Calculate total net worth across all accounts",
    { currency: z.enum(["CAD", "USD", "all"]).optional().describe("Filter by currency") },
    async ({ currency }) => {
      let query = `SELECT a.type, a.currency, COALESCE(SUM(t.amount), 0) as total FROM accounts a LEFT JOIN transactions t ON a.id = t.account_id`;
      const params: string[] = [];
      if (currency && currency !== "all") { query += " WHERE a.currency = ?"; params.push(currency); }
      query += " GROUP BY a.type, a.currency";
      const rows = sqlite.prepare(query).all(...params) as { type: string; currency: string; total: number }[];
      const summary: Record<string, { assets: number; liabilities: number; net: number }> = {};
      for (const row of rows) {
        if (!summary[row.currency]) summary[row.currency] = { assets: 0, liabilities: 0, net: 0 };
        if (row.type === "A") summary[row.currency].assets = row.total;
        else summary[row.currency].liabilities = row.total;
        summary[row.currency].net = summary[row.currency].assets + summary[row.currency].liabilities;
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
    }
  );

  server.tool("get_categories", "List all available transaction categories", {}, async () => {
    const rows = sqlite.prepare(`SELECT name, type, "group" FROM categories ORDER BY type, "group", name`).all();
    return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
  });

  server.tool("get_loans", "Get all loans with amortization summary", {}, async () => {
    const rows = sqlite.prepare(`SELECT id, name, type, principal, annual_rate, term_months, start_date, payment_frequency, extra_payment FROM loans`).all();
    return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
  });

  server.tool("get_goals", "Get all financial goals with progress", {}, async () => {
    const goals = sqlite.prepare(`SELECT g.id, g.name, g.type, g.target_amount, g.deadline, g.status, g.priority, a.name as account FROM goals g LEFT JOIN accounts a ON g.account_id = a.id ORDER BY g.priority`).all();
    return { content: [{ type: "text" as const, text: JSON.stringify(goals, null, 2) }] };
  });

  server.tool(
    "get_recurring_transactions",
    "Get detected recurring transactions (subscriptions, bills, salary)",
    {},
    async () => {
      const cutoff = new Date();
      cutoff.setFullYear(cutoff.getFullYear() - 1);
      const txns = sqlite.prepare(`SELECT id, date, payee, amount, account_id, category_id FROM transactions WHERE date >= ? AND payee != '' ORDER BY date`).all(cutoff.toISOString().split("T")[0]) as { id: number; date: string; payee: string; amount: number; account_id: number; category_id: number }[];
      const groups = new Map<string, typeof txns>();
      for (const t of txns) {
        const key = t.payee.trim().toLowerCase();
        groups.set(key, [...(groups.get(key) ?? []), t]);
      }
      const recurring = [];
      for (const [, group] of groups) {
        if (group.length < 3) continue;
        const avg = group.reduce((s, t) => s + t.amount, 0) / group.length;
        const consistent = group.every((t) => Math.abs(t.amount - avg) / Math.abs(avg) < 0.2);
        if (consistent) {
          recurring.push({ payee: group[0].payee, avgAmount: Math.round(avg * 100) / 100, count: group.length, lastDate: group[group.length - 1].date });
        }
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(recurring, null, 2) }] };
    }
  );

  server.tool(
    "get_income_statement",
    "Generate income statement for a period",
    { start_date: z.string().describe("Start date"), end_date: z.string().describe("End date") },
    async ({ start_date, end_date }) => {
      const rows = sqlite.prepare(`SELECT c.type as category_type, c."group" as category_group, c.name as category, SUM(t.amount) as total, COUNT(*) as count FROM transactions t LEFT JOIN categories c ON t.category_id = c.id WHERE t.date >= ? AND t.date <= ? AND c.type IN ('I','E') GROUP BY c.id ORDER BY c.type, c."group"`).all(start_date, end_date);
      return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
    }
  );

  // ============ WRITE TOOLS ============

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
      const acct = sqlite.prepare("SELECT id, currency FROM accounts WHERE name = ?").get(account) as { id: number; currency: string } | undefined;
      if (!acct) return { content: [{ type: "text" as const, text: `Error: Account "${account}" not found` }] };

      const cat = sqlite.prepare("SELECT id FROM categories WHERE name = ?").get(category) as { id: number } | undefined;
      if (!cat) return { content: [{ type: "text" as const, text: `Error: Category "${category}" not found` }] };

      sqlite.prepare("INSERT INTO transactions (date, account_id, category_id, currency, amount, payee, note, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(date, acct.id, cat.id, acct.currency, amount, payee ?? "", note ?? "", tags ?? "");
      return { content: [{ type: "text" as const, text: `Transaction added: ${amount} to ${account} (${category}) on ${date}` }] };
    }
  );

  server.tool(
    "set_budget",
    "Set or update a budget for a category in a specific month",
    {
      category: z.string().describe("Category name"),
      month: z.string().describe("Month (YYYY-MM)"),
      amount: z.number().describe("Budget amount (positive number)"),
    },
    async ({ category, month, amount }) => {
      const cat = sqlite.prepare("SELECT id FROM categories WHERE name = ?").get(category) as { id: number } | undefined;
      if (!cat) return { content: [{ type: "text" as const, text: `Error: Category "${category}" not found` }] };

      const existing = sqlite.prepare("SELECT id FROM budgets WHERE category_id = ? AND month = ?").get(cat.id, month) as { id: number } | undefined;
      if (existing) {
        sqlite.prepare("UPDATE budgets SET amount = ? WHERE id = ?").run(amount, existing.id);
      } else {
        sqlite.prepare("INSERT INTO budgets (category_id, month, amount) VALUES (?, ?, ?)").run(cat.id, month, amount);
      }
      return { content: [{ type: "text" as const, text: `Budget set: ${category} = $${amount} for ${month}` }] };
    }
  );

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
      let accountId = null;
      if (account) {
        const acct = sqlite.prepare("SELECT id FROM accounts WHERE name = ?").get(account) as { id: number } | undefined;
        accountId = acct?.id ?? null;
      }
      sqlite.prepare("INSERT INTO goals (name, type, target_amount, deadline, account_id, status) VALUES (?, ?, ?, ?, ?, 'active')").run(name, type, target_amount, deadline ?? null, accountId);
      return { content: [{ type: "text" as const, text: `Goal created: "${name}" — target $${target_amount}${deadline ? ` by ${deadline}` : ""}` }] };
    }
  );

  server.tool(
    "add_snapshot",
    "Record a net worth snapshot for an asset (e.g. house value, car value)",
    {
      account: z.string().describe("Account name"),
      value: z.number().describe("Current value"),
      date: z.string().optional().describe("Snapshot date (defaults to today)"),
      note: z.string().optional().describe("Optional note"),
    },
    async ({ account, value, date, note }) => {
      const acct = sqlite.prepare("SELECT id FROM accounts WHERE name = ?").get(account) as { id: number } | undefined;
      if (!acct) return { content: [{ type: "text" as const, text: `Error: Account "${account}" not found` }] };
      const d = date ?? new Date().toISOString().split("T")[0];
      sqlite.prepare("INSERT INTO snapshots (account_id, date, value, note) VALUES (?, ?, ?, ?)").run(acct.id, d, value, note ?? "");
      return { content: [{ type: "text" as const, text: `Snapshot recorded: ${account} = $${value} on ${d}` }] };
    }
  );

  // ============ TRANSACTION RULES TOOLS ============

  server.tool(
    "get_transaction_rules",
    "List all transaction auto-categorization rules",
    {},
    async () => {
      const rows = sqlite.prepare(
        `SELECT r.id, r.name, r.match_field, r.match_type, r.match_value,
                r.assign_category_id, c.name as category_name,
                r.assign_tags, r.rename_to, r.is_active, r.priority
         FROM transaction_rules r
         LEFT JOIN categories c ON r.assign_category_id = c.id
         ORDER BY r.priority DESC`
      ).all();
      return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
    }
  );

  server.tool(
    "apply_rules_to_uncategorized",
    "Find uncategorized transactions and apply matching rules to categorize them",
    {
      limit: z.number().optional().describe("Max transactions to process (default 500)"),
    },
    async ({ limit }) => {
      const maxRows = limit ?? 500;

      const rules = sqlite.prepare(
        `SELECT id, name, match_field, match_type, match_value,
                assign_category_id, assign_tags, rename_to, is_active, priority
         FROM transaction_rules WHERE is_active = 1 ORDER BY priority DESC`
      ).all() as Array<{
        id: number; name: string; match_field: string; match_type: string;
        match_value: string; assign_category_id: number | null;
        assign_tags: string | null; rename_to: string | null;
        is_active: number; priority: number;
      }>;

      if (rules.length === 0) {
        return { content: [{ type: "text" as const, text: "No active rules found." }] };
      }

      const uncategorized = sqlite.prepare(
        `SELECT id, payee, amount, tags FROM transactions
         WHERE category_id IS NULL ORDER BY date DESC LIMIT ?`
      ).all(maxRows) as Array<{ id: number; payee: string; amount: number; tags: string }>;

      if (uncategorized.length === 0) {
        return { content: [{ type: "text" as const, text: "No uncategorized transactions found." }] };
      }

      let applied = 0;
      const updateStmt = sqlite.prepare(
        `UPDATE transactions SET category_id = ?, tags = CASE WHEN ? IS NOT NULL THEN ? ELSE tags END,
         payee = CASE WHEN ? IS NOT NULL THEN ? ELSE payee END WHERE id = ?`
      );

      for (const txn of uncategorized) {
        for (const rule of rules) {
          if (matchesRule(txn, rule)) {
            if (rule.assign_category_id) {
              updateStmt.run(
                rule.assign_category_id,
                rule.assign_tags, rule.assign_tags ?? txn.tags,
                rule.rename_to, rule.rename_to ?? txn.payee,
                txn.id
              );
              applied++;
            }
            break;
          }
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: `Processed ${uncategorized.length} uncategorized transactions. Applied rules to ${applied} transactions.`,
        }],
      };
    }
  );

  // ============ SPOTLIGHT & RECAP TOOLS ============

  server.tool(
    "get_spotlight_items",
    "Get current attention items — overspent budgets, upcoming bills, goal deadlines, spending anomalies, uncategorized transactions, low balances, subscription renewals. Sorted by severity (critical first).",
    {},
    async () => {
      const today = new Date().toISOString().split("T")[0];
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const [y, m] = [now.getFullYear(), now.getMonth() + 1];
      const monthStart = `${month}-01`;
      const monthEnd = `${month}-${new Date(y, m, 0).getDate()}`;
      const weekAhead = new Date(now.getTime() + 7 * 86400000).toISOString().split("T")[0];

      const items: { type: string; severity: string; title: string; description: string; amount?: number }[] = [];

      const budgetRows = sqlite.prepare(`
        SELECT b.id, c.name as cat, b.amount as budget,
          COALESCE(ABS(SUM(CASE WHEN t.date >= ? AND t.date <= ? THEN t.amount ELSE 0 END)), 0) as spent
        FROM budgets b LEFT JOIN categories c ON b.category_id = c.id
        LEFT JOIN transactions t ON t.category_id = b.category_id
        WHERE b.month = ? GROUP BY b.id
      `).all(monthStart, monthEnd, month) as { id: number; cat: string; budget: number; spent: number }[];
      for (const r of budgetRows) {
        if (r.budget > 0 && r.spent > r.budget) {
          const pct = Math.round(((r.spent - r.budget) / r.budget) * 100);
          items.push({ type: "overspent_budget", severity: pct > 20 ? "critical" : "warning", title: `${r.cat} over budget`, description: `$${r.spent.toFixed(2)} of $${r.budget.toFixed(2)} (${pct}% over)`, amount: r.spent - r.budget });
        }
      }

      const subs = sqlite.prepare(`SELECT * FROM subscriptions WHERE status = 'active' AND next_date >= ? AND next_date <= ?`).all(today, weekAhead) as { id: number; name: string; amount: number; next_date: string; frequency: string }[];
      for (const s of subs) {
        if (Math.abs(s.amount) >= 100) {
          items.push({ type: "large_bill", severity: "warning", title: `${s.name} due soon`, description: `$${Math.abs(s.amount).toFixed(2)} ${s.frequency}`, amount: Math.abs(s.amount) });
        }
      }

      const uncat = sqlite.prepare(`SELECT COUNT(*) as cnt FROM transactions WHERE date >= ? AND date <= ? AND category_id IS NULL`).get(monthStart, monthEnd) as { cnt: number };
      if (uncat.cnt > 0) {
        items.push({ type: "uncategorized", severity: uncat.cnt > 10 ? "warning" : "info", title: `${uncat.cnt} uncategorized transaction(s)`, description: "Categorize for better tracking" });
      }

      const order: Record<string, number> = { critical: 0, warning: 1, info: 2 };
      items.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));

      return { content: [{ type: "text" as const, text: JSON.stringify(items, null, 2) }] };
    }
  );

  server.tool(
    "get_weekly_recap",
    "Get a weekly financial recap: spending summary (total + vs previous week + top categories), income, net cash flow, budget status, notable transactions, upcoming bills, net worth change.",
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

      const spending = sqlite.prepare(`SELECT c.name, ABS(SUM(t.amount)) as total FROM transactions t LEFT JOIN categories c ON t.category_id = c.id WHERE c.type = 'E' AND t.date >= ? AND t.date <= ? GROUP BY c.id ORDER BY total DESC`).all(ws, we) as { name: string; total: number }[];
      const totalSpent = spending.reduce((s, r) => s + r.total, 0);
      const prevSpending = sqlite.prepare(`SELECT ABS(SUM(t.amount)) as total FROM transactions t LEFT JOIN categories c ON t.category_id = c.id WHERE c.type = 'E' AND t.date >= ? AND t.date <= ?`).get(ps, pe) as { total: number } | undefined;
      const prevTotal = prevSpending?.total ?? 0;
      const changePct = prevTotal > 0 ? Math.round(((totalSpent - prevTotal) / prevTotal) * 100) : 0;

      const inc = sqlite.prepare(`SELECT COALESCE(SUM(t.amount), 0) as total FROM transactions t LEFT JOIN categories c ON t.category_id = c.id WHERE c.type = 'I' AND t.date >= ? AND t.date <= ?`).get(ws, we) as { total: number };

      const notable = sqlite.prepare(`SELECT t.date, t.payee, c.name as category, ABS(t.amount) as amt FROM transactions t LEFT JOIN categories c ON t.category_id = c.id WHERE c.type = 'E' AND t.date >= ? AND t.date <= ? ORDER BY ABS(t.amount) DESC LIMIT 5`).all(ws, we);

      const recap = {
        weekStart: ws, weekEnd: we,
        spending: { total: Math.round(totalSpent * 100) / 100, previousWeekTotal: Math.round(prevTotal * 100) / 100, changePercent: changePct, topCategories: spending.slice(0, 3) },
        income: Math.round(inc.total * 100) / 100,
        netCashFlow: Math.round((inc.total - totalSpent) * 100) / 100,
        notableTransactions: notable,
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(recap, null, 2) }] };
    }
  );
}
