// MCP Core Tools — extracted for reuse across stdio and HTTP transports
//
// IMPORTANT: Every query in this file must be scoped to the current userId.
// The stdio transport has no HTTP auth, so `registerCoreTools` takes the
// userId from the environment (`PF_USER_ID`) at startup and threads it into
// every tool via closure. Tool handlers must NEVER accept a userId from
// tool arguments — the argument schemas explicitly don't expose one.
//
// Read tools: add `user_id = ?` to every WHERE clause.
// Write tools: ownership pre-check on the target row before UPDATE/DELETE;
// INSERTs always include `user_id = ?` with the closure userId.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PgCompatDb } from "./pg-compat.js";
import {
  generateAmortizationSchedule,
  calculateDebtPayoff,
  type Debt,
} from "../src/lib/loan-calculator.js";
import { getLatestFxRate, getRate } from "../src/lib/fx-service.js";
import { resolveTxAmountsCore } from "../src/lib/currency-conversion.js";
import {
  invalidateUser as invalidateUserTxCache,
  getUserTransactions,
} from "../src/lib/mcp/user-tx-cache.js";
import {
  signConfirmationToken,
  verifyConfirmationToken,
} from "../src/lib/mcp/confirmation-token.js";
import fs from "fs/promises";
import {
  csvToRawTransactions,
  csvToRawTransactionsWithMapping,
} from "../src/lib/csv-parser.js";
import { parseOfx } from "../src/lib/ofx-parser.js";
import { previewImport as pipelinePreview, executeImport as pipelineExecute, type RawTransaction } from "../src/lib/import-pipeline.js";
import { generateImportHash } from "../src/lib/import-hash.js";

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

/**
 * Stdio-side mirror of mcp-server/reporting-currency.ts.
 *
 * Returns the user's display currency for a tool call:
 *   - explicit param wins (uppercased)
 *   - else settings.display_currency (uppercased)
 *   - else "CAD"
 */
async function resolveReportingCurrencyStdio(
  sqlite: PgCompatDb,
  userId: string,
  param?: string | null,
): Promise<string> {
  if (param && /^[A-Z]{3,4}$/i.test(param)) return param.toUpperCase();
  try {
    const r = await sqlite
      .prepare(`SELECT value FROM settings WHERE user_id = ? AND key = 'display_currency' LIMIT 1`)
      .get(userId) as { value?: string } | undefined;
    if (r?.value) return r.value.trim().toUpperCase();
  } catch {
    // Best effort — fall through to default.
  }
  return "CAD";
}

/**
 * Fuzzy match against a row list: exact-name → exact-alias → startsWith-name →
 * contains-name → reverse-contains-name.
 *
 * Alias match is exact-only (case-insensitive, trimmed). Only account rows
 * carry `alias`; for other shapes the alias branch is a no-op.
 */
function fuzzyFind(input: string, options: SqliteRow[]): SqliteRow | null {
  if (!input || !options.length) return null;
  const lo = input.toLowerCase().trim();
  return (
    options.find(o => String(o.name  ?? "").toLowerCase() === lo) ??
    options.find(o => String(o.alias ?? "").toLowerCase() === lo) ??
    options.find(o => String(o.name  ?? "").toLowerCase().startsWith(lo)) ??
    options.find(o => String(o.name  ?? "").toLowerCase().includes(lo)) ??
    options.find(o => lo.includes(String(o.name ?? "").toLowerCase())) ??
    null
  );
}

/** Auto-categorize payee: rules → historical frequency (both user-scoped) */
async function autoCategory(sqlite: PgCompatDb, userId: string, payee: string): Promise<number | null> {
  if (!payee) return null;
  const rule = await sqlite.prepare(
    `SELECT assign_category_id FROM transaction_rules WHERE user_id = ? AND is_active = 1 AND LOWER(?) LIKE LOWER(match_payee) ORDER BY priority DESC LIMIT 1`
  ).get(userId, payee) as { assign_category_id: number } | undefined;
  if (rule?.assign_category_id) return rule.assign_category_id;
  const hist = await sqlite.prepare(
    `SELECT category_id, COUNT(*) as cnt FROM transactions WHERE user_id = ? AND LOWER(payee) = LOWER(?) AND category_id IS NOT NULL GROUP BY category_id ORDER BY cnt DESC LIMIT 1`
  ).get(userId, payee) as { category_id: number } | undefined;
  return hist?.category_id ?? null;
}

const PORTFOLIO_DISCLAIMER =
  "⚠️ DISCLAIMER: This analysis is for informational purposes only and does not constitute financial advice. Past performance is not indicative of future results. Consult a qualified financial advisor before making investment decisions.";

