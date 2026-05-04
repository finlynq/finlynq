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
import { InvestmentHoldingRequiredError } from "../src/lib/investment-account.js";
import fs from "fs/promises";
import {
  csvToRawTransactions,
  csvToRawTransactionsWithMapping,
} from "../src/lib/csv-parser.js";
import { parseOfx } from "../src/lib/ofx-parser.js";
import { previewImport as pipelinePreview, executeImport as pipelineExecute, type RawTransaction } from "../src/lib/import-pipeline.js";
import { generateImportHash } from "../src/lib/import-hash.js";
import {
  detectProbableDuplicates,
  type DuplicateCandidatePool,
  type DuplicateCandidateRow,
  type DuplicateMatch,
} from "../src/lib/external-import/duplicate-detect.js";
import {
  scanForPossibleDuplicates,
  dateBoundsForScan,
  type CommittedInsert,
  type CandidateRow,
} from "../src/lib/mcp/duplicate-hints.js";

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

/**
 * Strict resolver for write operations: same waterfall as `fuzzyFind`, but
 * substring/reverse-substring hits are only accepted when the input and the
 * candidate share a whitespace-separated token of length ≥3. Otherwise the
 * substring fallback would silently route writes to a vaguely-similar account.
 * Reads still use plain `fuzzyFind` — wrong filters are recoverable, wrong
 * writes aren't.
 *
 * Mirrors `resolveAccountStrict` in register-tools-pg.ts; the two transports
 * keep the same behavior so a sloppy account name fails the same way on stdio
 * as it does on HTTP.
 */
type StdioAccountResolveResult =
  | { ok: true; account: SqliteRow; tier: "exact" | "alias" | "startsWith" | "substring" }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "low_confidence"; suggestion: SqliteRow };
function resolveAccountStrict(input: string, options: SqliteRow[]): StdioAccountResolveResult {
  if (!input || !options.length) return { ok: false, reason: "missing" };
  const lo = input.toLowerCase().trim();
  const exact = options.find(o => String(o.name ?? "").toLowerCase() === lo);
  if (exact) return { ok: true, account: exact, tier: "exact" };
  const alias = options.find(o => String(o.alias ?? "").toLowerCase() === lo);
  if (alias) return { ok: true, account: alias, tier: "alias" };
  const starts = options.find(o => {
    const n = String(o.name ?? "").toLowerCase();
    return n !== "" && n.startsWith(lo);
  });
  if (starts) return { ok: true, account: starts, tier: "startsWith" };
  const tokenize = (s: string) =>
    new Set(s.split(/\s+/).map(t => t.replace(/[^a-z0-9]/g, "")).filter(t => t.length >= 3));
  const inputTokens = tokenize(lo);
  const sharesToken = (name: string) => {
    if (!inputTokens.size) return false;
    for (const t of tokenize(name)) if (inputTokens.has(t)) return true;
    return false;
  };
  const sub = options.find(o => {
    const n = String(o.name ?? "").toLowerCase();
    if (n === "") return false;
    if (!n.includes(lo) && !lo.includes(n)) return false;
    return sharesToken(n);
  });
  if (sub) return { ok: true, account: sub, tier: "substring" };
  const legacy =
    options.find(o => String(o.name ?? "").toLowerCase().includes(lo)) ??
    options.find(o => {
      const n = String(o.name ?? "").toLowerCase();
      return n !== "" && lo.includes(n);
    });
  return legacy
    ? { ok: false, reason: "low_confidence", suggestion: legacy }
    : { ok: false, reason: "missing" };
}

/**
 * Strict resolver for category writes — same waterfall as
 * {@link resolveAccountStrict} minus the alias tier (categories have no
 * aliases). Substring/reverse-substring hits gated on a length-≥3
 * whitespace-token overlap so a sloppy "Cr" never silently routes a write
 * to "Credit Interest". Mirrors the HTTP transport's helper so a sloppy
 * category name fails the same way on stdio as it does on HTTP.
 */
type StdioCategoryResolveResult =
  | { ok: true; category: SqliteRow; tier: "exact" | "startsWith" | "substring" }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "low_confidence"; suggestion: SqliteRow };
