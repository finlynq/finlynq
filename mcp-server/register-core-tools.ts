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

type SqliteRow = Record<string, unknown>;

/** Fuzzy name → row match: exact → startsWith → contains → reverse-contains */
function fuzzyFind(input: string, options: SqliteRow[]): SqliteRow | null {
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

/** Auto-categorize payee: rules → historical frequency */
function autoCategory(sqlite: BetterSqlite3.Database, payee: string): number | null {
  if (!payee) return null;
  const rule = sqlite.prepare(
    `SELECT assign_category_id FROM transaction_rules WHERE is_active = 1 AND LOWER(?) LIKE LOWER(match_payee) ORDER BY priority DESC LIMIT 1`
  ).get(payee) as { assign_category_id: number } | undefined;
  if (rule?.assign_category_id) return rule.assign_category_id;
  const hist = sqlite.prepare(
    `SELECT category_id, COUNT(*) as cnt FROM transactions WHERE LOWER(payee) = LOWER(?) AND category_id IS NOT NULL GROUP BY category_id ORDER BY cnt DESC LIMIT 1`
  ).get(payee) as { category_id: number } | undefined;
  return hist?.category_id ?? null;
}

/** Most-recently-used account */
function defaultAccount(sqlite: BetterSqlite3.Database): SqliteRow | null {
  return sqlite.prepare(
    `SELECT a.id, a.name, a.currency FROM transactions t JOIN accounts a ON a.id = t.account_id ORDER BY t.date DESC, t.id DESC LIMIT 1`
  ).get() as SqliteRow | null;
}

const PORTFOLIO_DISCLAIMER =
  "⚠️ DISCLAIMER: This analysis is for informational purposes only and does not constitute financial advice. Past performance is not indicative of future results. Consult a qualified financial advisor before making investment decisions.";

function txt(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function sqliteErr(msg: string) {
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
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
      note: z.string().optional(),
      tags: z.string().optional().describe("Comma-separated tags"),
    },
    async ({ amount, payee, date, account, category, note, tags }) => {
      const today = new Date().toISOString().split("T")[0];
      const txDate = date ?? today;

      const allAccounts = sqlite.prepare(`SELECT id, name, currency FROM accounts`).all() as SqliteRow[];
      const acct = account ? fuzzyFind(account, allAccounts) : defaultAccount(sqlite);
      if (!acct) return sqliteErr(account ? `Account "${account}" not found. Available: ${allAccounts.map(a => a.name).join(", ")}` : "No accounts found — create an account first.");

      let catId: number | null = null;
      if (category) {
        const allCats = sqlite.prepare(`SELECT id, name FROM categories`).all() as SqliteRow[];
        const cat = fuzzyFind(category, allCats);
        if (!cat) return sqliteErr(`Category "${category}" not found. Available: ${allCats.map(c => c.name).join(", ")}`);
        catId = Number(cat.id);
      } else {
        catId = autoCategory(sqlite, payee);
      }

      const result = sqlite.prepare(
        `INSERT INTO transactions (date, account_id, category_id, currency, amount, payee, note, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      ).get(txDate, acct.id, catId, acct.currency, amount, payee, note ?? "", tags ?? "") as { id: number };

      const catName = catId ? (sqlite.prepare(`SELECT name FROM categories WHERE id = ?`).get(catId) as { name: string } | undefined)?.name ?? "uncategorized" : "uncategorized";
      return txt({ success: true, transactionId: result?.id, message: `Recorded: ${amount > 0 ? "+" : ""}${amount} on ${txDate} — "${payee}" → ${acct.name} (${catName})` });
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
      const allAccounts = sqlite.prepare(`SELECT id, name, currency FROM accounts`).all() as SqliteRow[];
      const allCats = sqlite.prepare(`SELECT id, name FROM categories`).all() as SqliteRow[];
      const mru = defaultAccount(sqlite);
      const stmt = sqlite.prepare(`INSERT INTO transactions (date, account_id, category_id, currency, amount, payee, note, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

      const results: { index: number; success: boolean; message: string }[] = [];
      for (let i = 0; i < transactions.length; i++) {
        const t = transactions[i];
        try {
          const acct = t.account ? fuzzyFind(t.account, allAccounts) : mru;
          if (!acct) { results.push({ index: i, success: false, message: `Account not found: "${t.account}"` }); continue; }
          let catId: number | null = null;
          if (t.category) { const cat = fuzzyFind(t.category, allCats); catId = cat ? Number(cat.id) : null; }
          else catId = autoCategory(sqlite, t.payee);
          stmt.run(t.date ?? today, acct.id, catId, acct.currency, t.amount, t.payee, t.note ?? "", t.tags ?? "");
          results.push({ index: i, success: true, message: `${t.payee}: ${t.amount}` });
        } catch (e) {
          results.push({ index: i, success: false, message: String(e) });
        }
      }
      const ok = results.filter(r => r.success).length;
      return txt({ imported: ok, failed: results.length - ok, results });
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
      const existing = sqlite.prepare(`SELECT id FROM transactions WHERE id = ?`).get(id);
      if (!existing) return sqliteErr(`Transaction #${id} not found`);

      let catId: number | undefined;
      if (category !== undefined) {
        const allCats = sqlite.prepare(`SELECT id, name FROM categories`).all() as SqliteRow[];
        const cat = fuzzyFind(category, allCats);
        if (!cat) return sqliteErr(`Category "${category}" not found`);
        catId = Number(cat.id);
      }

      const updates: string[] = [];
      const params: unknown[] = [];
      if (date !== undefined) { updates.push("date = ?"); params.push(date); }
      if (amount !== undefined) { updates.push("amount = ?"); params.push(amount); }
      if (payee !== undefined) { updates.push("payee = ?"); params.push(payee); }
      if (catId !== undefined) { updates.push("category_id = ?"); params.push(catId); }
      if (note !== undefined) { updates.push("note = ?"); params.push(note); }
      if (tags !== undefined) { updates.push("tags = ?"); params.push(tags); }
      if (!updates.length) return sqliteErr("No fields to update");

      params.push(id);
      sqlite.prepare(`UPDATE transactions SET ${updates.join(", ")} WHERE id = ?`).run(...params);
      return txt({ success: true, message: `Transaction #${id} updated (${updates.length} field(s))` });
    }
  );

  // ── delete_transaction ─────────────────────────────────────────────────────
  server.tool(
    "delete_transaction",
    "Permanently delete a transaction by ID",
    { id: z.number().describe("Transaction ID to delete") },
    async ({ id }) => {
      const t = sqlite.prepare(`SELECT id, payee, amount, date FROM transactions WHERE id = ?`).get(id) as { id: number; payee: string; amount: number; date: string } | undefined;
      if (!t) return sqliteErr(`Transaction #${id} not found`);
      sqlite.prepare(`DELETE FROM transactions WHERE id = ?`).run(id);
      return txt({ success: true, message: `Deleted transaction #${id}: "${t.payee}" ${t.amount} on ${t.date}` });
    }
  );

  // ── delete_budget ──────────────────────────────────────────────────────────
  server.tool(
    "delete_budget",
    "Delete a budget entry for a category/month",
    { category: z.string().describe("Category name"), month: z.string().describe("Month (YYYY-MM)") },
    async ({ category, month }) => {
      const allCats = sqlite.prepare(`SELECT id, name FROM categories`).all() as SqliteRow[];
      const cat = fuzzyFind(category, allCats);
      if (!cat) return sqliteErr(`Category "${category}" not found`);
      const existing = sqlite.prepare(`SELECT id FROM budgets WHERE category_id = ? AND month = ?`).get(cat.id, month) as { id: number } | undefined;
      if (!existing) return sqliteErr(`No budget for "${cat.name}" in ${month}`);
      sqlite.prepare(`DELETE FROM budgets WHERE id = ?`).run(existing.id);
      return txt({ success: true, message: `Budget deleted: ${cat.name} for ${month}` });
    }
  );

  // ── add_account ────────────────────────────────────────────────────────────
  server.tool(
    "add_account",
    "Create a new financial account",
    {
      name: z.string().describe("Account name (must be unique)"),
      type: z.enum(["A", "L"]).describe("'A'=asset, 'L'=liability"),
      group: z.string().optional().describe("Account group"),
      currency: z.enum(["CAD", "USD"]).optional().describe("Currency (default CAD)"),
      note: z.string().optional(),
    },
    async ({ name, type, group, currency, note }) => {
      const existing = sqlite.prepare(`SELECT id FROM accounts WHERE name = ?`).get(name);
      if (existing) return sqliteErr(`Account "${name}" already exists`);
      const result = sqlite.prepare(`INSERT INTO accounts (type, "group", name, currency, note) VALUES (?, ?, ?, ?, ?) RETURNING id`).get(type, group ?? "", name, currency ?? "CAD", note ?? "") as { id: number };
      return txt({ success: true, accountId: result?.id, message: `Account "${name}" created (${type === "A" ? "asset" : "liability"}, ${currency ?? "CAD"})` });
    }
  );

  // ── update_account ─────────────────────────────────────────────────────────
  server.tool(
    "update_account",
    "Update name, group, currency, or note of an account",
    {
      account: z.string().describe("Account name (fuzzy matched)"),
      name: z.string().optional(),
      group: z.string().optional(),
      currency: z.enum(["CAD", "USD"]).optional(),
      note: z.string().optional(),
    },
    async ({ account, name, group, currency, note }) => {
      const allAccounts = sqlite.prepare(`SELECT id, name FROM accounts`).all() as SqliteRow[];
      const acct = fuzzyFind(account, allAccounts);
      if (!acct) return sqliteErr(`Account "${account}" not found`);
      const updates: string[] = []; const params: unknown[] = [];
      if (name !== undefined) { updates.push(`name = ?`); params.push(name); }
      if (group !== undefined) { updates.push(`"group" = ?`); params.push(group); }
      if (currency !== undefined) { updates.push(`currency = ?`); params.push(currency); }
      if (note !== undefined) { updates.push(`note = ?`); params.push(note); }
      if (!updates.length) return sqliteErr("No fields to update");
      params.push(acct.id);
      sqlite.prepare(`UPDATE accounts SET ${updates.join(", ")} WHERE id = ?`).run(...params);
      return txt({ success: true, message: `Account "${acct.name}" updated` });
    }
  );

  // ── delete_account ─────────────────────────────────────────────────────────
  server.tool(
    "delete_account",
    "Delete an account (only if it has no transactions, unless force=true)",
    {
      account: z.string().describe("Account name (fuzzy matched)"),
      force: z.boolean().optional(),
    },
    async ({ account, force }) => {
      const allAccounts = sqlite.prepare(`SELECT id, name FROM accounts`).all() as SqliteRow[];
      const acct = fuzzyFind(account, allAccounts);
      if (!acct) return sqliteErr(`Account "${account}" not found`);
      const count = (sqlite.prepare(`SELECT COUNT(*) as cnt FROM transactions WHERE account_id = ?`).get(acct.id) as { cnt: number }).cnt;
      if (count > 0 && !force) return sqliteErr(`Account "${acct.name}" has ${count} transaction(s). Pass force=true to delete.`);
      sqlite.prepare(`DELETE FROM accounts WHERE id = ?`).run(acct.id);
      return txt({ success: true, message: `Account "${acct.name}" deleted${count > 0 ? ` (${count} transactions also removed)` : ""}` });
    }
  );

  // ── update_goal ────────────────────────────────────────────────────────────
  server.tool(
    "update_goal",
    "Update a financial goal's target, deadline, or status",
    {
      goal: z.string().describe("Goal name (fuzzy matched)"),
      target_amount: z.number().optional(),
      deadline: z.string().optional(),
      status: z.enum(["active", "completed", "paused"]).optional(),
      name: z.string().optional().describe("Rename the goal"),
    },
    async ({ goal, target_amount, deadline, status, name }) => {
      const allGoals = sqlite.prepare(`SELECT id, name FROM goals`).all() as SqliteRow[];
      const g = fuzzyFind(goal, allGoals);
      if (!g) return sqliteErr(`Goal "${goal}" not found`);
      const updates: string[] = []; const params: unknown[] = [];
      if (name !== undefined) { updates.push(`name = ?`); params.push(name); }
      if (target_amount !== undefined) { updates.push(`target_amount = ?`); params.push(target_amount); }
      if (deadline !== undefined) { updates.push(`deadline = ?`); params.push(deadline); }
      if (status !== undefined) { updates.push(`status = ?`); params.push(status); }
      if (!updates.length) return sqliteErr("No fields to update");
      params.push(g.id);
      sqlite.prepare(`UPDATE goals SET ${updates.join(", ")} WHERE id = ?`).run(...params);
      return txt({ success: true, message: `Goal "${g.name}" updated` });
    }
  );

  // ── delete_goal ────────────────────────────────────────────────────────────
  server.tool(
    "delete_goal",
    "Delete a financial goal by name",
    { goal: z.string().describe("Goal name (fuzzy matched)") },
    async ({ goal }) => {
      const allGoals = sqlite.prepare(`SELECT id, name FROM goals`).all() as SqliteRow[];
      const g = fuzzyFind(goal, allGoals);
      if (!g) return sqliteErr(`Goal "${goal}" not found`);
      sqlite.prepare(`DELETE FROM goals WHERE id = ?`).run(g.id);
      return txt({ success: true, message: `Goal "${g.name}" deleted` });
    }
  );

  // ── create_category ────────────────────────────────────────────────────────
  server.tool(
    "create_category",
    "Create a new transaction category",
    {
      name: z.string().describe("Category name (must be unique)"),
      type: z.enum(["E", "I", "T"]).describe("'E'=expense, 'I'=income, 'T'=transfer"),
      group: z.string().optional(),
      note: z.string().optional(),
    },
    async ({ name, type, group, note }) => {
      const existing = sqlite.prepare(`SELECT id FROM categories WHERE name = ?`).get(name);
      if (existing) return sqliteErr(`Category "${name}" already exists`);
      const result = sqlite.prepare(`INSERT INTO categories (name, type, "group", note) VALUES (?, ?, ?, ?) RETURNING id`).get(name, type, group ?? "", note ?? "") as { id: number };
      return txt({ success: true, categoryId: result?.id, message: `Category "${name}" created (${type === "E" ? "expense" : type === "I" ? "income" : "transfer"})` });
    }
  );

  // ── create_rule ────────────────────────────────────────────────────────────
  server.tool(
    "create_rule",
    "Create an auto-categorization rule for future imports",
    {
      match_payee: z.string().describe("Payee pattern (supports % wildcards)"),
      assign_category: z.string().describe("Category name to assign (fuzzy matched)"),
      rename_to: z.string().optional(),
      assign_tags: z.string().optional(),
      priority: z.number().optional().describe("Default 0"),
    },
    async ({ match_payee, assign_category, rename_to, assign_tags, priority }) => {
      const allCats = sqlite.prepare(`SELECT id, name FROM categories`).all() as SqliteRow[];
      const cat = fuzzyFind(assign_category, allCats);
      if (!cat) return sqliteErr(`Category "${assign_category}" not found`);
      sqlite.prepare(`INSERT INTO transaction_rules (match_payee, assign_category_id, rename_to, assign_tags, priority, is_active) VALUES (?, ?, ?, ?, ?, 1)`).run(match_payee, cat.id, rename_to ?? null, assign_tags ?? null, priority ?? 0);
      return txt({ success: true, message: `Rule created: "${match_payee}" → ${cat.name}` });
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
      const allCats = sqlite.prepare(`SELECT id, name FROM categories`).all() as SqliteRow[];
      const cat = fuzzyFind(category, allCats);
      if (!cat) return sqliteErr(`Category "${category}" not found`);
      const txn = sqlite.prepare(`SELECT id, payee FROM transactions WHERE id = ?`).get(transaction_id) as { id: number; payee: string } | undefined;
      if (!txn) return sqliteErr(`Transaction #${transaction_id} not found`);
      sqlite.prepare(`UPDATE transactions SET category_id = ? WHERE id = ?`).run(cat.id, transaction_id);
      return txt({ success: true, message: `Transaction #${transaction_id} ("${txn.payee}") categorized as "${cat.name}"` });
    }
  );

  // ── get_portfolio_analysis ─────────────────────────────────────────────────
  server.tool(
    "get_portfolio_analysis",
    "Portfolio holdings with allocation breakdown by asset class and currency",
    {},
    async () => {
      const holdings = sqlite.prepare(`
        SELECT ph.id, ph.name, ph.symbol, ph.currency, a.name as account_name,
               COALESCE(SUM(t.quantity), 0) as total_quantity,
               COALESCE(SUM(t.amount), 0) as book_value
        FROM portfolio_holdings ph
        JOIN accounts a ON a.id = ph.account_id
        LEFT JOIN transactions t ON t.portfolio_holding = ph.name
        GROUP BY ph.id, ph.name, ph.symbol, ph.currency, a.name
        ORDER BY ABS(COALESCE(SUM(t.amount), 0)) DESC
      `).all() as SqliteRow[];

      const byCurrency: Record<string, number> = {};
      const byAccount: Record<string, number> = {};
      let totalBV = 0;
      for (const h of holdings) {
        const bv = Math.abs(Number(h.book_value));
        byCurrency[String(h.currency)] = (byCurrency[String(h.currency)] ?? 0) + bv;
        byAccount[String(h.account_name)] = (byAccount[String(h.account_name)] ?? 0) + bv;
        totalBV += bv;
      }

      return txt({
        disclaimer: PORTFOLIO_DISCLAIMER,
        totalHoldings: holdings.length,
        totalBookValue: Math.round(totalBV * 100) / 100,
        holdings: holdings.map(h => ({
          name: h.name, symbol: h.symbol, account: h.account_name, currency: h.currency,
          quantity: Number(h.total_quantity),
          bookValue: Math.round(Math.abs(Number(h.book_value)) * 100) / 100,
          pct: totalBV > 0 ? Math.round((Math.abs(Number(h.book_value)) / totalBV) * 1000) / 10 : 0,
        })),
        allocationByCurrency: Object.entries(byCurrency).map(([currency, value]) => ({
          currency, value: Math.round(value * 100) / 100,
          pct: totalBV > 0 ? Math.round((value / totalBV) * 1000) / 10 : 0,
        })),
        allocationByAccount: Object.entries(byAccount).map(([account, value]) => ({
          account, value: Math.round(value * 100) / 100,
          pct: totalBV > 0 ? Math.round((value / totalBV) * 1000) / 10 : 0,
        })),
      });
    }
  );

  // ── get_portfolio_performance ──────────────────────────────────────────────
  server.tool(
    "get_portfolio_performance",
    "Portfolio performance: cost basis and realized P&L by holding",
    { period: z.enum(["1m", "3m", "6m", "1y", "all"]).optional() },
    async ({ period }) => {
      const cutoff: Record<string, string> = {
        "1m": new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0],
        "3m": new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0],
        "6m": new Date(Date.now() - 180 * 86400000).toISOString().split("T")[0],
        "1y": new Date(Date.now() - 365 * 86400000).toISOString().split("T")[0],
        "all": "1900-01-01",
      };
      const since = cutoff[period ?? "all"];
      const perf = sqlite.prepare(`
        SELECT portfolio_holding as holding, COUNT(*) as tx_count,
               SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as cost_basis,
               SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as proceeds,
               SUM(quantity) as net_quantity,
               MIN(date) as first_purchase, MAX(date) as last_activity
        FROM transactions WHERE portfolio_holding IS NOT NULL AND portfolio_holding != '' AND date >= ?
        GROUP BY portfolio_holding ORDER BY cost_basis DESC
      `).all(since) as SqliteRow[];

      const results = perf.map(p => {
        const costBasis = Number(p.cost_basis ?? 0);
        const proceeds = Number(p.proceeds ?? 0);
        const pnl = proceeds - costBasis;
        return {
          holding: p.holding, txCount: Number(p.tx_count),
          costBasis: Math.round(costBasis * 100) / 100,
          proceeds: Math.round(proceeds * 100) / 100,
          realizedPnL: Math.round(pnl * 100) / 100,
          realizedPnLPct: costBasis > 0 ? Math.round((pnl / costBasis) * 1000) / 10 : null,
          netQuantity: Number(p.net_quantity ?? 0),
          firstPurchase: p.first_purchase, lastActivity: p.last_activity,
        };
      });

      return txt({
        disclaimer: PORTFOLIO_DISCLAIMER,
        period: period ?? "all",
        summary: {
          holdings: results.length,
          totalCostBasis: Math.round(results.reduce((s, r) => s + r.costBasis, 0) * 100) / 100,
          totalRealizedPnL: Math.round(results.reduce((s, r) => s + r.realizedPnL, 0) * 100) / 100,
        },
        holdings: results,
      });
    }
  );

  // ── analyze_holding ────────────────────────────────────────────────────────
  server.tool(
    "analyze_holding",
    "Deep-dive analysis of a single holding: transaction history, avg cost, P&L",
    { symbol: z.string().describe("Holding name or symbol (fuzzy matched)") },
    async ({ symbol }) => {
      const txns = sqlite.prepare(`
        SELECT t.id, t.date, t.amount, t.quantity, t.payee, t.portfolio_holding, a.name as account_name, a.currency
        FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE (LOWER(t.portfolio_holding) LIKE LOWER(?) OR LOWER(t.payee) LIKE LOWER(?))
        ORDER BY t.date ASC
      `).all(`%${symbol}%`, `%${symbol}%`) as SqliteRow[];

      if (!txns.length) return sqliteErr(`No transactions found for "${symbol}"`);

      const holdingName = txns[0].portfolio_holding || txns[0].payee;
      let totalShares = 0, totalCost = 0;
      const purchases: SqliteRow[] = [], sales: SqliteRow[] = [];
      for (const t of txns) {
        if (Number(t.amount) < 0) { totalShares += Number(t.quantity ?? 0); totalCost += Math.abs(Number(t.amount)); purchases.push(t); }
        else { totalShares -= Number(t.quantity ?? 0); sales.push(t); }
      }
      const avgCost = purchases.length && totalCost > 0
        ? totalCost / purchases.reduce((s, t) => s + Number(t.quantity ?? 0), 0)
        : null;

      return txt({
        disclaimer: PORTFOLIO_DISCLAIMER,
        holding: holdingName, totalTransactions: txns.length,
        purchases: purchases.length, sales: sales.length,
        currentShares: Math.round(totalShares * 10000) / 10000,
        totalCostBasis: Math.round(totalCost * 100) / 100,
        avgCostPerShare: avgCost ? Math.round(avgCost * 100) / 100 : null,
        firstPurchase: txns[0].date, lastActivity: txns[txns.length - 1].date,
        recentTransactions: txns.slice(-5).map(t => ({ date: t.date, amount: t.amount, quantity: t.quantity, account: t.account_name })),
      });
    }
  );

  // ── get_rebalancing_suggestions ────────────────────────────────────────────
  server.tool(
    "get_rebalancing_suggestions",
    "Suggest rebalancing based on target allocations vs current book-value weights",
    {
      targets: z.array(z.object({
        holding: z.string(),
        target_pct: z.number().describe("Target allocation % (0-100)"),
      })).describe("Target allocations (should sum to ~100)"),
    },
    async ({ targets }) => {
      const holdings = sqlite.prepare(`
        SELECT portfolio_holding as name, SUM(ABS(amount)) as book_value
        FROM transactions WHERE portfolio_holding IS NOT NULL AND portfolio_holding != '' AND amount < 0
        GROUP BY portfolio_holding
      `).all() as SqliteRow[];

      const totalBV = holdings.reduce((s, h) => s + Number(h.book_value), 0);
      if (totalBV === 0) return sqliteErr("No portfolio holdings found");

      const currentMap = new Map(holdings.map(h => [String(h.name).toLowerCase(), { name: h.name, value: Number(h.book_value) }]));
      const suggestions = targets.map(t => {
        const lo = t.holding.toLowerCase();
        const current = [...currentMap.entries()].find(([k]) => k.includes(lo) || lo.includes(k))?.[1];
        const currValue = current?.value ?? 0;
        const targetValue = (t.target_pct / 100) * totalBV;
        const diff = targetValue - currValue;
        return {
          holding: t.holding,
          currentPct: Math.round((currValue / totalBV) * 1000) / 10,
          targetPct: t.target_pct,
          currentValue: Math.round(currValue * 100) / 100,
          targetValue: Math.round(targetValue * 100) / 100,
          action: diff > 0 ? "BUY" : diff < 0 ? "SELL" : "HOLD",
          amount: Math.round(Math.abs(diff) * 100) / 100,
        };
      });

      return txt({
        disclaimer: PORTFOLIO_DISCLAIMER,
        totalPortfolioValue: Math.round(totalBV * 100) / 100,
        suggestions,
        note: "Based on book cost, not market price.",
      });
    }
  );

  // ── get_investment_insights ────────────────────────────────────────────────
  server.tool(
    "get_investment_insights",
    "Investment patterns: contribution frequency, top positions, diversification score",
    {},
    async () => {
      const positions = sqlite.prepare(`
        SELECT portfolio_holding as name, SUM(ABS(amount)) as book_value, COUNT(*) as purchases
        FROM transactions WHERE portfolio_holding IS NOT NULL AND portfolio_holding != '' AND amount < 0
        GROUP BY portfolio_holding ORDER BY book_value DESC
      `).all() as SqliteRow[];

      const contributions = sqlite.prepare(`
        SELECT strftime('%Y-%m', date) as month, SUM(ABS(amount)) as invested
        FROM transactions WHERE portfolio_holding IS NOT NULL AND portfolio_holding != '' AND amount < 0
        GROUP BY strftime('%Y-%m', date) ORDER BY month DESC LIMIT 12
      `).all() as SqliteRow[];

      const totalInvested = positions.reduce((s, p) => s + Number(p.book_value), 0);
      const top3 = positions.slice(0, 3).reduce((s, p) => s + Number(p.book_value), 0) / (totalInvested || 1);
      const diversScore = Math.max(0, Math.round((1 - top3) * 100));
      const avgMonthly = contributions.length > 0 ? contributions.reduce((s, c) => s + Number(c.invested), 0) / contributions.length : 0;

      return txt({
        disclaimer: PORTFOLIO_DISCLAIMER,
        summary: {
          totalPositions: positions.length,
          totalInvested: Math.round(totalInvested * 100) / 100,
          avgMonthlyContribution: Math.round(avgMonthly * 100) / 100,
          diversificationScore: diversScore,
          diversificationLabel: diversScore > 70 ? "Well diversified" : diversScore > 40 ? "Moderately diversified" : "Concentrated",
          concentration: `Top 3 = ${Math.round(top3 * 1000) / 10}% of portfolio`,
        },
        topPositions: positions.slice(0, 5).map(p => ({
          name: p.name,
          bookValue: Math.round(Number(p.book_value) * 100) / 100,
          pct: Math.round((Number(p.book_value) / totalInvested) * 1000) / 10,
          purchases: Number(p.purchases),
        })),
        monthlyContributions: contributions.slice(0, 6).map(c => ({ month: c.month, invested: Math.round(Number(c.invested) * 100) / 100 })),
      });
    }
  );

  // ── compare_to_benchmark ───────────────────────────────────────────────────
  server.tool(
    "compare_to_benchmark",
    "Compare portfolio book-value growth to a reference benchmark (informational only)",
    { benchmark: z.enum(["SP500", "TSX", "MSCI_WORLD", "BONDS_CA"]).optional() },
    async ({ benchmark }) => {
      const bm = benchmark ?? "SP500";
      const bmInfo: Record<string, { label: string; annualizedReturn: number; description: string }> = {
        SP500:      { label: "S&P 500",            annualizedReturn: 10.5, description: "US large-cap equities (USD)" },
        TSX:        { label: "S&P/TSX Composite",   annualizedReturn: 8.2,  description: "Canadian equities (CAD)" },
        MSCI_WORLD: { label: "MSCI World",           annualizedReturn: 9.4,  description: "Global developed markets (USD)" },
        BONDS_CA:   { label: "Canadian Bonds",       annualizedReturn: 3.8,  description: "Canadian aggregate bonds (CAD)" },
      };
      const info = bmInfo[bm];

      const row = sqlite.prepare(`
        SELECT MIN(date) as first_date, MAX(date) as last_date, SUM(ABS(amount)) as total_invested
        FROM transactions WHERE portfolio_holding IS NOT NULL AND portfolio_holding != '' AND amount < 0
      `).get() as { first_date: string | null; last_date: string; total_invested: number } | undefined;

      if (!row?.first_date) return txt({ disclaimer: PORTFOLIO_DISCLAIMER, message: "No investment transactions found" });

      const yearsHeld = Math.max(0.1, (new Date(row.last_date).getTime() - new Date(row.first_date).getTime()) / (365.25 * 86400000));
      const benchFinal = row.total_invested * Math.pow(1 + info.annualizedReturn / 100, yearsHeld);
      const benchGain = benchFinal - row.total_invested;

      return txt({
        disclaimer: PORTFOLIO_DISCLAIMER,
        note: "Uses book cost, not market value. Illustrative only.",
        yourPortfolio: { totalInvested: Math.round(row.total_invested * 100) / 100, investingSince: row.first_date, yearsInvesting: Math.round(yearsHeld * 10) / 10 },
        benchmark: { name: info.label, description: info.description, historicalAnnualizedReturn: `${info.annualizedReturn}%`, period: "10-year historical average (approximate)" },
        hypothetical: {
          message: `If $${Math.round(row.total_invested)} invested over ${Math.round(yearsHeld * 10) / 10} years earned ${info.annualizedReturn}% annually:`,
          finalValue: Math.round(benchFinal * 100) / 100,
          gain: Math.round(benchGain * 100) / 100,
          gainPct: Math.round((benchGain / row.total_invested) * 1000) / 10,
        },
        limitations: [
          "Book cost ≠ market value — add current prices for real comparison",
          "Dollar-cost averaging timing not accounted for precisely",
          "Benchmark returns exclude fees, taxes, and currency conversion",
        ],
      });
    }
  );

  // ── finlynq_help ───────────────────────────────────────────────────────────
  server.tool(
    "finlynq_help",
    "Discover available tools, schema, and usage examples",
    {
      topic: z.enum(["tools", "schema", "examples", "write", "portfolio"]).optional(),
      tool_name: z.string().optional().describe("Get help for a specific tool"),
    },
    async ({ topic, tool_name }) => {
      if (tool_name) {
        const docs: Record<string, string> = {
          record_transaction: "record_transaction(amount, payee, date?, account?, category?, note?, tags?) — Smart defaults: account defaults to MRU, category auto-detected from payee rules/history.",
          bulk_record_transactions: "bulk_record_transactions(transactions[]) — Same smart defaults. Returns per-item success/failure.",
          update_transaction: "update_transaction(id, date?, amount?, payee?, category?, note?, tags?)",
          delete_transaction: "delete_transaction(id) — Permanently delete.",
          set_budget: "set_budget(category, month, amount) — Upsert budget. month=YYYY-MM.",
          delete_budget: "delete_budget(category, month)",
          add_account: "add_account(name, type, group?, currency?, note?) — type: 'A'=asset, 'L'=liability.",
          update_account: "update_account(account, name?, group?, currency?, note?)",
          delete_account: "delete_account(account, force?)",
          add_goal: "add_goal(name, type, target_amount, deadline?, account?)",
          update_goal: "update_goal(goal, target_amount?, deadline?, status?, name?)",
          delete_goal: "delete_goal(goal)",
          create_category: "create_category(name, type, group?, note?) — type: E/I/T",
          create_rule: "create_rule(match_payee, assign_category, rename_to?, assign_tags?, priority?)",
          categorize_transaction: "categorize_transaction(transaction_id, category)",
        };
        return txt({ tool: tool_name, usage: docs[tool_name] ?? "Use topic='tools' for full list." });
      }

      const t = topic ?? "tools";

      if (t === "tools") return txt({
        read_tools: ["get_account_balances", "get_transactions", "get_budget_summary", "get_spending_trends", "get_portfolio_summary", "get_net_worth", "get_categories", "get_loans", "get_goals", "get_recurring_transactions", "get_income_statement", "get_spotlight_items", "get_weekly_recap", "get_transaction_rules"],
        write_tools: ["record_transaction", "bulk_record_transactions", "update_transaction", "delete_transaction", "add_transaction", "set_budget", "delete_budget", "add_account", "update_account", "delete_account", "add_goal", "update_goal", "delete_goal", "create_category", "create_rule", "add_snapshot", "apply_rules_to_uncategorized", "categorize_transaction"],
        portfolio_tools: ["get_portfolio_analysis", "get_portfolio_performance", "analyze_holding", "get_rebalancing_suggestions", "get_investment_insights", "compare_to_benchmark"],
        tip: "Use tool_name='record_transaction' for usage details.",
      });

      if (t === "schema") return txt({
        key_tables: {
          transactions: "id, date, account_id, category_id, currency, amount, payee, note, tags",
          accounts: "id, type(A/L), group, name, currency, note",
          categories: "id, type(E/I/T), group, name, note",
          budgets: "id, category_id, month(YYYY-MM), amount",
          goals: "id, name, type, target_amount, deadline, status, account_id",
          transaction_rules: "id, match_payee, assign_category_id, rename_to, assign_tags, priority, is_active",
        },
        amount_convention: "Negative=expense/debit, Positive=income/credit",
        date_format: "YYYY-MM-DD strings",
      });

      if (t === "examples") return txt({ examples: [
        { task: "Log a coffee", call: 'record_transaction(amount=-5.50, payee="Tim Hortons")' },
        { task: "Log salary", call: 'record_transaction(amount=3500, payee="Employer", category="Salary")' },
        { task: "Set budget", call: 'set_budget(category="Groceries", month="2026-04", amount=600)' },
        { task: "Fix category", call: 'categorize_transaction(transaction_id=42, category="Restaurants")' },
        { task: "Analyze portfolio", call: "get_portfolio_analysis()" },
      ]});

      if (t === "portfolio") return txt({ tools: ["get_portfolio_analysis", "get_portfolio_performance", "analyze_holding", "get_rebalancing_suggestions", "get_investment_insights", "compare_to_benchmark"], disclaimer: PORTFOLIO_DISCLAIMER });

      if (t === "write") return txt({
        primary_add: "record_transaction — smart defaults, fuzzy matching",
        bulk: "bulk_record_transactions(transactions[])",
        edits: ["update_transaction(id, ...)", "delete_transaction(id)", "categorize_transaction(id, category)"],
        budget: ["set_budget(category, month, amount)", "delete_budget(category, month)"],
        accounts: ["add_account(name, type)", "update_account(account, ...)", "delete_account(account)"],
        goals: ["add_goal(name, type, amount)", "update_goal(goal, ...)", "delete_goal(goal)"],
        categories: ["create_category(name, type)", "create_rule(match_payee, assign_category)"],
      });

      return txt({ error: "Unknown topic" });
    }
  );
}