function txt(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function sqliteErr(msg: string) {
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

export interface CoreToolsOptions {
  userId: string;
}

export function registerCoreTools(server: McpServer, sqlite: PgCompatDb, opts: CoreToolsOptions) {
  const userId = opts.userId;
  if (!userId) {
    throw new Error("registerCoreTools: opts.userId is required — every stdio tool must be scoped to a user.");
  }

  // ============ READ TOOLS ============

  server.tool(
    "get_account_balances",
    "Get current balances for all accounts, grouped by type (asset/liability). Each balance is in its own (account) currency; the response surfaces reportingCurrency for cross-currency context.",
    {
      currency: z.enum(["CAD", "USD", "all"]).optional().describe("Filter by currency"),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency. Returned as response metadata for cross-currency aggregation context."),
    },
    async ({ currency, reportingCurrency }) => {
      const reporting = await resolveReportingCurrencyStdio(sqlite, userId, reportingCurrency);
      let query = `SELECT a.id, a.name, a.alias, a.type, a."group", a.currency, COALESCE(SUM(t.amount), 0) as balance FROM accounts a LEFT JOIN transactions t ON a.id = t.account_id AND t.user_id = ? WHERE a.user_id = ?`;
      const params: (string | number)[] = [userId, userId];
      if (currency && currency !== "all") { query += ` AND a.currency = ?`; params.push(currency); }
      query += ` GROUP BY a.id ORDER BY a.type, a."group", a.name`;
      const rows = await sqlite.prepare(query).all(...params);
      return { content: [{ type: "text" as const, text: JSON.stringify({ accounts: rows, reportingCurrency: reporting }, null, 2) }] };
    }
  );

  server.tool(
    "get_budget_summary",
    "Get budget vs actual spending for a specific month. Amounts are in the user's display currency (default reporting); pass reportingCurrency to override the surfaced metadata.",
    {
      month: z.string().describe("Month in YYYY-MM format"),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async ({ month, reportingCurrency }) => {
      const reporting = await resolveReportingCurrencyStdio(sqlite, userId, reportingCurrency);
      const [y, m] = month.split("-").map(Number);
      const startDate = `${month}-01`;
      const endDate = `${month}-${new Date(y, m, 0).getDate()}`;
      const rows = await sqlite.prepare(`SELECT b.id, c.name as category, c."group" as category_group, b.amount as budget, COALESCE(ABS(SUM(CASE WHEN t.date >= ? AND t.date <= ? AND t.user_id = ? THEN t.amount ELSE 0 END)), 0) as spent FROM budgets b JOIN categories c ON b.category_id = c.id LEFT JOIN transactions t ON t.category_id = c.id WHERE b.user_id = ? AND b.month = ? GROUP BY b.id ORDER BY c."group", c.name`).all(startDate, endDate, userId, userId, month);
      return { content: [{ type: "text" as const, text: JSON.stringify({ rows, reportingCurrency: reporting }, null, 2) }] };
    }
  );

  server.tool(
    "get_spending_trends",
    "Get spending trends over time grouped by category. Totals are in the user's display currency (default reporting); pass reportingCurrency to override the surfaced metadata.",
    {
      period: z.enum(["weekly", "monthly", "yearly"]).describe("Aggregation period"),
      months: z.number().optional().describe("Months to look back (default 12)"),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async ({ period, months, reportingCurrency }) => {
      const reporting = await resolveReportingCurrencyStdio(sqlite, userId, reportingCurrency);
      const lookback = months ?? 12;
      const startDate = new Date(new Date().getFullYear(), new Date().getMonth() - lookback, 1).toISOString().split("T")[0];
      const groupExpr = period === "weekly" ? "strftime('%Y-W%W', t.date)" : period === "yearly" ? "strftime('%Y', t.date)" : "strftime('%Y-%m', t.date)";
      const rows = await sqlite.prepare(`SELECT ${groupExpr} as period, c.name as category, c."group" as category_group, SUM(t.amount) as total FROM transactions t LEFT JOIN categories c ON t.category_id = c.id WHERE t.user_id = ? AND t.date >= ? AND c.type = 'E' GROUP BY ${groupExpr}, c.name ORDER BY ${groupExpr}, total`).all(userId, startDate);
      return { content: [{ type: "text" as const, text: JSON.stringify({ rows, reportingCurrency: reporting }, null, 2) }] };
    }
  );

  server.tool(
    "get_net_worth",
    "Net worth across all accounts. Returns per-currency assets/liabilities/net. Pass `months` > 0 for a trend; omit for current totals. reportingCurrency is surfaced as metadata for cross-currency context.",
    {
      currency: z.enum(["CAD", "USD", "all"]).optional().describe("Filter by currency"),
      months: z.number().optional().describe("If set, return a trend over the last N months"),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async ({ currency, months, reportingCurrency }) => {
      const reporting = await resolveReportingCurrencyStdio(sqlite, userId, reportingCurrency);
      if (!months || months <= 0) {
        let query = `SELECT a.type, a.currency, COALESCE(SUM(t.amount), 0) as total FROM accounts a LEFT JOIN transactions t ON a.id = t.account_id AND t.user_id = ? WHERE a.user_id = ?`;
        const params: (string | number)[] = [userId, userId];
        if (currency && currency !== "all") { query += " AND a.currency = ?"; params.push(currency); }
        query += " GROUP BY a.type, a.currency";
        const rows = await sqlite.prepare(query).all(...params) as { type: string; currency: string; total: number }[];
        const summary: Record<string, { assets: number; liabilities: number; net: number }> = {};
        for (const row of rows) {
          if (!summary[row.currency]) summary[row.currency] = { assets: 0, liabilities: 0, net: 0 };
          if (row.type === "A") summary[row.currency].assets = row.total;
          else summary[row.currency].liabilities = row.total;
          summary[row.currency].net = summary[row.currency].assets + summary[row.currency].liabilities;
        }
        return { content: [{ type: "text" as const, text: JSON.stringify({ byCurrency: summary, reportingCurrency: reporting }, null, 2) }] };
      }

      const startDate = new Date();
      startDate.setMonth(startDate.getMonth() - months);
      const startStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}-01`;

      let query = `SELECT strftime('%Y-%m', t.date) as month, a.currency, SUM(t.amount) as total FROM transactions t LEFT JOIN accounts a ON t.account_id = a.id WHERE t.user_id = ? AND t.date >= ?`;
      const params: (string | number)[] = [userId, startStr];
      if (currency && currency !== "all") { query += " AND a.currency = ?"; params.push(currency); }
      query += " GROUP BY strftime('%Y-%m', t.date), a.currency ORDER BY month";
      const rows = await sqlite.prepare(query).all(...params) as { month: string; currency: string; total: number }[];

      let baselineQuery = `SELECT a.currency, COALESCE(SUM(t.amount), 0) as total FROM transactions t LEFT JOIN accounts a ON t.account_id = a.id WHERE t.user_id = ? AND t.date < ?`;
      const baseParams: (string | number)[] = [userId, startStr];
      if (currency && currency !== "all") { baselineQuery += " AND a.currency = ?"; baseParams.push(currency); }
      baselineQuery += " GROUP BY a.currency";
      const baselines = await sqlite.prepare(baselineQuery).all(...baseParams) as { currency: string; total: number }[];

      const running = new Map<string, number>();
      for (const b of baselines) running.set(b.currency, Number(b.total));

      const trend = rows.map(row => {
        const c = row.currency ?? "CAD";
        const prev = running.get(c) ?? 0;
        const newTotal = prev + Number(row.total);
        running.set(c, newTotal);
        return { month: row.month, currency: c, monthlyChange: Math.round(Number(row.total) * 100) / 100, cumulativeNetWorth: Math.round(newTotal * 100) / 100 };
      });

      return { content: [{ type: "text" as const, text: JSON.stringify({ months, trend, reportingCurrency: reporting }, null, 2) }] };
    }
  );

  server.tool("get_categories", "List all available transaction categories", {}, async () => {
    const rows = await sqlite.prepare(`SELECT name, type, "group" FROM categories WHERE user_id = ? ORDER BY type, "group", name`).all(userId);
    return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
  });

  server.tool("get_loans", "Get all loans with amortization summary", {}, async () => {
    const rows = await sqlite.prepare(`SELECT id, name, type, principal, annual_rate, term_months, start_date, payment_frequency, extra_payment FROM loans WHERE user_id = ?`).all(userId);
    return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
  });

  server.tool("get_goals", "Get all financial goals with progress", {}, async () => {
    const goals = await sqlite.prepare(`SELECT g.id, g.name, g.type, g.target_amount, g.deadline, g.status, g.priority, a.name as account FROM goals g LEFT JOIN accounts a ON g.account_id = a.id WHERE g.user_id = ? ORDER BY g.priority`).all(userId);
    return { content: [{ type: "text" as const, text: JSON.stringify(goals, null, 2) }] };
  });

  server.tool(
    "get_recurring_transactions",
    "Get detected recurring transactions (subscriptions, bills, salary). Average amounts stay in each transaction's account currency; reportingCurrency is surfaced as metadata.",
    {
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async ({ reportingCurrency }) => {
      const reporting = await resolveReportingCurrencyStdio(sqlite, userId, reportingCurrency);
      const cutoff = new Date();
      cutoff.setFullYear(cutoff.getFullYear() - 1);
      const txns = await sqlite.prepare(`SELECT id, date, payee, amount, account_id, category_id FROM transactions WHERE user_id = ? AND date >= ? AND payee != '' ORDER BY date`).all(userId, cutoff.toISOString().split("T")[0]) as { id: number; date: string; payee: string; amount: number; account_id: number; category_id: number }[];
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
      return { content: [{ type: "text" as const, text: JSON.stringify({ recurring, reportingCurrency: reporting }, null, 2) }] };
    }
  );

  server.tool(
    "get_income_statement",
    "Generate income statement for a period. Totals are in the user's display currency by default; pass reportingCurrency to override the surfaced metadata.",
    {
      start_date: z.string().describe("Start date"),
      end_date: z.string().describe("End date"),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async ({ start_date, end_date, reportingCurrency }) => {
      const reporting = await resolveReportingCurrencyStdio(sqlite, userId, reportingCurrency);
      const rows = await sqlite.prepare(`SELECT c.type as category_type, c."group" as category_group, c.name as category, SUM(t.amount) as total, COUNT(*) as count FROM transactions t LEFT JOIN categories c ON t.category_id = c.id WHERE t.user_id = ? AND t.date >= ? AND t.date <= ? AND c.type IN ('I','E') GROUP BY c.id, c.type, c."group", c.name ORDER BY c.type, c."group"`).all(userId, start_date, end_date);
      return { content: [{ type: "text" as const, text: JSON.stringify({ rows, reportingCurrency: reporting }, null, 2) }] };
    }
  );

  // ============ WRITE TOOLS ============

  server.tool(
    "set_budget",
    "Set or update a budget for a category in a specific month",
    {
      category: z.string().describe("Category name"),
      month: z.string().describe("Month (YYYY-MM)"),
      amount: z.number().describe("Budget amount (positive number)"),
    },
    async ({ category, month, amount }) => {
      const cat = await sqlite.prepare("SELECT id FROM categories WHERE user_id = ? AND name = ?").get(userId, category) as { id: number } | undefined;
      if (!cat) return sqliteErr(`Category "${category}" not found`);

      const existing = await sqlite.prepare("SELECT id FROM budgets WHERE user_id = ? AND category_id = ? AND month = ?").get(userId, cat.id, month) as { id: number } | undefined;
      if (existing) {
        await sqlite.prepare("UPDATE budgets SET amount = ? WHERE id = ? AND user_id = ?").run(amount, existing.id, userId);
      } else {
        await sqlite.prepare("INSERT INTO budgets (user_id, category_id, month, amount) VALUES (?, ?, ?, ?)").run(userId, cat.id, month, amount);
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
      account: z.string().optional().describe("Linked account — name or alias (fuzzy matched against name; exact match on alias)"),
    },
    async ({ name, type, target_amount, deadline, account }) => {
      let accountId: number | null = null;
      if (account) {
        const allAccounts = await sqlite.prepare("SELECT id, name, alias FROM accounts WHERE user_id = ?").all(userId) as SqliteRow[];
        const acct = fuzzyFind(account, allAccounts);
        accountId = acct ? Number(acct.id) : null;
      }
      await sqlite.prepare("INSERT INTO goals (user_id, name, type, target_amount, deadline, account_id, status) VALUES (?, ?, ?, ?, ?, ?, 'active')").run(userId, name, type, target_amount, deadline ?? null, accountId);
      return { content: [{ type: "text" as const, text: `Goal created: "${name}" — target $${target_amount}${deadline ? ` by ${deadline}` : ""}` }] };
    }
  );

  server.tool(
    "add_snapshot",
    "Record a net worth snapshot for an asset (e.g. house value, car value)",
    {
      account: z.string().describe("Account name or alias (fuzzy matched against name; exact match on alias)"),
      value: z.number().describe("Current value"),
      date: z.string().optional().describe("Snapshot date (defaults to today)"),
      note: z.string().optional().describe("Optional note"),
    },
    async ({ account, value, date, note }) => {
      const allAccounts = await sqlite.prepare("SELECT id, name, alias FROM accounts WHERE user_id = ?").all(userId) as SqliteRow[];
      const acct = fuzzyFind(account, allAccounts);
      if (!acct) return sqliteErr(`Account "${account}" not found`);
      const d = date ?? new Date().toISOString().split("T")[0];
      await sqlite.prepare("INSERT INTO snapshots (user_id, account_id, date, value, note) VALUES (?, ?, ?, ?, ?)").run(userId, acct.id, d, value, note ?? "");
      return { content: [{ type: "text" as const, text: `Snapshot recorded: ${account} = $${value} on ${d}` }] };
    }
  );

  // ============ TRANSACTION RULES TOOLS ============

  server.tool(
    "get_transaction_rules",
    "List all transaction auto-categorization rules",
    {},
    async () => {
      const rows = await sqlite.prepare(
        `SELECT r.id, r.name, r.match_field, r.match_type, r.match_value,
                r.assign_category_id, c.name as category_name,
                r.assign_tags, r.rename_to, r.is_active, r.priority
         FROM transaction_rules r
         LEFT JOIN categories c ON r.assign_category_id = c.id
         WHERE r.user_id = ?
         ORDER BY r.priority DESC`
      ).all(userId);
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

      const rules = await sqlite.prepare(
        `SELECT id, name, match_field, match_type, match_value,
                assign_category_id, assign_tags, rename_to, is_active, priority
         FROM transaction_rules WHERE user_id = ? AND is_active = 1 ORDER BY priority DESC`
      ).all(userId) as Array<{
        id: number; name: string; match_field: string; match_type: string;
        match_value: string; assign_category_id: number | null;
        assign_tags: string | null; rename_to: string | null;
        is_active: number; priority: number;
      }>;

      if (rules.length === 0) {
        return { content: [{ type: "text" as const, text: "No active rules found." }] };
      }

      const uncategorized = await sqlite.prepare(
        `SELECT id, payee, amount, tags FROM transactions
         WHERE user_id = ? AND category_id IS NULL ORDER BY date DESC LIMIT ?`
      ).all(userId, maxRows) as Array<{ id: number; payee: string; amount: number; tags: string }>;

      if (uncategorized.length === 0) {
        return { content: [{ type: "text" as const, text: "No uncategorized transactions found." }] };
      }

      let applied = 0;
      const updateStmt = sqlite.prepare(
        `UPDATE transactions SET category_id = ?, tags = CASE WHEN ? IS NOT NULL THEN ? ELSE tags END,
         payee = CASE WHEN ? IS NOT NULL THEN ? ELSE payee END WHERE id = ? AND user_id = ?`
      );

      for (const txn of uncategorized) {
        for (const rule of rules) {
          if (matchesRule(txn, rule)) {
            if (rule.assign_category_id) {
              await updateStmt.run(
                rule.assign_category_id,
                rule.assign_tags, rule.assign_tags ?? txn.tags,
                rule.rename_to, rule.rename_to ?? txn.payee,
                txn.id, userId
              );
              applied++;
            }
            break;
          }
        }
      }

      if (applied > 0) invalidateUserTxCache(userId);
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
    "Get current attention items — overspent budgets, upcoming bills, goal deadlines, spending anomalies, uncategorized transactions, low balances, subscription renewals. Sorted by severity (critical first). reportingCurrency surfaced for cross-currency context.",
    {
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async ({ reportingCurrency }) => {
      const reporting = await resolveReportingCurrencyStdio(sqlite, userId, reportingCurrency);
      const today = new Date().toISOString().split("T")[0];
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const [y, m] = [now.getFullYear(), now.getMonth() + 1];
      const monthStart = `${month}-01`;
      const monthEnd = `${month}-${new Date(y, m, 0).getDate()}`;
      const weekAhead = new Date(now.getTime() + 7 * 86400000).toISOString().split("T")[0];

      const items: { type: string; severity: string; title: string; description: string; amount?: number }[] = [];

      const budgetRows = await sqlite.prepare(`
        SELECT b.id, c.name as cat, b.amount as budget,
          COALESCE(ABS(SUM(CASE WHEN t.date >= ? AND t.date <= ? AND t.user_id = ? THEN t.amount ELSE 0 END)), 0) as spent
        FROM budgets b LEFT JOIN categories c ON b.category_id = c.id
        LEFT JOIN transactions t ON t.category_id = b.category_id
        WHERE b.user_id = ? AND b.month = ? GROUP BY b.id, c.name, b.amount
      `).all(monthStart, monthEnd, userId, userId, month) as { id: number; cat: string; budget: number; spent: number }[];
      for (const r of budgetRows) {
        if (r.budget > 0 && r.spent > r.budget) {
          const pct = Math.round(((r.spent - r.budget) / r.budget) * 100);
          items.push({ type: "overspent_budget", severity: pct > 20 ? "critical" : "warning", title: `${r.cat} over budget`, description: `$${r.spent.toFixed(2)} of $${r.budget.toFixed(2)} (${pct}% over)`, amount: r.spent - r.budget });
        }
      }

      const subs = await sqlite.prepare(`SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active' AND next_date >= ? AND next_date <= ?`).all(userId, today, weekAhead) as { id: number; name: string; amount: number; next_date: string; frequency: string }[];
      for (const s of subs) {
        if (Math.abs(s.amount) >= 100) {
          items.push({ type: "large_bill", severity: "warning", title: `${s.name} due soon`, description: `$${Math.abs(s.amount).toFixed(2)} ${s.frequency}`, amount: Math.abs(s.amount) });
        }
      }

      const uncat = await sqlite.prepare(`SELECT COUNT(*) as cnt FROM transactions WHERE user_id = ? AND date >= ? AND date <= ? AND category_id IS NULL`).get(userId, monthStart, monthEnd) as { cnt: number };
      if (uncat.cnt > 0) {
        items.push({ type: "uncategorized", severity: uncat.cnt > 10 ? "warning" : "info", title: `${uncat.cnt} uncategorized transaction(s)`, description: "Categorize for better tracking" });
      }

      const order: Record<string, number> = { critical: 0, warning: 1, info: 2 };
      items.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));

      return { content: [{ type: "text" as const, text: JSON.stringify({ items, reportingCurrency: reporting }, null, 2) }] };
    }
  );

  server.tool(
    "get_weekly_recap",
    "Get a weekly financial recap: spending summary (total + vs previous week + top categories), income, net cash flow, budget status, notable transactions, upcoming bills, net worth change. reportingCurrency surfaced for cross-currency context.",
    {
      date: z.string().optional().describe("End date for the week (YYYY-MM-DD). Defaults to current week."),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async ({ date, reportingCurrency }) => {
      const reporting = await resolveReportingCurrencyStdio(sqlite, userId, reportingCurrency);
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

      const spending = await sqlite.prepare(`SELECT c.name, ABS(SUM(t.amount)) as total FROM transactions t LEFT JOIN categories c ON t.category_id = c.id WHERE t.user_id = ? AND c.type = 'E' AND t.date >= ? AND t.date <= ? GROUP BY c.id, c.name ORDER BY total DESC`).all(userId, ws, we) as { name: string; total: number }[];
      const totalSpent = spending.reduce((s, r) => s + r.total, 0);
      const prevSpending = await sqlite.prepare(`SELECT ABS(SUM(t.amount)) as total FROM transactions t LEFT JOIN categories c ON t.category_id = c.id WHERE t.user_id = ? AND c.type = 'E' AND t.date >= ? AND t.date <= ?`).get(userId, ps, pe) as { total: number } | undefined;
      const prevTotal = prevSpending?.total ?? 0;
      const changePct = prevTotal > 0 ? Math.round(((totalSpent - prevTotal) / prevTotal) * 100) : 0;

      const inc = await sqlite.prepare(`SELECT COALESCE(SUM(t.amount), 0) as total FROM transactions t LEFT JOIN categories c ON t.category_id = c.id WHERE t.user_id = ? AND c.type = 'I' AND t.date >= ? AND t.date <= ?`).get(userId, ws, we) as { total: number };

      const notable = await sqlite.prepare(`SELECT t.date, t.payee, c.name as category, ABS(t.amount) as amt FROM transactions t LEFT JOIN categories c ON t.category_id = c.id WHERE t.user_id = ? AND c.type = 'E' AND t.date >= ? AND t.date <= ? ORDER BY ABS(t.amount) DESC LIMIT 5`).all(userId, ws, we);

      const recap = {
        weekStart: ws, weekEnd: we,
        reportingCurrency: reporting,
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
    "Record a transaction. Account is required — ask the user which account to use if not specified; never guess. Category auto-detected from payee rules/history when omitted. For cross-currency entries pass enteredAmount + enteredCurrency; the server locks the FX rate at the date.",
    {
      amount: z.number().describe("Amount in account currency (negative=expense, positive=income). Use this for same-currency entries."),
      payee: z.string().describe("Payee or merchant name"),
      account: z.string().describe("Account name or alias (required — ask the user which account if unclear; fuzzy matched against name, exact match on alias)"),
      date: z.string().optional().describe("YYYY-MM-DD (default: today)"),
      category: z.string().optional().describe("Category name (auto-detected from payee if omitted)"),
      note: z.string().optional(),
      tags: z.string().optional().describe("Comma-separated tags"),
      enteredAmount: z.number().optional().describe("User-typed amount in enteredCurrency."),
      enteredCurrency: z.string().optional().describe("ISO code (USD/CAD/...) of enteredAmount; defaults to account currency."),
    },
    async ({ amount, payee, date, account, category, note, tags, enteredAmount, enteredCurrency }) => {
      const today = new Date().toISOString().split("T")[0];
      const txDate = date ?? today;

      const allAccounts = await sqlite.prepare(`SELECT id, name, alias, currency FROM accounts WHERE user_id = ?`).all(userId) as SqliteRow[];
      if (!allAccounts.length) return sqliteErr("No accounts found — create an account first.");
      const acct = fuzzyFind(account, allAccounts);
      if (!acct) return sqliteErr(`Account "${account}" not found. Available: ${allAccounts.map(a => a.name).join(", ")}`);

      let catId: number | null = null;
      if (category) {
        const allCats = await sqlite.prepare(`SELECT id, name FROM categories WHERE user_id = ?`).all(userId) as SqliteRow[];
        const cat = fuzzyFind(category, allCats);
        if (!cat) return sqliteErr(`Category "${category}" not found. Available: ${allCats.map(c => c.name).join(", ")}`);
        catId = Number(cat.id);
      } else {
        catId = await autoCategory(sqlite, userId, payee);
      }

      const resolved = await resolveTxAmountsCore({
        accountCurrency: String(acct.currency),
        date: txDate,
        userId,
        amount: enteredAmount != null ? undefined : amount,
        enteredAmount,
        enteredCurrency,
      });
      if (!resolved.ok) return sqliteErr(resolved.message);

      const result = await sqlite.prepare(
        `INSERT INTO transactions (user_id, date, account_id, category_id, currency, amount, entered_currency, entered_amount, entered_fx_rate, payee, note, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      ).get(userId, txDate, acct.id, catId, resolved.currency, resolved.amount, resolved.enteredCurrency, resolved.enteredAmount, resolved.enteredFxRate, payee, note ?? "", tags ?? "") as { id: number };

      const catName = catId ? (await sqlite.prepare(`SELECT name FROM categories WHERE user_id = ? AND id = ?`).get(userId, catId) as { name: string } | undefined)?.name ?? "uncategorized" : "uncategorized";
      invalidateUserTxCache(userId);
      return txt({ success: true, transactionId: result?.id, message: `Recorded: ${resolved.amount > 0 ? "+" : ""}${resolved.amount} ${resolved.currency} on ${txDate} — "${payee}" → ${acct.name} (${catName})` });
    }
  );

  // ── bulk_record_transactions ───────────────────────────────────────────────
  server.tool(
    "bulk_record_transactions",
    "Record multiple transactions at once. Each transaction must specify an account — ask the user if unclear; never guess. Category auto-detected when omitted. For cross-currency rows pass enteredAmount + enteredCurrency.",
    {
      transactions: z.array(z.object({
        amount: z.number(),
        payee: z.string(),
        account: z.string().describe("Account name or alias (required — fuzzy matched against name, exact match on alias)"),
        date: z.string().optional(),
        category: z.string().optional(),
        note: z.string().optional(),
        tags: z.string().optional(),
        enteredAmount: z.number().optional(),
        enteredCurrency: z.string().optional(),
      })).describe("Array of transactions to record"),
    },
    async ({ transactions }) => {
      const today = new Date().toISOString().split("T")[0];
      const allAccounts = await sqlite.prepare(`SELECT id, name, alias, currency FROM accounts WHERE user_id = ?`).all(userId) as SqliteRow[];
      const allCats = await sqlite.prepare(`SELECT id, name FROM categories WHERE user_id = ?`).all(userId) as SqliteRow[];
      const stmt = sqlite.prepare(`INSERT INTO transactions (user_id, date, account_id, category_id, currency, amount, entered_currency, entered_amount, entered_fx_rate, payee, note, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

      const results: { index: number; success: boolean; message: string }[] = [];
      for (let i = 0; i < transactions.length; i++) {
        const t = transactions[i];
        try {
          const acct = fuzzyFind(t.account, allAccounts);
          if (!acct) { results.push({ index: i, success: false, message: `Account not found: "${t.account}"` }); continue; }
          let catId: number | null = null;
          if (t.category) { const cat = fuzzyFind(t.category, allCats); catId = cat ? Number(cat.id) : null; }
          else catId = await autoCategory(sqlite, userId, t.payee);

          const txDate = t.date ?? today;
          const resolved = await resolveTxAmountsCore({
            accountCurrency: String(acct.currency),
            date: txDate,
            userId,
            amount: t.enteredAmount != null ? undefined : t.amount,
            enteredAmount: t.enteredAmount,
            enteredCurrency: t.enteredCurrency,
          });
          if (!resolved.ok) {
            results.push({ index: i, success: false, message: resolved.message });
            continue;
          }

          await stmt.run(userId, txDate, acct.id, catId, resolved.currency, resolved.amount, resolved.enteredCurrency, resolved.enteredAmount, resolved.enteredFxRate, t.payee, t.note ?? "", t.tags ?? "");
          results.push({ index: i, success: true, message: `${t.payee}: ${resolved.amount} ${resolved.currency}` });
        } catch (e) {
          results.push({ index: i, success: false, message: String(e) });
        }
      }
      const ok = results.filter(r => r.success).length;
      if (ok > 0) invalidateUserTxCache(userId);
      return txt({ imported: ok, failed: results.length - ok, results });
    }
  );

  // ── update_transaction ─────────────────────────────────────────────────────
  server.tool(
    "update_transaction",
    "Update fields of an existing transaction by ID. Pass enteredAmount + enteredCurrency to re-lock cross-currency rate; passing only `amount` updates the account-side without touching entered_*.",
    {
      id: z.number().describe("Transaction ID"),
      date: z.string().optional(),
      amount: z.number().optional().describe("Amount in account currency. Doesn't touch entered_* side."),
      payee: z.string().optional(),
      category: z.string().optional().describe("Category name (fuzzy matched)"),
      note: z.string().optional(),
      tags: z.string().optional(),
      enteredAmount: z.number().optional(),
      enteredCurrency: z.string().optional(),
    },
    async ({ id, date, amount, payee, category, note, tags, enteredAmount, enteredCurrency }) => {
      const existing = await sqlite.prepare(`
        SELECT t.id, t.account_id, t.date, a.currency AS account_currency
          FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
         WHERE t.id = ? AND t.user_id = ?
      `).get(id, userId) as { id: number; date: string; account_currency?: string } | undefined;
      if (!existing) return sqliteErr(`Transaction #${id} not found or not owned by user`);

      let catId: number | undefined;
      if (category !== undefined) {
        const allCats = await sqlite.prepare(`SELECT id, name FROM categories WHERE user_id = ?`).all(userId) as SqliteRow[];
        const cat = fuzzyFind(category, allCats);
        if (!cat) return sqliteErr(`Category "${category}" not found`);
        catId = Number(cat.id);
      }

      const updates: string[] = [];
      const params: unknown[] = [];
      if (date !== undefined) { updates.push("date = ?"); params.push(date); }
      if (enteredAmount !== undefined) {
        const txDate = date ?? existing.date;
        const resolved = await resolveTxAmountsCore({
          accountCurrency: String(existing.account_currency ?? "CAD"),
          date: txDate,
          userId,
          enteredAmount,
          enteredCurrency,
        });
        if (!resolved.ok) return sqliteErr(resolved.message);
        updates.push("amount = ?", "currency = ?", "entered_amount = ?", "entered_currency = ?", "entered_fx_rate = ?");
        params.push(resolved.amount, resolved.currency, resolved.enteredAmount, resolved.enteredCurrency, resolved.enteredFxRate);
      } else if (amount !== undefined) {
        updates.push("amount = ?");
        params.push(amount);
      }
      if (payee !== undefined) { updates.push("payee = ?"); params.push(payee); }
      if (catId !== undefined) { updates.push("category_id = ?"); params.push(catId); }
      if (note !== undefined) { updates.push("note = ?"); params.push(note); }
      if (tags !== undefined) { updates.push("tags = ?"); params.push(tags); }
      if (!updates.length) return sqliteErr("No fields to update");

      params.push(id, userId);
      await sqlite.prepare(`UPDATE transactions SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`).run(...params);
      invalidateUserTxCache(userId);
      return txt({ success: true, message: `Transaction #${id} updated (${updates.length} field(s))` });
    }
  );

  // ── delete_transaction ─────────────────────────────────────────────────────
  server.tool(
    "delete_transaction",
    "Permanently delete a transaction by ID",
    { id: z.number().describe("Transaction ID to delete") },
    async ({ id }) => {
      const t = await sqlite.prepare(`SELECT id, payee, amount, date FROM transactions WHERE id = ? AND user_id = ?`).get(id, userId) as { id: number; payee: string; amount: number; date: string } | undefined;
      if (!t) return sqliteErr(`Transaction #${id} not found or not owned by user`);
      await sqlite.prepare(`DELETE FROM transactions WHERE id = ? AND user_id = ?`).run(id, userId);
      invalidateUserTxCache(userId);
      return txt({ success: true, message: `Deleted transaction #${id}: "${t.payee}" ${t.amount} on ${t.date}` });
    }
  );

  // ── record_transfer ────────────────────────────────────────────────────────
  // Stdio variant — runs without a DEK so writes are stored plaintext (matches
  // the rest of stdio MCP). The Drizzle-backed ViaSql helper drives both
  // legs through a single pg client so the dual-INSERT is atomic; the
  // pg-compat layer's transaction() wrapper would NOT be atomic because its
  // inner prepare() calls each acquire their own pool client.
  server.tool(
    "record_transfer",
    "Record a transfer between two of the user's accounts. Creates BOTH legs atomically with a shared link_id. Auto-creates a Transfer category (type='R') if missing. For cross-currency transfers pass `receivedAmount` to lock the bank's landed amount. For in-kind (share) transfers between brokerage accounts, pass `holding` + `quantity`; the source holding MUST already exist, the destination holding is auto-created if missing. `amount` may be 0 for pure in-kind moves.",
    {
      fromAccount: z.string().describe("Source account name or alias"),
      toAccount: z.string().describe("Destination account name or alias (must differ)"),
      amount: z.number().nonnegative().describe("Cash amount sent, in SOURCE account's currency. > 0 for cash transfers; 0 only when `holding`+`quantity` are also set."),
      date: z.string().optional().describe("YYYY-MM-DD (default: today)"),
      receivedAmount: z.number().nonnegative().optional().describe("Cross-currency override: actual amount that landed in the destination, in DESTINATION's currency."),
      holding: z.string().optional().describe("Source-side holding name for an in-kind (share) transfer."),
      destHolding: z.string().optional().describe("Destination-side holding name. Defaults to `holding`. Use when destination uses a different label."),
      quantity: z.number().positive().optional().describe("Positive share count LEAVING source. Required when `holding` is set."),
      destQuantity: z.number().positive().optional().describe("Positive share count ARRIVING at destination. Defaults to `quantity`. Set when source/dest counts differ — stock split, merger, share-class conversion."),
      note: z.string().optional(),
      tags: z.string().optional(),
    },
    async ({ fromAccount, toAccount, amount, date, receivedAmount, holding, destHolding, quantity, destQuantity, note, tags }) => {
      const allAccounts = await sqlite.prepare(`SELECT id, name, alias, currency FROM accounts WHERE user_id = ?`).all(userId) as SqliteRow[];
      if (!allAccounts.length) return sqliteErr("No accounts found — create accounts first.");
      const fromAcct = fuzzyFind(fromAccount, allAccounts);
      if (!fromAcct) return sqliteErr(`Source account "${fromAccount}" not found.`);
      const toAcct = fuzzyFind(toAccount, allAccounts);
      if (!toAcct) return sqliteErr(`Destination account "${toAccount}" not found.`);

      const { createTransferPairViaSql } = await import("../src/lib/transfer.js");
      const result = await createTransferPairViaSql(sqlite.pool, userId, null, {
        fromAccountId: Number(fromAcct.id),
        toAccountId: Number(toAcct.id),
        enteredAmount: amount,
        date,
        receivedAmount,
        holdingName: holding,
        destHoldingName: destHolding,
        quantity,
        destQuantity,
        note,
        tags,
      });
      if (!result.ok) return sqliteErr(result.message);
      const inKindNote = result.holding
        ? (() => {
            const h = result.holding;
            const qtyChanged = h.quantity !== h.destQuantity;
            const nameChanged = h.destName !== h.name;
            if (qtyChanged && nameChanged) return ` · in-kind: ${h.quantity} × ${h.name} → ${h.destQuantity} × ${h.destName}`;
            if (qtyChanged) return ` · in-kind: ${h.quantity} → ${h.destQuantity} × ${h.name}`;
            if (nameChanged) return ` · in-kind: ${h.quantity} × ${h.name} → ${h.destName}`;
            return ` · in-kind: ${h.quantity} × ${h.name}`;
          })()
        : "";
      return txt({
        success: true,
        linkId: result.linkId,
        fromTransactionId: result.fromTransactionId,
        toTransactionId: result.toTransactionId,
        fromAmount: result.fromAmount,
        fromCurrency: result.fromCurrency,
        toAmount: result.toAmount,
        toCurrency: result.toCurrency,
        enteredFxRate: result.enteredFxRate,
        ...(result.holding ? { holding: result.holding } : {}),
        message: result.isCrossCurrency
          ? `Transferred ${amount} ${result.fromCurrency} from ${fromAcct.name} to ${toAcct.name} — landed as ${result.toAmount} ${result.toCurrency} (rate ${result.enteredFxRate.toFixed(6)})${inKindNote}`
          : `Transferred ${amount} ${result.fromCurrency} from ${fromAcct.name} to ${toAcct.name}${inKindNote}`,
      });
    }
  );

  // ── update_transfer ────────────────────────────────────────────────────────
  server.tool(
    "update_transfer",
    "Update both legs of an existing transfer pair atomically. Identify by linkId OR by either leg's transaction id. Refuses if the rows don't form a clean transfer pair.",
    {
      linkId: z.string().optional(),
      transactionId: z.number().int().optional(),
      fromAccount: z.string().optional(),
      toAccount: z.string().optional(),
      amount: z.number().positive().optional(),
      date: z.string().optional(),
      receivedAmount: z.number().positive().optional(),
      note: z.string().optional(),
      tags: z.string().optional(),
    },
    async ({ linkId, transactionId, fromAccount, toAccount, amount, date, receivedAmount, note, tags }) => {
      if (linkId == null && transactionId == null) return sqliteErr("Either linkId or transactionId is required");

      let fromAccountId: number | undefined;
      let toAccountId: number | undefined;
      if (fromAccount || toAccount) {
        const allAccounts = await sqlite.prepare(`SELECT id, name, alias, currency FROM accounts WHERE user_id = ?`).all(userId) as SqliteRow[];
        if (fromAccount) {
          const acct = fuzzyFind(fromAccount, allAccounts);
          if (!acct) return sqliteErr(`Source account "${fromAccount}" not found.`);
          fromAccountId = Number(acct.id);
        }
        if (toAccount) {
          const acct = fuzzyFind(toAccount, allAccounts);
          if (!acct) return sqliteErr(`Destination account "${toAccount}" not found.`);
          toAccountId = Number(acct.id);
        }
      }

      const { updateTransferPairViaSql } = await import("../src/lib/transfer.js");
      const result = await updateTransferPairViaSql(sqlite.pool, userId, null, {
        linkId, transactionId,
        fromAccountId, toAccountId,
        enteredAmount: amount,
        date, receivedAmount, note, tags,
      });
      if (!result.ok) return sqliteErr(result.message);
      return txt({
        success: true,
        linkId: result.linkId,
        fromTransactionId: result.fromTransactionId,
        toTransactionId: result.toTransactionId,
        fromAmount: result.fromAmount,
        fromCurrency: result.fromCurrency,
        toAmount: result.toAmount,
        toCurrency: result.toCurrency,
        enteredFxRate: result.enteredFxRate,
        message: `Transfer updated (linkId ${result.linkId})`,
      });
    }
  );

  // ── delete_transfer ────────────────────────────────────────────────────────
  server.tool(
    "delete_transfer",
    "Permanently delete BOTH legs of a transfer pair in one statement. Identify by linkId OR by either leg's id.",
    {
      linkId: z.string().optional(),
      transactionId: z.number().int().optional(),
    },
    async ({ linkId, transactionId }) => {
      if (linkId == null && transactionId == null) return sqliteErr("Either linkId or transactionId is required");
      const { deleteTransferPairViaSql } = await import("../src/lib/transfer.js");
      const result = await deleteTransferPairViaSql(sqlite.pool, userId, { linkId, transactionId });
      if (!result.ok) return sqliteErr(result.message);
      return txt({
        success: true,
        linkId: result.linkId,
        deletedCount: result.deletedCount,
        message: `Transfer deleted (${result.deletedCount} rows)`,
      });
    }
  );

  // ── delete_budget ──────────────────────────────────────────────────────────
  server.tool(
    "delete_budget",
    "Delete a budget entry for a category/month",
    { category: z.string().describe("Category name"), month: z.string().describe("Month (YYYY-MM)") },
    async ({ category, month }) => {
      const allCats = await sqlite.prepare(`SELECT id, name FROM categories WHERE user_id = ?`).all(userId) as SqliteRow[];
      const cat = fuzzyFind(category, allCats);
      if (!cat) return sqliteErr(`Category "${category}" not found`);
      const existing = await sqlite.prepare(`SELECT id FROM budgets WHERE user_id = ? AND category_id = ? AND month = ?`).get(userId, cat.id, month) as { id: number } | undefined;
      if (!existing) return sqliteErr(`No budget for "${cat.name}" in ${month}`);
      await sqlite.prepare(`DELETE FROM budgets WHERE id = ? AND user_id = ?`).run(existing.id, userId);
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
      alias: z.string().max(64).optional().describe("Optional short alias used to match the account when receipts or imports reference it by a non-canonical name (e.g. last 4 digits of a card, or a receipt label)."),
    },
    async ({ name, type, group, currency, note, alias }) => {
      const existing = await sqlite.prepare(`SELECT id FROM accounts WHERE user_id = ? AND name = ?`).get(userId, name);
      if (existing) return sqliteErr(`Account "${name}" already exists`);
      const aliasValue = alias && alias.trim() ? alias.trim() : null;
      const result = await sqlite.prepare(`INSERT INTO accounts (user_id, type, "group", name, currency, note, alias) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(userId, type, group ?? "", name, currency ?? "CAD", note ?? "", aliasValue) as { id: number };
      return txt({ success: true, accountId: result?.id, message: `Account "${name}" created (${type === "A" ? "asset" : "liability"}, ${currency ?? "CAD"})${aliasValue ? `, alias "${aliasValue}"` : ""}` });
    }
  );

  // ── update_account ─────────────────────────────────────────────────────────
  server.tool(
    "update_account",
    "Update name, group, currency, note, or alias of an account",
    {
      account: z.string().describe("Current account name or alias (fuzzy matched against name; exact match on alias)"),
      name: z.string().optional(),
      group: z.string().optional(),
      currency: z.enum(["CAD", "USD"]).optional(),
      note: z.string().optional(),
      alias: z.string().max(64).optional().describe("New alias — short shorthand used to match receipts/imports. Pass an empty string to clear."),
    },
    async ({ account, name, group, currency, note, alias }) => {
      const allAccounts = await sqlite.prepare(`SELECT id, name, alias FROM accounts WHERE user_id = ?`).all(userId) as SqliteRow[];
      const acct = fuzzyFind(account, allAccounts);
      if (!acct) return sqliteErr(`Account "${account}" not found`);
      const updates: string[] = []; const params: unknown[] = [];
      if (name !== undefined) { updates.push(`name = ?`); params.push(name); }
      if (group !== undefined) { updates.push(`"group" = ?`); params.push(group); }
      if (currency !== undefined) { updates.push(`currency = ?`); params.push(currency); }
      if (note !== undefined) { updates.push(`note = ?`); params.push(note); }
      if (alias !== undefined) {
        const trimmed = alias.trim();
        if (trimmed) { updates.push(`alias = ?`); params.push(trimmed); }
        else { updates.push(`alias = NULL`); }
      }
      if (!updates.length) return sqliteErr("No fields to update");
      params.push(acct.id, userId);
      await sqlite.prepare(`UPDATE accounts SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`).run(...params);
      return txt({ success: true, message: `Account "${acct.name}" updated` });
    }
  );

  // ── delete_account ─────────────────────────────────────────────────────────
  server.tool(
    "delete_account",
    "Delete an account (only if it has no transactions, unless force=true)",
    {
      account: z.string().describe("Account name or alias (fuzzy matched against name; exact match on alias)"),
      force: z.boolean().optional(),
    },
    async ({ account, force }) => {
      const allAccounts = await sqlite.prepare(`SELECT id, name, alias FROM accounts WHERE user_id = ?`).all(userId) as SqliteRow[];
      const acct = fuzzyFind(account, allAccounts);
      if (!acct) return sqliteErr(`Account "${account}" not found`);
      const count = (await sqlite.prepare(`SELECT COUNT(*) as cnt FROM transactions WHERE user_id = ? AND account_id = ?`).get(userId, acct.id) as { cnt: number }).cnt;
      if (count > 0 && !force) return sqliteErr(`Account "${acct.name}" has ${count} transaction(s). Pass force=true to delete.`);
      await sqlite.prepare(`DELETE FROM accounts WHERE id = ? AND user_id = ?`).run(acct.id, userId);
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
      const allGoals = await sqlite.prepare(`SELECT id, name FROM goals WHERE user_id = ?`).all(userId) as SqliteRow[];
      const g = fuzzyFind(goal, allGoals);
      if (!g) return sqliteErr(`Goal "${goal}" not found`);
      const updates: string[] = []; const params: unknown[] = [];
      if (name !== undefined) { updates.push(`name = ?`); params.push(name); }
      if (target_amount !== undefined) { updates.push(`target_amount = ?`); params.push(target_amount); }
      if (deadline !== undefined) { updates.push(`deadline = ?`); params.push(deadline); }
      if (status !== undefined) { updates.push(`status = ?`); params.push(status); }
      if (!updates.length) return sqliteErr("No fields to update");
      params.push(g.id, userId);
      await sqlite.prepare(`UPDATE goals SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`).run(...params);
      return txt({ success: true, message: `Goal "${g.name}" updated` });
    }
  );

  // ── delete_goal ────────────────────────────────────────────────────────────
  server.tool(
    "delete_goal",
    "Delete a financial goal by name",
    { goal: z.string().describe("Goal name (fuzzy matched)") },
    async ({ goal }) => {
      const allGoals = await sqlite.prepare(`SELECT id, name FROM goals WHERE user_id = ?`).all(userId) as SqliteRow[];
      const g = fuzzyFind(goal, allGoals);
      if (!g) return sqliteErr(`Goal "${goal}" not found`);
      await sqlite.prepare(`DELETE FROM goals WHERE id = ? AND user_id = ?`).run(g.id, userId);
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
      const existing = await sqlite.prepare(`SELECT id FROM categories WHERE user_id = ? AND name = ?`).get(userId, name);
      if (existing) return sqliteErr(`Category "${name}" already exists`);
      const result = await sqlite.prepare(`INSERT INTO categories (user_id, name, type, "group", note) VALUES (?, ?, ?, ?, ?) RETURNING id`).get(userId, name, type, group ?? "", note ?? "") as { id: number };
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
      const allCats = await sqlite.prepare(`SELECT id, name FROM categories WHERE user_id = ?`).all(userId) as SqliteRow[];
      const cat = fuzzyFind(assign_category, allCats);
      if (!cat) return sqliteErr(`Category "${assign_category}" not found`);
      await sqlite.prepare(
        `INSERT INTO transaction_rules (user_id, match_payee, assign_category_id, rename_to, assign_tags, priority, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)`
      ).run(userId, match_payee, cat.id, rename_to ?? null, assign_tags ?? null, priority ?? 0);
      return txt({ success: true, message: `Rule created: "${match_payee}" → ${cat.name}` });
    }
  );

  // ── add_portfolio_holding ──────────────────────────────────────────────────
  // Stdio has no DEK — writes plaintext only and leaves *_ct/*_lookup NULL.
  // The Stream D login backfill will encrypt these on next browser login.
  server.tool(
    "add_portfolio_holding",
    "Create a portfolio holding (a single position like 'VEQT.TO' inside a brokerage account). The import pipeline auto-creates these from CSV/ZIP uploads; this tool is for manually adding a position the user wants to track without an import.",
    {
      name: z.string().min(1).max(200).describe("Display name of the holding"),
      account: z.string().describe("Brokerage account name or alias (fuzzy matched). Required because uniqueness is per (account, name)."),
      symbol: z.string().max(50).optional().describe("Ticker symbol (e.g. 'VEQT.TO', 'BTC')"),
      currency: z.enum(["CAD", "USD"]).optional(),
      isCrypto: z.boolean().optional(),
      note: z.string().max(500).optional(),
    },
    async ({ name, account, symbol, currency, isCrypto, note }) => {
      const allAccounts = await sqlite.prepare(
        `SELECT id, name, alias, currency FROM accounts WHERE user_id = ? AND archived = false`
      ).all(userId) as SqliteRow[];
      const acct = fuzzyFind(account, allAccounts);
      if (!acct) return sqliteErr(`Account "${account}" not found`);

      const existing = await sqlite.prepare(
        `SELECT id FROM portfolio_holdings WHERE user_id = ? AND account_id = ? AND LOWER(name) = LOWER(?)`
      ).get(userId, acct.id, name);
      if (existing) return sqliteErr(`Holding "${name}" already exists in account "${acct.name}"`);

      const symbolValue = symbol && symbol.trim() ? symbol.trim() : null;
      const cur = currency ?? String(acct.currency ?? "CAD");
      try {
        const result = await sqlite.prepare(
          `INSERT INTO portfolio_holdings (user_id, account_id, name, symbol, currency, is_crypto, note)
           VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
        ).get(userId, acct.id, name, symbolValue, cur, isCrypto ? 1 : 0, note ?? "") as { id: number } | undefined;
        return txt({
          success: true,
          holdingId: result?.id,
          message: `Holding "${name}" created in "${acct.name}"${symbolValue ? ` (${symbolValue})` : ""} — pass holdingId=${result?.id} as portfolioHoldingId on record_transaction to bind transactions.`,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("23505") || msg.toLowerCase().includes("unique")) {
          return sqliteErr(`Holding "${name}" already exists in account "${acct.name}"`);
        }
        throw e;
      }
    }
  );

  // ── update_portfolio_holding ───────────────────────────────────────────────
  server.tool(
    "update_portfolio_holding",
    "Update a portfolio holding's name, symbol, account, currency, isCrypto, or note. Renames cascade to all transactions automatically because get_portfolio_analysis groups by FK, not by string.",
    {
      holding: z.string().describe("Current holding name OR symbol (fuzzy matched)"),
      name: z.string().min(1).max(200).optional(),
      symbol: z.string().max(50).optional().describe("Pass empty string to clear"),
      account: z.string().optional().describe("Move to a different brokerage account (name or alias)"),
      currency: z.enum(["CAD", "USD"]).optional(),
      isCrypto: z.boolean().optional(),
      note: z.string().max(500).optional(),
    },
    async ({ holding, name, symbol, account, currency, isCrypto, note }) => {
      const allHoldings = await sqlite.prepare(
        `SELECT id, account_id, name, symbol FROM portfolio_holdings WHERE user_id = ?`
      ).all(userId) as SqliteRow[];
      let h: SqliteRow | null = fuzzyFind(holding, allHoldings);
      if (!h) {
        const lo = holding.toLowerCase().trim();
        h =
          allHoldings.find((r) => String(r.symbol ?? "").toLowerCase() === lo) ??
          allHoldings.find((r) => String(r.symbol ?? "").toLowerCase().startsWith(lo)) ??
          null;
      }
      if (!h) return sqliteErr(`Holding "${holding}" not found`);

      let newAccountId: number | undefined;
      if (account !== undefined) {
        const allAccounts = await sqlite.prepare(
          `SELECT id, name, alias FROM accounts WHERE user_id = ? AND archived = false`
        ).all(userId) as SqliteRow[];
        const acct = fuzzyFind(account, allAccounts);
        if (!acct) return sqliteErr(`Account "${account}" not found`);
        newAccountId = Number(acct.id);
      }

      const updates: string[] = []; const params: unknown[] = [];
      if (name !== undefined) { updates.push(`name = ?`); params.push(name); }
      if (symbol !== undefined) {
        const trimmed = symbol.trim();
        if (trimmed) { updates.push(`symbol = ?`); params.push(trimmed); }
        else { updates.push(`symbol = NULL`); }
      }
      if (newAccountId !== undefined) { updates.push(`account_id = ?`); params.push(newAccountId); }
      if (currency !== undefined) { updates.push(`currency = ?`); params.push(currency); }
      if (isCrypto !== undefined) { updates.push(`is_crypto = ?`); params.push(isCrypto ? 1 : 0); }
      if (note !== undefined) { updates.push(`note = ?`); params.push(note); }
      if (!updates.length) return sqliteErr("No fields to update");

      params.push(h.id, userId);
      try {
        await sqlite.prepare(
          `UPDATE portfolio_holdings SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`
        ).run(...params);
        return txt({ success: true, holdingId: h.id, message: `Holding "${h.name}" updated` });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("23505") || msg.toLowerCase().includes("unique")) {
          return sqliteErr(`Another holding with name "${name ?? h.name}" already exists in this account`);
        }
        throw e;
      }
    }
  );

  // ── delete_portfolio_holding ───────────────────────────────────────────────
  server.tool(
    "delete_portfolio_holding",
    "Delete a portfolio holding. Transactions referencing it survive — the FK is set to NULL automatically (no data loss; they fall back to the orphan-aggregation path until reassigned).",
    {
      holding: z.string().describe("Holding name OR symbol (fuzzy matched)"),
    },
    async ({ holding }) => {
      const allHoldings = await sqlite.prepare(
        `SELECT id, name, symbol FROM portfolio_holdings WHERE user_id = ?`
      ).all(userId) as SqliteRow[];
      let h: SqliteRow | null = fuzzyFind(holding, allHoldings);
      if (!h) {
        const lo = holding.toLowerCase().trim();
        h =
          allHoldings.find((r) => String(r.symbol ?? "").toLowerCase() === lo) ??
          allHoldings.find((r) => String(r.symbol ?? "").toLowerCase().startsWith(lo)) ??
          null;
      }
      if (!h) return sqliteErr(`Holding "${holding}" not found`);

      const count = (await sqlite.prepare(
        `SELECT COUNT(*) as cnt FROM transactions WHERE user_id = ? AND portfolio_holding_id = ?`
      ).get(userId, h.id) as { cnt: number }).cnt;

      await sqlite.prepare(`DELETE FROM portfolio_holdings WHERE id = ? AND user_id = ?`).run(h.id, userId);
      return txt({
        success: true,
        message: count > 0
          ? `Holding "${h.name}" deleted; ${count} transaction(s) unlinked (still queryable, no longer aggregated under this holding).`
          : `Holding "${h.name}" deleted.`,
      });
    }
  );

  // ── get_portfolio_analysis ─────────────────────────────────────────────────
  server.tool(
    "get_portfolio_analysis",
    "Portfolio holdings with allocation breakdown by asset class and currency. Per-row amounts are in each holding's own currency; reportingCurrency is surfaced for cross-currency context.",
    {
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async ({ reportingCurrency }) => {
      const reporting = await resolveReportingCurrencyStdio(sqlite, userId, reportingCurrency);
      const holdings = await sqlite.prepare(`
        SELECT ph.id, ph.name, ph.symbol, ph.currency, a.name as account_name,
               COALESCE(SUM(t.quantity), 0) as total_quantity,
               COALESCE(SUM(t.amount), 0) as book_value
        FROM portfolio_holdings ph
        JOIN accounts a ON a.id = ph.account_id
        LEFT JOIN transactions t ON t.portfolio_holding = ph.name AND t.user_id = ?
        WHERE ph.user_id = ?
        GROUP BY ph.id, ph.name, ph.symbol, ph.currency, a.name
        ORDER BY ABS(COALESCE(SUM(t.amount), 0)) DESC
      `).all(userId, userId) as SqliteRow[];

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
        reportingCurrency: reporting,
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
    "Portfolio performance: cost basis and realized P&L by holding. Per-row amounts stay in each holding's own (account) currency; reportingCurrency is surfaced for cross-currency context.",
    {
      period: z.enum(["1m", "3m", "6m", "1y", "all"]).optional(),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async ({ period, reportingCurrency }) => {
      const reporting = await resolveReportingCurrencyStdio(sqlite, userId, reportingCurrency);
      const cutoff: Record<string, string> = {
        "1m": new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0],
        "3m": new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0],
        "6m": new Date(Date.now() - 180 * 86400000).toISOString().split("T")[0],
        "1y": new Date(Date.now() - 365 * 86400000).toISOString().split("T")[0],
        "all": "1900-01-01",
      };
      const since = cutoff[period ?? "all"];
      const perf = await sqlite.prepare(`
        SELECT portfolio_holding as holding, COUNT(*) as tx_count,
               SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as cost_basis,
               SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as proceeds,
               SUM(quantity) as net_quantity,
               MIN(date) as first_purchase, MAX(date) as last_activity
        FROM transactions WHERE user_id = ? AND portfolio_holding IS NOT NULL AND portfolio_holding != '' AND date >= ?
        GROUP BY portfolio_holding ORDER BY cost_basis DESC
      `).all(userId, since) as SqliteRow[];

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
        reportingCurrency: reporting,
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
    "Deep-dive analysis of a single holding: transaction history, avg cost, P&L. Per-row amounts stay in the transaction's account currency; reportingCurrency is surfaced for cross-currency context.",
    {
      symbol: z.string().describe("Holding name or symbol (fuzzy matched)"),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async ({ symbol, reportingCurrency }) => {
      const reporting = await resolveReportingCurrencyStdio(sqlite, userId, reportingCurrency);
      const txns = await sqlite.prepare(`
        SELECT t.id, t.date, t.amount, t.quantity, t.payee, t.portfolio_holding, a.name as account_name, a.currency
        FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE t.user_id = ? AND (LOWER(t.portfolio_holding) LIKE LOWER(?) OR LOWER(t.payee) LIKE LOWER(?))
        ORDER BY t.date ASC
      `).all(userId, `%${symbol}%`, `%${symbol}%`) as SqliteRow[];

      if (!txns.length) return sqliteErr(`No transactions found for "${symbol}"`);

      const holdingName = txns[0].portfolio_holding || txns[0].payee;
      let totalShares = 0, totalCost = 0;
      const purchases: SqliteRow[] = [], sales: SqliteRow[] = [];
      // qty>0 = buy (handles Finlynq-native amt<0+qty>0 and WP convention
      // amt>0+qty>0). qty<0 = sell (qty already negative). qty=0 = dividend.
      for (const t of txns) {
        const qty = Number(t.quantity ?? 0);
        if (qty > 0) { totalShares += qty; totalCost += Math.abs(Number(t.amount)); purchases.push(t); }
        else if (qty < 0) { totalShares += qty; sales.push(t); }
      }
      const avgCost = purchases.length && totalCost > 0
        ? totalCost / purchases.reduce((s, t) => s + Number(t.quantity ?? 0), 0)
        : null;

      return txt({
        disclaimer: PORTFOLIO_DISCLAIMER,
        holding: holdingName, totalTransactions: txns.length,
        reportingCurrency: reporting,
        purchases: purchases.length, sales: sales.length,
        currentShares: Math.round(totalShares * 10000) / 10000,
        totalCostBasis: Math.round(totalCost * 100) / 100,
        avgCostPerShare: avgCost ? Math.round(avgCost * 100) / 100 : null,
        firstPurchase: txns[0].date, lastActivity: txns[txns.length - 1].date,
        recentTransactions: txns.slice(-5).map(t => ({ date: t.date, amount: t.amount, quantity: t.quantity, account: t.account_name })),
      });
    }
  );

  // ── get_investment_insights ────────────────────────────────────────────────
  server.tool(
    "get_investment_insights",
    "Portfolio-level investment analytics. `mode: 'patterns'` (default) returns contribution frequency, top positions, diversification score. `mode: 'rebalancing'` suggests BUY/SELL amounts vs `targets`. `mode: 'benchmark'` compares growth vs a reference index.",
    {
      mode: z.enum(["patterns", "rebalancing", "benchmark"]).optional(),
      targets: z.array(z.object({
        holding: z.string(),
        target_pct: z.number().describe("Target allocation % (0-100)"),
      })).optional().describe("Required when mode='rebalancing'"),
      benchmark: z.enum(["SP500", "TSX", "MSCI_WORLD", "BONDS_CA"]).optional().describe("Benchmark for mode='benchmark'"),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async ({ mode, targets, benchmark, reportingCurrency }) => {
      const reporting = await resolveReportingCurrencyStdio(sqlite, userId, reportingCurrency);
      const m = mode ?? "patterns";

      if (m === "rebalancing") {
        if (!targets?.length) return sqliteErr("targets is required when mode='rebalancing'");
        const holdings = await sqlite.prepare(`
          SELECT portfolio_holding as name, SUM(ABS(amount)) as book_value
          FROM transactions WHERE user_id = ? AND portfolio_holding IS NOT NULL AND portfolio_holding != '' AND amount < 0
          GROUP BY portfolio_holding
        `).all(userId) as SqliteRow[];

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
          mode: "rebalancing",
          reportingCurrency: reporting,
          totalPortfolioValue: Math.round(totalBV * 100) / 100,
          suggestions,
          note: "Based on book cost, not market price.",
        });
      }

      if (m === "benchmark") {
        const bm = benchmark ?? "SP500";
        const bmInfo: Record<string, { label: string; annualizedReturn: number; description: string }> = {
          SP500:      { label: "S&P 500",            annualizedReturn: 10.5, description: "US large-cap equities (USD)" },
          TSX:        { label: "S&P/TSX Composite",   annualizedReturn: 8.2,  description: "Canadian equities (CAD)" },
          MSCI_WORLD: { label: "MSCI World",           annualizedReturn: 9.4,  description: "Global developed markets (USD)" },
          BONDS_CA:   { label: "Canadian Bonds",       annualizedReturn: 3.8,  description: "Canadian aggregate bonds (CAD)" },
        };
        const info = bmInfo[bm];

        const row = await sqlite.prepare(`
          SELECT MIN(date) as first_date, MAX(date) as last_date, SUM(ABS(amount)) as total_invested
          FROM transactions WHERE user_id = ? AND portfolio_holding IS NOT NULL AND portfolio_holding != '' AND amount < 0
        `).get(userId) as { first_date: string | null; last_date: string; total_invested: number } | undefined;

        if (!row?.first_date) return txt({ disclaimer: PORTFOLIO_DISCLAIMER, mode: "benchmark", reportingCurrency: reporting, message: "No investment transactions found" });

        const yearsHeld = Math.max(0.1, (new Date(row.last_date).getTime() - new Date(row.first_date).getTime()) / (365.25 * 86400000));
        const benchFinal = row.total_invested * Math.pow(1 + info.annualizedReturn / 100, yearsHeld);
        const benchGain = benchFinal - row.total_invested;

        return txt({
          disclaimer: PORTFOLIO_DISCLAIMER,
          mode: "benchmark",
          reportingCurrency: reporting,
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

      // Default: mode === "patterns"
      const positions = await sqlite.prepare(`
        SELECT portfolio_holding as name, SUM(ABS(amount)) as book_value, COUNT(*) as purchases
        FROM transactions WHERE user_id = ? AND portfolio_holding IS NOT NULL AND portfolio_holding != '' AND amount < 0
        GROUP BY portfolio_holding ORDER BY book_value DESC
      `).all(userId) as SqliteRow[];

      const contributions = await sqlite.prepare(`
        SELECT strftime('%Y-%m', date) as month, SUM(ABS(amount)) as invested
        FROM transactions WHERE user_id = ? AND portfolio_holding IS NOT NULL AND portfolio_holding != '' AND amount < 0
        GROUP BY strftime('%Y-%m', date) ORDER BY month DESC LIMIT 12
      `).all(userId) as SqliteRow[];

      const totalInvested = positions.reduce((s, p) => s + Number(p.book_value), 0);
      const top3 = positions.slice(0, 3).reduce((s, p) => s + Number(p.book_value), 0) / (totalInvested || 1);
      const diversScore = Math.max(0, Math.round((1 - top3) * 100));
      const avgMonthly = contributions.length > 0 ? contributions.reduce((s, c) => s + Number(c.invested), 0) / contributions.length : 0;

      return txt({
        disclaimer: PORTFOLIO_DISCLAIMER,
        mode: "patterns",
        reportingCurrency: reporting,
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
          record_transaction: "record_transaction(amount, payee, account, date?, category?, note?, tags?) — Account is REQUIRED: ask the user which account if unclear, never guess. Category auto-detected from payee rules/history when omitted.",
          bulk_record_transactions: "bulk_record_transactions(transactions[]) — Each item requires account. Returns per-item success/failure.",
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
          get_investment_insights: "get_investment_insights(mode?, targets?, benchmark?) — mode: 'patterns' (default), 'rebalancing' (needs targets), 'benchmark'",
          get_net_worth: "get_net_worth(currency?, months?) — Omit months for current totals; set months>0 for a trend.",
        };
        return txt({ tool: tool_name, usage: docs[tool_name] ?? "Use topic='tools' for full list." });
      }

      const t = topic ?? "tools";

      if (t === "tools") return txt({
        read_tools: ["get_account_balances", "search_transactions", "get_budget_summary", "get_spending_trends", "get_net_worth", "get_categories", "get_loans", "get_goals", "get_recurring_transactions", "get_income_statement", "get_spotlight_items", "get_weekly_recap", "get_transaction_rules"],
        write_tools: ["record_transaction", "bulk_record_transactions", "update_transaction", "delete_transaction", "set_budget", "delete_budget", "add_account", "update_account", "delete_account", "add_goal", "update_goal", "delete_goal", "create_category", "create_rule", "add_snapshot", "apply_rules_to_uncategorized"],
        portfolio_tools: ["get_portfolio_analysis", "get_portfolio_performance", "analyze_holding", "get_investment_insights"],
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
        { task: "Log a coffee", call: 'record_transaction(amount=-5.50, payee="Tim Hortons", account="RBC ION Visa")' },
        { task: "Log salary", call: 'record_transaction(amount=3500, payee="Employer", category="Salary")' },
        { task: "Set budget", call: 'set_budget(category="Groceries", month="2026-04", amount=600)' },
        { task: "Fix category", call: 'update_transaction(id=42, category="Restaurants")' },
        { task: "Net worth trend", call: "get_net_worth(months=12)" },
        { task: "Analyze portfolio", call: "get_portfolio_analysis()" },
        { task: "Rebalance", call: 'get_investment_insights(mode="rebalancing", targets=[{holding:"VEQT", target_pct:60}])' },
      ]});

      if (t === "portfolio") return txt({
        tools: ["get_portfolio_analysis", "get_portfolio_performance", "analyze_holding", "get_investment_insights"],
        modes: "get_investment_insights supports mode: 'patterns' (default) | 'rebalancing' (needs targets) | 'benchmark' (needs benchmark)",
        disclaimer: PORTFOLIO_DISCLAIMER,
      });

      if (t === "write") return txt({
        primary_add: "record_transaction — smart defaults, fuzzy matching",
        bulk: "bulk_record_transactions(transactions[])",
        edits: ["update_transaction(id, ...)", "delete_transaction(id)"],
        budget: ["set_budget(category, month, amount)", "delete_budget(category, month)"],
        accounts: ["add_account(name, type)", "update_account(account, ...)", "delete_account(account)"],
        goals: ["add_goal(name, type, amount)", "update_goal(goal, ...)", "delete_goal(goal)"],
        categories: ["create_category(name, type)", "create_rule(match_payee, assign_category)"],
        note: "Set category via update_transaction(id, category=...).",
      });

      return txt({ error: "Unknown topic" });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Wave 1B — Loans, FX, Subscriptions CRUD, Rules CRUD, Suggest, Splits CRUD
  //
  // NOTE: stdio transport stores text fields (payee/note/tags/split note) as
  // plaintext by design. Self-host users rely on OS-level disk encryption.
  // The HTTP equivalents in register-tools-pg.ts encrypt using the session DEK.
  // ═══════════════════════════════════════════════════════════════════════════

  // ── list_loans ────────────────────────────────────────────────────────────
  server.tool(
    "list_loans",
    "List all loans with balance, rate, payment, payoff date, and linked account",
    {},
    async () => {
      const rows = await sqlite.prepare(`
        SELECT l.id, l.name, l.type, l.principal, l.annual_rate, l.term_months,
               l.start_date, l.payment_amount, l.payment_frequency, l.extra_payment,
               l.note, l.account_id, a.name AS account_name
        FROM loans l LEFT JOIN accounts a ON a.id = l.account_id
        WHERE l.user_id = ? ORDER BY l.start_date DESC, l.id
      `).all(userId) as SqliteRow[];
      const today = new Date().toISOString().split("T")[0];
      const enriched = rows.map((r) => {
        const summary = generateAmortizationSchedule(
          Number(r.principal),
          Number(r.annual_rate),
          Number(r.term_months),
          String(r.start_date),
          Number(r.extra_payment ?? 0),
          String(r.payment_frequency ?? "monthly"),
        );
        const paid = summary.schedule.filter((x) => x.date <= today);
        const principalPaid = paid.reduce((s, x) => s + x.principal, 0);
        const interestPaid = paid.reduce((s, x) => s + x.interest, 0);
        return {
          ...r,
          monthlyPayment: summary.monthlyPayment,
          totalInterest: summary.totalInterest,
          payoffDate: summary.payoffDate,
          remainingBalance: Math.max(Number(r.principal) - principalPaid, 0),
          principalPaid: Math.round(principalPaid * 100) / 100,
          interestPaid: Math.round(interestPaid * 100) / 100,
          periodsRemaining: summary.schedule.length - paid.length,
        };
      });
      return txt({ success: true, data: enriched });
    }
  );

  // ── add_loan ──────────────────────────────────────────────────────────────
  server.tool(
    "add_loan",
    "Create a new loan",
    {
      name: z.string(),
      type: z.string(),
      principal: z.number(),
      annual_rate: z.number(),
      term_months: z.number().int().positive(),
      start_date: z.string(),
      account: z.string().optional().describe("Linked account — name or alias (fuzzy matched against name; exact match on alias)"),
      payment_amount: z.number().optional(),
      payment_frequency: z.enum(["monthly", "biweekly"]).optional(),
      extra_payment: z.number().optional(),
      min_payment: z.number().optional(),
      note: z.string().optional(),
    },
    async ({ name, type, principal, annual_rate, term_months, start_date, account, payment_amount, payment_frequency, extra_payment, min_payment, note }) => {
      let accountId: number | null = null;
      if (account) {
        const allAccounts = await sqlite.prepare(`SELECT id, name, alias FROM accounts WHERE user_id = ?`).all(userId) as SqliteRow[];
        const acct = fuzzyFind(account, allAccounts);
        if (!acct) return sqliteErr(`Account "${account}" not found`);
        accountId = Number(acct.id);
      }
      const pmt = payment_amount ?? min_payment ?? null;
      const result = await sqlite.prepare(
        `INSERT INTO loans (user_id, name, type, account_id, principal, annual_rate, term_months, start_date, payment_amount, payment_frequency, extra_payment, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      ).get(userId, name, type, accountId, principal, annual_rate, term_months, start_date, pmt, payment_frequency ?? "monthly", extra_payment ?? 0, note ?? "") as { id: number } | undefined;
      return txt({ success: true, data: { id: result?.id, message: `Loan "${name}" created` } });
    }
  );

  // ── update_loan ───────────────────────────────────────────────────────────
  server.tool(
    "update_loan",
    "Update any field of an existing loan by id",
    {
      id: z.number(),
      name: z.string().optional(),
      type: z.string().optional(),
      principal: z.number().optional(),
      annual_rate: z.number().optional(),
      term_months: z.number().int().positive().optional(),
      start_date: z.string().optional(),
      payment_amount: z.number().optional(),
      payment_frequency: z.enum(["monthly", "biweekly"]).optional(),
      extra_payment: z.number().optional(),
      account: z.string().optional().describe("Linked account — name or alias (fuzzy matched against name; exact match on alias). Empty string clears the link."),
      note: z.string().optional(),
    },
    async ({ id, name, type, principal, annual_rate, term_months, start_date, payment_amount, payment_frequency, extra_payment, account, note }) => {
      const existing = await sqlite.prepare(`SELECT id FROM loans WHERE id = ? AND user_id = ?`).get(id, userId);
      if (!existing) return sqliteErr(`Loan #${id} not found`);

      let accountIdUpdate: number | null | undefined;
      if (account !== undefined) {
        if (account === "") accountIdUpdate = null;
        else {
          const allAccounts = await sqlite.prepare(`SELECT id, name, alias FROM accounts WHERE user_id = ?`).all(userId) as SqliteRow[];
          const acct = fuzzyFind(account, allAccounts);
          if (!acct) return sqliteErr(`Account "${account}" not found`);
          accountIdUpdate = Number(acct.id);
        }
      }

      const updates: string[] = [];
      const params: unknown[] = [];
      if (name !== undefined) { updates.push(`name = ?`); params.push(name); }
      if (type !== undefined) { updates.push(`type = ?`); params.push(type); }
      if (principal !== undefined) { updates.push(`principal = ?`); params.push(principal); }
      if (annual_rate !== undefined) { updates.push(`annual_rate = ?`); params.push(annual_rate); }
      if (term_months !== undefined) { updates.push(`term_months = ?`); params.push(term_months); }
      if (start_date !== undefined) { updates.push(`start_date = ?`); params.push(start_date); }
      if (payment_amount !== undefined) { updates.push(`payment_amount = ?`); params.push(payment_amount); }
      if (payment_frequency !== undefined) { updates.push(`payment_frequency = ?`); params.push(payment_frequency); }
      if (extra_payment !== undefined) { updates.push(`extra_payment = ?`); params.push(extra_payment); }
      if (accountIdUpdate !== undefined) { updates.push(`account_id = ?`); params.push(accountIdUpdate); }
      if (note !== undefined) { updates.push(`note = ?`); params.push(note); }
      if (!updates.length) return sqliteErr("No fields to update");
      params.push(id, userId);
      await sqlite.prepare(`UPDATE loans SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`).run(...params);
      return txt({ success: true, data: { id, message: `Loan #${id} updated (${updates.length} field(s))` } });
    }
  );

  // ── delete_loan ───────────────────────────────────────────────────────────
  server.tool(
    "delete_loan",
    "Delete a loan by id",
    { id: z.number() },
    async ({ id }) => {
      const existing = await sqlite.prepare(`SELECT id, name FROM loans WHERE id = ? AND user_id = ?`).get(id, userId) as { id: number; name: string } | undefined;
      if (!existing) return sqliteErr(`Loan #${id} not found`);
      await sqlite.prepare(`DELETE FROM loans WHERE id = ? AND user_id = ?`).run(id, userId);
      return txt({ success: true, data: { id, message: `Loan "${existing.name}" deleted` } });
    }
  );

  // ── get_loan_amortization ─────────────────────────────────────────────────
  server.tool(
    "get_loan_amortization",
    "Full amortization schedule for a loan. Amounts are in the loan's own currency; the response surfaces both the loan currency and reportingCurrency for context.",
    {
      loan_id: z.number(),
      as_of_date: z.string().optional().describe("YYYY-MM-DD (default: today)"),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async ({ loan_id, as_of_date, reportingCurrency }) => {
      const reporting = await resolveReportingCurrencyStdio(sqlite, userId, reportingCurrency);
      const loan = await sqlite.prepare(
        `SELECT id, name, principal, annual_rate, term_months, start_date, payment_frequency, extra_payment, currency FROM loans WHERE id = ? AND user_id = ?`
      ).get(loan_id, userId) as SqliteRow | undefined;
      if (!loan) return sqliteErr(`Loan #${loan_id} not found`);
      const summary = generateAmortizationSchedule(
        Number(loan.principal),
        Number(loan.annual_rate),
        Number(loan.term_months),
        String(loan.start_date),
        Number(loan.extra_payment ?? 0),
        String(loan.payment_frequency ?? "monthly"),
      );
      const cutoff = as_of_date ?? new Date().toISOString().split("T")[0];
      const paid = summary.schedule.filter((r) => r.date <= cutoff);
      const principalPaid = paid.reduce((s, r) => s + r.principal, 0);
      const interestPaid = paid.reduce((s, r) => s + r.interest, 0);
      return txt({
        success: true,
        data: {
          loanId: loan_id,
          loanName: loan.name,
          loanCurrency: loan.currency ?? "CAD",
          reportingCurrency: reporting,
          asOfDate: cutoff,
          monthlyPayment: summary.monthlyPayment,
          totalPayments: summary.totalPayments,
          totalInterest: summary.totalInterest,
          payoffDate: summary.payoffDate,
          asOfSummary: {
            periodsElapsed: paid.length,
            principalPaid: Math.round(principalPaid * 100) / 100,
            interestPaid: Math.round(interestPaid * 100) / 100,
            remainingBalance: Math.max(Number(loan.principal) - principalPaid, 0),
            periodsRemaining: summary.schedule.length - paid.length,
          },
          schedule: summary.schedule,
        },
      });
    }
  );

  // ── get_debt_payoff_plan ──────────────────────────────────────────────────
  server.tool(
    "get_debt_payoff_plan",
    "Compare avalanche vs snowball payoff across all user loans. Loan balances stay in each loan's own currency; reportingCurrency is surfaced as metadata.",
    {
      strategy: z.enum(["avalanche", "snowball", "both"]).optional(),
      extra_payment: z.number().optional(),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async ({ strategy, extra_payment, reportingCurrency }) => {
      const reporting = await resolveReportingCurrencyStdio(sqlite, userId, reportingCurrency);
      const loans = await sqlite.prepare(
        `SELECT id, name, principal, annual_rate, term_months, start_date, payment_amount, payment_frequency, extra_payment FROM loans WHERE user_id = ?`
      ).all(userId) as SqliteRow[];
      if (!loans.length) return txt({ success: true, data: { message: "No loans found", strategies: {} } });
      const today = new Date().toISOString().split("T")[0];
      const debts: Debt[] = loans.map((l) => {
        const summary = generateAmortizationSchedule(
          Number(l.principal),
          Number(l.annual_rate),
          Number(l.term_months),
          String(l.start_date),
          Number(l.extra_payment ?? 0),
          String(l.payment_frequency ?? "monthly"),
        );
        const paid = summary.schedule.filter((r) => r.date <= today);
        const principalPaid = paid.reduce((s, r) => s + r.principal, 0);
        const balance = Math.max(Number(l.principal) - principalPaid, 0);
        const minPayment = Number(l.payment_amount ?? summary.monthlyPayment);
        return {
          id: Number(l.id),
          name: String(l.name),
          balance: Math.round(balance * 100) / 100,
          rate: Number(l.annual_rate),
          minPayment,
        };
      });
      const strat = strategy ?? "both";
      const extra = extra_payment ?? 0;
      const result: Record<string, unknown> = { inputs: { extraPayment: extra, debts }, reportingCurrency: reporting };
      if (strat === "avalanche" || strat === "both") result.avalanche = calculateDebtPayoff(debts, extra, "avalanche");
      if (strat === "snowball" || strat === "both") result.snowball = calculateDebtPayoff(debts, extra, "snowball");
      return txt({ success: true, data: result });
    }
  );

  // ── get_fx_rate ───────────────────────────────────────────────────────────
  server.tool(
    "get_fx_rate",
    "Get the FX rate to convert 1 unit of `from` into `to` on `date`. Cross-rates triangulate through USD; user overrides win.",
    {
      from: z.string(),
      to: z.string(),
      date: z.string().optional(),
    },
    async ({ from, to, date }) => {
      const d = date ?? new Date().toISOString().split("T")[0];
      if (from === to) return txt({ success: true, data: { from, to, date: d, rate: 1, source: "identity" } });
      const rate = await getRate(from, to, d, userId);
      return txt({ success: true, data: { from, to, date: d, rate, source: "triangulated" } });
    }
  );

  // ── list_fx_overrides ─────────────────────────────────────────────────────
  server.tool(
    "list_fx_overrides",
    "List the user's manual FX rate overrides (rate_to_usd pins by currency over date ranges)",
    {},
    async () => {
      const rows = await sqlite.prepare(
        `SELECT id, currency, date_from, date_to, rate_to_usd, note FROM fx_overrides WHERE user_id = ? ORDER BY currency, date_from DESC`
      ).all(userId);
      return txt({ success: true, data: rows });
    }
  );

  // ── set_fx_override ───────────────────────────────────────────────────────
  server.tool(
    "set_fx_override",
    "Pin a manual FX rate. Stored as rate_to_usd internally; one side of the from/to pair must be USD.",
    {
      from: z.string(),
      to: z.string(),
      date: z.string(),
      rate: z.number().positive(),
      dateTo: z.string().optional(),
      note: z.string().optional(),
    },
    async ({ from, to, date, rate, dateTo, note }) => {
      const fromU = from.trim().toUpperCase();
      const toU = to.trim().toUpperCase();
      let currency: string;
      let rateToUsd: number;
      if (fromU === "USD") { currency = toU; rateToUsd = 1 / rate; }
      else if (toU === "USD") { currency = fromU; rateToUsd = rate; }
      else return sqliteErr(`Cross-pair overrides aren't supported. Anchor against USD: pin ${fromU}→USD and ${toU}→USD separately.`);

      const result = await sqlite.prepare(
        `INSERT INTO fx_overrides (user_id, currency, date_from, date_to, rate_to_usd, note) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
      ).get(userId, currency, date, dateTo ?? date, rateToUsd, note ?? "") as { id: number } | undefined;
      return txt({ success: true, data: { id: result?.id, currency, dateFrom: date, dateTo: dateTo ?? date, rateToUsd, action: "created" } });
    }
  );

  // ── delete_fx_override ────────────────────────────────────────────────────
  server.tool(
    "delete_fx_override",
    "Delete a manual FX rate override by id",
    { id: z.number() },
    async ({ id }) => {
      const existing = await sqlite.prepare(
        `SELECT id, currency, date_from, date_to FROM fx_overrides WHERE id = ? AND user_id = ?`
      ).get(id, userId) as SqliteRow | undefined;
      if (!existing) return sqliteErr(`FX override #${id} not found`);
      await sqlite.prepare(`DELETE FROM fx_overrides WHERE id = ? AND user_id = ?`).run(id, userId);
      return txt({ success: true, data: { id, message: `Deleted FX override for ${existing.currency} (${existing.date_from}${existing.date_to ? `..${existing.date_to}` : "+"})` } });
    }
  );

  // ── convert_amount ────────────────────────────────────────────────────────
  server.tool(
    "convert_amount",
    "Convert an amount from one currency to another using triangulated FX rates",
    {
      amount: z.number(),
      from: z.string(),
      to: z.string(),
      date: z.string().optional(),
    },
    async ({ amount, from, to, date }) => {
      const d = date ?? new Date().toISOString().split("T")[0];
      if (from === to) return txt({ success: true, data: { amount, from, to, rate: 1, converted: amount } });
      const rate = await getRate(from, to, d, userId);
      const converted = Math.round(amount * rate * 100) / 100;
      return txt({ success: true, data: { amount, from, to, rate, converted, date: d, source: "triangulated" } });
    }
  );

  // ── list_subscriptions ────────────────────────────────────────────────────
  server.tool(
    "list_subscriptions",
    "List all subscriptions with status, next billing, category, account, notes",
    { status: z.enum(["active", "paused", "cancelled", "all"]).optional() },
    async ({ status }) => {
      let query = `SELECT s.id, s.name, s.amount, s.currency, s.frequency, s.next_date, s.status,
                          s.cancel_reminder_date, s.notes, s.category_id, c.name AS category_name,
                          s.account_id, a.name AS account_name
                   FROM subscriptions s
                   LEFT JOIN categories c ON c.id = s.category_id
                   LEFT JOIN accounts a ON a.id = s.account_id
                   WHERE s.user_id = ?`;
      const params: unknown[] = [userId];
      if (status && status !== "all") { query += ` AND s.status = ?`; params.push(status); }
      query += ` ORDER BY s.status, s.name`;
      const rows = await sqlite.prepare(query).all(...params);
      return txt({ success: true, data: rows });
    }
  );

  // ── add_subscription ──────────────────────────────────────────────────────
  server.tool(
    "add_subscription",
    "Create a new subscription",
    {
      name: z.string(),
      amount: z.number(),
      cadence: z.enum(["weekly", "monthly", "quarterly", "annual", "yearly"]),
      next_billing_date: z.string(),
      currency: z.enum(["CAD", "USD"]).optional(),
      category: z.string().optional(),
      account: z.string().optional().describe("Account name or alias (fuzzy matched against name; exact match on alias)"),
      notes: z.string().optional(),
    },
    async ({ name, amount, cadence, next_billing_date, currency, category, account, notes }) => {
      const existing = await sqlite.prepare(`SELECT id FROM subscriptions WHERE user_id = ? AND name = ?`).get(userId, name);
      if (existing) return sqliteErr(`Subscription "${name}" already exists`);

      let categoryId: number | null = null;
      if (category) {
        const allCats = await sqlite.prepare(`SELECT id, name FROM categories WHERE user_id = ?`).all(userId) as SqliteRow[];
        const cat = fuzzyFind(category, allCats);
        if (!cat) return sqliteErr(`Category "${category}" not found`);
        categoryId = Number(cat.id);
      }
      let accountId: number | null = null;
      if (account) {
        const allAccounts = await sqlite.prepare(`SELECT id, name, alias FROM accounts WHERE user_id = ?`).all(userId) as SqliteRow[];
        const acct = fuzzyFind(account, allAccounts);
        if (!acct) return sqliteErr(`Account "${account}" not found`);
        accountId = Number(acct.id);
      }
      const result = await sqlite.prepare(
        `INSERT INTO subscriptions (user_id, name, amount, currency, frequency, category_id, account_id, next_date, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?) RETURNING id`
      ).get(userId, name, amount, currency ?? "CAD", cadence, categoryId, accountId, next_billing_date, notes ?? null) as { id: number } | undefined;
      return txt({ success: true, data: { id: result?.id, message: `Subscription "${name}" created` } });
    }
  );

  // ── update_subscription ───────────────────────────────────────────────────
  server.tool(
    "update_subscription",
    "Update any field of an existing subscription",
    {
      id: z.number(),
      name: z.string().optional(),
      amount: z.number().optional(),
      cadence: z.enum(["weekly", "monthly", "quarterly", "annual", "yearly"]).optional(),
      next_billing_date: z.string().optional(),
      currency: z.enum(["CAD", "USD"]).optional(),
      category: z.string().optional().describe("Empty string clears"),
      account: z.string().optional().describe("Account name or alias (fuzzy matched against name; exact match on alias). Empty string clears."),
      status: z.enum(["active", "paused", "cancelled"]).optional(),
      cancel_reminder_date: z.string().optional(),
      notes: z.string().optional(),
    },
    async ({ id, name, amount, cadence, next_billing_date, currency, category, account, status, cancel_reminder_date, notes }) => {
      const existing = await sqlite.prepare(`SELECT id FROM subscriptions WHERE id = ? AND user_id = ?`).get(id, userId);
      if (!existing) return sqliteErr(`Subscription #${id} not found`);

      let categoryIdUpdate: number | null | undefined;
      if (category !== undefined) {
        if (category === "") categoryIdUpdate = null;
        else {
          const allCats = await sqlite.prepare(`SELECT id, name FROM categories WHERE user_id = ?`).all(userId) as SqliteRow[];
          const cat = fuzzyFind(category, allCats);
          if (!cat) return sqliteErr(`Category "${category}" not found`);
          categoryIdUpdate = Number(cat.id);
        }
      }
      let accountIdUpdate: number | null | undefined;
      if (account !== undefined) {
        if (account === "") accountIdUpdate = null;
        else {
          const allAccounts = await sqlite.prepare(`SELECT id, name, alias FROM accounts WHERE user_id = ?`).all(userId) as SqliteRow[];
          const acct = fuzzyFind(account, allAccounts);
          if (!acct) return sqliteErr(`Account "${account}" not found`);
          accountIdUpdate = Number(acct.id);
        }
      }

      const updates: string[] = [];
      const params: unknown[] = [];
      if (name !== undefined) { updates.push(`name = ?`); params.push(name); }
      if (amount !== undefined) { updates.push(`amount = ?`); params.push(amount); }
      if (cadence !== undefined) { updates.push(`frequency = ?`); params.push(cadence); }
      if (next_billing_date !== undefined) { updates.push(`next_date = ?`); params.push(next_billing_date); }
      if (currency !== undefined) { updates.push(`currency = ?`); params.push(currency); }
      if (categoryIdUpdate !== undefined) { updates.push(`category_id = ?`); params.push(categoryIdUpdate); }
      if (accountIdUpdate !== undefined) { updates.push(`account_id = ?`); params.push(accountIdUpdate); }
      if (status !== undefined) { updates.push(`status = ?`); params.push(status); }
      if (cancel_reminder_date !== undefined) { updates.push(`cancel_reminder_date = ?`); params.push(cancel_reminder_date); }
      if (notes !== undefined) { updates.push(`notes = ?`); params.push(notes); }
      if (!updates.length) return sqliteErr("No fields to update");
      params.push(id, userId);
      await sqlite.prepare(`UPDATE subscriptions SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`).run(...params);
      return txt({ success: true, data: { id, message: `Subscription #${id} updated (${updates.length} field(s))` } });
    }
  );

  // ── delete_subscription ───────────────────────────────────────────────────
  server.tool(
    "delete_subscription",
    "Permanently delete a subscription by id",
    { id: z.number() },
    async ({ id }) => {
      const existing = await sqlite.prepare(`SELECT id, name FROM subscriptions WHERE id = ? AND user_id = ?`).get(id, userId) as { id: number; name: string } | undefined;
      if (!existing) return sqliteErr(`Subscription #${id} not found`);
      await sqlite.prepare(`DELETE FROM subscriptions WHERE id = ? AND user_id = ?`).run(id, userId);
      return txt({ success: true, data: { id, message: `Subscription "${existing.name}" deleted` } });
    }
  );

  // ── list_rules ────────────────────────────────────────────────────────────
  server.tool(
    "list_rules",
    "List all auto-categorization rules",
    {},
    async () => {
      const rows = await sqlite.prepare(
        `SELECT r.id, r.name, r.match_field, r.match_type, r.match_value,
                r.assign_category_id, c.name AS category_name,
                r.assign_tags, r.rename_to, r.is_active, r.priority, r.created_at
         FROM transaction_rules r LEFT JOIN categories c ON c.id = r.assign_category_id
         WHERE r.user_id = ? ORDER BY r.priority DESC, r.id`
      ).all(userId);
      return txt({ success: true, data: rows });
    }
  );

  // ── update_rule ───────────────────────────────────────────────────────────
  server.tool(
    "update_rule",
    "Update any field of an existing transaction rule",
    {
      id: z.number(),
      name: z.string().optional(),
      match_field: z.enum(["payee", "amount", "tags"]).optional(),
      match_type: z.enum(["contains", "exact", "regex", "greater_than", "less_than"]).optional(),
      match_value: z.string().optional(),
      match_payee: z.string().optional(),
      assign_category: z.string().optional(),
      assign_tags: z.string().optional(),
      rename_to: z.string().optional(),
      is_active: z.boolean().optional(),
      priority: z.number().optional(),
    },
    async ({ id, name, match_field, match_type, match_value, match_payee, assign_category, assign_tags, rename_to, is_active, priority }) => {
      const existing = await sqlite.prepare(`SELECT id FROM transaction_rules WHERE id = ? AND user_id = ?`).get(id, userId);
      if (!existing) return sqliteErr(`Rule #${id} not found`);

      let assignCategoryIdUpdate: number | null | undefined;
      if (assign_category !== undefined) {
        if (assign_category === "") assignCategoryIdUpdate = null;
        else {
          const allCats = await sqlite.prepare(`SELECT id, name FROM categories WHERE user_id = ?`).all(userId) as SqliteRow[];
          const cat = fuzzyFind(assign_category, allCats);
          if (!cat) return sqliteErr(`Category "${assign_category}" not found`);
          assignCategoryIdUpdate = Number(cat.id);
        }
      }

      let effMatchField = match_field;
      let effMatchType = match_type;
      let effMatchValue = match_value;
      if (match_payee !== undefined) {
        effMatchField = effMatchField ?? "payee";
        effMatchType = effMatchType ?? "contains";
        effMatchValue = match_payee;
      }

      const updates: string[] = [];
      const params: unknown[] = [];
      if (name !== undefined) { updates.push(`name = ?`); params.push(name); }
      if (effMatchField !== undefined) { updates.push(`match_field = ?`); params.push(effMatchField); }
      if (effMatchType !== undefined) { updates.push(`match_type = ?`); params.push(effMatchType); }
      if (effMatchValue !== undefined) { updates.push(`match_value = ?`); params.push(effMatchValue); }
      if (assignCategoryIdUpdate !== undefined) { updates.push(`assign_category_id = ?`); params.push(assignCategoryIdUpdate); }
      if (assign_tags !== undefined) { updates.push(`assign_tags = ?`); params.push(assign_tags); }
      if (rename_to !== undefined) { updates.push(`rename_to = ?`); params.push(rename_to); }
      if (is_active !== undefined) { updates.push(`is_active = ?`); params.push(is_active ? 1 : 0); }
      if (priority !== undefined) { updates.push(`priority = ?`); params.push(priority); }
      if (!updates.length) return sqliteErr("No fields to update");
      params.push(id, userId);
      await sqlite.prepare(`UPDATE transaction_rules SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`).run(...params);
      return txt({ success: true, data: { id, message: `Rule #${id} updated (${updates.length} field(s))` } });
    }
  );

  // ── delete_rule ───────────────────────────────────────────────────────────
  server.tool(
    "delete_rule",
    "Delete a transaction rule by id",
    { id: z.number() },
    async ({ id }) => {
      const existing = await sqlite.prepare(`SELECT id, name FROM transaction_rules WHERE id = ? AND user_id = ?`).get(id, userId) as { id: number; name: string } | undefined;
      if (!existing) return sqliteErr(`Rule #${id} not found`);
      await sqlite.prepare(`DELETE FROM transaction_rules WHERE id = ? AND user_id = ?`).run(id, userId);
      return txt({ success: true, data: { id, message: `Rule "${existing.name}" deleted` } });
    }
  );

  // ── test_rule ─────────────────────────────────────────────────────────────
  // stdio transport reads plaintext payee/tags (no DEK), so matching is
  // straight SQL+memory against plaintext columns.
  server.tool(
    "test_rule",
    "Dry-run a rule pattern against the user's existing transactions. Returns matched rows without writing.",
    {
      match_payee: z.string().optional(),
      match_field: z.enum(["payee", "amount", "tags"]).optional(),
      match_type: z.enum(["contains", "exact", "regex", "greater_than", "less_than"]).optional(),
      match_value: z.string().optional(),
      match_amount: z.number().optional(),
      sample_size: z.number().optional(),
    },
    async ({ match_payee, match_field, match_type, match_value, match_amount, sample_size }) => {
      const field = match_field ?? "payee";
      const type = match_type ?? "contains";
      const value =
        match_value !== undefined ? match_value :
        match_amount !== undefined ? String(match_amount) :
        match_payee ?? "";
      if (!value && field !== "amount") return sqliteErr("match_value or match_payee is required");
      const limit = sample_size ?? 5000;
      const raw = await sqlite.prepare(
        `SELECT t.id, t.date, t.payee, t.tags, t.amount, t.category_id, c.name AS category_name,
                t.account_id, a.name AS account_name
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
         LEFT JOIN accounts a ON a.id = t.account_id
         WHERE t.user_id = ? ORDER BY t.date DESC, t.id DESC LIMIT ?`
      ).all(userId, limit) as SqliteRow[];

      let regex: RegExp | null = null;
      if (type === "regex") {
        try { regex = new RegExp(value, "i"); }
        catch { return sqliteErr(`Invalid regex: ${value}`); }
      }
      const ruleAmount = field === "amount" ? parseFloat(value) : NaN;
      const valueLower = value.toLowerCase();
      const matched: Record<string, unknown>[] = [];
      for (const r of raw) {
        const payee = String(r.payee ?? "");
        const tags = String(r.tags ?? "");
        let hit = false;
        if (field === "amount") {
          if (isNaN(ruleAmount)) continue;
          const amt = Number(r.amount);
          if (type === "greater_than") hit = amt > ruleAmount;
          else if (type === "less_than") hit = amt < ruleAmount;
          else if (type === "exact") hit = Math.abs(amt - ruleAmount) < 0.01;
        } else {
          const fieldVal = (field === "payee" ? payee : tags).toLowerCase();
          if (type === "contains") hit = fieldVal.includes(valueLower);
          else if (type === "exact") hit = fieldVal === valueLower;
          else if (type === "regex" && regex) hit = regex.test(field === "payee" ? payee : tags);
        }
        if (hit) {
          matched.push({
            id: Number(r.id),
            date: r.date,
            payee,
            tags,
            amount: Number(r.amount),
            category: r.category_name,
            account: r.account_name,
          });
        }
      }
      return txt({
        success: true,
        data: {
          scanned: raw.length,
          matchedCount: matched.length,
          matches: matched.slice(0, 50),
          rulePreview: { field, type, value },
          note: matched.length > 50 ? `Showing 50 of ${matched.length} matches` : undefined,
        },
      });
    }
  );

  // ── reorder_rules ─────────────────────────────────────────────────────────
  server.tool(
    "reorder_rules",
    "Reorder rules — first id in `ordered_ids` becomes highest priority",
    { ordered_ids: z.array(z.number()).min(1) },
    async ({ ordered_ids }) => {
      const placeholders = ordered_ids.map(() => "?").join(",");
      const ownedRows = await sqlite.prepare(
        `SELECT id FROM transaction_rules WHERE user_id = ? AND id IN (${placeholders})`
      ).all(userId, ...ordered_ids) as SqliteRow[];
      if (ownedRows.length !== ordered_ids.length) {
        return sqliteErr(`One or more rule ids are not owned by this user (expected ${ordered_ids.length}, found ${ownedRows.length})`);
      }
      const base = ordered_ids.length * 10;
      for (let i = 0; i < ordered_ids.length; i++) {
        const priority = base - i * 10;
        await sqlite.prepare(`UPDATE transaction_rules SET priority = ? WHERE id = ? AND user_id = ?`).run(priority, ordered_ids[i], userId);
      }
      return txt({ success: true, data: { reordered: ordered_ids.length, order: ordered_ids } });
    }
  );

  // ── suggest_transaction_details ───────────────────────────────────────────
  // stdio plaintext: straightforward SQL match against plaintext payee/tags.
  server.tool(
    "suggest_transaction_details",
    "Suggest category + tags for a transaction based on rule matches and historical frequency",
    {
      payee: z.string(),
      amount: z.number().optional(),
      account_id: z.number().optional(),
      top_n: z.number().optional(),
    },
    async ({ payee, amount, top_n }) => {
      const topN = top_n ?? 3;
      if (!payee.trim()) return sqliteErr("payee is required");

      const rules = await sqlite.prepare(
        `SELECT id, name, match_field, match_type, match_value, assign_category_id, assign_tags, rename_to, priority
         FROM transaction_rules WHERE user_id = ? AND is_active = 1 ORDER BY priority DESC, id`
      ).all(userId) as SqliteRow[];
      const payeeLower = payee.toLowerCase();
      const matchedRules: Record<string, unknown>[] = [];
      for (const r of rules) {
        const field = String(r.match_field ?? "payee");
        const type = String(r.match_type ?? "contains");
        const value = String(r.match_value ?? "");
        let hit = false;
        if (field === "payee") {
          const valLower = value.toLowerCase();
          if (type === "contains") hit = payeeLower.includes(valLower) || valLower.includes(payeeLower);
          else if (type === "exact") hit = payeeLower === valLower;
          else if (type === "regex") {
            try { hit = new RegExp(value, "i").test(payee); } catch { /* ignore */ }
          }
        } else if (field === "amount" && amount !== undefined) {
          const ruleAmt = parseFloat(value);
          if (!isNaN(ruleAmt)) {
            if (type === "greater_than") hit = amount > ruleAmt;
            else if (type === "less_than") hit = amount < ruleAmt;
            else if (type === "exact") hit = Math.abs(amount - ruleAmt) < 0.01;
          }
        }
        if (hit) matchedRules.push(r);
      }

      const historyRows = await sqlite.prepare(
        `SELECT category_id, tags, COUNT(*) AS cnt
         FROM transactions
         WHERE user_id = ? AND LOWER(payee) = LOWER(?) AND category_id IS NOT NULL
         GROUP BY category_id, tags
         ORDER BY cnt DESC LIMIT 20`
      ).all(userId, payee) as SqliteRow[];

      const catCounts = new Map<number, number>();
      const tagCounts = new Map<string, number>();
      let historicalMatches = 0;
      for (const r of historyRows) {
        const cnt = Number(r.cnt);
        historicalMatches += cnt;
        if (r.category_id) catCounts.set(Number(r.category_id), (catCounts.get(Number(r.category_id)) ?? 0) + cnt);
        const t = String(r.tags ?? "");
        for (const tag of t.split(",").map((x) => x.trim()).filter(Boolean)) {
          tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + cnt);
        }
      }

      const topCatIds = Array.from(catCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, topN);
      let categoryRows: SqliteRow[] = [];
      if (topCatIds.length) {
        const ph = topCatIds.map(() => "?").join(",");
        categoryRows = await sqlite.prepare(
          `SELECT id, name, type, "group" FROM categories WHERE user_id = ? AND id IN (${ph})`
        ).all(userId, ...topCatIds.map(([id]) => id)) as SqliteRow[];
      }
      const categorySuggestions = topCatIds.map(([id, count]) => {
        const c = categoryRows.find((x) => Number(x.id) === id);
        return { id, count, name: c?.name ?? null, type: c?.type ?? null, group: c?.group ?? null };
      });
      const topTags = Array.from(tagCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, topN).map(([tag, count]) => ({ tag, count }));

      return txt({
        success: true,
        data: {
          payee,
          rules: matchedRules.map((r) => ({ id: Number(r.id), name: r.name, assignCategoryId: r.assign_category_id, assignTags: r.assign_tags, renameTo: r.rename_to })),
          categories: categorySuggestions,
          tags: topTags,
          historicalMatches,
        },
      });
    }
  );

  // ── list_splits ───────────────────────────────────────────────────────────
  server.tool(
    "list_splits",
    "List all splits for a transaction",
    { transaction_id: z.number() },
    async ({ transaction_id }) => {
      const owner = await sqlite.prepare(`SELECT id FROM transactions WHERE id = ? AND user_id = ?`).get(transaction_id, userId);
      if (!owner) return sqliteErr(`Transaction #${transaction_id} not found`);
      const rows = await sqlite.prepare(
        `SELECT s.id, s.transaction_id, s.category_id, c.name AS category_name,
                s.account_id, a.name AS account_name,
                s.amount, s.note, s.description, s.tags
         FROM transaction_splits s
         LEFT JOIN categories c ON c.id = s.category_id
         LEFT JOIN accounts a ON a.id = s.account_id
         WHERE s.transaction_id = ? ORDER BY s.id`
      ).all(transaction_id);
      return txt({ success: true, data: rows });
    }
  );

  // ── add_split ─────────────────────────────────────────────────────────────
  server.tool(
    "add_split",
    "Add a single split to an existing transaction",
    {
      transaction_id: z.number(),
      category_id: z.number().optional(),
      account_id: z.number().optional(),
      amount: z.number(),
      note: z.string().optional(),
      description: z.string().optional(),
      tags: z.string().optional(),
    },
    async ({ transaction_id, category_id, account_id, amount, note, description, tags }) => {
      const owner = await sqlite.prepare(`SELECT id FROM transactions WHERE id = ? AND user_id = ?`).get(transaction_id, userId);
      if (!owner) return sqliteErr(`Transaction #${transaction_id} not found`);
      const result = await sqlite.prepare(
        `INSERT INTO transaction_splits (transaction_id, category_id, account_id, amount, note, description, tags) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
      ).get(transaction_id, category_id ?? null, account_id ?? null, amount, note ?? "", description ?? "", tags ?? "") as { id: number } | undefined;
      invalidateUserTxCache(userId);
      return txt({ success: true, data: { id: result?.id, message: `Split added to txn #${transaction_id}` } });
    }
  );

  // ── update_split ──────────────────────────────────────────────────────────
  server.tool(
    "update_split",
    "Update fields of an existing split",
    {
      split_id: z.number(),
      category_id: z.number().nullable().optional(),
      account_id: z.number().nullable().optional(),
      amount: z.number().optional(),
      note: z.string().optional(),
      description: z.string().optional(),
      tags: z.string().optional(),
    },
    async ({ split_id, category_id, account_id, amount, note, description, tags }) => {
      const owner = await sqlite.prepare(
        `SELECT s.id FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id WHERE s.id = ? AND t.user_id = ?`
      ).get(split_id, userId);
      if (!owner) return sqliteErr(`Split #${split_id} not found`);

      const updates: string[] = [];
      const params: unknown[] = [];
      if (category_id !== undefined) { updates.push(`category_id = ?`); params.push(category_id); }
      if (account_id !== undefined) { updates.push(`account_id = ?`); params.push(account_id); }
      if (amount !== undefined) { updates.push(`amount = ?`); params.push(amount); }
      if (note !== undefined) { updates.push(`note = ?`); params.push(note); }
      if (description !== undefined) { updates.push(`description = ?`); params.push(description); }
      if (tags !== undefined) { updates.push(`tags = ?`); params.push(tags); }
      if (!updates.length) return sqliteErr("No fields to update");
      params.push(split_id);
      await sqlite.prepare(`UPDATE transaction_splits SET ${updates.join(", ")} WHERE id = ?`).run(...params);
      invalidateUserTxCache(userId);
      return txt({ success: true, data: { id: split_id, message: `Split #${split_id} updated (${updates.length} field(s))` } });
    }
  );

  // ── delete_split ──────────────────────────────────────────────────────────
  server.tool(
    "delete_split",
    "Delete a split by id",
    { split_id: z.number() },
    async ({ split_id }) => {
      const owner = await sqlite.prepare(
        `SELECT s.id FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id WHERE s.id = ? AND t.user_id = ?`
      ).get(split_id, userId);
      if (!owner) return sqliteErr(`Split #${split_id} not found`);
      await sqlite.prepare(`DELETE FROM transaction_splits WHERE id = ?`).run(split_id);
      invalidateUserTxCache(userId);
      return txt({ success: true, data: { id: split_id, message: `Split #${split_id} deleted` } });
    }
  );

  // ── replace_splits ────────────────────────────────────────────────────────
  server.tool(
    "replace_splits",
    "Atomically replace all splits on a transaction. Validates sum equals parent amount (±$0.01).",
    {
      transaction_id: z.number(),
      splits: z.array(z.object({
        category_id: z.number().nullable().optional(),
        account_id: z.number().nullable().optional(),
        amount: z.number(),
        note: z.string().optional(),
        description: z.string().optional(),
        tags: z.string().optional(),
      })).min(1),
    },
    async ({ transaction_id, splits }) => {
      const owner = await sqlite.prepare(`SELECT id, amount FROM transactions WHERE id = ? AND user_id = ?`).get(transaction_id, userId) as { id: number; amount: number } | undefined;
      if (!owner) return sqliteErr(`Transaction #${transaction_id} not found`);
      const sum = splits.reduce((s, x) => s + Number(x.amount), 0);
      if (Math.abs(sum - Number(owner.amount)) > 0.01) {
        return sqliteErr(`Splits sum (${sum.toFixed(2)}) must equal parent transaction amount (${Number(owner.amount).toFixed(2)})`);
      }
      await sqlite.prepare(`DELETE FROM transaction_splits WHERE transaction_id = ?`).run(transaction_id);
      const insertedIds: number[] = [];
      for (const s of splits) {
        const r = await sqlite.prepare(
          `INSERT INTO transaction_splits (transaction_id, category_id, account_id, amount, note, description, tags) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
        ).get(transaction_id, s.category_id ?? null, s.account_id ?? null, s.amount, s.note ?? "", s.description ?? "", s.tags ?? "") as { id: number } | undefined;
        if (r?.id) insertedIds.push(Number(r.id));
      }
      invalidateUserTxCache(userId);
      return txt({ success: true, data: { transactionId: transaction_id, replacedWith: insertedIds.length, splitIds: insertedIds } });
    }
  );

  // ─── Wave 2: bulk edit + detect_subscriptions + upload flow ────────────────
  //
  // stdio runs without envelope encryption (architectural decision #1) so
  // there's no DEK plumbing here — payee/note/tags live in the DB as
  // plaintext. Logic mirrors register-tools-pg.ts but drops the encrypt+
  // decrypt passes.

  const bulkFilterSchema = z.object({
    ids: z.array(z.number()).optional(),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    category_id: z.number().nullable().optional(),
    account_id: z.number().optional(),
    payee_match: z.string().optional(),
  });
  type BulkFilter = z.infer<typeof bulkFilterSchema>;

  const bulkChangesSchema = z.object({
    category_id: z.number().nullable().optional(),
    account_id: z.number().optional(),
    date: z.string().optional(),
    note: z.string().optional(),
    payee: z.string().optional(),
    is_business: z.number().optional(),
    tags: z.object({
      mode: z.enum(["append", "replace", "remove"]),
      value: z.string(),
    }).optional(),
  });
  type BulkChanges = z.infer<typeof bulkChangesSchema>;

  async function resolveFilterToIds(filter: BulkFilter): Promise<number[]> {
    const hasAny =
      (filter.ids && filter.ids.length > 0) ||
      filter.start_date !== undefined ||
      filter.end_date !== undefined ||
      filter.category_id !== undefined ||
      filter.account_id !== undefined ||
      (filter.payee_match !== undefined && filter.payee_match !== "");
    if (!hasAny) throw new Error("At least one filter field is required");

    const clauses: string[] = [`user_id = ?`];
    const params: unknown[] = [userId];
    if (filter.ids && filter.ids.length > 0) {
      const safeIds = filter.ids.map((n) => Number(n)).filter((n) => Number.isFinite(n));
      if (safeIds.length === 0) return [];
      clauses.push(`id IN (${safeIds.map(() => "?").join(",")})`);
      params.push(...safeIds);
    }
    if (filter.start_date) { clauses.push(`date >= ?`); params.push(filter.start_date); }
    if (filter.end_date) { clauses.push(`date <= ?`); params.push(filter.end_date); }
    if (filter.category_id === null) clauses.push(`category_id IS NULL`);
    else if (filter.category_id !== undefined) { clauses.push(`category_id = ?`); params.push(filter.category_id); }
    if (filter.account_id !== undefined) { clauses.push(`account_id = ?`); params.push(filter.account_id); }
    if (filter.payee_match) { clauses.push(`LOWER(payee) LIKE ?`); params.push(`%${filter.payee_match.toLowerCase()}%`); }

    const rows = await sqlite.prepare(
      `SELECT id FROM transactions WHERE ${clauses.join(" AND ")} ORDER BY date DESC, id DESC LIMIT 10000`
    ).all(...params) as Array<{ id: number }>;
    return rows.map((r) => Number(r.id));
  }

  function applyChangesToRow(row: Record<string, unknown>, changes: BulkChanges): Record<string, unknown> {
    const out = { ...row };
    if (changes.category_id !== undefined) out.category_id = changes.category_id;
    if (changes.account_id !== undefined) out.account_id = changes.account_id;
    if (changes.date !== undefined) out.date = changes.date;
    if (changes.note !== undefined) out.note = changes.note;
    if (changes.payee !== undefined) out.payee = changes.payee;
    if (changes.is_business !== undefined) out.is_business = changes.is_business;
    if (changes.tags !== undefined) {
      const currentSet = new Set(String(out.tags ?? "").split(",").map((s) => s.trim()).filter(Boolean));
      const tokens = changes.tags.value.split(",").map((s) => s.trim()).filter(Boolean);
      if (changes.tags.mode === "replace") out.tags = tokens.join(",");
      else if (changes.tags.mode === "append") { for (const t of tokens) currentSet.add(t); out.tags = Array.from(currentSet).join(","); }
      else { for (const t of tokens) currentSet.delete(t); out.tags = Array.from(currentSet).join(","); }
    }
    return out;
  }

  async function commitBulkUpdate(ids: number[], changes: BulkChanges): Promise<number> {
    if (ids.length === 0) return 0;
    const inList = `(${ids.map(() => "?").join(",")})`;

    if (changes.category_id !== undefined) {
      await sqlite.prepare(`UPDATE transactions SET category_id = ? WHERE id IN ${inList} AND user_id = ?`).run(changes.category_id, ...ids, userId);
    }
    if (changes.account_id !== undefined) {
      await sqlite.prepare(`UPDATE transactions SET account_id = ? WHERE id IN ${inList} AND user_id = ?`).run(changes.account_id, ...ids, userId);
    }
    if (changes.date !== undefined) {
      await sqlite.prepare(`UPDATE transactions SET date = ? WHERE id IN ${inList} AND user_id = ?`).run(changes.date, ...ids, userId);
    }
    if (changes.is_business !== undefined) {
      await sqlite.prepare(`UPDATE transactions SET is_business = ? WHERE id IN ${inList} AND user_id = ?`).run(changes.is_business, ...ids, userId);
    }
    if (changes.payee !== undefined) {
      await sqlite.prepare(`UPDATE transactions SET payee = ? WHERE id IN ${inList} AND user_id = ?`).run(changes.payee, ...ids, userId);
    }
    if (changes.note !== undefined) {
      await sqlite.prepare(`UPDATE transactions SET note = ? WHERE id IN ${inList} AND user_id = ?`).run(changes.note, ...ids, userId);
    }
    if (changes.tags !== undefined) {
      if (changes.tags.mode === "replace") {
        await sqlite.prepare(`UPDATE transactions SET tags = ? WHERE id IN ${inList} AND user_id = ?`).run(changes.tags.value, ...ids, userId);
      } else {
        const rows = await sqlite.prepare(`SELECT id, tags FROM transactions WHERE id IN ${inList} AND user_id = ?`).all(...ids, userId) as Array<{ id: number; tags: string }>;
        const tokens = changes.tags.value.split(",").map((s) => s.trim()).filter(Boolean);
        for (const r of rows) {
          const set = new Set(String(r.tags ?? "").split(",").map((s) => s.trim()).filter(Boolean));
          if (changes.tags.mode === "append") { for (const t of tokens) set.add(t); }
          else { for (const t of tokens) set.delete(t); }
          const next = Array.from(set).join(",");
          await sqlite.prepare(`UPDATE transactions SET tags = ? WHERE id = ? AND user_id = ?`).run(next, Number(r.id), userId);
        }
      }
    }
    return ids.length;
  }

  async function previewBulk(filter: BulkFilter, changes: BulkChanges, op: string) {
    const ids = await resolveFilterToIds(filter);
    if (ids.length === 0) return { affectedCount: 0, sampleBefore: [], sampleAfter: [], ids, confirmationToken: "" };
    const sampleIds = ids.slice(0, 10);
    const placeholders = sampleIds.map(() => "?").join(",");
    const before = await sqlite.prepare(
      `SELECT t.id, t.date, t.account_id, a.name AS account, t.category_id, c.name AS category,
              t.currency, t.amount, t.payee, t.note, t.tags, t.is_business
       FROM transactions t
       LEFT JOIN accounts a ON t.account_id = a.id
       LEFT JOIN categories c ON t.category_id = c.id
       WHERE t.id IN (${placeholders}) AND t.user_id = ?
       ORDER BY t.id`
    ).all(...sampleIds, userId) as Record<string, unknown>[];
    const after = before.map((r) => applyChangesToRow(r, changes));
    const token = signConfirmationToken(userId, op, { ids, changes });
    return { affectedCount: ids.length, sampleBefore: before, sampleAfter: after, ids, confirmationToken: token };
  }

  // ── preview_bulk_update ────────────────────────────────────────────────────
  server.tool(
    "preview_bulk_update",
    "Preview a bulk update over transactions matching `filter`. Returns affected count, before/after samples, and a confirmationToken (5-min TTL).",
    { filter: bulkFilterSchema, changes: bulkChangesSchema },
    async ({ filter, changes }) => {
      try {
        const { affectedCount, sampleBefore, sampleAfter, confirmationToken } = await previewBulk(filter, changes, "bulk_update");
        return txt({ success: true, data: { affectedCount, sampleBefore, sampleAfter, confirmationToken } });
      } catch (e) { return sqliteErr(String(e instanceof Error ? e.message : e)); }
    }
  );

  // ── execute_bulk_update ────────────────────────────────────────────────────
  server.tool(
    "execute_bulk_update",
    "Commit a bulk update. Must be preceded by preview_bulk_update with the same filter+changes.",
    { filter: bulkFilterSchema, changes: bulkChangesSchema, confirmation_token: z.string() },
    async ({ filter, changes, confirmation_token }) => {
      try {
        const ids = await resolveFilterToIds(filter);
        const check = verifyConfirmationToken(confirmation_token, userId, "bulk_update", { ids, changes });
        if (!check.valid) return sqliteErr(`Confirmation token invalid: ${check.reason}. Re-run preview_bulk_update.`);
        const n = await commitBulkUpdate(ids, changes);
        if (n > 0) invalidateUserTxCache(userId);
        return txt({ success: true, data: { updated: n } });
      } catch (e) { return sqliteErr(String(e instanceof Error ? e.message : e)); }
    }
  );

  // ── preview_bulk_delete ────────────────────────────────────────────────────
  server.tool(
    "preview_bulk_delete",
    "Preview a bulk delete. Returns affected count, sample rows, and a confirmationToken (5-min TTL).",
    { filter: bulkFilterSchema },
    async ({ filter }) => {
      try {
        const ids = await resolveFilterToIds(filter);
        if (ids.length === 0) return txt({ success: true, data: { affectedCount: 0, sample: [], confirmationToken: "" } });
        const sampleIds = ids.slice(0, 10);
        const placeholders = sampleIds.map(() => "?").join(",");
        const sample = await sqlite.prepare(
          `SELECT t.id, t.date, a.name AS account, c.name AS category, t.currency, t.amount, t.payee, t.note, t.tags
           FROM transactions t
           LEFT JOIN accounts a ON t.account_id = a.id
           LEFT JOIN categories c ON t.category_id = c.id
           WHERE t.id IN (${placeholders}) AND t.user_id = ?
           ORDER BY t.id`
        ).all(...sampleIds, userId);
        const token = signConfirmationToken(userId, "bulk_delete", { ids });
        return txt({ success: true, data: { affectedCount: ids.length, sample, confirmationToken: token } });
      } catch (e) { return sqliteErr(String(e instanceof Error ? e.message : e)); }
    }
  );

  // ── execute_bulk_delete ────────────────────────────────────────────────────
  server.tool(
    "execute_bulk_delete",
    "Commit a bulk delete. Must be preceded by preview_bulk_delete.",
    { filter: bulkFilterSchema, confirmation_token: z.string() },
    async ({ filter, confirmation_token }) => {
      try {
        const ids = await resolveFilterToIds(filter);
        const check = verifyConfirmationToken(confirmation_token, userId, "bulk_delete", { ids });
        if (!check.valid) return sqliteErr(`Confirmation token invalid: ${check.reason}. Re-run preview_bulk_delete.`);
        if (ids.length === 0) return txt({ success: true, data: { deleted: 0 } });
        const placeholders = ids.map(() => "?").join(",");
        await sqlite.prepare(`DELETE FROM transactions WHERE id IN (${placeholders}) AND user_id = ?`).run(...ids, userId);
        invalidateUserTxCache(userId);
        return txt({ success: true, data: { deleted: ids.length } });
      } catch (e) { return sqliteErr(String(e instanceof Error ? e.message : e)); }
    }
  );

  // ── preview_bulk_categorize ────────────────────────────────────────────────
  server.tool(
    "preview_bulk_categorize",
    "Preview a bulk-categorize (shortcut for preview_bulk_update with only category_id).",
    { filter: bulkFilterSchema, category_id: z.number() },
    async ({ filter, category_id }) => {
      try {
        const cat = await sqlite.prepare(`SELECT id, name FROM categories WHERE id = ? AND user_id = ?`).get(category_id, userId) as { id: number; name: string } | undefined;
        if (!cat) return sqliteErr(`Category #${category_id} not found`);
        const changes: BulkChanges = { category_id };
        const { affectedCount, sampleBefore, sampleAfter, confirmationToken } = await previewBulk(filter, changes, "bulk_categorize");
        return txt({ success: true, data: { categoryId: category_id, categoryName: cat.name, affectedCount, sampleBefore, sampleAfter, confirmationToken } });
      } catch (e) { return sqliteErr(String(e instanceof Error ? e.message : e)); }
    }
  );

  // ── execute_bulk_categorize ────────────────────────────────────────────────
  server.tool(
    "execute_bulk_categorize",
    "Commit a bulk-categorize. Must be preceded by preview_bulk_categorize.",
    { filter: bulkFilterSchema, category_id: z.number(), confirmation_token: z.string() },
    async ({ filter, category_id, confirmation_token }) => {
      try {
        const ids = await resolveFilterToIds(filter);
        const changes: BulkChanges = { category_id };
        const check = verifyConfirmationToken(confirmation_token, userId, "bulk_categorize", { ids, changes });
        if (!check.valid) return sqliteErr(`Confirmation token invalid: ${check.reason}. Re-run preview_bulk_categorize.`);
        const n = await commitBulkUpdate(ids, changes);
        if (n > 0) invalidateUserTxCache(userId);
        return txt({ success: true, data: { updated: n } });
      } catch (e) { return sqliteErr(String(e instanceof Error ? e.message : e)); }
    }
  );

  // ── detect_subscriptions ───────────────────────────────────────────────────
  server.tool(
    "detect_subscriptions",
    "Scan recent transactions and return candidate subscriptions with regular cadence + stable amount. Returns a confirmationToken for bulk_add_subscriptions.",
    { lookback_months: z.number().optional() },
    async ({ lookback_months }) => {
      const months = lookback_months ?? 6;
      const since = new Date();
      since.setMonth(since.getMonth() - months);
      const sinceStr = since.toISOString().split("T")[0];

      // stdio has plaintext payees — read straight from SQL (no cache needed,
      // but using the cache for consistency with the HTTP transport).
      const all = await getUserTransactions(userId, null);
      const recent = all.filter(
        (t) => t.date >= sinceStr && t.payee && !t.payee.startsWith("v1:")
      );

      const groups = new Map<string, typeof recent>();
      for (const t of recent) {
        const key = t.payee.toLowerCase().replace(/\s+/g, " ").trim();
        if (!key) continue;
        const list = groups.get(key) ?? [];
        list.push(t);
        groups.set(key, list);
      }

      type Candidate = {
        payee: string; avgAmount: number;
        cadence: "weekly" | "monthly" | "quarterly" | "annual";
        confidence: number; occurrences: number;
        sampleTransactionIds: number[];
      };
      const candidates: Candidate[] = [];

      for (const [, txs] of groups) {
        if (txs.length < 3) continue;
        txs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        const amounts = txs.map((t) => t.amount);
        const avg = amounts.reduce((s, n) => s + n, 0) / amounts.length;
        if (Math.abs(avg) < 0.01) continue;
        const stddev = Math.sqrt(amounts.reduce((s, n) => s + (n - avg) ** 2, 0) / amounts.length);
        if (stddev > Math.abs(avg) * 0.05) continue;

        const intervals: number[] = [];
        for (let i = 1; i < txs.length; i++) {
          const d1 = new Date(txs[i - 1].date + "T00:00:00Z").getTime();
          const d2 = new Date(txs[i].date + "T00:00:00Z").getTime();
          intervals.push(Math.round((d2 - d1) / 86400000));
        }
        const avgInt = intervals.reduce((s, n) => s + n, 0) / intervals.length;

        let cadence: Candidate["cadence"] | null = null;
        let tol = 0;
        if (Math.abs(avgInt - 7) <= 1) { cadence = "weekly"; tol = 1; }
        else if (Math.abs(avgInt - 30) <= 3) { cadence = "monthly"; tol = 3; }
        else if (Math.abs(avgInt - 91) <= 7) { cadence = "quarterly"; tol = 7; }
        else if (Math.abs(avgInt - 365) <= 15) { cadence = "annual"; tol = 15; }
        if (!cadence) continue;
        const regular = intervals.every((n) => Math.abs(n - avgInt) <= tol);
        if (!regular) continue;

        const countScore = Math.min(1, txs.length / 6);
        const amtTightness = Math.abs(avg) > 0 ? 1 - Math.min(1, stddev / Math.abs(avg)) : 1;
        const confidence = Math.round(((countScore * 0.4) + (amtTightness * 0.6)) * 100) / 100;

        candidates.push({
          payee: txs[0].payee,
          avgAmount: Math.round(Math.abs(avg) * 100) / 100,
          cadence, confidence,
          occurrences: txs.length,
          sampleTransactionIds: txs.slice(-5).map((t) => t.id),
        });
      }
      candidates.sort((a, b) => b.confidence - a.confidence || b.occurrences - a.occurrences);

      const approvable = candidates.map((c) => ({ payee: c.payee, amount: c.avgAmount, cadence: c.cadence }));
      const token = candidates.length
        ? signConfirmationToken(userId, "bulk_add_subscriptions", { candidates: approvable })
        : "";

      return txt({
        success: true,
        data: {
          scanned: recent.length,
          candidates,
          confirmationToken: token,
        },
      });
    }
  );

  // ── bulk_add_subscriptions ─────────────────────────────────────────────────
  server.tool(
    "bulk_add_subscriptions",
    "Commit a set of detected subscriptions. Pass the candidates from detect_subscriptions + the confirmationToken.",
    {
      candidates: z.array(z.object({
        payee: z.string(), amount: z.number(),
        cadence: z.enum(["weekly", "monthly", "quarterly", "annual"]),
        next_billing_date: z.string().optional(),
        category_id: z.number().optional(),
      })).min(1),
      confirmation_token: z.string(),
    },
    async ({ candidates, confirmation_token }) => {
      const approvable = candidates.map((c) => ({ payee: c.payee, amount: c.amount, cadence: c.cadence }));
      const check = verifyConfirmationToken(confirmation_token, userId, "bulk_add_subscriptions", { candidates: approvable });
      if (!check.valid) return sqliteErr(`Confirmation token invalid: ${check.reason}. Re-run detect_subscriptions.`);

      const today = new Date();
      const addInterval = (base: Date, cadence: string): string => {
        const d = new Date(base);
        if (cadence === "weekly") d.setDate(d.getDate() + 7);
        else if (cadence === "monthly") d.setMonth(d.getMonth() + 1);
        else if (cadence === "quarterly") d.setMonth(d.getMonth() + 3);
        else d.setFullYear(d.getFullYear() + 1);
        return d.toISOString().split("T")[0];
      };

      let created = 0;
      const skipped: string[] = [];
      for (const c of candidates) {
        const existing = await sqlite.prepare(`SELECT id FROM subscriptions WHERE user_id = ? AND name = ?`).get(userId, c.payee);
        if (existing) { skipped.push(c.payee); continue; }
        const next = c.next_billing_date ?? addInterval(today, c.cadence);
        await sqlite.prepare(
          `INSERT INTO subscriptions (user_id, name, amount, currency, frequency, category_id, account_id, next_date, status, notes)
           VALUES (?, ?, ?, 'CAD', ?, ?, NULL, ?, 'active', 'Auto-detected by MCP')`
        ).run(userId, c.payee, c.amount, c.cadence, c.category_id ?? null, next);
        created++;
      }
      return txt({ success: true, data: { created, skipped, message: `Created ${created} subscription(s); skipped ${skipped.length} existing` } });
    }
  );

  // ─── Part 1 tail — upload preview/execute (stdio) ──────────────────────────
  //
  // stdio transport has two paths:
  //   upload_id  — reads from the mcp_uploads table (works when stdio is
  //                pointed at the same DB the HTTP transport writes to, e.g.
  //                managed-cloud self-host connecting locally)
  //   file_path  — direct local-file import, gated by ALLOW_LOCAL_FILE_IMPORT=1
  //                so hosted users can't get here even if they try

  const allowLocalFile = process.env.ALLOW_LOCAL_FILE_IMPORT === "1";

  async function loadRowsFromPath(filePath: string): Promise<{ format: string; rows: RawTransaction[]; errors: Array<{ row: number; message: string }> }> {
    const buf = await fs.readFile(filePath);
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    if (ext === "csv") {
      const txt = buf.toString("utf8");
      const { rows, errors } = csvToRawTransactions(txt);
      return { format: "csv", rows, errors };
    }
    if (ext === "ofx" || ext === "qfx") {
      const txt = buf.toString("utf8");
      const parsed = parseOfx(txt);
      return {
        format: ext,
        rows: parsed.transactions.map((t) => ({
          date: t.date, account: "", amount: t.amount,
          payee: t.payee, currency: parsed.currency,
          note: t.memo, fitId: t.fitId,
        })),
        errors: [],
      };
    }
    throw new Error(`Unsupported file extension: ${ext}`);
  }

  async function loadRowsFromUpload(uploadId: string, columnMapping: Record<string, string> | undefined): Promise<{ upload: Record<string, unknown>; rows: RawTransaction[]; errors: Array<{ row: number; message: string }> }> {
    const upload = await sqlite.prepare(
      `SELECT id, user_id, format, storage_path, status, expires_at FROM mcp_uploads WHERE id = ? AND user_id = ?`
    ).get(uploadId, userId) as Record<string, unknown> | undefined;
    if (!upload) throw new Error(`Upload #${uploadId} not found`);
    if (String(upload.status) === "executed") throw new Error("Upload already executed");
    if (String(upload.status) === "cancelled") throw new Error("Upload was cancelled");
    const expiresAt = new Date(String(upload.expires_at));
    if (expiresAt.getTime() < Date.now()) throw new Error("Upload expired");

    const rawBuf = await fs.readFile(String(upload.storage_path));
    // Finding #7 — HTTP-side uploads are encrypted at rest. Stdio has no DEK,
    // so if the file carries the encryption magic we can't read it; fail
    // clearly instead of handing ciphertext to the CSV parser.
    const { isEncryptedFile } = await import("../src/lib/crypto/file-envelope");
    if (isEncryptedFile(rawBuf)) {
      throw new Error(
        "This upload was created via the HTTP MCP transport and is encrypted " +
          "at rest. Stdio MCP cannot decrypt it — use the HTTP transport " +
          "(OAuth or Bearer pf_ token) to import this upload."
      );
    }
    const buf = rawBuf;
    const format = String(upload.format);
    let rows: RawTransaction[] = [];
    const errors: Array<{ row: number; message: string }> = [];
    if (format === "csv") {
      const txtContent = buf.toString("utf8");
      const res = columnMapping
        ? csvToRawTransactionsWithMapping(txtContent, columnMapping)
        : csvToRawTransactions(txtContent);
      rows = res.rows; errors.push(...res.errors);
    } else if (format === "ofx" || format === "qfx") {
      const txtContent = buf.toString("utf8");
      const parsed = parseOfx(txtContent);
      rows = parsed.transactions.map((t) => ({
        date: t.date, account: "", amount: t.amount,
        payee: t.payee, currency: parsed.currency,
        note: t.memo, fitId: t.fitId,
      }));
    } else {
      throw new Error(`Unsupported upload format: ${format}`);
    }
    return { upload, rows, errors };
  }

  // ── list_pending_uploads ───────────────────────────────────────────────────
  server.tool(
    "list_pending_uploads",
    "List uploaded files that are pending or previewed (not yet executed or cancelled).",
    {},
    async () => {
      const rows = await sqlite.prepare(
        `SELECT id, format, original_filename, size_bytes, row_count, status, created_at, expires_at
         FROM mcp_uploads
         WHERE user_id = ? AND status IN ('pending', 'previewed') AND expires_at > NOW()
         ORDER BY created_at DESC`
      ).all(userId);
      return txt({ success: true, data: rows });
    }
  );

  // ── preview_import ─────────────────────────────────────────────────────────
  server.tool(
    "preview_import",
    "Preview an uploaded CSV/OFX/QFX file (or a local file path if ALLOW_LOCAL_FILE_IMPORT=1). Returns parsed rows + confirmationToken.",
    {
      upload_id: z.string().optional(),
      file_path: z.string().optional().describe("Local absolute path (stdio only, ALLOW_LOCAL_FILE_IMPORT=1)"),
      template_id: z.number().optional(),
      column_mapping: z.record(z.string(), z.string()).optional(),
    },
    async ({ upload_id, file_path, template_id, column_mapping }) => {
      try {
        if (!upload_id && !file_path) return sqliteErr("Provide upload_id or file_path");
        if (file_path && !allowLocalFile) return sqliteErr("Local-file import disabled — set ALLOW_LOCAL_FILE_IMPORT=1");

        let mapping: Record<string, string> | undefined = column_mapping;
        if (template_id !== undefined && !mapping) {
          const tpl = await sqlite.prepare(`SELECT column_mapping FROM import_templates WHERE id = ? AND user_id = ?`).get(template_id, userId) as { column_mapping: string } | undefined;
          if (!tpl) return sqliteErr(`Import template #${template_id} not found`);
          try { mapping = JSON.parse(tpl.column_mapping) as Record<string, string>; }
          catch { return sqliteErr("Import template has invalid column_mapping JSON"); }
        }

        let rows: RawTransaction[] = [];
        let errors: Array<{ row: number; message: string }> = [];
        let format = "csv";

        if (upload_id) {
          const loaded = await loadRowsFromUpload(upload_id, mapping);
          rows = loaded.rows; errors = loaded.errors;
          format = String(loaded.upload.format);
        } else if (file_path) {
          const loaded = await loadRowsFromPath(file_path);
          rows = loaded.rows; errors = loaded.errors;
          format = loaded.format;
        }

        const accounts = await sqlite.prepare(`SELECT id, name, alias FROM accounts WHERE user_id = ?`).all(userId) as Array<{ id: number; name: string; alias: string | null }>;
        const accountByName = new Map<string, number>();
        for (const a of accounts) {
          const nameKey = a.name.toLowerCase().trim();
          accountByName.set(nameKey, a.id);
          if (a.alias) {
            const aliasKey = a.alias.toLowerCase().trim();
            // name wins on collision — don't overwrite.
            if (!accountByName.has(aliasKey)) accountByName.set(aliasKey, a.id);
          }
        }
        const existingHashRows = await sqlite.prepare(`SELECT import_hash FROM transactions WHERE user_id = ? AND import_hash IS NOT NULL`).all(userId) as Array<{ import_hash: string }>;
        const existingHashes = new Set<string>(existingHashRows.map((r) => r.import_hash));

        let dedupHits = 0;
        const unresolvedAccounts = new Set<string>();
        for (const r of rows) {
          const aId = r.account ? accountByName.get(r.account.toLowerCase().trim()) : undefined;
          if (!aId && r.account) unresolvedAccounts.add(r.account);
          if (aId) {
            const h = generateImportHash(r.date, aId, r.amount, r.payee);
            if (existingHashes.has(h)) dedupHits++;
          }
        }

        let categorizedRows = 0;
        for (const r of rows) if (r.category) categorizedRows++;
        // A deeper rules-based pass costs an extra DB read; stdio is hot-path,
        // keep this lightweight.

        if (upload_id) {
          await sqlite.prepare(
            `UPDATE mcp_uploads SET status = 'previewed', row_count = ? WHERE id = ? AND user_id = ?`
          ).run(rows.length, upload_id, userId);
        }

        const tokenPayload = {
          uploadId: upload_id ?? null,
          filePath: file_path ?? null,
          templateId: template_id ?? null,
          columnMapping: mapping ?? null,
        };
        const token = signConfirmationToken(userId, "execute_import", tokenPayload);

        return txt({
          success: true,
          data: {
            uploadId: upload_id ?? null,
            filePath: file_path ?? null,
            format,
            parsedRows: rows.length,
            sampleRows: rows.slice(0, 20),
            parseErrors: errors.slice(0, 20),
            dedupHits,
            categoryCoveragePct: rows.length === 0 ? 0 : Math.round((categorizedRows / rows.length) * 100),
            unresolvedAccounts: Array.from(unresolvedAccounts),
            confirmationToken: token,
          },
        });
      } catch (e) { return sqliteErr(String(e instanceof Error ? e.message : e)); }
    }
  );

  // ── execute_import ─────────────────────────────────────────────────────────
  server.tool(
    "execute_import",
    "Commit an uploaded file (or local file if ALLOW_LOCAL_FILE_IMPORT=1). Requires the token from preview_import.",
    {
      upload_id: z.string().optional(),
      file_path: z.string().optional(),
      confirmation_token: z.string(),
      template_id: z.number().optional(),
      column_mapping: z.record(z.string(), z.string()).optional(),
    },
    async ({ upload_id, file_path, confirmation_token, template_id, column_mapping }) => {
      if (!upload_id && !file_path) return sqliteErr("Provide upload_id or file_path");
      if (file_path && !allowLocalFile) return sqliteErr("Local-file import disabled — set ALLOW_LOCAL_FILE_IMPORT=1");

      const check = verifyConfirmationToken(confirmation_token, userId, "execute_import", {
        uploadId: upload_id ?? null,
        filePath: file_path ?? null,
        templateId: template_id ?? null,
        columnMapping: column_mapping ?? null,
      });
      if (!check.valid) return sqliteErr(`Confirmation token invalid: ${check.reason}. Re-run preview_import.`);

      try {
        let mapping: Record<string, string> | undefined = column_mapping;
        if (template_id !== undefined && !mapping) {
          const tpl = await sqlite.prepare(`SELECT column_mapping FROM import_templates WHERE id = ? AND user_id = ?`).get(template_id, userId) as { column_mapping: string } | undefined;
          if (tpl) { try { mapping = JSON.parse(tpl.column_mapping) as Record<string, string>; } catch { /* ignore */ } }
        }

        let rows: RawTransaction[] = [];
        if (upload_id) rows = (await loadRowsFromUpload(upload_id, mapping)).rows;
        else if (file_path) rows = (await loadRowsFromPath(file_path)).rows;

        // stdio has no DEK — pipelineExecute will store plaintext.
        const result = await pipelineExecute(rows, [], userId);

        if (upload_id) {
          await sqlite.prepare(`UPDATE mcp_uploads SET status = 'executed' WHERE id = ? AND user_id = ?`).run(upload_id, userId);
        }
        invalidateUserTxCache(userId);
        return txt({ success: true, data: result });
      } catch (e) { return sqliteErr(String(e instanceof Error ? e.message : e)); }
    }
  );

  // ── cancel_import ──────────────────────────────────────────────────────────
  server.tool(
    "cancel_import",
    "Cancel a pending MCP upload — marks the row as cancelled and deletes the file.",
    { upload_id: z.string() },
    async ({ upload_id }) => {
      const u = await sqlite.prepare(`SELECT id, storage_path, status FROM mcp_uploads WHERE id = ? AND user_id = ?`).get(upload_id, userId) as { id: string; storage_path: string; status: string } | undefined;
      if (!u) return sqliteErr(`Upload #${upload_id} not found`);
      if (u.status === "executed") return sqliteErr("Upload already executed, cannot cancel");
      try { await fs.unlink(u.storage_path); } catch { /* file already gone */ }
      await sqlite.prepare(`UPDATE mcp_uploads SET status = 'cancelled' WHERE id = ? AND user_id = ?`).run(upload_id, userId);
      return txt({ success: true, data: { uploadId: upload_id, message: "Upload cancelled" } });
    }
  );
}
