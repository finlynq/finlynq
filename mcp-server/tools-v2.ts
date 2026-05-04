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
    "Calculate a financial health score. Stream D Phase 4: stdio cannot decrypt category names (used by the budget-adherence component) — use HTTP MCP at /mcp or the web UI.",
    {},
    async () => mcpError("get_financial_health_score requires an unlocked DEK to decrypt category names after Stream D Phase 4. Stdio MCP cannot decrypt — use the HTTP MCP transport at /mcp or the web UI for this query.")
  );


  server.tool(
    "get_spending_anomalies",
    "Find spending categories with >30% deviation from their 3-month average. Stream D Phase 4: stdio cannot decrypt category names — use HTTP MCP at /mcp or the web UI.",
    {},
    async () => mcpError("get_spending_anomalies requires an unlocked DEK to decrypt category names after Stream D Phase 4. Stdio MCP cannot decrypt — use the HTTP MCP transport at /mcp or the web UI for this query."),
  );

  server.tool(
    "get_subscription_summary",
    "Get all tracked subscriptions with total monthly cost and upcoming renewals. Stream D Phase 4: stdio cannot decrypt subscription/category names — use HTTP MCP at /mcp or the web UI for this query.",
    {},
    async () => mcpError("get_subscription_summary requires an unlocked DEK to decrypt subscriptions/categories names after Stream D Phase 4. Stdio MCP cannot decrypt — use the HTTP MCP transport at /mcp or the web UI for this query."),
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
    "Flexible transaction search. Stream D Phase 4: stdio cannot decrypt account/category names — `account` and `category` (name) filters and the joined name fields are unavailable. Use HTTP MCP at /mcp or the web UI for full search.",
    {
      payee: z.string().optional(),
      min_amount: z.number().optional(),
      max_amount: z.number().optional(),
      start_date: z.string().optional(),
      end_date: z.string().optional(),
      category: z.string().optional(),
      tags: z.string().optional(),
      account_id: z.number().int().optional(),
      portfolio_holding_id: z.number().int().optional(),
      limit: z.number().optional(),
    },
    async () => mcpError("search_transactions requires an unlocked DEK to decrypt account/category names after Stream D Phase 4. Stdio MCP cannot decrypt — use the HTTP MCP transport at /mcp or the web UI for this query."),
  );

  // ---- WRITE TOOLS ----

  server.tool(
    "add_account",
    "Create a new financial account. Stream D Phase 4: stdio cannot create accounts (would require writing the encrypted name siblings). Use HTTP MCP at /mcp or the web UI.",
    {
      name: z.string().describe("Account name (must be unique)"),
      type: z.enum(["A", "L"]).describe("Account type: 'A' for asset, 'L' for liability"),
      group: z.string().optional(),
      currency: z.enum(["CAD", "USD"]).optional(),
      note: z.string().optional(),
    },
    async () => mcpError("add_account requires an unlocked DEK to write the encrypted accounts.name_ct/name_lookup columns after Stream D Phase 4. Stdio MCP cannot encrypt — use the HTTP MCP transport at /mcp or the web UI."),
  );
}