function resolveCategoryStrict(input: string, options: SqliteRow[]): StdioCategoryResolveResult {
  if (!input || !options.length) return { ok: false, reason: "missing" };
  const lo = input.toLowerCase().trim();
  const exact = options.find(o => String(o.name ?? "").toLowerCase() === lo);
  if (exact) return { ok: true, category: exact, tier: "exact" };
  const starts = options.find(o => {
    const n = String(o.name ?? "").toLowerCase();
    return n !== "" && n.startsWith(lo);
  });
  if (starts) return { ok: true, category: starts, tier: "startsWith" };
  const tokenize = (s: string) =>
    new Set(s.split(/\s+/).map(t => t.replace(/[^a-z0-9]/g, "")).filter(t => t.length >= 3));
  const inputTokens = tokenize(lo);
  const sharesToken = (name: string) => {
    if (!inputTokens.size) return false;
    for (const t of tokenize(name)) if (inputTokens.has(t)) return true;
    return false;
  };
  const sub = options.find(o => {
    const n = String(o.name ?? "").toLowerCase();
    if (n === "") return false;
    if (!n.includes(lo) && !lo.includes(n)) return false;
    return sharesToken(n);
  });
  if (sub) return { ok: true, category: sub, tier: "substring" };
  const legacy =
    options.find(o => String(o.name ?? "").toLowerCase().includes(lo)) ??
    options.find(o => {
      const n = String(o.name ?? "").toLowerCase();
      return n !== "" && lo.includes(n);
    });
  return legacy
    ? { ok: false, reason: "low_confidence", suggestion: legacy }
    : { ok: false, reason: "missing" };
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

/**
 * Stream D Phase 4 refusal helper (2026-05-03).
 *
 * The plaintext display-name columns on accounts/categories/goals/loans/
 * subscriptions/portfolio_holdings were physically dropped. Writes to those
 * tables now require the encrypted `name_ct` + `name_lookup` siblings, which
 * can only be computed inside an authenticated session that holds the user's
 * DEK in cache. The stdio MCP transport has no DEK (no auth on the wire,
 * no session), so it cannot create or rename rows in those six tables.
 *
 * Read paths still work — the data flows through the queries.ts helpers
 * which just return the ciphertext (decryption happens at the HTTP layer).
 * Stdio reads of `name` will surface as `null` in the row payload.
 *
 * Use this helper at the very top of every gated tool's handler.
 */
function streamDRefuse(table: "accounts" | "categories" | "goals" | "loans" | "subscriptions" | "portfolio_holdings") {
  return sqliteErr(
    `Stdio MCP cannot create or update ${table} after Stream D Phase 4. The display name requires a DEK that the stdio transport doesn't carry. Use the HTTP MCP transport instead, or set the row up via the web UI.`,
  );
}

/** Issue #65: shift an ISO YYYY-MM-DD date by N days (UTC-safe). Returns null on parse failure. */
function shiftIsoDate(iso: string, deltaDays: number): string | null {
  const ms = Date.parse(iso + "T00:00:00Z");
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms + deltaDays * 86_400_000);
  return d.toISOString().slice(0, 10);
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
      // Stream D Phase 4 — stdio cannot create goals.
      void name; void type; void target_amount; void deadline; void account;
      return streamDRefuse("goals");
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
      // Issue #28: stdio MCP UPDATE bumps updated_at like every other UPDATE.
      // pg-compat shim resolves NOW() to PG, no SQLite branch needed here.
      const updateStmt = sqlite.prepare(
        `UPDATE transactions SET category_id = ?, tags = CASE WHEN ? IS NOT NULL THEN ? ELSE tags END,
         payee = CASE WHEN ? IS NOT NULL THEN ? ELSE payee END,
         updated_at = NOW() WHERE id = ? AND user_id = ?`
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
    "Record a transaction. Prefer `account_id` (exact, no ambiguity) over `account` name; pass at least one. When only `account` is given, exact/alias/startsWith hits route immediately and weak substring fallbacks are REJECTED with a 'did you mean…' error rather than silently writing to the wrong account. Category auto-detected from payee rules/history when omitted. For cross-currency entries pass enteredAmount + enteredCurrency; the server locks the FX rate at the date. Pass `dryRun: true` to validate + resolve without writing — the response shape includes `dryRun: true`, `wouldBeId: null`, and the same resolved* fields a real write returns.",
    {
      amount: z.number().describe("Amount in account currency (negative=expense, positive=income). Use this for same-currency entries."),
      payee: z.string().describe("Payee or merchant name"),
      account: z.string().optional().describe("Account name or alias — fuzzy matched against name, exact on alias. PREFER `account_id` when known; this name path rejects low-confidence matches rather than guessing. Required if `account_id` is not provided."),
      account_id: z.number().int().optional().describe("Account FK (accounts.id). Skips fuzzy matching entirely; always routes to the exact account. Recommended when known. If both this and `account` are passed, this wins."),
      date: z.string().optional().describe("YYYY-MM-DD (default: today)"),
      category: z.string().optional().describe("Category name (auto-detected from payee if omitted)"),
      note: z.string().optional(),
      tags: z.string().optional().describe("Comma-separated tags"),
      enteredAmount: z.number().optional().describe("User-typed amount in enteredCurrency."),
      enteredCurrency: z.string().optional().describe("ISO code (USD/CAD/...) of enteredAmount; defaults to account currency."),
      dryRun: z.boolean().optional().describe("When true, run the full validation/resolution pipeline (account, FX, category) and return a preview WITHOUT writing to the DB. Response carries `dryRun: true`, `wouldBeId: null`, plus the resolved* fields."),
    },
    async ({ amount, payee, date, account, account_id, category, note, tags, enteredAmount, enteredCurrency, dryRun }) => {
      const today = new Date().toISOString().split("T")[0];
      const txDate = date ?? today;

      const allAccounts = await sqlite.prepare(`SELECT id, name, alias, currency, is_investment FROM accounts WHERE user_id = ?`).all(userId) as SqliteRow[];
      if (!allAccounts.length) return sqliteErr("No accounts found — create an account first.");
      let acct: SqliteRow | null = null;
      if (account_id != null) {
        acct = allAccounts.find(a => Number(a.id) === account_id) ?? null;
        if (!acct) return sqliteErr(`Account #${account_id} not found or not owned by you.`);
      } else {
        if (!account) return sqliteErr("Pass either `account_id` or `account` (name/alias).");
        const r = resolveAccountStrict(account, allAccounts);
        if (!r.ok) {
          const list = allAccounts.map(a => `"${a.name}" (id=${Number(a.id)})`).join(", ");
          if (r.reason === "low_confidence") {
            return sqliteErr(`Account "${account}" did not match strongly — closest is "${r.suggestion.name}" (id=${Number(r.suggestion.id)}) but no shared whitespace token. Re-call with account_id=${Number(r.suggestion.id)} if that's right, or pick another from: ${list}`);
          }
          return sqliteErr(`Account "${account}" not found. Available: ${list}`);
        }
        acct = r.account;
      }

      // Investment-account constraint: stdio MCP record_transaction has no
      // portfolio-holding parameter, so it can't satisfy the FK requirement.
      // Refuse with a pointer to the HTTP MCP / web UI rather than silently
      // writing a row that the aggregator can't attribute. Stdio MCP is a
      // self-hosted-only path; the HTTP MCP at /mcp does support holdings.
      if (acct.is_investment) {
        return sqliteErr(`Account "${acct.name}" is an investment account — record_transaction over stdio MCP can't bind to a portfolio holding. Use the HTTP MCP at /mcp (record_transaction has portfolioHolding/portfolioHoldingId there) or the web app to record transactions in this account.`);
      }

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

      // Resolve category name once — used by both dry-run preview and the
      // success message. The lookup below skips when catId is null.
      const catName = catId ? (await sqlite.prepare(`SELECT name FROM categories WHERE user_id = ? AND id = ?`).get(userId, catId) as { name: string } | undefined)?.name ?? "uncategorized" : "uncategorized";
      const resolvedAccountInfo = { id: Number(acct.id), name: String(acct.name ?? "") };
      const resolvedCategory = catId ? { id: Number(catId), name: String(catName ?? "") } : null;

      if (dryRun) {
        // Validation + resolution complete; no DB write, no cache invalidation.
        return txt({
          success: true,
          dryRun: true,
          wouldBeId: null,
          resolvedAccount: resolvedAccountInfo,
          resolvedCategory,
          amount: resolved.amount,
          currency: resolved.currency,
          enteredAmount: resolved.enteredAmount,
          enteredCurrency: resolved.enteredCurrency,
          enteredFxRate: resolved.enteredFxRate,
          date: txDate,
          message: `Dry run OK — would record: ${resolved.amount > 0 ? "+" : ""}${resolved.amount} ${resolved.currency} on ${txDate} — "${payee}" → ${acct.name} (${catName})`,
        });
      }

      // Issue #28: stamp source explicitly + return audit timestamps.
      const result = await sqlite.prepare(
        `INSERT INTO transactions (user_id, date, account_id, category_id, currency, amount, entered_currency, entered_amount, entered_fx_rate, payee, note, tags, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, created_at, updated_at, source`
      ).get(userId, txDate, acct.id, catId, resolved.currency, resolved.amount, resolved.enteredCurrency, resolved.enteredAmount, resolved.enteredFxRate, payee, note ?? "", tags ?? "", "mcp_stdio") as { id: number; created_at?: string; updated_at?: string; source?: string };

      invalidateUserTxCache(userId);
      return txt({
        success: true,
        transactionId: result?.id,
        createdAt: result?.created_at,
        updatedAt: result?.updated_at,
        source: result?.source,
        resolvedAccount: resolvedAccountInfo,
        resolvedCategory,
        message: `Recorded: ${resolved.amount > 0 ? "+" : ""}${resolved.amount} ${resolved.currency} on ${txDate} — "${payee}" → ${acct.name} (${catName})`,
      });
    }
  );

  // ── bulk_record_transactions ───────────────────────────────────────────────
  server.tool(
    "bulk_record_transactions",
    "Record multiple transactions at once. Prefer per-row `account_id` (or top-level `account_id` as a fallback for every row that omits its own) over `account` name — exact ids skip fuzzy matching. When only `account` is given, exact/alias/startsWith hits route immediately and weak substring fallbacks fail that row with a 'did you mean…' message rather than silently writing to the wrong account. Category auto-detected when omitted. For cross-currency rows pass enteredAmount + enteredCurrency. Each per-row result includes `resolvedAccount` so callers can verify routing immediately. Pass top-level `dryRun: true` to validate + resolve every row without writing — each per-row result then carries `dryRun: true` and `wouldBeId: null` alongside the same resolved* fields a real write returns. Pass top-level `idempotencyKey` (UUID v4) to make this batch safe to retry — if the same `(user, key)` was already committed within 72h, the original result is returned verbatim with no INSERTs (set per-call: callers should generate one fresh UUID per logical batch). After a successful (non-dryRun) batch the response includes a top-level `possibleDuplicates` array — hints only, never blocks the insert — flagging newly-inserted rows that look suspiciously like an existing row in the same account (same direction, amount within 5%, dates within 7 days). Empty array when nothing matches; never null.",
    {
      account_id: z.number().int().optional().describe("Top-level account FK applied to every row that omits its own `account_id` and `account`. Convenient when bulk-importing one account's statement."),
      dryRun: z.boolean().optional().describe("When true, run the full per-row validation/resolution pipeline but skip every INSERT. Per-row results carry `dryRun: true`, `wouldBeId: null`, plus `resolvedAccount`/`resolvedCategory`."),
      idempotencyKey: z.string().uuid().optional().describe("Optional UUID v4 the caller mints once per batch. First call with `(user, key)` writes the rows AND stashes the response JSON; any retry within 72h returns the stored response verbatim with no INSERTs and no cache invalidation. Skipped on `dryRun: true` and skipped when zero rows commit."),
      transactions: z.array(z.object({
        amount: z.number(),
        payee: z.string(),
        account: z.string().optional().describe("Account name or alias — fuzzy matched against name, exact on alias. PREFER `account_id`. Required if neither row-level `account_id` nor top-level `account_id` is set."),
        account_id: z.number().int().optional().describe("Per-row account FK (accounts.id). Skips fuzzy matching; routes to the exact account. Wins over both `account` and the top-level `account_id`."),
        date: z.string().optional(),
        category: z.string().optional(),
        note: z.string().optional(),
        tags: z.string().optional(),
        enteredAmount: z.number().optional(),
        enteredCurrency: z.string().optional(),
      })).describe("Array of transactions to record"),
    },
    async ({ transactions, account_id: defaultAccountId, dryRun, idempotencyKey }) => {
      const today = new Date().toISOString().split("T")[0];

      // Idempotency replay (issue #98). Lookup BEFORE prefetching accounts /
      // categories so a hit returns immediately. Stdio uses the pg-compat
      // shim — `?::uuid` casting works correctly. dryRun=true skips replay
      // and skips storage so a preview never blocks a future real submit.
      if (idempotencyKey && !dryRun) {
        try {
          const hit = (await sqlite
            .prepare(
              `SELECT response_json FROM mcp_idempotency_keys WHERE user_id = ? AND key = ?::uuid AND tool_name = 'bulk_record_transactions' AND created_at > NOW() - INTERVAL '72 hours' LIMIT 1`,
            )
            .get(userId, idempotencyKey)) as SqliteRow | undefined;
          if (hit && hit.response_json != null) {
            const replay =
              typeof hit.response_json === "string"
                ? JSON.parse(hit.response_json)
                : hit.response_json;
            return txt({ ...replay, replayed: true });
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn("[bulk_record_transactions] idempotency lookup failed:", e);
        }
      }

      const allAccounts = await sqlite.prepare(`SELECT id, name, alias, currency, is_investment FROM accounts WHERE user_id = ?`).all(userId) as SqliteRow[];
      const allCats = await sqlite.prepare(`SELECT id, name FROM categories WHERE user_id = ?`).all(userId) as SqliteRow[];
      const catNameById = new Map<number, string>(allCats.map(c => [Number(c.id), String(c.name ?? "")]));
      // Issue #28: stamp source explicitly so stdio-MCP rows are
      // distinguishable from HTTP-MCP and UI rows in the audit column.
      // Issue #90: RETURNING id so the post-loop scan can collect
      // committed rows for duplicate-hint surfacing.
      const stmt = sqlite.prepare(`INSERT INTO transactions (user_id, date, account_id, category_id, currency, amount, entered_currency, entered_amount, entered_fx_rate, payee, note, tags, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`);

      const accountById = new Map<number, SqliteRow>();
      for (const a of allAccounts) accountById.set(Number(a.id), a);
      let defaultAcct: SqliteRow | null = null;
      let defaultAcctError: string | null = null;
      if (defaultAccountId != null) {
        defaultAcct = accountById.get(defaultAccountId) ?? null;
        if (!defaultAcct) defaultAcctError = `Top-level account_id #${defaultAccountId} not found or not owned by you.`;
      }

      const results: {
        index: number;
        success: boolean;
        message: string;
        resolvedAccount?: { id: number; name: string };
        resolvedCategory?: { id: number; name: string } | null;
        dryRun?: boolean;
        wouldBeId?: null;
      }[] = [];
      // Issue #90 — capture every committed row so the post-loop scan can
      // surface possible-duplicate hints. Stdio writes are plaintext per
      // the load-bearing rule, so no decrypt is needed for the candidate
      // pool either.
      const committed: CommittedInsert[] = [];
      for (let i = 0; i < transactions.length; i++) {
        const t = transactions[i];
        try {
          // Resolve account: per-row id > top-level id > strict fuzzy on name.
          let acct: SqliteRow | null = null;
          if (t.account_id != null) {
            acct = accountById.get(t.account_id) ?? null;
            if (!acct) {
              results.push({ index: i, success: false, message: `Account #${t.account_id} not found or not owned by you.` });
              continue;
            }
          } else if (t.account) {
            const r = resolveAccountStrict(t.account, allAccounts);
            if (!r.ok) {
              const list = allAccounts.map(a => `"${a.name}" (id=${Number(a.id)})`).join(", ");
              if (r.reason === "low_confidence") {
                results.push({ index: i, success: false, message: `Account "${t.account}" did not match strongly — closest is "${r.suggestion.name}" (id=${Number(r.suggestion.id)}) but no shared whitespace token. Re-submit with account_id=${Number(r.suggestion.id)} if that's right, or pick another from: ${list}` });
              } else {
                results.push({ index: i, success: false, message: `Account not found: "${t.account}". Available: ${list}` });
              }
              continue;
            }
            acct = r.account;
          } else if (defaultAcct) {
            acct = defaultAcct;
          } else if (defaultAcctError) {
            results.push({ index: i, success: false, message: defaultAcctError });
            continue;
          } else {
            results.push({ index: i, success: false, message: "Pass either a per-row `account_id`/`account`, or a top-level `account_id`." });
            continue;
          }
          const resolvedAccountInfo = { id: Number(acct.id), name: String(acct.name ?? "") };
          // Investment-account constraint — stdio MCP can't bind holdings,
          // so investment-account rows fail individually. See the same
          // check in record_transaction for rationale.
          if (acct.is_investment) {
            results.push({ index: i, success: false, message: `Account "${acct.name}" is an investment account — stdio MCP can't bind portfolio holdings. Use the HTTP MCP at /mcp or the web app for this account.`, resolvedAccount: resolvedAccountInfo });
            continue;
          }
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
            results.push({ index: i, success: false, message: resolved.message, resolvedAccount: resolvedAccountInfo });
            continue;
          }

          const rowCategory = catId != null ? { id: Number(catId), name: catNameById.get(Number(catId)) ?? "" } : null;

          if (dryRun) {
            results.push({
              index: i,
              success: true,
              dryRun: true,
              wouldBeId: null,
              message: `Dry run OK — would record ${t.payee}: ${resolved.amount} ${resolved.currency}`,
              resolvedAccount: resolvedAccountInfo,
              resolvedCategory: rowCategory,
            });
            continue;
          }

          // The pg-compat shim's `run()` exposes `lastInsertRowid` from
          // RETURNING id, so this stays a simple drop-in even though
          // sqlite-style stmts don't natively return ids.
          const runRes = await stmt.run(userId, txDate, acct.id, catId, resolved.currency, resolved.amount, resolved.enteredCurrency, resolved.enteredAmount, resolved.enteredFxRate, t.payee, t.note ?? "", t.tags ?? "", "mcp_stdio");
          const newTxId = runRes && typeof runRes.lastInsertRowid === "number" ? runRes.lastInsertRowid : null;
          if (newTxId != null && newTxId > 0) {
            committed.push({
              newTransactionId: newTxId,
              accountId: Number(acct.id),
              date: txDate,
              amount: resolved.amount,
              payee: t.payee,
            });
          }
          results.push({ index: i, success: true, message: `${t.payee}: ${resolved.amount} ${resolved.currency}`, resolvedAccount: resolvedAccountInfo, resolvedCategory: rowCategory });
        } catch (e) {
          results.push({ index: i, success: false, message: String(e) });
        }
      }
      const ok = results.filter(r => r.success).length;
      // Skip cache invalidation on dry-run — no rows touched.
      if (!dryRun && ok > 0) invalidateUserTxCache(userId);

      // Issue #90 — post-insert duplicate-hint scan. HINTS ONLY: never
      // blocks any row. Skipped for dry-run. One indexed query bounded by
      // [globalMinDate-7d, globalMaxDate+7d] across affected accounts;
      // per-row band check happens in JS via the shared helper. Stdio
      // writes are plaintext (no DEK on this transport), so no decrypt
      // step here — payee strings come straight out of the column.
      let possibleDuplicates: ReturnType<typeof scanForPossibleDuplicates> = [];
      if (!dryRun && committed.length > 0) {
        try {
          const bounds = dateBoundsForScan(committed);
          if (bounds) {
            const accountIds = Array.from(new Set(committed.map(c => c.accountId)));
            const newTxIds = new Set<number>(committed.map(c => c.newTransactionId));
            // Use a parameterised IN list — pg-compat shim translates `?`
            // to `$N` so build placeholders dynamically.
            const accPlaceholders = accountIds.map(() => "?").join(",");
            const poolRows = (await sqlite
              .prepare(
                `SELECT id, account_id, date, amount, payee FROM transactions WHERE user_id = ? AND account_id IN (${accPlaceholders}) AND date BETWEEN ? AND ?`,
              )
              .all(userId, ...accountIds, bounds.minDate, bounds.maxDate)) as SqliteRow[];
            const candidates: CandidateRow[] = [];
            for (const r of poolRows) {
              const id = Number(r.id);
              if (newTxIds.has(id)) continue;
              candidates.push({
                id,
                accountId: Number(r.account_id),
                date: String(r.date ?? ""),
                amount: Number(r.amount),
                payee: String(r.payee ?? ""),
              });
            }
            possibleDuplicates = scanForPossibleDuplicates(committed, candidates);
          }
        } catch (e) {
          // Scan must never fail the response.
          // eslint-disable-next-line no-console
          console.warn("[bulk_record_transactions] duplicate-hint scan failed:", e);
          possibleDuplicates = [];
        }
      }

      const responseBody = {
        ...(dryRun ? { dryRun: true } : {}),
        imported: dryRun ? 0 : ok,
        failed: results.length - ok,
        ...(dryRun ? { previewed: ok } : {}),
        results,
        possibleDuplicates,
      };

      // Issue #98 — persist redacted response under the caller-supplied
      // idempotency key. Same rules as the HTTP path: skip on dryRun, skip
      // on ok===0. Stdio writes are plaintext anyway (no DEK on this
      // transport), but the same redaction policy applies on the at-rest
      // response_json so the table contract is identical between transports.
      if (idempotencyKey && !dryRun && ok > 0) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const redactedResults = (responseBody.results as any[]).map((r) => {
            const out = { ...r };
            if (typeof out.message === "string") {
              out.message = `row #${out.index}: redacted on replay`;
            }
            if (out.resolvedAccount && typeof out.resolvedAccount === "object") {
              out.resolvedAccount = { id: out.resolvedAccount.id, name: "[redacted]" };
            }
            if (out.resolvedCategory && typeof out.resolvedCategory === "object") {
              out.resolvedCategory = { id: out.resolvedCategory.id, name: "[redacted]" };
            }
            return out;
          });
          const redactedBody = { ...responseBody, results: redactedResults };
          await sqlite
            .prepare(
              `INSERT INTO mcp_idempotency_keys (user_id, key, tool_name, response_json) VALUES (?, ?::uuid, 'bulk_record_transactions', ?::jsonb) ON CONFLICT (user_id, key) DO NOTHING`,
            )
            .run(userId, idempotencyKey, JSON.stringify(redactedBody));
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn("[bulk_record_transactions] idempotency persist failed:", e);
        }
      }

      return txt(responseBody);
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

      // Issue #60: strict resolver — substring matches gated on token
      // overlap so a sloppy "Cr" can't silently route a write to
      // "Credit Interest". Stdio writes are plaintext (no DEK), so no
      // decrypt step here.
      let catId: number | undefined;
      let resolvedCategory: { id: number; name: string } | null = null;
      if (category !== undefined) {
        const allCats = await sqlite.prepare(`SELECT id, name FROM categories WHERE user_id = ?`).all(userId) as SqliteRow[];
        const resolved = resolveCategoryStrict(category, allCats);
        if (!resolved.ok) {
          if (resolved.reason === "low_confidence") {
            return sqliteErr(`Category "${category}" did not match strongly — did you mean "${resolved.suggestion.name}" (id=${Number(resolved.suggestion.id)})? Re-call with the exact name to confirm.`);
          }
          const list = allCats.map(c => `"${c.name}" (id=${Number(c.id)})`).join(", ");
          return sqliteErr(`Category "${category}" not found. Available: ${list}`);
        }
        catId = Number(resolved.category.id);
        resolvedCategory = { id: catId, name: String(resolved.category.name ?? "") };
      }

      // Issue #60: track explicit column names instead of a count so the AI
      // assistant can verify the exact write. Mirrors the HTTP transport.
      const fieldsUpdated: string[] = [];
      const updates: string[] = [];
      const params: unknown[] = [];
      if (date !== undefined) {
        updates.push("date = ?");
        params.push(date);
        fieldsUpdated.push("date");
      }
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
        fieldsUpdated.push("amount", "currency", "entered_amount", "entered_currency", "entered_fx_rate");
      } else if (amount !== undefined) {
        updates.push("amount = ?");
        params.push(amount);
        fieldsUpdated.push("amount");
      }
      if (payee !== undefined) {
        updates.push("payee = ?");
        params.push(payee);
        fieldsUpdated.push("payee");
      }
      if (catId !== undefined) {
        updates.push("category_id = ?");
        params.push(catId);
        fieldsUpdated.push("category_id");
      }
      if (note !== undefined) {
        updates.push("note = ?");
        params.push(note);
        fieldsUpdated.push("note");
      }
      if (tags !== undefined) {
        updates.push("tags = ?");
        params.push(tags);
        fieldsUpdated.push("tags");
      }
      if (!updates.length) return sqliteErr("No fields to update");

      // Issue #28: every UPDATE bumps updated_at. Always appended — `source`
      // stays untouched (INSERT-only).
      updates.push("updated_at = NOW()");

      params.push(id, userId);
      await sqlite.prepare(`UPDATE transactions SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`).run(...params);
      invalidateUserTxCache(userId);
      // Issue #28: re-read the audit timestamp so the AI assistant can
      // verify the write landed.
      const after = await sqlite.prepare(`SELECT updated_at FROM transactions WHERE id = ? AND user_id = ?`).get(id, userId) as { updated_at?: string } | undefined;
      return txt({
        success: true,
        message: `Transaction #${id} updated`,
        fieldsUpdated,
        ...(resolvedCategory ? { resolvedCategory } : {}),
        updatedAt: after?.updated_at,
      });
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
    "Record a transfer between two of the user's accounts. Creates BOTH legs atomically with a shared link_id. PREFER `from_account_id` / `to_account_id` (exact, no ambiguity) over names; weak substring matches on the name path are REJECTED with a 'did you mean…' error rather than silently routing the pair to the wrong account. Auto-creates a Transfer category (type='R') if missing. For cross-currency transfers pass `receivedAmount` to lock the bank's landed amount. For in-kind (share) transfers between brokerage accounts, pass `holding` + `quantity`; BOTH the source and destination holdings MUST already exist in their respective accounts. Investment accounts require a cash holding for the transaction currency — if one is missing, call `add_portfolio_holding` first. `amount` may be 0 for pure in-kind moves. For brokerage stock/ETF/crypto buys and sells (cash sleeve ↔ symbol holding inside one brokerage account), prefer `record_trade` — it handles the same-account in-kind dance automatically.",
    {
      fromAccount: z.string().optional().describe("Source account name or alias. PREFER `from_account_id` when known; this name path rejects low-confidence matches rather than guessing. Required if `from_account_id` is not provided."),
      toAccount: z.string().optional().describe("Destination account name or alias. Same as fromAccount is allowed for intra-account in-kind rebalances (e.g. cash sleeve ↔ symbol holding, or a different-currency cash sleeve) when `holding` and `destHolding` are also set; same-account cash-only transfers are rejected. PREFER `to_account_id` when known. Required if `to_account_id` is not provided."),
      from_account_id: z.number().int().optional().describe("Source account FK (accounts.id). Skips fuzzy matching. If both this and `fromAccount` are passed, this wins."),
      to_account_id: z.number().int().optional().describe("Destination account FK (accounts.id). Skips fuzzy matching. If both this and `toAccount` are passed, this wins."),
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
    async ({ fromAccount, toAccount, from_account_id, to_account_id, amount, date, receivedAmount, holding, destHolding, quantity, destQuantity, note, tags }) => {
      const allAccounts = await sqlite.prepare(`SELECT id, name, alias, currency FROM accounts WHERE user_id = ?`).all(userId) as SqliteRow[];
      if (!allAccounts.length) return sqliteErr("No accounts found — create accounts first.");
      const list = allAccounts.map(a => `"${a.name}" (id=${Number(a.id)})`).join(", ");
      let fromAcct: SqliteRow | null = null;
      if (from_account_id != null) {
        fromAcct = allAccounts.find(a => Number(a.id) === from_account_id) ?? null;
        if (!fromAcct) return sqliteErr(`Source account #${from_account_id} not found or not owned by you.`);
      } else {
        if (!fromAccount) return sqliteErr("Pass either `from_account_id` or `fromAccount` (name/alias).");
        const r = resolveAccountStrict(fromAccount, allAccounts);
        if (!r.ok) {
          if (r.reason === "low_confidence") {
            return sqliteErr(`Source account "${fromAccount}" did not match strongly — closest is "${r.suggestion.name}" (id=${Number(r.suggestion.id)}) but no shared whitespace token. Re-call with from_account_id=${Number(r.suggestion.id)} if that's right, or pick another from: ${list}`);
          }
          return sqliteErr(`Source account "${fromAccount}" not found. Available: ${list}`);
        }
        fromAcct = r.account;
      }
      let toAcct: SqliteRow | null = null;
      if (to_account_id != null) {
        toAcct = allAccounts.find(a => Number(a.id) === to_account_id) ?? null;
        if (!toAcct) return sqliteErr(`Destination account #${to_account_id} not found or not owned by you.`);
      } else {
        if (!toAccount) return sqliteErr("Pass either `to_account_id` or `toAccount` (name/alias).");
        const r = resolveAccountStrict(toAccount, allAccounts);
        if (!r.ok) {
          if (r.reason === "low_confidence") {
            return sqliteErr(`Destination account "${toAccount}" did not match strongly — closest is "${r.suggestion.name}" (id=${Number(r.suggestion.id)}) but no shared whitespace token. Re-call with to_account_id=${Number(r.suggestion.id)} if that's right, or pick another from: ${list}`);
          }
          return sqliteErr(`Destination account "${toAccount}" not found. Available: ${list}`);
        }
        toAcct = r.account;
      }

      const { createTransferPairViaSql } = await import("../src/lib/transfer.js");
      let result: Awaited<ReturnType<typeof createTransferPairViaSql>>;
      try {
        result = await createTransferPairViaSql(sqlite.pool, userId, null, {
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
          // Issue #28: MCP stdio transport.
          txSource: "mcp_stdio",
        });
      } catch (e) {
        // Strict-mode investment-account guard (issue #22). Stdio exposes a
        // `holding` parameter so the user can satisfy the constraint by
        // re-calling with `holding: "Cash"`. Map the throw to a friendly
        // tool error rather than crashing the stdio process.
        if (e instanceof InvestmentHoldingRequiredError) return sqliteErr(e.message);
        throw e;
      }
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
        resolvedFromAccount: { id: Number(fromAcct.id), name: String(fromAcct.name ?? "") },
        resolvedToAccount: { id: Number(toAcct.id), name: String(toAcct.name ?? "") },
        ...(result.holding ? { holding: result.holding } : {}),
        message: result.isCrossCurrency
          ? `Transferred ${amount} ${result.fromCurrency} from ${fromAcct.name} to ${toAcct.name} — landed as ${result.toAmount} ${result.toCurrency} (rate ${result.enteredFxRate.toFixed(6)})${inKindNote}`
          : `Transferred ${amount} ${result.fromCurrency} from ${fromAcct.name} to ${toAcct.name}${inKindNote}`,
      });
    }
  );

  // ── record_trade ───────────────────────────────────────────────────────────
  // Mirror of the HTTP MCP tool. Stdio writes are plaintext (no DEK in this
  // transport — see CLAUDE.md "Stdio MCP writes are plaintext"), so the cash
  // sleeve / symbol holding insert paths skip the *_ct columns and rely on
  // the next-login Stream D backfill to fill them in.
  server.tool(
    "record_trade",
    "Record a stock/ETF/crypto buy or sell in a brokerage account. Wraps record_transfer with the right same-account in-kind dance so the symbol holding's share count + cost basis flow through the portfolio aggregator. BUY: source=cash sleeve in `currency`, destination=symbol holding (must already exist — call `add_portfolio_holding` first if missing). SELL: mirror — source=symbol holding (must already exist), destination=cash sleeve (must already exist for the trade currency — call `add_portfolio_holding` first if missing). Cross-currency trades require `fxRate` (trade_currency → account_currency); the cash sleeve for the trade currency is auto-managed on first use within record_trade itself. Optional `fees` post as a separate negative cash transaction on the cash sleeve. PREFER `account_id` over `account` name; weak substring matches on the name path are REJECTED with a 'did you mean…' error rather than silently routing the trade to the wrong account.",
    {
      account: z.string().optional().describe("Brokerage account name or alias. PREFER `account_id` when known; this name path rejects low-confidence matches rather than guessing. Required if `account_id` is not provided."),
      account_id: z.number().int().optional().describe("Account FK (accounts.id). Skips fuzzy matching."),
      side: z.enum(["buy", "sell"]).describe("'buy' (cash → symbol) or 'sell' (symbol → cash)."),
      symbol: z.string().min(1).max(50).describe("Ticker symbol of the security being traded."),
      quantity: z.number().positive().describe("Share count (always positive)."),
      price: z.number().positive().describe("Per-share price in `currency`."),
      currency: z.string().optional().describe("ISO code (USD/CAD/...) of the trade. Defaults to account currency."),
      fees: z.number().nonnegative().optional().describe("Optional commission/fees in `currency`. Booked as a separate negative-amount cash transaction."),
      fxRate: z.number().positive().optional().describe("Trade-currency → account-currency rate. REQUIRED when currency differs from account currency."),
      date: z.string().optional().describe("Trade/settlement date YYYY-MM-DD (default: today)."),
      note: z.string().optional(),
    },
    async ({ account, account_id, side, symbol, quantity, price, currency, fees, fxRate, date, note }) => {
      const txDate = date ?? new Date().toISOString().split("T")[0];
      const trimmedSymbol = symbol.trim();
      if (!trimmedSymbol) return sqliteErr("symbol cannot be empty");

      const allAccounts = await sqlite.prepare(
        `SELECT id, name, alias, currency, is_investment FROM accounts WHERE user_id = ?`
      ).all(userId) as SqliteRow[];
      if (!allAccounts.length) return sqliteErr("No accounts found — create accounts first.");
      let acct: SqliteRow | null = null;
      if (account_id != null) {
        acct = allAccounts.find(a => Number(a.id) === account_id) ?? null;
        if (!acct) return sqliteErr(`Account #${account_id} not found or not owned by you.`);
      } else {
        if (!account) return sqliteErr("Pass either `account_id` or `account` (name/alias).");
        const r = resolveAccountStrict(account, allAccounts);
        if (!r.ok) {
          const list = allAccounts.map(a => `"${a.name}" (id=${Number(a.id)})`).join(", ");
          if (r.reason === "low_confidence") {
            return sqliteErr(`Account "${account}" did not match strongly — closest is "${r.suggestion.name}" (id=${Number(r.suggestion.id)}) but no shared whitespace token. Re-call with account_id=${Number(r.suggestion.id)} if that's right, or pick another from: ${list}`);
          }
          return sqliteErr(`Account "${account}" not found. Available: ${list}`);
        }
        acct = r.account;
      }

      if (!acct.is_investment) {
        return sqliteErr(`Account "${acct.name}" is not an investment account — toggle is_investment first or use record_transaction for non-trade entries.`);
      }

      const acctCurrency = String(acct.currency ?? "CAD").toUpperCase();
      const tradeCurrency = (currency ?? acctCurrency).toUpperCase();
      const isCrossCurrency = tradeCurrency !== acctCurrency;
      let fx = 1;
      if (isCrossCurrency) {
        if (fxRate == null) {
          return sqliteErr(`Trade currency ${tradeCurrency} differs from account currency ${acctCurrency} — pass fxRate (${tradeCurrency}→${acctCurrency}) so the cost-basis side can be locked.`);
        }
        fx = fxRate;
      }

      const cashAmountTrade = Math.round(quantity * price * 100) / 100;
      const cashAmountAcct = Math.round(cashAmountTrade * fx * 100) / 100;

      // Find or create the cash sleeve in tradeCurrency. Stdio runs dek-less,
      // so name_ct / name_lookup stay NULL (filled by next-login backfill).
      const cashName = isCrossCurrency ? `${tradeCurrency} Cash` : "Cash";
      const cashCandidate = await sqlite.prepare(
        `SELECT id, name FROM portfolio_holdings
          WHERE user_id = ? AND account_id = ? AND currency = ?
            AND (symbol IS NULL OR UPPER(symbol) = ?)
          ORDER BY (symbol IS NULL) DESC, id ASC
          LIMIT 1`
      ).get(userId, acct.id, tradeCurrency, tradeCurrency) as { id: number; name: string } | undefined;
      let cashHoldingId: number;
      let cashHoldingName: string;
      if (cashCandidate) {
        cashHoldingId = Number(cashCandidate.id);
        cashHoldingName = String(cashCandidate.name ?? cashName);
      } else {
        const cashSymbol = isCrossCurrency ? tradeCurrency : null;
        const ins = await sqlite.prepare(
          `INSERT INTO portfolio_holdings (user_id, account_id, name, symbol, currency, is_crypto, note)
           VALUES (?, ?, ?, ?, ?, 0, 'auto-created for cash sleeve')
           RETURNING id, name`
        ).get(userId, acct.id, cashName, cashSymbol, tradeCurrency) as { id: number; name: string } | undefined;
        cashHoldingId = Number(ins?.id);
        cashHoldingName = String(ins?.name ?? cashName);
      }

      // For SELL the symbol holding must already exist — pre-flight rather
      // than relying on the createTransferPair message.
      if (side === "sell") {
        const sym = await sqlite.prepare(
          `SELECT id FROM portfolio_holdings
            WHERE user_id = ? AND account_id = ?
              AND (LOWER(name) = LOWER(?) OR LOWER(symbol) = LOWER(?))
            LIMIT 1`
        ).get(userId, acct.id, trimmedSymbol, trimmedSymbol);
        if (!sym) return sqliteErr(`Cannot sell "${trimmedSymbol}" in "${acct.name}" — no existing position. Use add_portfolio_holding first if you need to record an opening position.`);
      }

      const tradePayee = `${side === "buy" ? "Buy" : "Sell"} ${quantity} ${trimmedSymbol} @ ${price.toFixed(2)} ${tradeCurrency}`;
      const sourceHolding = side === "buy" ? cashHoldingName : trimmedSymbol;
      const destHolding = side === "buy" ? trimmedSymbol : cashHoldingName;
      const sourceQty = side === "buy" ? cashAmountTrade : quantity;
      const destQty = side === "buy" ? quantity : cashAmountTrade;

      const { createTransferPairViaSql } = await import("../src/lib/transfer.js");
      let transferResult: Awaited<ReturnType<typeof createTransferPairViaSql>>;
      try {
        transferResult = await createTransferPairViaSql(sqlite.pool, userId, null, {
          fromAccountId: Number(acct.id),
          toAccountId: Number(acct.id),
          enteredAmount: cashAmountAcct,
          date: txDate,
          holdingName: sourceHolding,
          destHoldingName: destHolding,
          quantity: sourceQty,
          destQuantity: destQty,
          note: note ?? tradePayee,
          tags: "source:record_trade",
          // Issue #28: MCP stdio transport.
          txSource: "mcp_stdio",
        });
      } catch (e) {
        // record_trade always supplies sourceHolding + destHolding, so the
        // strict-mode guard shouldn't fire. Defensive map in case a future
        // refactor removes one of those.
        if (e instanceof InvestmentHoldingRequiredError) return sqliteErr(e.message);
        throw e;
      }
      if (!transferResult.ok) return sqliteErr(transferResult.message);

      let feeTxId: number | null = null;
      const feeAmountTrade = fees != null && fees > 0 ? Math.round(fees * 100) / 100 : 0;
      if (feeAmountTrade > 0) {
        const feeAmountAcct = Math.round(feeAmountTrade * fx * 100) / 100;
        const feePayee = `Trade fee — ${trimmedSymbol}`;
        // Issue #28: stamp source explicitly. Fee leg shares the trade's
        // surface attribution.
        const feeIns = await sqlite.prepare(
          `INSERT INTO transactions (user_id, date, account_id, category_id, currency, amount, entered_currency, entered_amount, entered_fx_rate, payee, note, tags, portfolio_holding_id, quantity, source)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, '', ?, ?, NULL, ?)
           RETURNING id`
        ).get(
          userId, txDate, acct.id, acctCurrency,
          -feeAmountAcct, tradeCurrency, -feeAmountTrade, fx,
          feePayee, `source:record_trade,trade-link:${transferResult.linkId}`, cashHoldingId,
          "mcp_stdio",
        ) as { id: number } | undefined;
        feeTxId = feeIns?.id ?? null;
      }

      return txt({
        success: true,
        side,
        symbol: trimmedSymbol,
        linkId: transferResult.linkId,
        fromTransactionId: transferResult.fromTransactionId,
        toTransactionId: transferResult.toTransactionId,
        cashHoldingId,
        symbolHoldingId: side === "buy" ? transferResult.holding?.toHoldingId : transferResult.holding?.fromHoldingId,
        cashAmount: cashAmountTrade,
        cashAmountAccountCurrency: cashAmountAcct,
        tradeCurrency,
        accountCurrency: acctCurrency,
        fxRate: fx,
        resolvedAccount: { id: Number(acct.id), name: String(acct.name ?? "") },
        ...(feeTxId != null ? { feeTransactionId: feeTxId, fees: feeAmountTrade } : {}),
        message: `${tradePayee} in ${acct.name}${isCrossCurrency ? ` (${cashAmountAcct} ${acctCurrency} @ rate ${fx.toFixed(6)})` : ""}${feeAmountTrade > 0 ? ` · fees ${feeAmountTrade} ${tradeCurrency}` : ""}`,
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
      // Stream D Phase 4 — stdio cannot create accounts. See streamDRefuse.
      void name; void type; void group; void currency; void note; void alias;
      return streamDRefuse("accounts");
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
      // Stream D Phase 4 — stdio cannot update accounts (would touch the
      // encrypted display-name columns).
      void account; void name; void group; void currency; void note; void alias;
      return streamDRefuse("accounts");
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
      // Stream D Phase 4 — stdio cannot update goals (would touch name_ct).
      void goal; void target_amount; void deadline; void status; void name;
      return streamDRefuse("goals");
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
      // Stream D Phase 4 — stdio cannot create categories.
      void name; void type; void group; void note;
      return streamDRefuse("categories");
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
      // Stream D Phase 4 — stdio cannot create portfolio_holdings (would
      // touch the encrypted name_ct/symbol_ct columns).
      void name; void account; void symbol; void currency; void isCrypto; void note;
      return streamDRefuse("portfolio_holdings");
    }
  );

  // ── update_portfolio_holding ───────────────────────────────────────────────
  server.tool(
    "update_portfolio_holding",
    "Update a portfolio holding's name, symbol, currency, isCrypto, or note. Renames cascade to all transactions automatically because get_portfolio_analysis groups by FK, not by string. NOTE: the legacy `account` parameter is REFUSED (issue #99) — moving a holding to a different account would leave stale `holding_accounts` rows and broken transaction account attribution. To move shares between accounts use record_transfer (in-kind); to re-attribute existing transactions update them individually.",
    {
      holding: z.string().describe("Current holding name OR symbol (fuzzy matched)"),
      name: z.string().min(1).max(200).optional(),
      symbol: z.string().max(50).optional().describe("Pass empty string to clear"),
      account: z.string().optional().describe("REFUSED (issue #99): account moves create stale state. Use record_transfer (in-kind) instead."),
      currency: z.enum(["CAD", "USD"]).optional(),
      isCrypto: z.boolean().optional(),
      note: z.string().max(500).optional(),
    },
    async ({ holding, name, symbol, account, currency, isCrypto, note }) => {
      // Stream D Phase 4 — stdio cannot update portfolio_holdings.
      void holding; void name; void symbol; void account; void currency; void isCrypto; void note;
      return streamDRefuse("portfolio_holdings");
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
    "Portfolio holdings with allocation breakdown by asset class and currency. Per-row amounts are in each holding's own currency; reportingCurrency is surfaced for cross-currency context. Pass `symbols` to filter to specific holdings; matching is case-insensitive substring against the row's `name + symbol + account` combination. Within a single entry, ALL whitespace/paren-separated tokens must match (AND); across multiple entries the result is the union (OR). Unmatched filter entries surface in the response's `warnings` array.",
    {
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
      symbols: z.array(z.string()).optional().describe("Filter to specific holding names/symbols/accounts (omit for all). Substring match against the row's `name + symbol + account` combination. Within a single entry, ALL whitespace/paren-separated tokens must match (AND) — so 'VCN.TO (TFSA)' matches only holdings whose combined name/symbol/account contains both 'vcn.to' and 'tfsa'. Across multiple entries the result is the union (OR). Unmatched entries surface in `warnings`."),
    },
    async ({ reportingCurrency, symbols }) => {
      const reporting = await resolveReportingCurrencyStdio(sqlite, userId, reportingCurrency);
      // Phase 6 (2026-04-29): JOIN on the FK rather than the (dropped)
      // portfolio_holding text column. Section F (issue #25): JOIN through
      // holding_accounts (Section G) for transactions so the (holding,
      // account) grain stays consistent with the HTTP MCP + REST. Today
      // each holding has a single is_primary=true pairing, so behavior is
      // unchanged. CLAUDE.md "Portfolio aggregator" applies (no qty>0/<0
      // CASE here — pure SUM(quantity) / SUM(amount), so the rule is moot
      // in this query).
      const holdings = await sqlite.prepare(`
        SELECT ph.id, ph.name, ph.symbol, ph.currency, a.name as account_name,
               COALESCE(SUM(t.quantity), 0) as total_quantity,
               COALESCE(SUM(t.amount), 0) as book_value
        FROM portfolio_holdings ph
        JOIN accounts a ON a.id = ph.account_id
        LEFT JOIN transactions t
          ON t.portfolio_holding_id = ph.id AND t.user_id = ?
        LEFT JOIN holding_accounts ha
          ON ha.holding_id = t.portfolio_holding_id
         AND ha.account_id = t.account_id
         AND ha.user_id = ?
        WHERE ph.user_id = ?
          AND (t.id IS NULL OR ha.holding_id IS NOT NULL)
        GROUP BY ph.id, ph.name, ph.symbol, ph.currency, a.name
        ORDER BY ABS(COALESCE(SUM(t.amount), 0)) DESC
      `).all(userId, userId, userId) as SqliteRow[];

      // Issue #124: in-process `symbols` filter, mirrored from HTTP. AND
      // within an entry across name + symbol + account; OR across entries.
      // Empty/whitespace-only entries (e.g. "()" tokenizes to []) are
      // skipped and surface as warnings rather than vacuously matching every
      // row. The full-string substring fast path handles single-token cases
      // (like "VCN.TO") cheaply. Stdio reads `h.name`/`h.symbol`/
      // `h.account_name` directly off the SELECT — once issue #131 lands the
      // upstream query will populate those from `name_ct`/`symbol_ct` via
      // decryption; this filter is field-shape agnostic.
      const symbolFilters = symbols?.length ? symbols.map(s => s.toLowerCase()) : null;
      const symbolTokens = symbolFilters
        ? symbolFilters.map(s => ({
            raw: s,
            tokens: s.split(/[\s()[\]]+/).filter(Boolean),
          }))
        : null;
      const matchedFilters = new Set<string>();
      const filteredHoldings = symbolTokens
        ? holdings.filter(h => {
            const name = String(h.name ?? "").toLowerCase();
            const sym = String(h.symbol ?? "").toLowerCase();
            const acct = String(h.account_name ?? "").toLowerCase();
            const haystack = `${name} ${sym} ${acct}`;
            return symbolTokens.some(({ raw, tokens }) => {
              if (tokens.length === 0) return false;
              if (haystack.includes(raw)) {
                matchedFilters.add(raw);
                return true;
              }
              const hit = tokens.every(t => haystack.includes(t));
              if (hit) matchedFilters.add(raw);
              return hit;
            });
          })
        : holdings;
      const warnings: string[] = symbolFilters
        ? symbols!.filter(s => !matchedFilters.has(s.toLowerCase()))
            .map(s => `${s}: no matching holding found`)
        : [];

      const byCurrency: Record<string, number> = {};
      const byAccount: Record<string, number> = {};
      let totalBV = 0;
      for (const h of filteredHoldings) {
        const bv = Math.abs(Number(h.book_value));
        byCurrency[String(h.currency)] = (byCurrency[String(h.currency)] ?? 0) + bv;
        byAccount[String(h.account_name)] = (byAccount[String(h.account_name)] ?? 0) + bv;
        totalBV += bv;
      }

      return txt({
        disclaimer: PORTFOLIO_DISCLAIMER,
        reportingCurrency: reporting,
        totalHoldings: filteredHoldings.length,
        totalBookValue: Math.round(totalBV * 100) / 100,
        warnings,
        holdings: filteredHoldings.map(h => ({
          // FK to portfolio_holdings.id — pass as portfolioHoldingId on
          // record_transaction / update_transaction in the HTTP MCP. (Stdio
          // MCP write tools don't currently bind to portfolio_holdings.)
          id: Number(h.id),
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
      // Phase 6 (2026-04-29): aggregate by FK + JOIN portfolio_holdings for
      // the display name. The legacy `portfolio_holding` text column was
      // dropped; FK is the sole source of truth. Section F (issue #25):
      // JOIN through holding_accounts (Section G) on (holding_id,
      // account_id) so the join grain matches the rest of the aggregator
      // surface. CLAUDE.md "Portfolio aggregator" — this query keys cost
      // basis on amt-sign (`amount<0` = buy), which is the LEGACY
      // amt-sign convention NOT the qty>0 rule. Preserved here for
      // backwards compat with stdio MCP consumers; the HTTP path uses the
      // qty>0 rule.
      // Issue #96: LEFT JOIN to cash-leg sibling for multi-currency trade
      // pairs. When a buy row (qty>0, amount<0) has a paired cash leg
      // (same trade_link_id, qty=0), the cash leg's `amount` is the
      // broker's actual settlement at IBKR's FX rate; the stock leg's
      // amount is the same trade re-priced at Finlynq's live rate and
      // under-counts the spread. Stdio refuses investment-account writes
      // (CLAUDE.md), so it can't *create* trade_link_id rows — but it
      // MUST read them correctly for users who created the trade via HTTP
      // MCP. This query now picks the cash leg's amount via a CASE when
      // present.
      // CLAUDE.md flags this query keys cost basis on amt-sign — the
      // legacy convention used here (NOT the qty>0 rule). Preserved for
      // backwards compat; the HTTP path uses qty>0. Both paths apply the
      // same #96 cash-leg substitution.
      const perf = await sqlite.prepare(`
        SELECT ph.name as holding, COUNT(*) as tx_count,
               SUM(CASE
                 WHEN t.amount < 0 AND cash.id IS NOT NULL THEN ABS(cash.amount)
                 WHEN t.amount < 0 THEN ABS(t.amount)
                 ELSE 0
               END) as cost_basis,
               SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) as proceeds,
               SUM(t.quantity) as net_quantity,
               MIN(t.date) as first_purchase, MAX(t.date) as last_activity
        FROM transactions t
        INNER JOIN holding_accounts ha
          ON ha.holding_id = t.portfolio_holding_id
         AND ha.account_id = t.account_id
         AND ha.user_id = ?
        LEFT JOIN portfolio_holdings ph ON ph.id = t.portfolio_holding_id
        LEFT JOIN transactions cash
          ON cash.user_id = ?
         AND cash.trade_link_id IS NOT NULL
         AND cash.trade_link_id = t.trade_link_id
         AND cash.id <> t.id
         AND COALESCE(cash.quantity, 0) = 0
        WHERE t.user_id = ? AND t.portfolio_holding_id IS NOT NULL AND t.date >= ?
        GROUP BY ph.id, ph.name ORDER BY cost_basis DESC
      `).all(userId, userId, userId, since) as SqliteRow[];

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
    "Deep-dive analysis of a single holding: transaction history, avg cost, P&L. Per-row amounts stay in the transaction's account currency; reportingCurrency is surfaced for cross-currency context. When `symbol` substring-matches multiple holdings sharing a name (TFSA + RRSP), pass `holdingId` to scope; otherwise the response includes an `ambiguous` array of candidates.",
    {
      symbol: z.string().optional().describe("Holding name or symbol (fuzzy matched). Required when `holdingId` is omitted."),
      holdingId: z.number().int().optional().describe("Filter to this exact portfolio_holdings.id — bypasses fuzzy matching. Use this when `symbol` matches multiple positions sharing the same name."),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async ({ symbol, holdingId, reportingCurrency }) => {
      if (!symbol && holdingId == null) {
        return sqliteErr("analyze_holding requires either `symbol` or `holdingId`");
      }
      const reporting = await resolveReportingCurrencyStdio(sqlite, userId, reportingCurrency);
      // Phase 6 (2026-04-29): match on the JOINed portfolio_holdings name +
      // symbol + tx payee. The legacy `t.portfolio_holding` text column was
      // dropped; FK + JOIN is the only source of truth for holding names.
      // Section F (issue #25): JOIN through holding_accounts (Section G) on
      // (holding_id, account_id) so the join grain matches the HTTP MCP +
      // REST aggregator surface. CLAUDE.md "Portfolio aggregator" — qty>0
      // = buy regardless of amount sign (preserved in the loop below).
      // Symbol gets exact case-insensitive equality (tickers are short and
      // prone to spurious substring hits — "GE" inside "ORANGE" etc.).
      // Issue #86: when holdingId is supplied, scope the query to that FK
      // exclusively (bypasses the fuzzy substring filter).
      // Issue #96: LEFT JOIN to cash-leg sibling. cash_amount is null when
      // no pair exists; the per-row buy loop below prefers cash_amount when
      // present and falls back to t.amount otherwise. Stdio MCP can't
      // *create* trade_link_id rows but must read them correctly for users
      // who created the trade via HTTP MCP.
      const txns = holdingId != null
        ? await sqlite.prepare(`
            SELECT t.id, t.date, t.amount, t.quantity, t.payee, t.portfolio_holding_id,
                   ph.name as portfolio_holding,
                   a.name as account_name, a.currency,
                   cash.amount as cash_amount, cash.id as cash_id
            FROM transactions t
            JOIN accounts a ON a.id = t.account_id
            INNER JOIN holding_accounts ha
              ON ha.holding_id = t.portfolio_holding_id
             AND ha.account_id = t.account_id
             AND ha.user_id = ?
            LEFT JOIN portfolio_holdings ph ON ph.id = t.portfolio_holding_id
            LEFT JOIN transactions cash
              ON cash.user_id = ?
             AND cash.trade_link_id IS NOT NULL
             AND cash.trade_link_id = t.trade_link_id
             AND cash.id <> t.id
             AND COALESCE(cash.quantity, 0) = 0
            WHERE t.user_id = ?
              AND t.portfolio_holding_id = ?
            ORDER BY t.date ASC
          `).all(userId, userId, userId, holdingId) as SqliteRow[]
        : await sqlite.prepare(`
            SELECT t.id, t.date, t.amount, t.quantity, t.payee, t.portfolio_holding_id,
                   ph.name as portfolio_holding,
                   a.name as account_name, a.currency,
                   cash.amount as cash_amount, cash.id as cash_id
            FROM transactions t
            JOIN accounts a ON a.id = t.account_id
            INNER JOIN holding_accounts ha
              ON ha.holding_id = t.portfolio_holding_id
             AND ha.account_id = t.account_id
             AND ha.user_id = ?
            LEFT JOIN portfolio_holdings ph ON ph.id = t.portfolio_holding_id
            LEFT JOIN transactions cash
              ON cash.user_id = ?
             AND cash.trade_link_id IS NOT NULL
             AND cash.trade_link_id = t.trade_link_id
             AND cash.id <> t.id
             AND COALESCE(cash.quantity, 0) = 0
            WHERE t.user_id = ?
              AND (
                LOWER(ph.name) LIKE LOWER(?)
                OR LOWER(t.payee) LIKE LOWER(?)
                OR LOWER(ph.symbol) = LOWER(?)
              )
            ORDER BY t.date ASC
          `).all(userId, userId, userId, `%${symbol}%`, `%${symbol}%`, symbol) as SqliteRow[];

      if (!txns.length) {
        return sqliteErr(holdingId != null
          ? `No transactions found for holdingId=${holdingId}`
          : `No transactions found for "${symbol}"`);
      }

      // Issue #86: detect cross-holding ambiguity (only when no holdingId
      // was supplied). If multiple distinct holding ids matched, return the
      // candidate list and require the caller to disambiguate.
      if (holdingId == null) {
        const distinctIds = new Set<number>();
        for (const t of txns) {
          if (t.portfolio_holding_id != null) distinctIds.add(Number(t.portfolio_holding_id));
        }
        if (distinctIds.size > 1) {
          const ambiguous: Array<{ holdingId: number; name: string | null; account: string | null }> = [];
          const seen = new Set<number>();
          for (const t of txns) {
            const hid = t.portfolio_holding_id != null ? Number(t.portfolio_holding_id) : null;
            if (hid == null || seen.has(hid)) continue;
            seen.add(hid);
            ambiguous.push({
              holdingId: hid,
              name: (t.portfolio_holding ?? null) as string | null,
              account: (t.account_name ?? null) as string | null,
            });
          }
          return txt({
            disclaimer: PORTFOLIO_DISCLAIMER,
            ambiguous,
            note: `Substring "${symbol}" matched ${ambiguous.length} distinct holdings. Re-call analyze_holding with one of these holdingId values.`,
          });
        }
      }

      const holdingName = txns[0].portfolio_holding || txns[0].payee;
      // Prefer rows whose joined portfolio_holding name equals the chosen
      // holdingName — payee-only matches could otherwise surface a different
      // holding's id.
      // Issue #86: when holdingId was supplied, use it directly.
      const resolvedHoldingId: number | null = holdingId ??
        ((txns.find(
          (t) =>
            t.portfolio_holding_id != null &&
            String(t.portfolio_holding ?? "") === String(holdingName)
        )?.portfolio_holding_id as number | undefined) ?? null);
      let totalShares = 0, totalCost = 0;
      const purchases: SqliteRow[] = [], sales: SqliteRow[] = [];
      // qty>0 = buy (handles Finlynq-native amt<0+qty>0 and WP convention
      // amt>0+qty>0). qty<0 = sell (qty already negative). qty=0 = dividend.
      // Issue #96: when a paired cash-leg sibling exists (multi-currency
      // trade pair, t.cash_id != null), use the cash leg's amount as cost
      // basis instead of the stock leg's amount.
      for (const t of txns) {
        const qty = Number(t.quantity ?? 0);
        if (qty > 0) {
          totalShares += qty;
          const cashAmt = t.cash_id != null ? Number(t.cash_amount) : NaN;
          const buyCostAmt = Number.isFinite(cashAmt) ? Math.abs(cashAmt) : Math.abs(Number(t.amount));
          totalCost += buyCostAmt;
          purchases.push(t);
        }
        else if (qty < 0) { totalShares += qty; sales.push(t); }
      }
      const avgCost = purchases.length && totalCost > 0
        ? totalCost / purchases.reduce((s, t) => s + Number(t.quantity ?? 0), 0)
        : null;

      return txt({
        disclaimer: PORTFOLIO_DISCLAIMER,
        holdingId: resolvedHoldingId,
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

  // ── trace_holding_quantity ─────────────────────────────────────────────────
  server.tool(
    "trace_holding_quantity",
    "Per-transaction quantity contributions for a single holding, with running sum. Diagnostic tool for investigating quantity discrepancies. Read-only. JOINs through holding_accounts (issue #25) so the rows match what the four aggregators see; rows whose (holding_id, account_id) pair is missing from holding_accounts are OMITTED but counted in `unjoinedTransactionCount`. When `symbol` matches multiple holdings, response surfaces an `ambiguous` candidate list (re-call with `holdingId`).",
    {
      symbol: z.string().optional().describe("Holding name or symbol (fuzzy matched). Required when `holdingId` is omitted."),
      holdingId: z.number().int().optional().describe("Filter to this exact portfolio_holdings.id — bypasses fuzzy matching."),
    },
    async ({ symbol, holdingId }) => {
      if (!symbol && holdingId == null) {
        return sqliteErr("trace_holding_quantity requires either `symbol` or `holdingId`");
      }
      // Resolve the holding id when only `symbol` was supplied. Stdio reads
      // plaintext name/symbol (per the stdio carve-out — no DEK).
      let resolvedHoldingId: number | null = holdingId ?? null;
      if (resolvedHoldingId == null) {
        const matches = await sqlite.prepare(`
          SELECT id, name, symbol, account_id
          FROM portfolio_holdings
          WHERE user_id = ?
            AND (
              LOWER(name) LIKE LOWER(?)
              OR LOWER(symbol) = LOWER(?)
            )
        `).all(userId, `%${symbol}%`, symbol) as SqliteRow[];

        if (!matches.length) return sqliteErr(`No holding found matching "${symbol}"`);

        const distinctIds = new Set<number>(matches.map((m) => Number(m.id)));
        if (distinctIds.size > 1) {
          const ids = [...distinctIds];
          const accounts = await sqlite.prepare(
            `SELECT id, name FROM accounts WHERE user_id = ?`
          ).all(userId) as SqliteRow[];
          const accountNameById = new Map<number, string>();
          for (const a of accounts) accountNameById.set(Number(a.id), String(a.name ?? ""));
          const ambiguous = ids.map((id) => {
            const m = matches.find((x) => Number(x.id) === id)!;
            return {
              holdingId: id,
              name: (m.name ?? null) as string | null,
              symbol: (m.symbol ?? null) as string | null,
              account: accountNameById.get(Number(m.account_id)) ?? null,
            };
          });
          return txt({
            ambiguous,
            note: `Substring "${symbol}" matched ${ambiguous.length} distinct holdings. Re-call trace_holding_quantity with one of these holdingId values.`,
          });
        }
        resolvedHoldingId = Number(matches[0].id);
      }

      // Count transactions whose (holding_id, account_id) pair is missing
      // from holding_accounts — these are invisible to the four aggregators.
      const unjoinedRow = await sqlite.prepare(`
        SELECT COUNT(*) AS cnt
        FROM transactions t
        WHERE t.user_id = ?
          AND t.portfolio_holding_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM holding_accounts ha
            WHERE ha.user_id = ?
              AND ha.holding_id = t.portfolio_holding_id
              AND ha.account_id = t.account_id
          )
      `).get(userId, resolvedHoldingId, userId) as { cnt: number };
      const unjoinedTransactionCount = Number(unjoinedRow?.cnt ?? 0);

      const legsRaw = await sqlite.prepare(`
        SELECT t.id, t.date, t.account_id, t.quantity, t.amount, t.source, t.payee,
               a.name AS account_name
        FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        INNER JOIN holding_accounts ha
          ON ha.holding_id = t.portfolio_holding_id
         AND ha.account_id = t.account_id
         AND ha.user_id = ?
        WHERE t.user_id = ?
          AND t.portfolio_holding_id = ?
        ORDER BY t.date ASC, t.id ASC
      `).all(userId, userId, resolvedHoldingId) as SqliteRow[];

      let runningSum = 0;
      const legs = legsRaw.map((row) => {
        const qty = Number(row.quantity ?? 0);
        runningSum += qty;
        const accountName: string | null = row.account_name == null ? null : String(row.account_name);
        const source: string | null = row.source == null ? null : String(row.source);
        const payee: string | null = row.payee == null ? null : String(row.payee);
        return {
          transactionId: Number(row.id),
          date: row.date,
          accountId: Number(row.account_id),
          accountName,
          quantity: qty,
          amount: Number(row.amount ?? 0),
          source,
          payee,
          runningSum: Math.round(runningSum * 10000) / 10000,
        };
      });

      const totalQty = Math.round(runningSum * 10000) / 10000;
      const perAccount = new Map<number, { accountId: number; accountName: string | null; qty: number; legCount: number }>();
      for (const l of legs) {
        const e = perAccount.get(l.accountId);
        if (e) { e.qty += l.quantity; e.legCount += 1; }
        else perAccount.set(l.accountId, { accountId: l.accountId, accountName: l.accountName, qty: l.quantity, legCount: 1 });
      }
      const perAccountArr = [...perAccount.values()].map((e) => ({
        ...e,
        qty: Math.round(e.qty * 10000) / 10000,
      }));

      return txt({
        holdingId: resolvedHoldingId,
        totalLegs: legs.length,
        totalQty,
        unjoinedTransactionCount,
        unjoinedNote: unjoinedTransactionCount > 0
          ? `${unjoinedTransactionCount} transaction(s) reference this holding but their (holdingId, accountId) pair is NOT in holding_accounts — invisible to the four aggregators.`
          : null,
        perAccount: perAccountArr,
        legs,
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
        // Phase 6 (2026-04-29): aggregate by FK + JOIN.
        // Issue #96: LEFT JOIN to cash-leg sibling. When a paired cash leg
        // exists, prefer its amount (broker's actual settlement at IBKR's
        // FX rate) over the stock leg's amount (Finlynq's live FX rate).
        const holdings = await sqlite.prepare(`
          SELECT ph.name as name,
                 SUM(CASE
                   WHEN cash.id IS NOT NULL THEN ABS(cash.amount)
                   ELSE ABS(t.amount)
                 END) as book_value
          FROM transactions t
          LEFT JOIN portfolio_holdings ph ON ph.id = t.portfolio_holding_id
          LEFT JOIN transactions cash
            ON cash.user_id = ?
           AND cash.trade_link_id IS NOT NULL
           AND cash.trade_link_id = t.trade_link_id
           AND cash.id <> t.id
           AND COALESCE(cash.quantity, 0) = 0
          WHERE t.user_id = ? AND t.portfolio_holding_id IS NOT NULL AND t.amount < 0
          GROUP BY ph.id, ph.name
        `).all(userId, userId) as SqliteRow[];

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

        // Phase 6 (2026-04-29): FK filter replaces legacy text-column check.
        const row = await sqlite.prepare(`
          SELECT MIN(date) as first_date, MAX(date) as last_date, SUM(ABS(amount)) as total_invested
          FROM transactions WHERE user_id = ? AND portfolio_holding_id IS NOT NULL AND amount < 0
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
      // Phase 6 (2026-04-29): aggregate by FK + JOIN.
      const positions = await sqlite.prepare(`
        SELECT ph.name as name, SUM(ABS(t.amount)) as book_value, COUNT(*) as purchases
        FROM transactions t
        LEFT JOIN portfolio_holdings ph ON ph.id = t.portfolio_holding_id
        WHERE t.user_id = ? AND t.portfolio_holding_id IS NOT NULL AND t.amount < 0
        GROUP BY ph.id, ph.name ORDER BY book_value DESC
      `).all(userId) as SqliteRow[];

      const contributions = await sqlite.prepare(`
        SELECT strftime('%Y-%m', date) as month, SUM(ABS(amount)) as invested
        FROM transactions WHERE user_id = ? AND portfolio_holding_id IS NOT NULL AND amount < 0
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
          record_transfer: "record_transfer(fromAccount, toAccount, amount, ...) — Atomic transfer pair. In-kind: holding+quantity.",
          record_trade: "record_trade(account, side, symbol, quantity, price, currency?, fees?, fxRate?) — Brokerage buy/sell. Cross-currency requires fxRate.",
          preview_bulk_update: "preview_bulk_update(filter, changes) — stdio-accepted `changes` keys: category_id, category (name → id), account_id, date, note, payee, is_business, tags. Unknown keys fail strictly. Returns affectedCount, sampleBefore/After, unappliedChanges[{field, requestedValue, reason}], confirmationToken. sampleAfter.category re-hydrates to the resolved name when `category` resolves. (HTTP transport adds quantity, portfolioHoldingId, portfolioHolding.)",
          execute_bulk_update: "execute_bulk_update(filter, changes, confirmation_token) — re-runs name→id resolution and aborts when the resolved set is empty. Returns {updated, unappliedChanges[{field, requestedValue, reason}]}. Stdio: category-by-name only (HTTP supports quantity/holding writes too).",
        };
        return txt({ tool: tool_name, usage: docs[tool_name] ?? "Use topic='tools' for full list." });
      }

      const t = topic ?? "tools";

      if (t === "tools") return txt({
        read_tools: ["get_account_balances", "search_transactions", "get_budget_summary", "get_spending_trends", "get_net_worth", "get_categories", "get_loans", "get_goals", "get_recurring_transactions", "get_income_statement", "get_spotlight_items", "get_weekly_recap", "get_transaction_rules"],
        write_tools: ["record_transaction", "bulk_record_transactions", "update_transaction", "delete_transaction", "set_budget", "delete_budget", "add_account", "update_account", "delete_account", "add_goal", "update_goal", "delete_goal", "create_category", "create_rule", "add_snapshot", "apply_rules_to_uncategorized"],
        portfolio_tools: ["get_portfolio_analysis", "get_portfolio_performance", "analyze_holding", "trace_holding_quantity", "get_investment_insights"],
        trade_tools: ["record_transfer", "record_trade"],
        tip: "Use tool_name='record_transaction' for usage details. For brokerage buys/sells prefer record_trade; record_transfer is the manual fallback for non-trade in-kind moves (e.g. forex sleeve, ACATS).",
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
        tools: ["get_portfolio_analysis", "get_portfolio_performance", "analyze_holding", "trace_holding_quantity", "get_investment_insights"],
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
      // Stream D Phase 4 — stdio cannot create loans.
      void name; void type; void principal; void annual_rate; void term_months; void start_date;
      void account; void payment_amount; void payment_frequency; void extra_payment; void min_payment; void note;
      return streamDRefuse("loans");
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
      // Stream D Phase 4 — stdio cannot update loans.
      void id; void name; void type; void principal; void annual_rate; void term_months; void start_date;
      void payment_amount; void payment_frequency; void extra_payment; void account; void note;
      return streamDRefuse("loans");
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
      // Stream D Phase 4 — stdio cannot create subscriptions.
      void name; void amount; void cadence; void next_billing_date; void currency; void category; void account; void notes;
      return streamDRefuse("subscriptions");
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
      // Stream D Phase 4 — stdio cannot update subscriptions (would touch
      // the encrypted name_ct/lookup column when name changes; refuse the
      // whole tool to keep the contract clean).
      void id; void name; void amount; void cadence; void next_billing_date; void currency;
      void category; void account; void status; void cancel_reminder_date; void notes;
      return streamDRefuse("subscriptions");
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

  // Issue #61: `.strict()` so unknown keys fail at validation time instead
  // of silently no-op'ing. Stdio's surface is intentionally narrower than
  // HTTP's — `category` (name) is the only addition. quantity/holding fields
  // are HTTP-only because stdio has no holding plumbing (no DEK, no
  // resolvePortfolioHoldingByName equivalent), mirrors the stdio
  // `record_transaction` carve-out that already refuses investment-account
  // writes. Callers passing `quantity` to stdio get a clean strict-mode 400.
  const bulkChangesSchema = z.object({
    category_id: z.number().nullable().optional(),
    category: z.string().optional(),
    account_id: z.number().optional(),
    date: z.string().optional(),
    note: z.string().optional(),
    payee: z.string().optional(),
    is_business: z.number().optional(),
    tags: z.object({
      mode: z.enum(["append", "replace", "remove"]),
      value: z.string(),
    }).optional(),
  }).strict();
  type BulkChanges = z.infer<typeof bulkChangesSchema>;

  /** Issue #61: post-resolution shape — names → ids. */
  type ResolvedChanges = {
    category_id?: number | null;
    account_id?: number;
    date?: string;
    note?: string;
    payee?: string;
    is_business?: number;
    tags?: { mode: "append" | "replace" | "remove"; value: string };
    /**
     * Issue #93: when `category` (name) resolved successfully, carry the
     * resolved display name through so `applyChangesToRow` can re-hydrate
     * `sampleAfter.category` for preview fidelity. Not written to the DB.
     */
    category_name?: string;
  };
  /**
   * Issue #93: preview/execute responses surface every requested change that
   * failed to resolve. `field` is the key the caller passed (e.g. "category");
   * `requestedValue` is the value they sent so callers don't have to regex
   * the reason string to recover what they tried.
   */
  type UnappliedChange = { field: string; requestedValue: unknown; reason: string };

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

  /**
   * Issue #61: resolve names → ids before preview/commit. Stdio carries the
   * narrower surface — only `category` (name) needs resolution. Mirrors the
   * HTTP transport's helper but without DEK plumbing (stdio reads plaintext
   * `name` directly via SQL).
   */
  async function resolveBulkChanges(
    changes: BulkChanges,
  ): Promise<{ resolved: ResolvedChanges; unapplied: UnappliedChange[]; error?: string }> {
    const resolved: ResolvedChanges = {};
    const unapplied: UnappliedChange[] = [];

    if (changes.category_id !== undefined) resolved.category_id = changes.category_id;
    if (changes.account_id !== undefined) resolved.account_id = changes.account_id;
    if (changes.date !== undefined) resolved.date = changes.date;
    if (changes.note !== undefined) resolved.note = changes.note;
    if (changes.payee !== undefined) resolved.payee = changes.payee;
    if (changes.is_business !== undefined) resolved.is_business = changes.is_business;
    if (changes.tags !== undefined) resolved.tags = changes.tags;

    if (changes.category !== undefined) {
      const allCats = await sqlite.prepare(`SELECT id, name FROM categories WHERE user_id = ?`).all(userId) as SqliteRow[];
      const r = resolveCategoryStrict(changes.category, allCats);
      if (!r.ok) {
        if (r.reason === "low_confidence") {
          unapplied.push({
            field: "category",
            requestedValue: changes.category,
            reason: `Category "${changes.category}" did not match strongly — did you mean "${r.suggestion.name}" (id=${Number(r.suggestion.id)})?`,
          });
        } else {
          const list = allCats.map(c => `"${c.name}" (id=${Number(c.id)})`).join(", ");
          unapplied.push({
            field: "category",
            requestedValue: changes.category,
            reason: `Category "${changes.category}" not found. Available: ${list}`,
          });
        }
      } else {
        const resolvedId = Number(r.category.id);
        if (changes.category_id !== undefined && changes.category_id !== null && changes.category_id !== resolvedId) {
          return {
            resolved,
            unapplied,
            error: `category "${changes.category}" resolves to id=${resolvedId}, but category_id=${changes.category_id} disagrees. Pass only one, or make them match.`,
          };
        }
        resolved.category_id = resolvedId;
        // Issue #93: thread the resolved display name through so
        // `applyChangesToRow` can re-hydrate `sampleAfter.category`.
        resolved.category_name = String(r.category.name ?? "");
      }
    }

    return { resolved, unapplied };
  }

  function applyChangesToRow(row: Record<string, unknown>, resolved: ResolvedChanges): Record<string, unknown> {
    const out = { ...row };
    if (resolved.category_id !== undefined) out.category_id = resolved.category_id;
    // Issue #93: when `category` (name) resolved, re-hydrate the joined
    // category display name so `sampleAfter.category` reflects the new
    // category instead of the old one.
    if (resolved.category_name !== undefined) out.category = resolved.category_name;
    if (resolved.account_id !== undefined) out.account_id = resolved.account_id;
    if (resolved.date !== undefined) out.date = resolved.date;
    if (resolved.note !== undefined) out.note = resolved.note;
    if (resolved.payee !== undefined) out.payee = resolved.payee;
    if (resolved.is_business !== undefined) out.is_business = resolved.is_business;
    if (resolved.tags !== undefined) {
      const currentSet = new Set(String(out.tags ?? "").split(",").map((s) => s.trim()).filter(Boolean));
      const tokens = resolved.tags.value.split(",").map((s) => s.trim()).filter(Boolean);
      if (resolved.tags.mode === "replace") out.tags = tokens.join(",");
      else if (resolved.tags.mode === "append") { for (const t of tokens) currentSet.add(t); out.tags = Array.from(currentSet).join(","); }
      else { for (const t of tokens) currentSet.delete(t); out.tags = Array.from(currentSet).join(","); }
    }
    return out;
  }

  /**
   * Commit a bulk update. Issue #61: takes the post-resolution shape so
   * commit only ever writes FK ints. Issue #28 audit-trio: every UPDATE
   * here bumps `updated_at = NOW()`; `source` is INSERT-only, never modified.
   */
  async function commitBulkUpdate(ids: number[], resolved: ResolvedChanges): Promise<number> {
    if (ids.length === 0) return 0;
    const inList = `(${ids.map(() => "?").join(",")})`;

    if (resolved.category_id !== undefined) {
      await sqlite.prepare(`UPDATE transactions SET category_id = ?, updated_at = NOW() WHERE id IN ${inList} AND user_id = ?`).run(resolved.category_id, ...ids, userId);
    }
    if (resolved.account_id !== undefined) {
      await sqlite.prepare(`UPDATE transactions SET account_id = ?, updated_at = NOW() WHERE id IN ${inList} AND user_id = ?`).run(resolved.account_id, ...ids, userId);
    }
    if (resolved.date !== undefined) {
      await sqlite.prepare(`UPDATE transactions SET date = ?, updated_at = NOW() WHERE id IN ${inList} AND user_id = ?`).run(resolved.date, ...ids, userId);
    }
    if (resolved.is_business !== undefined) {
      await sqlite.prepare(`UPDATE transactions SET is_business = ?, updated_at = NOW() WHERE id IN ${inList} AND user_id = ?`).run(resolved.is_business, ...ids, userId);
    }
    if (resolved.payee !== undefined) {
      await sqlite.prepare(`UPDATE transactions SET payee = ?, updated_at = NOW() WHERE id IN ${inList} AND user_id = ?`).run(resolved.payee, ...ids, userId);
    }
    if (resolved.note !== undefined) {
      await sqlite.prepare(`UPDATE transactions SET note = ?, updated_at = NOW() WHERE id IN ${inList} AND user_id = ?`).run(resolved.note, ...ids, userId);
    }
    if (resolved.tags !== undefined) {
      if (resolved.tags.mode === "replace") {
        await sqlite.prepare(`UPDATE transactions SET tags = ?, updated_at = NOW() WHERE id IN ${inList} AND user_id = ?`).run(resolved.tags.value, ...ids, userId);
      } else {
        const rows = await sqlite.prepare(`SELECT id, tags FROM transactions WHERE id IN ${inList} AND user_id = ?`).all(...ids, userId) as Array<{ id: number; tags: string }>;
        const tokens = resolved.tags.value.split(",").map((s) => s.trim()).filter(Boolean);
        for (const r of rows) {
          const set = new Set(String(r.tags ?? "").split(",").map((s) => s.trim()).filter(Boolean));
          if (resolved.tags.mode === "append") { for (const t of tokens) set.add(t); }
          else { for (const t of tokens) set.delete(t); }
          const next = Array.from(set).join(",");
          await sqlite.prepare(`UPDATE transactions SET tags = ?, updated_at = NOW() WHERE id = ? AND user_id = ?`).run(next, Number(r.id), userId);
        }
      }
    }
    return ids.length;
  }

  /**
   * Issue #61: resolves names → ids upstream so the sample `after` reflects
   * the post-resolution shape, AND surfaces `unappliedChanges` so identical
   * before/after sample rows always come with a reason.
   */
  async function previewBulk(filter: BulkFilter, changes: BulkChanges, op: string) {
    const ids = await resolveFilterToIds(filter);
    const { resolved, unapplied, error } = await resolveBulkChanges(changes);
    if (error) throw new Error(error);

    if (ids.length === 0) {
      return { affectedCount: 0, sampleBefore: [], sampleAfter: [], unappliedChanges: unapplied, ids: [], confirmationToken: "" };
    }
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
    const after = before.map((r) => applyChangesToRow(r, resolved));
    // Sign the user-supplied `changes` (not the resolved form) so the token
    // round-trips between preview and execute calls.
    const token = signConfirmationToken(userId, op, { ids, changes });
    return { affectedCount: ids.length, sampleBefore: before, sampleAfter: after, unappliedChanges: unapplied, ids, confirmationToken: token };
  }

  // ── preview_bulk_update ────────────────────────────────────────────────────
  // Issue #61: stdio surface accepts category_id, category (name), account_id,
  // date, note, payee, is_business, tags. Unknown keys (incl. quantity /
  // portfolioHoldingId / portfolioHolding) fail strictly — those are HTTP-only
  // because stdio has no holding plumbing.
  server.tool(
    "preview_bulk_update",
    "Preview a bulk update over transactions matching `filter`. Returns affected count, before/after samples, an `unappliedChanges` array, and a confirmationToken (5-min TTL). Each `unappliedChanges` entry is `{ field, requestedValue, reason }` — `field` is the change key, `requestedValue` is the value you sent, `reason` explains the failure. `sampleAfter.category` reflects the resolved category display name when `category` (name) resolved. Stdio-accepted `changes` keys: category_id, category (name → id), account_id, date, note, payee, is_business, tags. Unknown keys fail. (HTTP transport additionally supports quantity, portfolioHoldingId, portfolioHolding.)",
    { filter: bulkFilterSchema, changes: bulkChangesSchema },
    async ({ filter, changes }) => {
      try {
        const { affectedCount, sampleBefore, sampleAfter, unappliedChanges, confirmationToken } = await previewBulk(filter, changes, "bulk_update");
        return txt({ success: true, data: { affectedCount, sampleBefore, sampleAfter, unappliedChanges, confirmationToken } });
      } catch (e) { return sqliteErr(String(e instanceof Error ? e.message : e)); }
    }
  );

  // ── execute_bulk_update ────────────────────────────────────────────────────
  server.tool(
    "execute_bulk_update",
    "Commit a bulk update. Must be preceded by preview_bulk_update with the same filter+changes. Returns `{ updated, unappliedChanges }` where each `unappliedChanges` entry is `{ field, requestedValue, reason }`. Stdio-accepted `changes` keys: category_id, category (name), account_id, date, note, payee, is_business, tags. Aborts (no commit) when ALL requested changes failed to resolve.",
    { filter: bulkFilterSchema, changes: bulkChangesSchema, confirmation_token: z.string() },
    async ({ filter, changes, confirmation_token }) => {
      try {
        const ids = await resolveFilterToIds(filter);
        const check = verifyConfirmationToken(confirmation_token, userId, "bulk_update", { ids, changes });
        if (!check.valid) return sqliteErr(`Confirmation token invalid: ${check.reason}. Re-run preview_bulk_update.`);

        // Issue #61: resolve names → ids HERE; refuse if all changes failed
        // resolution.
        const { resolved, unapplied, error } = await resolveBulkChanges(changes);
        if (error) return sqliteErr(error);
        const requestedKeys = Object.keys(changes);
        // Issue #93: `category_name` is preview-only metadata, not a DB
        // column. Don't count it as an "applied change" when deciding whether
        // to abort — keeps the abort guard honest.
        const resolvedKeys = Object.keys(resolved).filter((k) => k !== "category_name");
        if (requestedKeys.length > 0 && resolvedKeys.length === 0) {
          return sqliteErr(`No changes could be applied. Resolution failures: ${unapplied.map(u => `${u.field}: ${u.reason}`).join(" | ")}`);
        }

        const n = await commitBulkUpdate(ids, resolved);
        if (n > 0) invalidateUserTxCache(userId);
        return txt({ success: true, data: { updated: n, unappliedChanges: unapplied } });
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
        // Issue #61: commit takes the resolved shape now. category_id is
        // already an int so resolution is a no-op for this path.
        const resolved: ResolvedChanges = { category_id };
        const n = await commitBulkUpdate(ids, resolved);
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

      // Stream D Phase 4 — stdio cannot bulk-insert subscriptions because
      // each row needs `name_ct` + `name_lookup` and the stdio transport
      // has no DEK. Refuse the whole batch.
      void candidates; void today; void addInterval;
      return streamDRefuse("subscriptions");
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
    "Preview an uploaded CSV/OFX/QFX file (or a local file path if ALLOW_LOCAL_FILE_IMPORT=1). Returns parsed rows, probable cross-source duplicates (FX-spread + ±7 day fuzzy match — heuristic, not exact), and a confirmationToken.",
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
        // Issue #65: collect rows that survived exact-dedup so the cross-source
        // detector below has a clean pool to match against.
        const fuzzyInputs: Array<{
          rowIndex: number;
          date: string;
          accountId: number;
          amount: number;
          payeePlain: string;
          importHash: string;
        }> = [];
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          const aId = r.account ? accountByName.get(r.account.toLowerCase().trim()) : undefined;
          if (!aId && r.account) unresolvedAccounts.add(r.account);
          if (aId) {
            const h = generateImportHash(r.date, aId, r.amount, r.payee);
            if (existingHashes.has(h)) {
              dedupHits++;
            } else {
              fuzzyInputs.push({
                rowIndex: i,
                date: r.date,
                accountId: aId,
                amount: r.amount,
                payeePlain: r.payee ?? "",
                importHash: h,
              });
            }
          }
        }

        // Issue #65: cross-source duplicate detection (heuristic — warning surface
        // only). Stdio writes plaintext, so candidate-row payee is plaintext too —
        // no DEK gymnastics needed here.
        let probableDuplicates: DuplicateMatch[] = [];
        if (fuzzyInputs.length > 0) {
          try {
            const accIds = Array.from(new Set(fuzzyInputs.map((f) => f.accountId)));
            const dates = fuzzyInputs.map((f) => f.date).sort();
            const dateMin = shiftIsoDate(dates[0], -7);
            const dateMax = shiftIsoDate(dates[dates.length - 1], 7);
            if (dateMin && dateMax) {
              const placeholders = accIds.map(() => "?").join(",");
              const poolRows = await sqlite.prepare(
                `SELECT t.id, t.account_id, t.date, t.amount, t.payee, t.import_hash,
                        t.fit_id, t.link_id, c.type AS category_type, t.source,
                        t.portfolio_holding_id
                   FROM transactions t
                   LEFT JOIN categories c ON c.id = t.category_id
                  WHERE t.user_id = ?
                    AND t.account_id IN (${placeholders})
                    AND t.date BETWEEN ? AND ?`,
              ).all(userId, ...accIds, dateMin, dateMax) as Array<Record<string, unknown>>;

              const byAccount = new Map<number, DuplicateCandidateRow[]>();
              const linkIds: string[] = [];
              for (const p of poolRows) {
                const accId = Number(p.account_id);
                const row: DuplicateCandidateRow = {
                  id: Number(p.id),
                  accountId: accId,
                  date: String(p.date),
                  amount: Number(p.amount),
                  payeePlain: p.payee == null ? null : String(p.payee),
                  importHash: p.import_hash == null ? null : String(p.import_hash),
                  fitId: p.fit_id == null ? null : String(p.fit_id),
                  linkId: p.link_id == null ? null : String(p.link_id),
                  categoryType: p.category_type == null ? null : String(p.category_type),
                  source: p.source == null ? null : String(p.source),
                  portfolioHoldingId: p.portfolio_holding_id == null ? null : Number(p.portfolio_holding_id),
                };
                const arr = byAccount.get(accId) ?? [];
                arr.push(row);
                byAccount.set(accId, arr);
                if (row.categoryType === "R" && row.linkId) linkIds.push(row.linkId);
              }

              const siblingAccountByLinkId = new Map<string, number>();
              if (linkIds.length > 0) {
                const sibPlaceholders = linkIds.map(() => "?").join(",");
                const sibRows = await sqlite.prepare(
                  `SELECT link_id, account_id
                     FROM transactions
                    WHERE user_id = ?
                      AND link_id IN (${sibPlaceholders})`,
                ).all(userId, ...linkIds) as Array<Record<string, unknown>>;
                const accountSet = new Set<number>(accIds);
                const byLink = new Map<string, number[]>();
                for (const sr of sibRows) {
                  const lid = sr.link_id == null ? null : String(sr.link_id);
                  const a = sr.account_id == null ? null : Number(sr.account_id);
                  if (!lid || a == null) continue;
                  const arr = byLink.get(lid) ?? [];
                  arr.push(a);
                  byLink.set(lid, arr);
                }
                for (const [linkId, accs] of byLink) {
                  const sib = accs.find((a) => !accountSet.has(a));
                  if (sib != null) siblingAccountByLinkId.set(linkId, sib);
                }
              }

              const pool: DuplicateCandidatePool = { byAccount, siblingAccountByLinkId };
              probableDuplicates = detectProbableDuplicates(fuzzyInputs, pool);
            }
          } catch {
            probableDuplicates = [];
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
            // Issue #65: warning surface — heuristic flags rows that may match
            // an existing transaction (FX-spread, settlement-vs-posting drift).
            // Thresholds: ±7 days, amount within ±7% OR ±$50 (whichever
            // larger), score ≥ 0.6.
            probableDuplicates,
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
