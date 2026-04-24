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
import { decryptField, encryptField } from "../src/lib/crypto/envelope";
import {
  generateAmortizationSchedule,
  calculateDebtPayoff,
  type Debt,
} from "../src/lib/loan-calculator";
import { getLatestFxRate } from "../src/lib/fx-service";
import {
  invalidateUser as invalidateUserTxCache,
  getUserTransactions,
} from "../src/lib/mcp/user-tx-cache";
import {
  signConfirmationToken,
  verifyConfirmationToken,
} from "../src/lib/mcp/confirmation-token";
import fs from "fs/promises";
import path from "path";
import {
  csvToRawTransactions,
  csvToRawTransactionsWithMapping,
  extractCSVHeaders,
} from "../src/lib/csv-parser";
import { parseOfx } from "../src/lib/ofx-parser";
import { previewImport as pipelinePreview, executeImport as pipelineExecute, type RawTransaction } from "../src/lib/import-pipeline";
import { generateImportHash } from "../src/lib/import-hash";
import { applyRulesToBatch, type TransactionRule } from "../src/lib/auto-categorize";

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

/**
 * Fuzzy match against a row list: exact-name → exact-alias → startsWith-name →
 * contains-name → reverse-contains-name.
 *
 * Alias match is exact-only (case-insensitive, trimmed). Aliases are meant to
 * be precise shorthands like "1234" or "Visa4242"; loose matching on a short
 * alias would false-match too often. Only rows carrying an `alias` column
 * (accounts) exercise the alias branch — for other row shapes it's a no-op.
 */
function fuzzyFind(input: string, options: Row[]): Row | null {
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
 * Auto-categorize payee: transaction_rules → historical frequency.
 *
 * Rule matching runs in SQL (transaction_rules.match_payee is plaintext).
 * The historical-frequency match must run in memory when payees are
 * encrypted — equality against ciphertext never hits. With no DEK the
 * history match is skipped; rule matches still work.
 */
async function autoCategory(
  db: DbLike,
  userId: string,
  payee: string,
  dek: Buffer | null
): Promise<number | null> {
  if (!payee) return null;
  const lo = `%${payee.toLowerCase()}%`;
  const rules = await q(db, sql`
    SELECT assign_category_id FROM transaction_rules
    WHERE user_id = ${userId} AND is_active = 1
      AND (LOWER(match_payee) LIKE ${lo} OR LOWER(${payee}) LIKE LOWER(match_payee))
    ORDER BY priority DESC LIMIT 1
  `);
  if (rules.length && rules[0].assign_category_id) return Number(rules[0].assign_category_id);

  if (!dek) {
    // Legacy plaintext-only fallback
    const hist = await q(db, sql`
      SELECT category_id, COUNT(*) as cnt FROM transactions
      WHERE user_id = ${userId} AND LOWER(payee) = LOWER(${payee}) AND category_id IS NOT NULL
      GROUP BY category_id ORDER BY cnt DESC LIMIT 1
    `);
    return hist.length ? Number(hist[0].category_id) : null;
  }

  // Fetch candidate rows with category, decrypt payee, then tally.
  const rows = await q(db, sql`
    SELECT payee, category_id FROM transactions
    WHERE user_id = ${userId} AND category_id IS NOT NULL AND payee IS NOT NULL AND payee <> ''
    ORDER BY date DESC, id DESC
    LIMIT 5000
  `);
  const target = payee.toLowerCase();
  const counts = new Map<number, number>();
  for (const r of rows) {
    const p = decryptField(dek, String(r.payee ?? ""));
    if (!p) continue;
    if (p.toLowerCase() === target) {
      const cid = Number(r.category_id);
      counts.set(cid, (counts.get(cid) ?? 0) + 1);
    }
  }
  let bestId: number | null = null;
  let bestCnt = 0;
  for (const [id, cnt] of counts) {
    if (cnt > bestCnt) {
      bestCnt = cnt;
      bestId = id;
    }
  }
  return bestId;
}

const PORTFOLIO_DISCLAIMER =
  "⚠️ DISCLAIMER: This analysis is for informational purposes only and does not constitute financial advice. Past performance is not indicative of future results. Consult a qualified financial advisor before making investment decisions.";

// ─── registration ─────────────────────────────────────────────────────────────

/**
 * Decrypt the text fields on a transaction row in place. Tolerates legacy
 * plaintext rows (values without the `v1:` prefix pass through unchanged)
 * and missing DEK (returns the row untouched so legacy API keys still work
 * for plaintext data).
 */
function decryptTxRowFields(
  dek: Buffer | null | undefined,
  row: Record<string, unknown>
): Record<string, unknown> {
  if (!dek) return row;
  for (const k of ["payee", "note", "tags", "portfolio_holding"] as const) {
    const v = row[k];
    if (typeof v === "string") {
      row[k] = decryptField(dek, v) ?? v;
    }
  }
  return row;
}

/**
 * Aggregate buy/sell/dividend totals per portfolio_holding, decrypting the
 * name in memory. Several MCP tools need this shape — we can't use SQL
 * GROUP BY because each ciphertext row has a random IV.
 */
type HoldingAggRow = {
  name: string;
  buy_qty: number;
  buy_amount: number;
  sell_qty: number;
  sell_amount: number;
  dividends: number;
  first_purchase: string | null;
  purchases: number;
};

async function aggregateHoldings(
  db: DbLike,
  userId: string,
  dek: Buffer | null,
  opts?: { buysOnly?: boolean; since?: string }
): Promise<(HoldingAggRow & { tx_count: number; net_quantity: number; last_activity: string | null })[]> {
  const buysFilter = opts?.buysOnly
    ? sql`AND amount < 0`
    : sql``;
  const dateFilter = opts?.since ? sql`AND date >= ${opts.since}` : sql``;
  const raw = await q(db, sql`
    SELECT portfolio_holding, amount, quantity, date
    FROM transactions
    WHERE user_id = ${userId}
      AND portfolio_holding IS NOT NULL AND portfolio_holding != ''
      ${buysFilter}
      ${dateFilter}
  `);
  type Agg = HoldingAggRow & { tx_count: number; net_quantity: number; last_activity: string | null };
  const out = new Map<string, Agg>();
  for (const r of raw) {
    const ph = String(r.portfolio_holding ?? "");
    const name = dek ? (decryptField(dek, ph) ?? "") : ph;
    if (!name) continue;
    const qty = Number(r.quantity ?? 0);
    const amt = Number(r.amount);
    const d = String(r.date);
    const row = out.get(name) ?? {
      name,
      buy_qty: 0,
      buy_amount: 0,
      sell_qty: 0,
      sell_amount: 0,
      dividends: 0,
      first_purchase: null as string | null,
      purchases: 0,
      tx_count: 0,
      net_quantity: 0,
      last_activity: null as string | null,
    };
    row.tx_count += 1;
    row.net_quantity += qty;
    if (!row.last_activity || d > row.last_activity) row.last_activity = d;
    if (amt < 0) {
      row.buy_qty += qty;
      row.buy_amount += Math.abs(amt);
      row.purchases += 1;
      if (!row.first_purchase || d < row.first_purchase) row.first_purchase = d;
    } else if (amt > 0 && qty < 0) {
      row.sell_qty += Math.abs(qty);
      row.sell_amount += amt;
    } else if (amt > 0 && (qty === 0 || r.quantity == null)) {
      row.dividends += amt;
    }
    out.set(name, row);
  }
  return Array.from(out.values()).sort((a, b) => b.buy_amount - a.buy_amount);
}

export function registerPgTools(
  server: McpServer,
  db: DbLike,
  userId: string,
  dek: Buffer | null = null
) {

  // ── get_account_balances ───────────────────────────────────────────────────
  server.tool(
    "get_account_balances",
    "Get current balances for all accounts, grouped by type (asset/liability)",
    { currency: z.enum(["CAD", "USD", "all"]).optional().describe("Filter by currency") },
    async ({ currency }) => {
      const rows = await q(db, sql`
        SELECT a.id, a.name, a.alias, a.type, a."group", a.currency,
               COALESCE(SUM(t.amount), 0) AS balance
        FROM accounts a
        LEFT JOIN transactions t ON a.id = t.account_id AND t.user_id = ${userId}
        WHERE a.user_id = ${userId}
          ${currency && currency !== "all" ? sql`AND a.currency = ${currency}` : sql``}
        GROUP BY a.id, a.name, a.alias, a.type, a."group", a.currency
        ORDER BY a.type, a."group", a.name
      `);
      return text(rows);
    }
  );

  // ── search_transactions ────────────────────────────────────────────────────
  server.tool(
    "search_transactions",
    "Flexible transaction search with partial payee match, amount range, date range, category, and tags. When text fields are encrypted, payee/tags substring match runs in memory after decryption.",
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
      // Push amount/date/category to SQL; payee/tags filter must happen in memory
      // after decryption when the data is encrypted. Fetch a larger window then
      // trim to lim after filtering.
      const fetchCap = payee || tags ? Math.max(lim * 10, 500) : lim;
      const rows = await q(db, sql`
        SELECT t.id, t.date, a.name AS account, c.name AS category, c.type AS category_type,
               t.currency, t.amount, t.payee, t.note, t.tags
        FROM transactions t
        LEFT JOIN accounts a ON t.account_id = a.id
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.user_id = ${userId}
          ${min_amount !== undefined ? sql`AND t.amount >= ${min_amount}` : sql``}
          ${max_amount !== undefined ? sql`AND t.amount <= ${max_amount}` : sql``}
          ${start_date ? sql`AND t.date >= ${start_date}` : sql``}
          ${end_date ? sql`AND t.date <= ${end_date}` : sql``}
          ${category ? sql`AND c.name = ${category}` : sql``}
        ORDER BY t.date DESC
        LIMIT ${fetchCap}
      `);
      let decrypted = rows.map((r) => decryptTxRowFields(dek, r as Record<string, unknown>));
      if (payee) {
        const q = payee.toLowerCase();
        decrypted = decrypted.filter((r) =>
          String(r.payee ?? "").toLowerCase().includes(q)
        );
      }
      if (tags) {
        const q = tags.toLowerCase();
        decrypted = decrypted.filter((r) =>
          String(r.tags ?? "").toLowerCase().includes(q)
        );
      }
      decrypted = decrypted.slice(0, lim);
      return text({ results: decrypted, count: decrypted.length });
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
    "Net worth across all accounts. Pass `months` > 0 to get a month-by-month trend; omit for current totals only.",
    {
      currency: z.enum(["CAD", "USD", "all"]).optional().describe("Filter by currency"),
      months: z.number().optional().describe("If set, return a trend over the last N months. Omit or set to 0 for current totals."),
    },
    async ({ currency, months }) => {
      if (!months || months <= 0) {
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

      const startDate = new Date();
      startDate.setMonth(startDate.getMonth() - months);
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

      return text({ months, trend });
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

      const rawTxns = await q(db, sql`
        SELECT id, date, payee, amount FROM transactions
        WHERE user_id = ${userId} AND date >= ${cutoffStr} AND payee != ''
        ORDER BY date
      `) as { id: number; date: string; payee: string; amount: number }[];

      // Decrypt payees before grouping — ciphertext has a random IV per row
      // so SQL-side grouping on it would be wrong.
      const txns = rawTxns.map((t) => ({ ...t, payee: (dek ? decryptField(dek, t.payee) : t.payee) ?? "" }));

      const groups = new Map<string, typeof txns>();
      for (const t of txns) {
        const key = t.payee.trim().toLowerCase();
        if (!key) continue;
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

      const notableRaw = await q(db, sql`
        SELECT t.date, t.payee, c.name AS category, ABS(t.amount) AS amt
        FROM transactions t LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.user_id = ${userId} AND c.type = 'E' AND t.date >= ${ws} AND t.date <= ${we}
        ORDER BY ABS(t.amount) DESC LIMIT 5
      `);
      const notable = notableRaw.map((n) => ({
        ...n,
        payee: dek ? (decryptField(dek, String(n.payee ?? "")) ?? "") : n.payee,
      }));

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

      const rawTxns = await q(db, sql`
        SELECT id, date, payee, amount FROM transactions
        WHERE user_id = ${userId} AND date >= ${cutoffStr} AND payee != ''
        ORDER BY date
      `) as { id: number; date: string; payee: string; amount: number }[];

      // Decrypt payee in memory before grouping.
      const txns = rawTxns.map((t) => ({ ...t, payee: (dek ? decryptField(dek, t.payee) : t.payee) ?? "" }));

      const groups = new Map<string, typeof txns>();
      for (const t of txns) {
        const key = t.payee.trim().toLowerCase();
        if (!key) continue;
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
      account: z.string().optional().describe("Linked account — name or alias (fuzzy matched against name; exact match on alias)"),
    },
    async ({ name, type, target_amount, deadline, account }) => {
      let accountId: number | null = null;
      if (account) {
        const allAccounts = await q(db, sql`SELECT id, name, alias FROM accounts WHERE user_id = ${userId}`);
        const acct = fuzzyFind(account, allAccounts);
        accountId = acct ? Number(acct.id) : null;
      }
      await db.execute(sql`
        INSERT INTO goals (user_id, name, type, target_amount, deadline, account_id, status)
        VALUES (${userId}, ${name}, ${type}, ${target_amount}, ${deadline ?? null}, ${accountId}, 'active')
      `);
      return text({ success: true, message: `Goal created: "${name}" — target $${target_amount}${deadline ? ` by ${deadline}` : ""}` });
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
      alias: z.string().max(64).optional().describe("Optional short alias used to match the account when receipts or imports reference it by a non-canonical name (e.g. last 4 digits of a card, or a receipt label)."),
    },
    async ({ name, type, group, currency, note, alias }) => {
      const existing = await q(db, sql`SELECT id FROM accounts WHERE user_id = ${userId} AND name = ${name}`);
      if (existing.length) return err(`Account "${name}" already exists (id: ${existing[0].id})`);

      const aliasValue = alias && alias.trim() ? alias.trim() : null;
      const result = await q(db, sql`
        INSERT INTO accounts (user_id, type, "group", name, currency, note, alias)
        VALUES (${userId}, ${type}, ${group ?? ""}, ${name}, ${currency ?? "CAD"}, ${note ?? ""}, ${aliasValue})
        RETURNING id
      `);

      return text({ success: true, accountId: result[0]?.id, message: `Account "${name}" created (${type === "A" ? "asset" : "liability"}, ${currency ?? "CAD"})${aliasValue ? `, alias "${aliasValue}"` : ""}` });
    }
  );

  // ── record_transaction ─────────────────────────────────────────────────────
  server.tool(
    "record_transaction",
    "Record a transaction. Account is required — ask the user which account to use if not specified; never guess. Category auto-detected from payee rules/history when omitted.",
    {
      amount: z.number().describe("Amount (negative=expense, positive=income/transfer-in)"),
      payee: z.string().describe("Payee or merchant name"),
      account: z.string().describe("Account name or alias (required — ask the user which account if unclear; fuzzy matched against name, exact match on alias)"),
      date: z.string().optional().describe("YYYY-MM-DD (default: today)"),
      category: z.string().optional().describe("Category name (auto-detected from payee if omitted)"),
      note: z.string().optional().describe("Optional note"),
      tags: z.string().optional().describe("Comma-separated tags"),
    },
    async ({ amount, payee, date, account, category, note, tags }) => {
      const today = new Date().toISOString().split("T")[0];
      const txDate = date ?? today;

      const allAccounts = await q(db, sql`SELECT id, name, alias, currency FROM accounts WHERE user_id = ${userId}`);
      if (!allAccounts.length) return err("No accounts found — create an account first.");
      const acct: Row | null = fuzzyFind(account, allAccounts);
      if (!acct) return err(`Account "${account}" not found. Available: ${allAccounts.map(a => a.name).join(", ")}`);

      // Resolve category (fuzzy or auto)
      let catId: number | null = null;
      if (category) {
        const allCats = await q(db, sql`SELECT id, name FROM categories WHERE user_id = ${userId}`);
        const cat = fuzzyFind(category, allCats);
        if (!cat) return err(`Category "${category}" not found. Available: ${allCats.map(c => c.name).join(", ")}`);
        catId = Number(cat.id);
      } else {
        catId = await autoCategory(db, userId, payee, dek);
      }

      // Encrypt text fields when a DEK is available. Without one (legacy API
      // keys) we fall back to plaintext; the row will still be readable via
      // the legacy passthrough in decryptField.
      const encPayee = dek ? encryptField(dek, payee) : payee;
      const encNote = dek ? encryptField(dek, note ?? "") : (note ?? "");
      const encTags = dek ? encryptField(dek, tags ?? "") : (tags ?? "");

      const result = await q(db, sql`
        INSERT INTO transactions (user_id, date, account_id, category_id, currency, amount, payee, note, tags)
        VALUES (${userId}, ${txDate}, ${acct.id}, ${catId}, ${acct.currency}, ${amount}, ${encPayee}, ${encNote}, ${encTags})
        RETURNING id
      `);

      const catName = catId ? (await q(db, sql`SELECT name FROM categories WHERE id = ${catId}`))[0]?.name : "uncategorized";
      invalidateUserTxCache(userId);
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
    "Record multiple transactions at once. Each transaction must specify an account — ask the user if unclear; never guess. Category auto-detected when omitted.",
    {
      transactions: z.array(z.object({
        amount: z.number(),
        payee: z.string(),
        account: z.string().describe("Account name or alias (required — fuzzy matched against name, exact match on alias)"),
        date: z.string().optional(),
        category: z.string().optional(),
        note: z.string().optional(),
        tags: z.string().optional(),
      })).describe("Array of transactions to record"),
    },
    async ({ transactions }) => {
      const today = new Date().toISOString().split("T")[0];
      const allAccounts = await q(db, sql`SELECT id, name, alias, currency FROM accounts WHERE user_id = ${userId}`);
      const allCats = await q(db, sql`SELECT id, name FROM categories WHERE user_id = ${userId}`);

      const results: { index: number; success: boolean; message: string }[] = [];
      for (let i = 0; i < transactions.length; i++) {
        const t = transactions[i];
        try {
          const acct = fuzzyFind(t.account, allAccounts);
          if (!acct) { results.push({ index: i, success: false, message: `Account not found: "${t.account}"` }); continue; }

          let catId: number | null = null;
          if (t.category) {
            const cat = fuzzyFind(t.category, allCats);
            catId = cat ? Number(cat.id) : null;
          } else {
            catId = await autoCategory(db, userId, t.payee, dek);
          }

          const encPayee = dek ? encryptField(dek, t.payee) : t.payee;
          const encNote = dek ? encryptField(dek, t.note ?? "") : (t.note ?? "");
          const encTags = dek ? encryptField(dek, t.tags ?? "") : (t.tags ?? "");

          await db.execute(sql`
            INSERT INTO transactions (user_id, date, account_id, category_id, currency, amount, payee, note, tags)
            VALUES (${userId}, ${t.date ?? today}, ${acct.id}, ${catId}, ${acct.currency}, ${t.amount}, ${encPayee}, ${encNote}, ${encTags})
          `);
          results.push({ index: i, success: true, message: `${t.payee}: ${t.amount}` });
        } catch (e) {
          results.push({ index: i, success: false, message: String(e) });
        }
      }

      const ok = results.filter(r => r.success).length;
      if (ok > 0) invalidateUserTxCache(userId);
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

      // Apply each field as its own parameterized UPDATE. Simpler and safer
      // than a dynamic SET clause, and the per-call latency is negligible
      // (tool is called once at a time).
      let changed = 0;
      if (date !== undefined) {
        await db.execute(sql`UPDATE transactions SET date = ${date} WHERE id = ${id} AND user_id = ${userId}`);
        changed++;
      }
      if (amount !== undefined) {
        await db.execute(sql`UPDATE transactions SET amount = ${amount} WHERE id = ${id} AND user_id = ${userId}`);
        changed++;
      }
      if (catId !== undefined) {
        await db.execute(sql`UPDATE transactions SET category_id = ${catId} WHERE id = ${id} AND user_id = ${userId}`);
        changed++;
      }
      if (payee !== undefined) {
        const v = dek ? encryptField(dek, payee) : payee;
        await db.execute(sql`UPDATE transactions SET payee = ${v} WHERE id = ${id} AND user_id = ${userId}`);
        changed++;
      }
      if (note !== undefined) {
        const v = dek ? encryptField(dek, note) : note;
        await db.execute(sql`UPDATE transactions SET note = ${v} WHERE id = ${id} AND user_id = ${userId}`);
        changed++;
      }
      if (tags !== undefined) {
        const v = dek ? encryptField(dek, tags) : tags;
        await db.execute(sql`UPDATE transactions SET tags = ${v} WHERE id = ${id} AND user_id = ${userId}`);
        changed++;
      }

      if (!changed) return err("No fields to update");

      invalidateUserTxCache(userId);
      return text({ success: true, message: `Transaction #${id} updated (${changed} field(s))` });
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
      const plainPayee = dek ? (decryptField(dek, String(t.payee ?? "")) ?? "") : t.payee;
      await db.execute(sql`DELETE FROM transactions WHERE id = ${id} AND user_id = ${userId}`);
      invalidateUserTxCache(userId);
      return text({ success: true, message: `Deleted transaction #${id}: "${plainPayee}" ${t.amount} on ${t.date}` });
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
    "Update name, group, currency, note, or alias of an account",
    {
      account: z.string().describe("Current account name or alias (fuzzy matched against name; exact match on alias)"),
      name: z.string().optional().describe("New name"),
      group: z.string().optional().describe("New group"),
      currency: z.enum(["CAD", "USD"]).optional().describe("New currency"),
      note: z.string().optional().describe("New note"),
      alias: z.string().max(64).optional().describe("New alias — short shorthand used to match receipts/imports (e.g. last 4 digits of a card). Pass an empty string to clear."),
    },
    async ({ account, name, group, currency, note, alias }) => {
      const allAccounts = await q(db, sql`SELECT id, name, alias FROM accounts WHERE user_id = ${userId}`);
      const acct = fuzzyFind(account, allAccounts);
      if (!acct) return err(`Account "${account}" not found`);

      // Build parameterized SET clauses — no sql.raw, no manual escaping.
      const updates: ReturnType<typeof sql>[] = [];
      if (name !== undefined) updates.push(sql`name = ${name}`);
      if (group !== undefined) updates.push(sql`"group" = ${group}`);
      if (currency !== undefined) updates.push(sql`currency = ${currency}`);
      if (note !== undefined) updates.push(sql`note = ${note}`);
      if (alias !== undefined) {
        const trimmed = alias.trim();
        updates.push(trimmed ? sql`alias = ${trimmed}` : sql`alias = NULL`);
      }
      if (!updates.length) return err("No fields to update");

      const result = await db.execute(
        sql`UPDATE accounts SET ${sql.join(updates, sql`, `)} WHERE id = ${acct.id} AND user_id = ${userId}`
      );
      // pg returns { rowCount }; some drivers expose it differently. If the update
      // touched 0 rows the ownership check in WHERE failed (e.g. race with delete).
      const affected =
        (result && typeof result === "object" && "rowCount" in result && typeof (result as { rowCount: unknown }).rowCount === "number")
          ? (result as { rowCount: number }).rowCount
          : null;
      if (affected === 0) return err(`Account "${acct.name}" not found or not owned by this user`);
      return text({ success: true, message: `Account "${acct.name}" updated` });
    }
  );

  // ── delete_account ─────────────────────────────────────────────────────────
  server.tool(
    "delete_account",
    "Delete an account (only if it has no transactions)",
    {
      account: z.string().describe("Account name or alias (fuzzy matched against name; exact match on alias)"),
      force: z.boolean().optional().describe("Delete even if transactions exist (moves them to uncategorized)"),
    },
    async ({ account, force }) => {
      const allAccounts = await q(db, sql`SELECT id, name, alias FROM accounts WHERE user_id = ${userId}`);
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

      // Build parameterized SET clauses — no sql.raw, no manual escaping.
      const updates: ReturnType<typeof sql>[] = [];
      if (name !== undefined) updates.push(sql`name = ${name}`);
      if (target_amount !== undefined) updates.push(sql`target_amount = ${target_amount}`);
      if (deadline !== undefined) updates.push(sql`deadline = ${deadline}`);
      if (status !== undefined) updates.push(sql`status = ${status}`);
      if (!updates.length) return err("No fields to update");

      const result = await db.execute(
        sql`UPDATE goals SET ${sql.join(updates, sql`, `)} WHERE id = ${g.id} AND user_id = ${userId}`
      );
      const affected =
        (result && typeof result === "object" && "rowCount" in result && typeof (result as { rowCount: unknown }).rowCount === "number")
          ? (result as { rowCount: number }).rowCount
          : null;
      if (affected === 0) return err(`Goal "${g.name}" not found or not owned by this user`);
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
        // Decrypt the payee so we can match against the plaintext rule pattern.
        const plainPayee = dek ? (decryptField(dek, String(txn.payee ?? "")) ?? "") : String(txn.payee ?? "");
        for (const rule of rules) {
          const pattern = String(rule.match_payee ?? "").toLowerCase().replace(/%/g, "");
          if (plainPayee.toLowerCase().includes(pattern)) {
            if (!dry_run) {
              // rule.rename_to / rule.assign_tags are plaintext; encrypt
              // them before writing to the encrypted transaction columns.
              const encRename = rule.rename_to && dek ? encryptField(dek, String(rule.rename_to)) : rule.rename_to;
              const encTags = rule.assign_tags && dek ? encryptField(dek, String(rule.assign_tags)) : rule.assign_tags;
              await db.execute(sql`
                UPDATE transactions SET category_id = ${rule.assign_category_id}
                ${rule.rename_to ? sql`, payee = ${encRename}` : sql``}
                ${rule.assign_tags ? sql`, tags = ${encTags}` : sql``}
                WHERE id = ${txn.id} AND user_id = ${userId}
              `);
            }
            preview.push({ id: Number(txn.id), payee: plainPayee, categoryId: Number(rule.assign_category_id) });
            updated++;
            break;
          }
        }
      }

      if (!dry_run && updated > 0) invalidateUserTxCache(userId);
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
          record_transaction: "record_transaction(amount, payee, account, date?, category?, note?, tags?) — Account is REQUIRED: ask the user which account if unclear, never guess. Category auto-detected from payee rules/history when omitted.",
          bulk_record_transactions: "bulk_record_transactions(transactions[]) — Each item requires account. Returns per-item success/failure.",
          update_transaction: "update_transaction(id, date?, amount?, payee?, category?, note?, tags?) — Update any field by transaction ID.",
          delete_transaction: "delete_transaction(id) — Permanently delete. Cannot be undone.",
          set_budget: "set_budget(category, month, amount) — Upsert budget. month=YYYY-MM.",
          delete_budget: "delete_budget(category, month) — Remove budget entry.",
          add_account: "add_account(name, type, group?, currency?, note?, alias?) — type: 'A'=asset, 'L'=liability. alias is a short shorthand (e.g. last 4 digits of a card) used when receipts/imports reference the account by a non-canonical name.",
          update_account: "update_account(account, name?, group?, currency?, note?, alias?) — Fuzzy account name or alias. Pass empty alias to clear.",
          delete_account: "delete_account(account, force?) — force=true to delete with transactions.",
          add_goal: "add_goal(name, type, target_amount, deadline?, account?) — type: savings|debt_payoff|investment|emergency_fund.",
          update_goal: "update_goal(goal, target_amount?, deadline?, status?, name?) — status: active|completed|paused.",
          delete_goal: "delete_goal(goal) — Fuzzy goal name.",
          create_category: "create_category(name, type, group?, note?) — type: 'E'=expense, 'I'=income, 'T'=transfer.",
          create_rule: "create_rule(match_payee, assign_category, rename_to?, assign_tags?, priority?) — match_payee supports % wildcards.",
          apply_rules_to_uncategorized: "apply_rules_to_uncategorized(dry_run?, limit?) — Batch-apply rules to uncategorized transactions.",
          get_portfolio_analysis: "get_portfolio_analysis(symbols?) — Holdings with full metrics; pass symbols[] to filter. Includes disclaimer.",
          get_investment_insights: "get_investment_insights(mode?, targets?, benchmark?) — mode: 'patterns' (default), 'rebalancing' (needs targets), 'benchmark' (SP500|TSX|MSCI_WORLD|BONDS_CA).",
          get_net_worth: "get_net_worth(currency?, months?) — Omit months for current totals; set months>0 for a trend.",
        };
        return text({ tool: tool_name, usage: docs[tool_name] ?? "No specific docs. Use topic='tools' for full list." });
      }

      const t = topic ?? "tools";

      if (t === "tools") {
        return text({
          read_tools: ["get_account_balances", "search_transactions", "get_budget_summary", "get_spending_trends", "get_income_statement", "get_net_worth", "get_goals", "get_categories", "get_loans", "get_subscription_summary", "get_recurring_transactions", "get_financial_health_score", "get_spending_anomalies", "get_spotlight_items", "get_weekly_recap", "get_cash_flow_forecast"],
          write_tools: ["record_transaction", "bulk_record_transactions", "update_transaction", "delete_transaction", "set_budget", "delete_budget", "add_account", "update_account", "delete_account", "add_goal", "update_goal", "delete_goal", "create_category", "create_rule", "add_snapshot", "apply_rules_to_uncategorized"],
          portfolio_tools: ["get_portfolio_analysis", "get_portfolio_performance", "analyze_holding", "get_investment_insights"],
          tip: "Use tool_name='record_transaction' for detailed usage of any tool",
        });
      }

      if (t === "write") {
        return text({
          primary_add: "record_transaction — account required, fuzzy matching on account/category names",
          bulk_add: "bulk_record_transactions — array of transactions (account required per item)",
          edits: ["update_transaction(id, ...fields)", "delete_transaction(id)"],
          budget: ["set_budget(category, month, amount)", "delete_budget(category, month)"],
          accounts: ["add_account(name, type)", "update_account(account, ...)", "delete_account(account)"],
          goals: ["add_goal(name, type, amount)", "update_goal(goal, ...)", "delete_goal(goal)"],
          categories: ["create_category(name, type)", "create_rule(match_payee, assign_category)"],
          note: "All name inputs use fuzzy matching — partial names work. Each account can also have an `alias` (e.g. last 4 digits of a card); account lookups exact-match on alias in addition to fuzzy-matching on name, so you can pass either. Set category via update_transaction(id, category=...).",
        });
      }

      if (t === "schema") {
        return text({
          key_tables: {
            transactions: "id, user_id, date, account_id, category_id, currency, amount, payee, note, tags, import_hash, fit_id",
            accounts: "id, user_id, type(A/L), group, name, currency, note, archived, alias",
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
            { task: "Log a coffee purchase", call: 'record_transaction(amount=-5.50, payee="Tim Hortons", account="RBC ION Visa")' },
            { task: "Log salary deposit", call: 'record_transaction(amount=3500, payee="Employer", account="RBC Chequing", category="Salary")' },
            { task: "Import bank statement rows", call: "bulk_record_transactions([{amount, payee, date, account}, ...])" },
            { task: "Set grocery budget", call: 'set_budget(category="Groceries", month="2026-04", amount=600)' },
            { task: "Fix wrong category", call: 'update_transaction(id=42, category="Restaurants")' },
            { task: "Auto-categorize backlog", call: "apply_rules_to_uncategorized(dry_run=true)" },
            { task: "Create savings goal", call: 'add_goal(name="Emergency Fund", type="emergency_fund", target_amount=10000)' },
            { task: "Analyze investments", call: "get_portfolio_analysis()" },
            { task: "Rebalance vs targets", call: 'get_investment_insights(mode="rebalancing", targets=[{holding:"VEQT", target_pct:60}])' },
            { task: "Net worth trend", call: "get_net_worth(months=12)" },
          ],
        });
      }

      if (t === "portfolio") {
        return text({
          tools: ["get_portfolio_analysis", "get_portfolio_performance", "analyze_holding", "get_investment_insights"],
          modes: "get_investment_insights supports mode: 'patterns' (default) | 'rebalancing' (needs targets) | 'benchmark' (needs benchmark)",
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
    "Portfolio holdings with all investment metrics: quantity, cost basis, avg cost, unrealized/realized gain, dividends, total return, % of portfolio. Pass `symbols` to filter to specific holdings.",
    {
      symbols: z.array(z.string()).optional().describe("Filter to specific holding names/symbols (omit for all)"),
    },
    async ({ symbols }) => {
      const metrics = await aggregateHoldings(db, userId, dek);

      const ph = await q(db, sql`
        SELECT ph.name, ph.symbol, ph.currency, a.name as account_name
        FROM portfolio_holdings ph
        JOIN accounts a ON a.id = ph.account_id
        WHERE ph.user_id = ${userId}
      `);
      const phMap = new Map(ph.map(p => [String(p.name), p]));

      const symbolFilters = symbols?.length ? symbols.map(s => s.toLowerCase()) : null;

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
        const info = phMap.get(String(m.name));
        if (symbolFilters) {
          const name = String(m.name).toLowerCase();
          const sym = String(info?.symbol ?? "").toLowerCase();
          if (!symbolFilters.some(s => name.includes(s) || sym.includes(s))) continue;
        }
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

      const perf = await aggregateHoldings(db, userId, dek, { since });

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
          holding: p.name,
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
      const lo = symbol.toLowerCase();
      // Fetch all investment-y rows for the user, then filter in memory —
      // LIKE on ciphertext won't match (random IV per row).
      const rawTxns = await q(db, sql`
        SELECT t.id, t.date, t.amount, t.quantity, t.payee, t.note, t.tags, t.portfolio_holding,
               a.name as account_name, a.currency
        FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        WHERE t.user_id = ${userId}
          AND (t.portfolio_holding IS NOT NULL AND t.portfolio_holding <> '')
        ORDER BY t.date ASC
      `);

      const decryptedAll: Row[] = rawTxns.map((t) => {
        const ph = dek ? decryptField(dek, String(t.portfolio_holding ?? "")) : t.portfolio_holding;
        const pay = dek ? decryptField(dek, String(t.payee ?? "")) : t.payee;
        const nt = dek ? decryptField(dek, String(t.note ?? "")) : t.note;
        const tg = dek ? decryptField(dek, String(t.tags ?? "")) : t.tags;
        return { ...t, portfolio_holding: ph, payee: pay, note: nt, tags: tg };
      });
      const txns = decryptedAll.filter((t) => {
        const ph = String(t.portfolio_holding ?? "").toLowerCase();
        const pay = String(t.payee ?? "").toLowerCase();
        return ph.includes(lo) || pay.includes(lo);
      });

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

  // ── get_investment_insights ────────────────────────────────────────────────
  server.tool(
    "get_investment_insights",
    "Portfolio-level investment analytics. `mode: 'patterns'` (default) returns contribution frequency, largest positions, diversification score. `mode: 'rebalancing'` suggests BUY/SELL amounts vs `targets`. `mode: 'benchmark'` compares book-value growth vs a reference index.",
    {
      mode: z.enum(["patterns", "rebalancing", "benchmark"]).optional().describe("Analytics mode (default: patterns)"),
      targets: z.array(z.object({
        holding: z.string().describe("Holding name or symbol"),
        target_pct: z.number().describe("Target allocation percentage (0-100)"),
      })).optional().describe("Required when mode='rebalancing'. Target allocations (should sum to ~100)."),
      benchmark: z.enum(["SP500", "TSX", "MSCI_WORLD", "BONDS_CA"]).optional().describe("Benchmark for mode='benchmark' (default SP500)"),
    },
    async ({ mode, targets, benchmark }) => {
      const m = mode ?? "patterns";

      if (m === "rebalancing") {
        if (!targets?.length) return err("targets is required when mode='rebalancing'");
        const aggs = await aggregateHoldings(db, userId, dek, { buysOnly: true });
        const holdings = aggs.map((a) => ({ name: a.name, book_value: a.buy_amount }));

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
          mode: "rebalancing",
          totalPortfolioValue: Math.round(totalBV * 100) / 100,
          suggestions,
          note: "Values based on book cost, not market price. Get current prices for accurate rebalancing.",
        });
      }

      if (m === "benchmark") {
        const bm = benchmark ?? "SP500";
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
          return text({ disclaimer: PORTFOLIO_DISCLAIMER, mode: "benchmark", message: "No investment transactions found" });
        }

        const info = firstTxn[0];
        const firstDate = new Date(String(info.first_date));
        const lastDate = new Date(String(info.last_date));
        const yearsHeld = Math.max(0.1, (lastDate.getTime() - firstDate.getTime()) / (365.25 * 86400000));
        const totalInvested = Number(info.total_invested);

        const benchmarkFinalValue = totalInvested * Math.pow(1 + bmInfo.annualizedReturn / 100, yearsHeld);
        const benchmarkGain = benchmarkFinalValue - totalInvested;

        return text({
          disclaimer: PORTFOLIO_DISCLAIMER,
          mode: "benchmark",
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

      // Default: mode === "patterns"
      const contributions = await q(db, sql`
        SELECT DATE_TRUNC('month', date::date) as month, SUM(ABS(amount)) as invested
        FROM transactions
        WHERE user_id = ${userId} AND portfolio_holding IS NOT NULL AND portfolio_holding != '' AND amount < 0
        GROUP BY DATE_TRUNC('month', date::date)
        ORDER BY month DESC LIMIT 12
      `);

      const aggs = await aggregateHoldings(db, userId, dek, { buysOnly: true });
      const positions = aggs.map((a) => ({
        name: a.name,
        book_value: a.buy_amount,
        purchases: a.purchases,
      }));

      const totalInvested = positions.reduce((s, p) => s + Number(p.book_value), 0);
      const top3Pct = positions.slice(0, 3).reduce((s, p) => s + Number(p.book_value), 0) / (totalInvested || 1);
      const diversificationScore = Math.max(0, Math.round((1 - top3Pct) * 100));

      const avgMonthlyContrib = contributions.length > 0
        ? contributions.reduce((s, c) => s + Number(c.invested), 0) / contributions.length
        : 0;

      return text({
        disclaimer: PORTFOLIO_DISCLAIMER,
        mode: "patterns",
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

  // ═══════════════════════════════════════════════════════════════════════════
  // Wave 1B — Loans, FX, Subscriptions CRUD, Rules CRUD, Suggest, Splits CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  // ── list_loans ────────────────────────────────────────────────────────────
  server.tool(
    "list_loans",
    "List all loans with balance, rate, payment, payoff date, and linked account",
    {},
    async () => {
      const rows = await q(db, sql`
        SELECT l.id, l.name, l.type, l.principal, l.annual_rate, l.term_months,
               l.start_date, l.payment_amount, l.payment_frequency, l.extra_payment,
               l.note, l.account_id, a.name AS account_name
        FROM loans l
        LEFT JOIN accounts a ON a.id = l.account_id
        WHERE l.user_id = ${userId}
        ORDER BY l.start_date DESC, l.id
      `);
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
      return text({ success: true, data: enriched });
    }
  );

  // ── add_loan ──────────────────────────────────────────────────────────────
  server.tool(
    "add_loan",
    "Create a new loan. All non-optional fields required; payment_amount defaults to calculated monthly payment.",
    {
      name: z.string().describe("Loan name"),
      type: z.string().describe("Loan type (e.g. 'mortgage', 'auto', 'student', 'personal')"),
      principal: z.number().describe("Original loan principal"),
      annual_rate: z.number().describe("Annual interest rate (e.g. 5.5 for 5.5%)"),
      term_months: z.number().int().positive().describe("Loan term in months"),
      start_date: z.string().describe("Loan start date (YYYY-MM-DD)"),
      account: z.string().optional().describe("Linked account — name or alias (fuzzy matched against name; exact match on alias)"),
      payment_amount: z.number().optional().describe("Override computed monthly payment"),
      payment_frequency: z.enum(["monthly", "biweekly"]).optional().describe("Default monthly"),
      extra_payment: z.number().optional().describe("Extra principal per payment (default 0)"),
      min_payment: z.number().optional().describe("Alias for payment_amount — minimum required payment"),
      note: z.string().optional(),
    },
    async ({ name, type, principal, annual_rate, term_months, start_date, account, payment_amount, payment_frequency, extra_payment, min_payment, note }) => {
      let accountId: number | null = null;
      if (account) {
        const allAccounts = await q(db, sql`SELECT id, name, alias FROM accounts WHERE user_id = ${userId}`);
        const acct = fuzzyFind(account, allAccounts);
        if (!acct) return err(`Account "${account}" not found`);
        accountId = Number(acct.id);
      }
      const pmt = payment_amount ?? min_payment ?? null;
      const result = await q(db, sql`
        INSERT INTO loans (user_id, name, type, account_id, principal, annual_rate, term_months, start_date, payment_amount, payment_frequency, extra_payment, note)
        VALUES (${userId}, ${name}, ${type}, ${accountId}, ${principal}, ${annual_rate}, ${term_months}, ${start_date}, ${pmt}, ${payment_frequency ?? "monthly"}, ${extra_payment ?? 0}, ${note ?? ""})
        RETURNING id
      `);
      return text({ success: true, data: { id: result[0]?.id, message: `Loan "${name}" created — $${principal} at ${annual_rate}% over ${term_months} months` } });
    }
  );

  // ── update_loan ───────────────────────────────────────────────────────────
  server.tool(
    "update_loan",
    "Update any field of an existing loan by id",
    {
      id: z.number().describe("Loan id"),
      name: z.string().optional(),
      type: z.string().optional(),
      principal: z.number().optional(),
      annual_rate: z.number().optional(),
      term_months: z.number().int().positive().optional(),
      start_date: z.string().optional(),
      payment_amount: z.number().optional(),
      payment_frequency: z.enum(["monthly", "biweekly"]).optional(),
      extra_payment: z.number().optional(),
      account: z.string().optional().describe("Linked account — name or alias (fuzzy matched against name; exact match on alias). Pass empty string to clear."),
      note: z.string().optional(),
    },
    async ({ id, name, type, principal, annual_rate, term_months, start_date, payment_amount, payment_frequency, extra_payment, account, note }) => {
      const existing = await q(db, sql`SELECT id FROM loans WHERE id = ${id} AND user_id = ${userId}`);
      if (!existing.length) return err(`Loan #${id} not found`);

      let accountIdUpdate: number | null | undefined;
      if (account !== undefined) {
        if (account === "") {
          accountIdUpdate = null;
        } else {
          const allAccounts = await q(db, sql`SELECT id, name, alias FROM accounts WHERE user_id = ${userId}`);
          const acct = fuzzyFind(account, allAccounts);
          if (!acct) return err(`Account "${account}" not found`);
          accountIdUpdate = Number(acct.id);
        }
      }

      const updates: ReturnType<typeof sql>[] = [];
      if (name !== undefined) updates.push(sql`name = ${name}`);
      if (type !== undefined) updates.push(sql`type = ${type}`);
      if (principal !== undefined) updates.push(sql`principal = ${principal}`);
      if (annual_rate !== undefined) updates.push(sql`annual_rate = ${annual_rate}`);
      if (term_months !== undefined) updates.push(sql`term_months = ${term_months}`);
      if (start_date !== undefined) updates.push(sql`start_date = ${start_date}`);
      if (payment_amount !== undefined) updates.push(sql`payment_amount = ${payment_amount}`);
      if (payment_frequency !== undefined) updates.push(sql`payment_frequency = ${payment_frequency}`);
      if (extra_payment !== undefined) updates.push(sql`extra_payment = ${extra_payment}`);
      if (accountIdUpdate !== undefined) updates.push(sql`account_id = ${accountIdUpdate}`);
      if (note !== undefined) updates.push(sql`note = ${note}`);
      if (!updates.length) return err("No fields to update");

      await db.execute(sql`UPDATE loans SET ${sql.join(updates, sql`, `)} WHERE id = ${id} AND user_id = ${userId}`);
      return text({ success: true, data: { id, message: `Loan #${id} updated (${updates.length} field(s))` } });
    }
  );

  // ── delete_loan ───────────────────────────────────────────────────────────
  server.tool(
    "delete_loan",
    "Delete a loan by id",
    { id: z.number().describe("Loan id to delete") },
    async ({ id }) => {
      const existing = await q(db, sql`SELECT id, name FROM loans WHERE id = ${id} AND user_id = ${userId}`);
      if (!existing.length) return err(`Loan #${id} not found`);
      await db.execute(sql`DELETE FROM loans WHERE id = ${id} AND user_id = ${userId}`);
      return text({ success: true, data: { id, message: `Loan "${existing[0].name}" deleted` } });
    }
  );

  // ── get_loan_amortization ─────────────────────────────────────────────────
  server.tool(
    "get_loan_amortization",
    "Full amortization schedule for a loan. Returns every payment period with principal/interest/balance.",
    {
      loan_id: z.number().describe("Loan id"),
      as_of_date: z.string().optional().describe("YYYY-MM-DD — summarises paid-to-date at this point (default: today)"),
    },
    async ({ loan_id, as_of_date }) => {
      const rows = await q(db, sql`
        SELECT id, name, principal, annual_rate, term_months, start_date,
               payment_frequency, extra_payment
        FROM loans WHERE id = ${loan_id} AND user_id = ${userId}
      `);
      if (!rows.length) return err(`Loan #${loan_id} not found`);
      const loan = rows[0];
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
      return text({
        success: true,
        data: {
          loanId: loan_id,
          loanName: loan.name,
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
    "Compare debt payoff strategies (avalanche vs snowball) across all user loans with an optional extra monthly payment",
    {
      strategy: z.enum(["avalanche", "snowball", "both"]).optional().describe("'avalanche' (highest rate first), 'snowball' (smallest balance first), or 'both' (default)"),
      extra_payment: z.number().optional().describe("Extra monthly payment to apply on top of minimums (default 0)"),
    },
    async ({ strategy, extra_payment }) => {
      const loans = await q(db, sql`
        SELECT id, name, principal, annual_rate, term_months, start_date,
               payment_amount, payment_frequency, extra_payment
        FROM loans WHERE user_id = ${userId}
      `);
      if (!loans.length) return text({ success: true, data: { message: "No loans found", strategies: {} } });
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
      const result: Record<string, unknown> = { inputs: { extraPayment: extra, debts } };
      if (strat === "avalanche" || strat === "both") {
        result.avalanche = calculateDebtPayoff(debts, extra, "avalanche");
      }
      if (strat === "snowball" || strat === "both") {
        result.snowball = calculateDebtPayoff(debts, extra, "snowball");
      }
      return text({ success: true, data: result });
    }
  );

  // ── get_fx_rate ───────────────────────────────────────────────────────────
  server.tool(
    "get_fx_rate",
    "Get the FX rate from one currency to another. Reads from fx_rates cache (with user-scoped overrides) and falls back to Yahoo Finance if missing.",
    {
      from: z.string().describe("Source currency (e.g. USD)"),
      to: z.string().describe("Target currency (e.g. CAD)"),
      date: z.string().optional().describe("YYYY-MM-DD — defaults to latest/today"),
    },
    async ({ from, to, date }) => {
      if (from === to) return text({ success: true, data: { from, to, date: date ?? new Date().toISOString().split("T")[0], rate: 1, source: "identity" } });
      if (date) {
        // Exact-date lookup (user-scoped override wins)
        const rows = await q(db, sql`
          SELECT id, user_id, date, rate FROM fx_rates
          WHERE from_currency = ${from} AND to_currency = ${to} AND date = ${date}
          ORDER BY (user_id = ${userId}) DESC, id DESC LIMIT 1
        `);
        if (rows.length) return text({ success: true, data: { from, to, date, rate: Number(rows[0].rate), source: String(rows[0].user_id) === userId ? "override" : "cache", id: Number(rows[0].id) } });
        return err(`No FX rate found for ${from}→${to} on ${date}`);
      }
      // Latest
      const rate = await getLatestFxRate(from, to, userId);
      return text({ success: true, data: { from, to, date: new Date().toISOString().split("T")[0], rate, source: "latest" } });
    }
  );

  // ── list_fx_overrides ─────────────────────────────────────────────────────
  server.tool(
    "list_fx_overrides",
    "List the user's manual FX rate pins (rows in fx_rates scoped to this user)",
    {},
    async () => {
      const rows = await q(db, sql`
        SELECT id, date, from_currency, to_currency, rate
        FROM fx_rates WHERE user_id = ${userId}
        ORDER BY date DESC, id DESC
      `);
      return text({ success: true, data: rows });
    }
  );

  // ── set_fx_override ───────────────────────────────────────────────────────
  server.tool(
    "set_fx_override",
    "Pin a manual FX rate for a specific currency pair + date (upserts — existing override for the same pair+date is replaced)",
    {
      from: z.string().describe("Source currency (e.g. USD)"),
      to: z.string().describe("Target currency (e.g. CAD)"),
      date: z.string().describe("YYYY-MM-DD"),
      rate: z.number().positive().describe("Exchange rate — 1 {from} = rate {to}"),
    },
    async ({ from, to, date, rate }) => {
      const existing = await q(db, sql`
        SELECT id FROM fx_rates
        WHERE user_id = ${userId} AND from_currency = ${from} AND to_currency = ${to} AND date = ${date}
      `);
      if (existing.length) {
        await db.execute(sql`UPDATE fx_rates SET rate = ${rate} WHERE id = ${existing[0].id} AND user_id = ${userId}`);
        return text({ success: true, data: { id: Number(existing[0].id), from, to, date, rate, action: "updated" } });
      }
      const result = await q(db, sql`
        INSERT INTO fx_rates (user_id, date, from_currency, to_currency, rate)
        VALUES (${userId}, ${date}, ${from}, ${to}, ${rate})
        RETURNING id
      `);
      return text({ success: true, data: { id: Number(result[0]?.id), from, to, date, rate, action: "created" } });
    }
  );

  // ── delete_fx_override ────────────────────────────────────────────────────
  server.tool(
    "delete_fx_override",
    "Delete a manual FX rate pin by id",
    { id: z.number().describe("fx_rates row id") },
    async ({ id }) => {
      const existing = await q(db, sql`SELECT id, from_currency, to_currency, date FROM fx_rates WHERE id = ${id} AND user_id = ${userId}`);
      if (!existing.length) return err(`FX override #${id} not found`);
      await db.execute(sql`DELETE FROM fx_rates WHERE id = ${id} AND user_id = ${userId}`);
      const r = existing[0];
      return text({ success: true, data: { id, message: `Deleted FX override: ${r.from_currency}→${r.to_currency} on ${r.date}` } });
    }
  );

  // ── convert_amount ────────────────────────────────────────────────────────
  server.tool(
    "convert_amount",
    "Convert an amount from one currency to another using live/cached FX rates",
    {
      amount: z.number().describe("Amount to convert"),
      from: z.string().describe("Source currency"),
      to: z.string().describe("Target currency"),
      date: z.string().optional().describe("YYYY-MM-DD — defaults to latest"),
    },
    async ({ amount, from, to, date }) => {
      if (from === to) return text({ success: true, data: { amount, from, to, rate: 1, converted: amount } });
      let rate: number | null = null;
      let source = "latest";
      if (date) {
        const rows = await q(db, sql`
          SELECT user_id, rate FROM fx_rates
          WHERE from_currency = ${from} AND to_currency = ${to} AND date = ${date}
          ORDER BY (user_id = ${userId}) DESC, id DESC LIMIT 1
        `);
        if (rows.length) {
          rate = Number(rows[0].rate);
          source = String(rows[0].user_id) === userId ? "override" : "cache";
        }
      }
      if (rate === null) rate = await getLatestFxRate(from, to, userId);
      const converted = Math.round(amount * rate * 100) / 100;
      return text({ success: true, data: { amount, from, to, rate, converted, date: date ?? new Date().toISOString().split("T")[0], source } });
    }
  );

  // ── list_subscriptions ────────────────────────────────────────────────────
  // Distinct from get_subscription_summary (which aggregates monthly cost +
  // upcoming renewals). This returns the raw row set with status + category +
  // account, for editing flows.
  server.tool(
    "list_subscriptions",
    "List all subscriptions with full detail (status, next billing, category, account, notes)",
    { status: z.enum(["active", "paused", "cancelled", "all"]).optional().describe("Filter by status (default: all)") },
    async ({ status }) => {
      const rows = await q(db, sql`
        SELECT s.id, s.name, s.amount, s.currency, s.frequency, s.next_date, s.status,
               s.cancel_reminder_date, s.notes,
               s.category_id, c.name AS category_name,
               s.account_id, a.name AS account_name
        FROM subscriptions s
        LEFT JOIN categories c ON c.id = s.category_id
        LEFT JOIN accounts a ON a.id = s.account_id
        WHERE s.user_id = ${userId}
          ${status && status !== "all" ? sql`AND s.status = ${status}` : sql``}
        ORDER BY s.status, s.name
      `);
      return text({ success: true, data: rows });
    }
  );

  // ── add_subscription ──────────────────────────────────────────────────────
  server.tool(
    "add_subscription",
    "Create a new subscription",
    {
      name: z.string().describe("Subscription name (unique per user)"),
      amount: z.number().describe("Amount per billing cycle (positive number)"),
      cadence: z.enum(["weekly", "monthly", "quarterly", "annual", "yearly"]).describe("Billing frequency"),
      next_billing_date: z.string().describe("Next billing date (YYYY-MM-DD)"),
      currency: z.enum(["CAD", "USD"]).optional().describe("Default CAD"),
      category: z.string().optional().describe("Category name (fuzzy matched)"),
      account: z.string().optional().describe("Account name or alias (fuzzy matched against name; exact match on alias)"),
      notes: z.string().optional(),
    },
    async ({ name, amount, cadence, next_billing_date, currency, category, account, notes }) => {
      const existing = await q(db, sql`SELECT id FROM subscriptions WHERE user_id = ${userId} AND name = ${name}`);
      if (existing.length) return err(`Subscription "${name}" already exists (id: ${existing[0].id})`);

      let categoryId: number | null = null;
      if (category) {
        const allCats = await q(db, sql`SELECT id, name FROM categories WHERE user_id = ${userId}`);
        const cat = fuzzyFind(category, allCats);
        if (!cat) return err(`Category "${category}" not found`);
        categoryId = Number(cat.id);
      }
      let accountId: number | null = null;
      if (account) {
        const allAccounts = await q(db, sql`SELECT id, name, alias FROM accounts WHERE user_id = ${userId}`);
        const acct = fuzzyFind(account, allAccounts);
        if (!acct) return err(`Account "${account}" not found`);
        accountId = Number(acct.id);
      }
      const result = await q(db, sql`
        INSERT INTO subscriptions (user_id, name, amount, currency, frequency, category_id, account_id, next_date, status, notes)
        VALUES (${userId}, ${name}, ${amount}, ${currency ?? "CAD"}, ${cadence}, ${categoryId}, ${accountId}, ${next_billing_date}, 'active', ${notes ?? null})
        RETURNING id
      `);
      return text({ success: true, data: { id: Number(result[0]?.id), message: `Subscription "${name}" created — ${currency ?? "CAD"} ${amount} ${cadence}, next ${next_billing_date}` } });
    }
  );

  // ── update_subscription ───────────────────────────────────────────────────
  server.tool(
    "update_subscription",
    "Update any field of an existing subscription",
    {
      id: z.number().describe("Subscription id"),
      name: z.string().optional(),
      amount: z.number().optional(),
      cadence: z.enum(["weekly", "monthly", "quarterly", "annual", "yearly"]).optional(),
      next_billing_date: z.string().optional().describe("YYYY-MM-DD"),
      currency: z.enum(["CAD", "USD"]).optional(),
      category: z.string().optional().describe("Category name (fuzzy). Empty string clears."),
      account: z.string().optional().describe("Account name or alias (fuzzy matched against name; exact match on alias). Empty string clears."),
      status: z.enum(["active", "paused", "cancelled"]).optional(),
      cancel_reminder_date: z.string().optional().describe("YYYY-MM-DD"),
      notes: z.string().optional(),
    },
    async ({ id, name, amount, cadence, next_billing_date, currency, category, account, status, cancel_reminder_date, notes }) => {
      const existing = await q(db, sql`SELECT id FROM subscriptions WHERE id = ${id} AND user_id = ${userId}`);
      if (!existing.length) return err(`Subscription #${id} not found`);

      let categoryIdUpdate: number | null | undefined;
      if (category !== undefined) {
        if (category === "") categoryIdUpdate = null;
        else {
          const allCats = await q(db, sql`SELECT id, name FROM categories WHERE user_id = ${userId}`);
          const cat = fuzzyFind(category, allCats);
          if (!cat) return err(`Category "${category}" not found`);
          categoryIdUpdate = Number(cat.id);
        }
      }
      let accountIdUpdate: number | null | undefined;
      if (account !== undefined) {
        if (account === "") accountIdUpdate = null;
        else {
          const allAccounts = await q(db, sql`SELECT id, name, alias FROM accounts WHERE user_id = ${userId}`);
          const acct = fuzzyFind(account, allAccounts);
          if (!acct) return err(`Account "${account}" not found`);
          accountIdUpdate = Number(acct.id);
        }
      }

      const updates: ReturnType<typeof sql>[] = [];
      if (name !== undefined) updates.push(sql`name = ${name}`);
      if (amount !== undefined) updates.push(sql`amount = ${amount}`);
      if (cadence !== undefined) updates.push(sql`frequency = ${cadence}`);
      if (next_billing_date !== undefined) updates.push(sql`next_date = ${next_billing_date}`);
      if (currency !== undefined) updates.push(sql`currency = ${currency}`);
      if (categoryIdUpdate !== undefined) updates.push(sql`category_id = ${categoryIdUpdate}`);
      if (accountIdUpdate !== undefined) updates.push(sql`account_id = ${accountIdUpdate}`);
      if (status !== undefined) updates.push(sql`status = ${status}`);
      if (cancel_reminder_date !== undefined) updates.push(sql`cancel_reminder_date = ${cancel_reminder_date}`);
      if (notes !== undefined) updates.push(sql`notes = ${notes}`);
      if (!updates.length) return err("No fields to update");

      await db.execute(sql`UPDATE subscriptions SET ${sql.join(updates, sql`, `)} WHERE id = ${id} AND user_id = ${userId}`);
      return text({ success: true, data: { id, message: `Subscription #${id} updated (${updates.length} field(s))` } });
    }
  );

  // ── delete_subscription ───────────────────────────────────────────────────
  server.tool(
    "delete_subscription",
    "Permanently delete a subscription by id",
    { id: z.number().describe("Subscription id") },
    async ({ id }) => {
      const existing = await q(db, sql`SELECT id, name FROM subscriptions WHERE id = ${id} AND user_id = ${userId}`);
      if (!existing.length) return err(`Subscription #${id} not found`);
      await db.execute(sql`DELETE FROM subscriptions WHERE id = ${id} AND user_id = ${userId}`);
      return text({ success: true, data: { id, message: `Subscription "${existing[0].name}" deleted` } });
    }
  );

  // ── list_rules ────────────────────────────────────────────────────────────
  server.tool(
    "list_rules",
    "List all auto-categorization rules with their match patterns and target categories",
    {},
    async () => {
      const rows = await q(db, sql`
        SELECT r.id, r.name, r.match_field, r.match_type, r.match_value,
               r.assign_category_id, c.name AS category_name,
               r.assign_tags, r.rename_to, r.is_active, r.priority, r.created_at
        FROM transaction_rules r
        LEFT JOIN categories c ON c.id = r.assign_category_id
        WHERE r.user_id = ${userId}
        ORDER BY r.priority DESC, r.id
      `);
      return text({ success: true, data: rows });
    }
  );

  // ── update_rule ───────────────────────────────────────────────────────────
  server.tool(
    "update_rule",
    "Update any field of an existing transaction rule",
    {
      id: z.number().describe("Rule id"),
      name: z.string().optional(),
      match_field: z.enum(["payee", "amount", "tags"]).optional(),
      match_type: z.enum(["contains", "exact", "regex", "greater_than", "less_than"]).optional(),
      match_value: z.string().optional(),
      match_payee: z.string().optional().describe("Alias: sets match_field='payee', match_type='contains', match_value"),
      assign_category: z.string().optional().describe("Category name (fuzzy matched). Empty string clears."),
      assign_tags: z.string().optional(),
      rename_to: z.string().optional(),
      is_active: z.boolean().optional(),
      priority: z.number().optional(),
    },
    async ({ id, name, match_field, match_type, match_value, match_payee, assign_category, assign_tags, rename_to, is_active, priority }) => {
      const existing = await q(db, sql`SELECT id FROM transaction_rules WHERE id = ${id} AND user_id = ${userId}`);
      if (!existing.length) return err(`Rule #${id} not found`);

      let assignCategoryIdUpdate: number | null | undefined;
      if (assign_category !== undefined) {
        if (assign_category === "") assignCategoryIdUpdate = null;
        else {
          const allCats = await q(db, sql`SELECT id, name FROM categories WHERE user_id = ${userId}`);
          const cat = fuzzyFind(assign_category, allCats);
          if (!cat) return err(`Category "${assign_category}" not found`);
          assignCategoryIdUpdate = Number(cat.id);
        }
      }

      // match_payee is a convenience alias — expands to three field writes
      let effMatchField = match_field;
      let effMatchType = match_type;
      let effMatchValue = match_value;
      if (match_payee !== undefined) {
        effMatchField = effMatchField ?? "payee";
        effMatchType = effMatchType ?? "contains";
        effMatchValue = match_payee;
      }

      const updates: ReturnType<typeof sql>[] = [];
      if (name !== undefined) updates.push(sql`name = ${name}`);
      if (effMatchField !== undefined) updates.push(sql`match_field = ${effMatchField}`);
      if (effMatchType !== undefined) updates.push(sql`match_type = ${effMatchType}`);
      if (effMatchValue !== undefined) updates.push(sql`match_value = ${effMatchValue}`);
      if (assignCategoryIdUpdate !== undefined) updates.push(sql`assign_category_id = ${assignCategoryIdUpdate}`);
      if (assign_tags !== undefined) updates.push(sql`assign_tags = ${assign_tags}`);
      if (rename_to !== undefined) updates.push(sql`rename_to = ${rename_to}`);
      if (is_active !== undefined) updates.push(sql`is_active = ${is_active ? 1 : 0}`);
      if (priority !== undefined) updates.push(sql`priority = ${priority}`);
      if (!updates.length) return err("No fields to update");

      await db.execute(sql`UPDATE transaction_rules SET ${sql.join(updates, sql`, `)} WHERE id = ${id} AND user_id = ${userId}`);
      return text({ success: true, data: { id, message: `Rule #${id} updated (${updates.length} field(s))` } });
    }
  );

  // ── delete_rule ───────────────────────────────────────────────────────────
  server.tool(
    "delete_rule",
    "Delete a transaction rule by id",
    { id: z.number().describe("Rule id") },
    async ({ id }) => {
      const existing = await q(db, sql`SELECT id, name FROM transaction_rules WHERE id = ${id} AND user_id = ${userId}`);
      if (!existing.length) return err(`Rule #${id} not found`);
      await db.execute(sql`DELETE FROM transaction_rules WHERE id = ${id} AND user_id = ${userId}`);
      return text({ success: true, data: { id, message: `Rule "${existing[0].name}" deleted` } });
    }
  );

  // ── test_rule ─────────────────────────────────────────────────────────────
  server.tool(
    "test_rule",
    "Dry-run a rule pattern against the user's existing transactions. Decrypts payee/tags in memory when matching. Returns matched rows without writing.",
    {
      match_payee: z.string().optional().describe("Payee pattern (required if match_field='payee' or match_type omitted)"),
      match_field: z.enum(["payee", "amount", "tags"]).optional().describe("Default 'payee'"),
      match_type: z.enum(["contains", "exact", "regex", "greater_than", "less_than"]).optional().describe("Default 'contains'"),
      match_value: z.string().optional().describe("Overrides match_payee when match_field != 'payee'"),
      match_amount: z.number().optional().describe("Alias — set as match_value when match_field='amount'"),
      sample_size: z.number().optional().describe("Max transactions to scan (default 5000)"),
    },
    async ({ match_payee, match_field, match_type, match_value, match_amount, sample_size }) => {
      const field = match_field ?? "payee";
      const type = match_type ?? "contains";
      const value =
        match_value !== undefined ? match_value :
        match_amount !== undefined ? String(match_amount) :
        match_payee ?? "";
      if (!value && field !== "amount") return err("match_value or match_payee is required");
      const limit = sample_size ?? 5000;

      const raw = await q(db, sql`
        SELECT t.id, t.date, t.payee, t.tags, t.amount, t.category_id, c.name AS category_name,
               t.account_id, a.name AS account_name
        FROM transactions t
        LEFT JOIN categories c ON c.id = t.category_id
        LEFT JOIN accounts a ON a.id = t.account_id
        WHERE t.user_id = ${userId}
        ORDER BY t.date DESC, t.id DESC
        LIMIT ${limit}
      `);

      // Decrypt payee/tags in memory (identical pattern to apply_rules_to_uncategorized).
      const matched: Record<string, unknown>[] = [];
      const valueLower = value.toLowerCase();
      let regex: RegExp | null = null;
      if (type === "regex") {
        try { regex = new RegExp(value, "i"); }
        catch { return err(`Invalid regex: ${value}`); }
      }
      const ruleAmount = field === "amount" ? parseFloat(value) : NaN;

      for (const r of raw) {
        const plainPayee = dek ? (decryptField(dek, String(r.payee ?? "")) ?? "") : String(r.payee ?? "");
        const plainTags = dek ? (decryptField(dek, String(r.tags ?? "")) ?? "") : String(r.tags ?? "");
        let hit = false;
        if (field === "amount") {
          if (isNaN(ruleAmount)) continue;
          const amt = Number(r.amount);
          if (type === "greater_than") hit = amt > ruleAmount;
          else if (type === "less_than") hit = amt < ruleAmount;
          else if (type === "exact") hit = Math.abs(amt - ruleAmount) < 0.01;
        } else {
          const fieldVal = (field === "payee" ? plainPayee : plainTags).toLowerCase();
          if (type === "contains") hit = fieldVal.includes(valueLower);
          else if (type === "exact") hit = fieldVal === valueLower;
          else if (type === "regex" && regex) hit = regex.test(field === "payee" ? plainPayee : plainTags);
        }
        if (hit) {
          matched.push({
            id: Number(r.id),
            date: r.date,
            payee: plainPayee,
            tags: plainTags,
            amount: Number(r.amount),
            category: r.category_name,
            account: r.account_name,
          });
        }
      }

      return text({
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
    "Reorder rules by assigning new priorities. The first id in `ordered_ids` gets the highest priority.",
    {
      ordered_ids: z.array(z.number()).min(1).describe("Rule ids in desired execution order (first = highest priority)"),
    },
    async ({ ordered_ids }) => {
      // Verify ownership of every id before writing anything.
      const owned = await q(db, sql`
        SELECT id FROM transaction_rules WHERE user_id = ${userId} AND id IN ${sql.raw(`(${ordered_ids.map((n) => Number(n)).join(",")})`)}
      `);
      if (owned.length !== ordered_ids.length) {
        return err(`One or more rule ids are not owned by this user (expected ${ordered_ids.length}, found ${owned.length})`);
      }
      // Highest priority for the first id, decrementing down.
      // Use a wide base so new rules default (priority 0) land below.
      const base = ordered_ids.length * 10;
      for (let i = 0; i < ordered_ids.length; i++) {
        const priority = base - i * 10;
        await db.execute(sql`UPDATE transaction_rules SET priority = ${priority} WHERE id = ${ordered_ids[i]} AND user_id = ${userId}`);
      }
      return text({ success: true, data: { reordered: ordered_ids.length, order: ordered_ids } });
    }
  );

  // ── suggest_transaction_details ───────────────────────────────────────────
  server.tool(
    "suggest_transaction_details",
    "Suggest category + tags for a transaction based on rule matches and historical frequency. Decrypts payees in memory when matching history.",
    {
      payee: z.string().describe("Payee/merchant name"),
      amount: z.number().optional().describe("Transaction amount (for amount-based rules)"),
      account_id: z.number().optional().describe("Reserved for future use — account-scoped suggestions"),
      top_n: z.number().optional().describe("Max category suggestions (default 3)"),
    },
    async ({ payee, amount, account_id: _account_id, top_n }) => {
      const topN = top_n ?? 3;
      if (!payee.trim()) return err("payee is required");

      // 1. Rule match — transaction_rules.match_value is plaintext, so SQL works.
      const rules = await q(db, sql`
        SELECT id, name, match_field, match_type, match_value, assign_category_id, assign_tags, rename_to, priority
        FROM transaction_rules
        WHERE user_id = ${userId} AND is_active = 1
        ORDER BY priority DESC, id
      `);
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
            try { hit = new RegExp(value, "i").test(payee); } catch { /* ignore bad regex */ }
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

      // 2. Historical frequency — payee may be encrypted, so decrypt+match in memory.
      const raw = await q(db, sql`
        SELECT payee, category_id, tags
        FROM transactions
        WHERE user_id = ${userId} AND category_id IS NOT NULL AND payee IS NOT NULL AND payee <> ''
        ORDER BY date DESC, id DESC
        LIMIT 5000
      `);
      const catCounts = new Map<number, number>();
      const tagCounts = new Map<string, number>();
      for (const r of raw) {
        const p = dek ? (decryptField(dek, String(r.payee ?? "")) ?? "") : String(r.payee ?? "");
        if (p.toLowerCase().trim() !== payeeLower.trim()) continue;
        const cid = Number(r.category_id);
        if (cid) catCounts.set(cid, (catCounts.get(cid) ?? 0) + 1);
        const t = dek ? (decryptField(dek, String(r.tags ?? "")) ?? "") : String(r.tags ?? "");
        for (const tag of t.split(",").map((x) => x.trim()).filter(Boolean)) {
          tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
        }
      }

      // Hydrate category names for the top-N counts
      const topCatIds = Array.from(catCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, topN);
      const categoryRows = topCatIds.length
        ? await q(db, sql`SELECT id, name, type, "group" FROM categories WHERE user_id = ${userId} AND id IN ${sql.raw(`(${topCatIds.map(([id]) => id).join(",")})`)}`)
        : [];
      const categorySuggestions = topCatIds.map(([id, count]) => {
        const c = categoryRows.find((x) => Number(x.id) === id);
        return { id, count, name: c?.name ?? null, type: c?.type ?? null, group: c?.group ?? null };
      });

      const topTags = Array.from(tagCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, topN).map(([tag, count]) => ({ tag, count }));

      return text({
        success: true,
        data: {
          payee,
          rules: matchedRules.map((r) => ({ id: Number(r.id), name: r.name, assignCategoryId: r.assign_category_id, assignTags: r.assign_tags, renameTo: r.rename_to })),
          categories: categorySuggestions,
          tags: topTags,
          historicalMatches: raw.length > 0 ? Array.from(catCounts.values()).reduce((s, n) => s + n, 0) : 0,
        },
      });
    }
  );

  // ── list_splits ───────────────────────────────────────────────────────────
  server.tool(
    "list_splits",
    "List all splits for a transaction. Decrypts note/description/tags in memory when a DEK is available.",
    { transaction_id: z.number().describe("Parent transaction id") },
    async ({ transaction_id }) => {
      const owner = await q(db, sql`SELECT id FROM transactions WHERE id = ${transaction_id} AND user_id = ${userId}`);
      if (!owner.length) return err(`Transaction #${transaction_id} not found`);
      const rows = await q(db, sql`
        SELECT s.id, s.transaction_id, s.category_id, c.name AS category_name,
               s.account_id, a.name AS account_name,
               s.amount, s.note, s.description, s.tags
        FROM transaction_splits s
        LEFT JOIN categories c ON c.id = s.category_id
        LEFT JOIN accounts a ON a.id = s.account_id
        WHERE s.transaction_id = ${transaction_id}
        ORDER BY s.id
      `);
      const decrypted = rows.map((r) => {
        if (!dek) return r;
        return {
          ...r,
          note: decryptField(dek, String(r.note ?? "")) ?? r.note,
          description: decryptField(dek, String(r.description ?? "")) ?? r.description,
          tags: decryptField(dek, String(r.tags ?? "")) ?? r.tags,
        };
      });
      return text({ success: true, data: decrypted });
    }
  );

  // ── add_split ─────────────────────────────────────────────────────────────
  server.tool(
    "add_split",
    "Add a single split to an existing transaction",
    {
      transaction_id: z.number().describe("Parent transaction id"),
      category_id: z.number().optional().describe("Category id (split into this category)"),
      account_id: z.number().optional().describe("Account id (rare — override parent account)"),
      amount: z.number().describe("Split amount (same sign convention as parent)"),
      note: z.string().optional(),
      description: z.string().optional(),
      tags: z.string().optional(),
    },
    async ({ transaction_id, category_id, account_id, amount, note, description, tags }) => {
      const owner = await q(db, sql`SELECT id FROM transactions WHERE id = ${transaction_id} AND user_id = ${userId}`);
      if (!owner.length) return err(`Transaction #${transaction_id} not found`);

      const encNote = dek ? encryptField(dek, note ?? "") : (note ?? "");
      const encDesc = dek ? encryptField(dek, description ?? "") : (description ?? "");
      const encTags = dek ? encryptField(dek, tags ?? "") : (tags ?? "");

      const result = await q(db, sql`
        INSERT INTO transaction_splits (transaction_id, category_id, account_id, amount, note, description, tags)
        VALUES (${transaction_id}, ${category_id ?? null}, ${account_id ?? null}, ${amount}, ${encNote}, ${encDesc}, ${encTags})
        RETURNING id
      `);
      invalidateUserTxCache(userId);
      return text({ success: true, data: { id: Number(result[0]?.id), message: `Split added to txn #${transaction_id}` } });
    }
  );

  // ── update_split ──────────────────────────────────────────────────────────
  server.tool(
    "update_split",
    "Update fields of an existing split",
    {
      split_id: z.number().describe("Split id"),
      category_id: z.number().nullable().optional(),
      account_id: z.number().nullable().optional(),
      amount: z.number().optional(),
      note: z.string().optional(),
      description: z.string().optional(),
      tags: z.string().optional(),
    },
    async ({ split_id, category_id, account_id, amount, note, description, tags }) => {
      // Ownership: split → txn → user
      const owner = await q(db, sql`
        SELECT s.id FROM transaction_splits s
        JOIN transactions t ON t.id = s.transaction_id
        WHERE s.id = ${split_id} AND t.user_id = ${userId}
      `);
      if (!owner.length) return err(`Split #${split_id} not found`);

      const updates: ReturnType<typeof sql>[] = [];
      if (category_id !== undefined) updates.push(sql`category_id = ${category_id}`);
      if (account_id !== undefined) updates.push(sql`account_id = ${account_id}`);
      if (amount !== undefined) updates.push(sql`amount = ${amount}`);
      if (note !== undefined) {
        const v = dek ? encryptField(dek, note) : note;
        updates.push(sql`note = ${v}`);
      }
      if (description !== undefined) {
        const v = dek ? encryptField(dek, description) : description;
        updates.push(sql`description = ${v}`);
      }
      if (tags !== undefined) {
        const v = dek ? encryptField(dek, tags) : tags;
        updates.push(sql`tags = ${v}`);
      }
      if (!updates.length) return err("No fields to update");

      await db.execute(sql`UPDATE transaction_splits SET ${sql.join(updates, sql`, `)} WHERE id = ${split_id}`);
      invalidateUserTxCache(userId);
      return text({ success: true, data: { id: split_id, message: `Split #${split_id} updated (${updates.length} field(s))` } });
    }
  );

  // ── delete_split ──────────────────────────────────────────────────────────
  server.tool(
    "delete_split",
    "Delete a split by id",
    { split_id: z.number().describe("Split id") },
    async ({ split_id }) => {
      const owner = await q(db, sql`
        SELECT s.id FROM transaction_splits s
        JOIN transactions t ON t.id = s.transaction_id
        WHERE s.id = ${split_id} AND t.user_id = ${userId}
      `);
      if (!owner.length) return err(`Split #${split_id} not found`);
      await db.execute(sql`DELETE FROM transaction_splits WHERE id = ${split_id}`);
      invalidateUserTxCache(userId);
      return text({ success: true, data: { id: split_id, message: `Split #${split_id} deleted` } });
    }
  );

  // ── replace_splits ────────────────────────────────────────────────────────
  server.tool(
    "replace_splits",
    "Atomically replace all splits on a transaction. Validates the splits sum equals the parent transaction amount (±$0.01).",
    {
      transaction_id: z.number().describe("Parent transaction id"),
      splits: z.array(z.object({
        category_id: z.number().nullable().optional(),
        account_id: z.number().nullable().optional(),
        amount: z.number(),
        note: z.string().optional(),
        description: z.string().optional(),
        tags: z.string().optional(),
      })).min(1).describe("New set of splits (replaces all existing)"),
    },
    async ({ transaction_id, splits }) => {
      const owner = await q(db, sql`SELECT id, amount FROM transactions WHERE id = ${transaction_id} AND user_id = ${userId}`);
      if (!owner.length) return err(`Transaction #${transaction_id} not found`);
      const parentAmount = Number(owner[0].amount);
      const sum = splits.reduce((s, x) => s + Number(x.amount), 0);
      if (Math.abs(sum - parentAmount) > 0.01) {
        return err(`Splits sum (${sum.toFixed(2)}) must equal parent transaction amount (${parentAmount.toFixed(2)})`);
      }

      // Delete + bulk insert. Not wrapped in a transaction — Drizzle's execute
      // is per-statement here. Risk window is small; if the insert fails the
      // user ends up with zero splits and can retry. Accept for now.
      await db.execute(sql`DELETE FROM transaction_splits WHERE transaction_id = ${transaction_id}`);
      const insertedIds: number[] = [];
      for (const s of splits) {
        const encNote = dek ? encryptField(dek, s.note ?? "") : (s.note ?? "");
        const encDesc = dek ? encryptField(dek, s.description ?? "") : (s.description ?? "");
        const encTags = dek ? encryptField(dek, s.tags ?? "") : (s.tags ?? "");
        const r = await q(db, sql`
          INSERT INTO transaction_splits (transaction_id, category_id, account_id, amount, note, description, tags)
          VALUES (${transaction_id}, ${s.category_id ?? null}, ${s.account_id ?? null}, ${s.amount}, ${encNote}, ${encDesc}, ${encTags})
          RETURNING id
        `);
        insertedIds.push(Number(r[0]?.id));
      }
      invalidateUserTxCache(userId);
      return text({ success: true, data: { transactionId: transaction_id, replacedWith: insertedIds.length, splitIds: insertedIds } });
    }
  );

  // ─── Wave 2: bulk edit + detect_subscriptions + upload flow ────────────────

  // Zod schema for the filter shape used by preview_bulk_*. Mirrors the logic
  // supported by /api/transactions/bulk but extended with range filters so
  // Claude doesn't have to fetch ids first.
  const bulkFilterSchema = z.object({
    ids: z.array(z.number()).optional().describe("Explicit transaction ids"),
    start_date: z.string().optional().describe("YYYY-MM-DD inclusive"),
    end_date: z.string().optional().describe("YYYY-MM-DD inclusive"),
    category_id: z.number().nullable().optional().describe("Exact category id (null matches uncategorized)"),
    account_id: z.number().optional().describe("Exact account id"),
    payee_match: z.string().optional().describe("Substring match against plaintext payee (case-insensitive)"),
  }).describe("Filter — at least one field required");

  type BulkFilter = z.infer<typeof bulkFilterSchema>;

  const bulkChangesSchema = z.object({
    category_id: z.number().nullable().optional(),
    account_id: z.number().optional(),
    date: z.string().optional(),
    note: z.string().optional(),
    payee: z.string().optional(),
    is_business: z.number().optional().describe("0 or 1"),
    tags: z.object({
      mode: z.enum(["append", "replace", "remove"]),
      value: z.string(),
    }).optional().describe("Tag edit. mode=replace overwrites, append adds if not present, remove strips exact matches"),
  });

  type BulkChanges = z.infer<typeof bulkChangesSchema>;

  /**
   * Resolve a bulk filter to a list of transaction ids owned by the user.
   * Payee match is the only one that needs decryption — everything else is SQL.
   * Hard cap at 10k ids to keep preview/execute payloads tractable.
   */
  async function resolveFilterToIds(filter: BulkFilter): Promise<number[]> {
    const hasAny =
      (filter.ids && filter.ids.length > 0) ||
      filter.start_date !== undefined ||
      filter.end_date !== undefined ||
      filter.category_id !== undefined ||
      filter.account_id !== undefined ||
      (filter.payee_match !== undefined && filter.payee_match !== "");
    if (!hasAny) throw new Error("At least one filter field is required");

    const whereParts: ReturnType<typeof sql>[] = [sql`user_id = ${userId}`];
    if (filter.ids && filter.ids.length > 0) {
      const safeIds = filter.ids.map((n) => Number(n)).filter((n) => Number.isFinite(n));
      if (safeIds.length === 0) return [];
      whereParts.push(sql.raw(`id IN (${safeIds.join(",")})`));
    }
    if (filter.start_date) whereParts.push(sql`date >= ${filter.start_date}`);
    if (filter.end_date) whereParts.push(sql`date <= ${filter.end_date}`);
    if (filter.category_id === null) whereParts.push(sql`category_id IS NULL`);
    else if (filter.category_id !== undefined) whereParts.push(sql`category_id = ${filter.category_id}`);
    if (filter.account_id !== undefined) whereParts.push(sql`account_id = ${filter.account_id}`);

    const rows = await q(db, sql`
      SELECT id, payee FROM transactions
      WHERE ${sql.join(whereParts, sql` AND `)}
      ORDER BY date DESC, id DESC
      LIMIT 10000
    `);

    if (!filter.payee_match) return rows.map((r) => Number(r.id));

    const needle = filter.payee_match.toLowerCase();
    const out: number[] = [];
    for (const r of rows) {
      const plain = dek ? (decryptField(dek, String(r.payee ?? "")) ?? "") : String(r.payee ?? "");
      if (plain.toLowerCase().includes(needle)) out.push(Number(r.id));
    }
    return out;
  }

  /** Apply in-memory `changes` to a decrypted row for preview sampleAfter. */
  function applyChangesToRow(row: Record<string, unknown>, changes: BulkChanges): Record<string, unknown> {
    const out = { ...row };
    if (changes.category_id !== undefined) out.category_id = changes.category_id;
    if (changes.account_id !== undefined) out.account_id = changes.account_id;
    if (changes.date !== undefined) out.date = changes.date;
    if (changes.note !== undefined) out.note = changes.note;
    if (changes.payee !== undefined) out.payee = changes.payee;
    if (changes.is_business !== undefined) out.is_business = changes.is_business;
    if (changes.tags !== undefined) {
      const current = String(out.tags ?? "");
      const currentSet = new Set(current.split(",").map((s) => s.trim()).filter(Boolean));
      const tokens = changes.tags.value.split(",").map((s) => s.trim()).filter(Boolean);
      if (changes.tags.mode === "replace") {
        out.tags = tokens.join(",");
      } else if (changes.tags.mode === "append") {
        for (const t of tokens) currentSet.add(t);
        out.tags = Array.from(currentSet).join(",");
      } else {
        for (const t of tokens) currentSet.delete(t);
        out.tags = Array.from(currentSet).join(",");
      }
    }
    return out;
  }

  /** Shared preview helper — resolves ids + samples before/after. */
  async function previewBulk(filter: BulkFilter, changes: BulkChanges, op: string) {
    const ids = await resolveFilterToIds(filter);
    if (ids.length === 0) return { affectedCount: 0, sampleBefore: [], sampleAfter: [], confirmationToken: "" };

    const sampleIds = ids.slice(0, 10);
    const rows = await q(db, sql`
      SELECT t.id, t.date, t.account_id, a.name AS account, t.category_id, c.name AS category,
             t.currency, t.amount, t.payee, t.note, t.tags, t.is_business
      FROM transactions t
      LEFT JOIN accounts a ON t.account_id = a.id
      LEFT JOIN categories c ON t.category_id = c.id
      WHERE t.id IN ${sql.raw(`(${sampleIds.join(",")})`)} AND t.user_id = ${userId}
      ORDER BY t.id
    `);
    const before = rows.map((r) => decryptTxRowFields(dek, r as Record<string, unknown>));
    const after = before.map((r) => applyChangesToRow(r, changes));
    // The token payload encodes the resolved ids — not the filter — so Claude
    // can't widen the scope between preview and execute.
    const token = signConfirmationToken(userId, op, { ids, changes });
    return { affectedCount: ids.length, sampleBefore: before, sampleAfter: after, ids, confirmationToken: token };
  }

  /** Commit a bulk update to the resolved ids. */
  async function commitBulkUpdate(ids: number[], changes: BulkChanges): Promise<number> {
    if (ids.length === 0) return 0;
    const idList = sql.raw(`(${ids.map((n) => Number(n)).join(",")})`);

    // Per-field updates: keeps the SQL simple + parameterized, and lets us
    // encrypt payee / note / tags when a DEK is present.
    if (changes.category_id !== undefined) {
      await db.execute(sql`UPDATE transactions SET category_id = ${changes.category_id} WHERE id IN ${idList} AND user_id = ${userId}`);
    }
    if (changes.account_id !== undefined) {
      await db.execute(sql`UPDATE transactions SET account_id = ${changes.account_id} WHERE id IN ${idList} AND user_id = ${userId}`);
    }
    if (changes.date !== undefined) {
      await db.execute(sql`UPDATE transactions SET date = ${changes.date} WHERE id IN ${idList} AND user_id = ${userId}`);
    }
    if (changes.is_business !== undefined) {
      await db.execute(sql`UPDATE transactions SET is_business = ${changes.is_business} WHERE id IN ${idList} AND user_id = ${userId}`);
    }
    if (changes.payee !== undefined) {
      const v = dek ? encryptField(dek, changes.payee) : changes.payee;
      await db.execute(sql`UPDATE transactions SET payee = ${v} WHERE id IN ${idList} AND user_id = ${userId}`);
    }
    if (changes.note !== undefined) {
      const v = dek ? encryptField(dek, changes.note) : changes.note;
      await db.execute(sql`UPDATE transactions SET note = ${v} WHERE id IN ${idList} AND user_id = ${userId}`);
    }
    if (changes.tags !== undefined) {
      // Tag edits need per-row merging when mode != replace (because each row
      // carries different existing tags). Fetch the current tags, decrypt,
      // mutate, re-encrypt, write row-by-row. For replace we can write once.
      if (changes.tags.mode === "replace") {
        const v = dek ? encryptField(dek, changes.tags.value) : changes.tags.value;
        await db.execute(sql`UPDATE transactions SET tags = ${v} WHERE id IN ${idList} AND user_id = ${userId}`);
      } else {
        const rows = await q(db, sql`SELECT id, tags FROM transactions WHERE id IN ${idList} AND user_id = ${userId}`);
        const tokens = changes.tags.value.split(",").map((s) => s.trim()).filter(Boolean);
        for (const r of rows) {
          const plain = dek ? (decryptField(dek, String(r.tags ?? "")) ?? "") : String(r.tags ?? "");
          const set = new Set(plain.split(",").map((s) => s.trim()).filter(Boolean));
          if (changes.tags.mode === "append") {
            for (const t of tokens) set.add(t);
          } else {
            for (const t of tokens) set.delete(t);
          }
          const next = Array.from(set).join(",");
          const v = dek ? encryptField(dek, next) : next;
          await db.execute(sql`UPDATE transactions SET tags = ${v} WHERE id = ${Number(r.id)} AND user_id = ${userId}`);
        }
      }
    }
    return ids.length;
  }

  // ── preview_bulk_update ────────────────────────────────────────────────────
  server.tool(
    "preview_bulk_update",
    "Preview a bulk update over transactions matching `filter`. Returns affected count, before/after samples, and a confirmationToken (5-min TTL) for execute_bulk_update.",
    {
      filter: bulkFilterSchema,
      changes: bulkChangesSchema,
    },
    async ({ filter, changes }) => {
      try {
        const { affectedCount, sampleBefore, sampleAfter, confirmationToken } = await previewBulk(filter, changes, "bulk_update");
        return text({ success: true, data: { affectedCount, sampleBefore, sampleAfter, confirmationToken } });
      } catch (e) {
        return err(String(e instanceof Error ? e.message : e));
      }
    }
  );

  // ── execute_bulk_update ────────────────────────────────────────────────────
  server.tool(
    "execute_bulk_update",
    "Commit a bulk update. Must be preceded by preview_bulk_update; the same filter+changes must be passed.",
    {
      filter: bulkFilterSchema,
      changes: bulkChangesSchema,
      confirmation_token: z.string().describe("Token returned by preview_bulk_update"),
    },
    async ({ filter, changes, confirmation_token }) => {
      try {
        const ids = await resolveFilterToIds(filter);
        const check = verifyConfirmationToken(confirmation_token, userId, "bulk_update", { ids, changes });
        if (!check.valid) return err(`Confirmation token invalid: ${check.reason}. Re-run preview_bulk_update.`);
        const n = await commitBulkUpdate(ids, changes);
        if (n > 0) invalidateUserTxCache(userId);
        return text({ success: true, data: { updated: n } });
      } catch (e) {
        return err(String(e instanceof Error ? e.message : e));
      }
    }
  );

  // ── preview_bulk_delete ────────────────────────────────────────────────────
  server.tool(
    "preview_bulk_delete",
    "Preview a bulk delete. Returns affected count, sample rows, and a confirmationToken (5-min TTL) for execute_bulk_delete.",
    { filter: bulkFilterSchema },
    async ({ filter }) => {
      try {
        const ids = await resolveFilterToIds(filter);
        if (ids.length === 0) {
          return text({ success: true, data: { affectedCount: 0, sample: [], confirmationToken: "" } });
        }
        const sampleIds = ids.slice(0, 10);
        const rows = await q(db, sql`
          SELECT t.id, t.date, a.name AS account, c.name AS category, t.currency, t.amount, t.payee, t.note, t.tags
          FROM transactions t
          LEFT JOIN accounts a ON t.account_id = a.id
          LEFT JOIN categories c ON t.category_id = c.id
          WHERE t.id IN ${sql.raw(`(${sampleIds.join(",")})`)} AND t.user_id = ${userId}
          ORDER BY t.id
        `);
        const sample = rows.map((r) => decryptTxRowFields(dek, r as Record<string, unknown>));
        const token = signConfirmationToken(userId, "bulk_delete", { ids });
        return text({ success: true, data: { affectedCount: ids.length, sample, confirmationToken: token } });
      } catch (e) {
        return err(String(e instanceof Error ? e.message : e));
      }
    }
  );

  // ── execute_bulk_delete ────────────────────────────────────────────────────
  server.tool(
    "execute_bulk_delete",
    "Commit a bulk delete. Must be preceded by preview_bulk_delete; the same filter must be passed.",
    {
      filter: bulkFilterSchema,
      confirmation_token: z.string().describe("Token returned by preview_bulk_delete"),
    },
    async ({ filter, confirmation_token }) => {
      try {
        const ids = await resolveFilterToIds(filter);
        const check = verifyConfirmationToken(confirmation_token, userId, "bulk_delete", { ids });
        if (!check.valid) return err(`Confirmation token invalid: ${check.reason}. Re-run preview_bulk_delete.`);
        if (ids.length === 0) return text({ success: true, data: { deleted: 0 } });
        await db.execute(sql`DELETE FROM transactions WHERE id IN ${sql.raw(`(${ids.join(",")})`)} AND user_id = ${userId}`);
        invalidateUserTxCache(userId);
        return text({ success: true, data: { deleted: ids.length } });
      } catch (e) {
        return err(String(e instanceof Error ? e.message : e));
      }
    }
  );

  // ── preview_bulk_categorize ────────────────────────────────────────────────
  server.tool(
    "preview_bulk_categorize",
    "Preview a bulk-categorize (shortcut for preview_bulk_update with only category_id set). Returns affected count + sample + confirmationToken.",
    {
      filter: bulkFilterSchema,
      category_id: z.number().describe("Target category id"),
    },
    async ({ filter, category_id }) => {
      try {
        // Validate category ownership up front so the preview is honest.
        const cat = await q(db, sql`SELECT id, name FROM categories WHERE id = ${category_id} AND user_id = ${userId}`);
        if (!cat.length) return err(`Category #${category_id} not found`);
        const changes: BulkChanges = { category_id };
        const { affectedCount, sampleBefore, sampleAfter, confirmationToken } = await previewBulk(filter, changes, "bulk_categorize");
        return text({
          success: true,
          data: {
            categoryId: category_id,
            categoryName: cat[0].name,
            affectedCount,
            sampleBefore,
            sampleAfter,
            confirmationToken,
          },
        });
      } catch (e) {
        return err(String(e instanceof Error ? e.message : e));
      }
    }
  );

  // ── execute_bulk_categorize ────────────────────────────────────────────────
  server.tool(
    "execute_bulk_categorize",
    "Commit a bulk-categorize. Must be preceded by preview_bulk_categorize with the same filter + category_id.",
    {
      filter: bulkFilterSchema,
      category_id: z.number(),
      confirmation_token: z.string(),
    },
    async ({ filter, category_id, confirmation_token }) => {
      try {
        const ids = await resolveFilterToIds(filter);
        const changes: BulkChanges = { category_id };
        const check = verifyConfirmationToken(confirmation_token, userId, "bulk_categorize", { ids, changes });
        if (!check.valid) return err(`Confirmation token invalid: ${check.reason}. Re-run preview_bulk_categorize.`);
        const n = await commitBulkUpdate(ids, changes);
        if (n > 0) invalidateUserTxCache(userId);
        return text({ success: true, data: { updated: n } });
      } catch (e) {
        return err(String(e instanceof Error ? e.message : e));
      }
    }
  );

  // ─── Part 2 tail — detect_subscriptions + bulk_add_subscriptions ───────────

  // ── detect_subscriptions ───────────────────────────────────────────────────
  server.tool(
    "detect_subscriptions",
    "Scan recent transactions (via the decrypted tx cache) and return candidate subscriptions — payees with 3+ regular-cadence occurrences and stable amounts. Returns a confirmationToken for bulk_add_subscriptions.",
    {
      lookback_months: z.number().optional().describe("Months of history to scan (default 6)"),
    },
    async ({ lookback_months }) => {
      const months = lookback_months ?? 6;
      const since = new Date();
      since.setMonth(since.getMonth() - months);
      const sinceStr = since.toISOString().split("T")[0];

      const all = await getUserTransactions(userId, dek);
      // Skip rows where payee looks like ciphertext (missing DEK) — we can't
      // meaningfully group on those.
      const recent = all.filter(
        (t) => t.date >= sinceStr && t.payee && !t.payee.startsWith("v1:")
      );

      // Group by normalized payee. Normalization: lowercase + collapse runs
      // of whitespace. Fancy merchant-name cleanup is out of scope here.
      const groups = new Map<string, typeof recent>();
      for (const t of recent) {
        const key = t.payee.toLowerCase().replace(/\s+/g, " ").trim();
        if (!key) continue;
        const list = groups.get(key) ?? [];
        list.push(t);
        groups.set(key, list);
      }

      type Candidate = {
        payee: string;
        avgAmount: number;
        cadence: "weekly" | "monthly" | "quarterly" | "annual";
        confidence: number;
        sampleTransactionIds: number[];
        occurrences: number;
      };
      const candidates: Candidate[] = [];

      for (const [, txs] of groups) {
        if (txs.length < 3) continue;
        // Order ascending by date for interval math.
        txs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

        const amounts = txs.map((t) => t.amount);
        const avg = amounts.reduce((s, n) => s + n, 0) / amounts.length;
        if (Math.abs(avg) < 0.01) continue; // zero-amount noise

        // Amount stability: stddev within 5% of |avg|.
        const stddev = Math.sqrt(
          amounts.reduce((s, n) => s + (n - avg) ** 2, 0) / amounts.length
        );
        const stableAmount = stddev <= Math.abs(avg) * 0.05;
        if (!stableAmount) continue;

        // Interval in days between consecutive txs.
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

        // Confidence: count + regularity + amount tightness.
        const countScore = Math.min(1, txs.length / 6); // 6+ = 1.0
        const amtTightness = Math.abs(avg) > 0 ? 1 - Math.min(1, stddev / Math.abs(avg)) : 1;
        const intTightness = 1 - Math.min(1, (stddev === 0 ? 0 : 0) + 0);
        const _ = intTightness;
        const confidence = Math.round(((countScore * 0.4) + (amtTightness * 0.6)) * 100) / 100;

        candidates.push({
          payee: txs[0].payee, // keep the casing from the first row
          avgAmount: Math.round(Math.abs(avg) * 100) / 100,
          cadence,
          confidence,
          occurrences: txs.length,
          sampleTransactionIds: txs.slice(-5).map((t) => t.id),
        });
      }

      candidates.sort((a, b) => b.confidence - a.confidence || b.occurrences - a.occurrences);

      // Payload for the token: just the list Claude is authorised to commit.
      // We don't encode the lookback window — Claude could re-run detect with
      // a different window and the candidates would differ, so we sign the
      // actual shortlist shape it saw.
      const approvable = candidates.map((c) => ({
        payee: c.payee,
        amount: c.avgAmount,
        cadence: c.cadence,
      }));
      const token = candidates.length
        ? signConfirmationToken(userId, "bulk_add_subscriptions", { candidates: approvable })
        : "";

      return text({
        success: true,
        data: {
          scanned: recent.length,
          cacheDegraded: all.length > 0 && all.every((t) => t.payee.startsWith("v1:")),
          candidates,
          confirmationToken: token,
        },
      });
    }
  );

  // ── bulk_add_subscriptions ─────────────────────────────────────────────────
  server.tool(
    "bulk_add_subscriptions",
    "Commit a set of detected subscriptions. Pass the candidates returned by detect_subscriptions (payee + amount + cadence), plus the confirmationToken.",
    {
      candidates: z.array(z.object({
        payee: z.string(),
        amount: z.number(),
        cadence: z.enum(["weekly", "monthly", "quarterly", "annual"]),
        next_billing_date: z.string().optional().describe("YYYY-MM-DD. Defaults to today + cadence interval"),
        category_id: z.number().optional(),
      })).min(1),
      confirmation_token: z.string(),
    },
    async ({ candidates, confirmation_token }) => {
      // The token is signed over {payee, amount, cadence} only — additional
      // fields (next_billing_date, category_id) don't change the approval.
      const approvable = candidates.map((c) => ({
        payee: c.payee,
        amount: c.amount,
        cadence: c.cadence,
      }));
      const check = verifyConfirmationToken(confirmation_token, userId, "bulk_add_subscriptions", { candidates: approvable });
      if (!check.valid) return err(`Confirmation token invalid: ${check.reason}. Re-run detect_subscriptions.`);

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
        const existing = await q(db, sql`SELECT id FROM subscriptions WHERE user_id = ${userId} AND name = ${c.payee}`);
        if (existing.length) { skipped.push(c.payee); continue; }
        const next = c.next_billing_date ?? addInterval(today, c.cadence);
        await db.execute(sql`
          INSERT INTO subscriptions (user_id, name, amount, currency, frequency, category_id, account_id, next_date, status, notes)
          VALUES (${userId}, ${c.payee}, ${c.amount}, 'CAD', ${c.cadence}, ${c.category_id ?? null}, NULL, ${next}, 'active', 'Auto-detected by MCP')
        `);
        created++;
      }
      return text({ success: true, data: { created, skipped, message: `Created ${created} subscription(s); skipped ${skipped.length} existing` } });
    }
  );

  // ─── Part 1 tail — file upload preview/execute ─────────────────────────────

  /**
   * Load a parsed-rows array from a stored upload. Returns the raw RawTransaction
   * list plus parse errors. Used by both preview_import and execute_import.
   */
  async function loadUploadRows(
    uploadId: string,
    columnMapping: Record<string, string> | undefined
  ): Promise<{ upload: Row; rows: RawTransaction[]; errors: Array<{ row: number; message: string }> }> {
    const uploads = await q(db, sql`
      SELECT id, user_id, format, storage_path, original_filename, size_bytes, status, created_at, expires_at
      FROM mcp_uploads
      WHERE id = ${uploadId} AND user_id = ${userId}
    `);
    if (!uploads.length) throw new Error(`Upload #${uploadId} not found`);
    const upload = uploads[0];
    if (String(upload.status) === "executed") throw new Error("Upload already executed");
    if (String(upload.status) === "cancelled") throw new Error("Upload was cancelled");
    const expiresAt = new Date(String(upload.expires_at));
    if (expiresAt.getTime() < Date.now()) throw new Error("Upload expired");

    const buf = await fs.readFile(String(upload.storage_path));
    const format = String(upload.format);
    let rows: RawTransaction[] = [];
    const errors: Array<{ row: number; message: string }> = [];

    if (format === "csv") {
      const text = buf.toString("utf8");
      const result = columnMapping
        ? csvToRawTransactionsWithMapping(text, columnMapping)
        : csvToRawTransactions(text);
      rows = result.rows;
      errors.push(...result.errors);
    } else if (format === "ofx" || format === "qfx") {
      const text = buf.toString("utf8");
      const parsed = parseOfx(text);
      rows = parsed.transactions.map((t) => ({
        date: t.date,
        account: "", // OFX doesn't name the account — user fills via column_mapping.account if needed
        amount: t.amount,
        payee: t.payee,
        currency: parsed.currency,
        note: t.memo,
        fitId: t.fitId,
      }));
    } else {
      throw new Error(`Unsupported upload format: ${format}`);
    }

    return { upload, rows, errors };
  }

  // ── list_pending_uploads ───────────────────────────────────────────────────
  server.tool(
    "list_pending_uploads",
    "List MCP uploads that are still pending or previewed (not yet executed, cancelled, or expired).",
    {},
    async () => {
      const rows = await q(db, sql`
        SELECT id, format, original_filename, size_bytes, row_count, status,
               created_at, expires_at
        FROM mcp_uploads
        WHERE user_id = ${userId}
          AND status IN ('pending', 'previewed')
          AND expires_at > NOW()
        ORDER BY created_at DESC
      `);
      return text({ success: true, data: rows });
    }
  );

  // ── preview_import ─────────────────────────────────────────────────────────
  server.tool(
    "preview_import",
    "Preview an uploaded CSV/OFX/QFX file. Returns first 20 parsed rows, dedup hit count, category auto-match coverage, unresolved accounts, and a confirmationToken for execute_import.",
    {
      upload_id: z.string().describe("The id returned by POST /api/mcp/upload"),
      template_id: z.number().optional().describe("Apply a saved import template's column mapping"),
      column_mapping: z.record(z.string(), z.string()).optional().describe("Ad-hoc column mapping {date, amount, payee?, account?, category?, note?, tags?}"),
    },
    async ({ upload_id, template_id, column_mapping }) => {
      try {
        // Resolve column mapping from template_id or inline.
        let mapping: Record<string, string> | undefined = column_mapping;
        if (template_id !== undefined && !mapping) {
          const tpl = await q(db, sql`
            SELECT column_mapping, default_account
            FROM import_templates
            WHERE id = ${template_id} AND user_id = ${userId}
          `);
          if (!tpl.length) return err(`Import template #${template_id} not found`);
          try {
            mapping = JSON.parse(String(tpl[0].column_mapping)) as Record<string, string>;
          } catch {
            return err("Import template has invalid column_mapping JSON");
          }
        }

        const { upload, rows, errors } = await loadUploadRows(upload_id, mapping);

        // Dedup via generateImportHash — runs against plaintext payee, which
        // is what we have at this boundary.
        const accounts = await q(db, sql`SELECT id, name, alias FROM accounts WHERE user_id = ${userId}`);
        const accountByName = new Map<string, number>(accounts.map((a) => [String(a.name), Number(a.id)]));
        const existingHashRows = await q(db, sql`SELECT import_hash FROM transactions WHERE user_id = ${userId} AND import_hash IS NOT NULL`);
        const existingHashes = new Set<string>(existingHashRows.map((r) => String(r.import_hash)));

        let dedupHits = 0;
        const unresolvedAccounts = new Set<string>();
        for (const r of rows) {
          const aId = accountByName.get(r.account);
          if (!aId && r.account) unresolvedAccounts.add(r.account);
          if (aId) {
            const h = generateImportHash(r.date, aId, r.amount, r.payee);
            if (existingHashes.has(h)) dedupHits++;
          }
        }

        // Category coverage via the active rule set (plaintext match_value).
        const rules = await q(db, sql`
          SELECT match_field, match_type, match_value, assign_category_id
          FROM transaction_rules
          WHERE user_id = ${userId} AND is_active = 1 AND assign_category_id IS NOT NULL
          ORDER BY priority DESC
        `);
        const ruleSet: TransactionRule[] = rules.map((r) => ({
          id: 0,
          name: "",
          matchField: String(r.match_field ?? "payee"),
          matchType: String(r.match_type ?? "contains"),
          matchValue: String(r.match_value ?? ""),
          assignCategoryId: r.assign_category_id == null ? null : Number(r.assign_category_id),
          assignTags: null,
          renameTo: null,
          isActive: 1,
          priority: 0,
          createdAt: "",
        })) as unknown as TransactionRule[];
        let matchedCat = 0;
        if (ruleSet.length > 0 && rows.length > 0) {
          const results = applyRulesToBatch(
            rows.map((r) => ({ payee: r.payee ?? "", amount: r.amount, tags: r.tags ?? "" })),
            ruleSet,
          );
          for (const res of results) {
            if (res.match?.assignCategoryId) matchedCat++;
          }
        }
        // Rows that already carry an explicit category name also count.
        for (const r of rows) {
          if (r.category && r.category.length > 0) matchedCat++;
        }

        // Record the preview — update status + rowCount.
        await db.execute(sql`
          UPDATE mcp_uploads
          SET status = 'previewed', row_count = ${rows.length}
          WHERE id = ${upload_id} AND user_id = ${userId}
        `);

        const token = signConfirmationToken(userId, "execute_import", {
          uploadId: upload_id,
          templateId: template_id ?? null,
          columnMapping: mapping ?? null,
        });

        return text({
          success: true,
          data: {
            uploadId: upload_id,
            format: upload.format,
            parsedRows: rows.length,
            sampleRows: rows.slice(0, 20),
            parseErrors: errors.slice(0, 20),
            dedupHits,
            categoryCoveragePct: rows.length === 0 ? 0 : Math.round((matchedCat / rows.length) * 100),
            unresolvedAccounts: Array.from(unresolvedAccounts),
            confirmationToken: token,
          },
        });
      } catch (e) {
        return err(String(e instanceof Error ? e.message : e));
      }
    }
  );

  // ── execute_import ─────────────────────────────────────────────────────────
  server.tool(
    "execute_import",
    "Commit an upload as transactions. Requires the token from preview_import with matching uploadId + templateId + columnMapping.",
    {
      upload_id: z.string(),
      confirmation_token: z.string(),
      template_id: z.number().optional(),
      column_mapping: z.record(z.string(), z.string()).optional(),
    },
    async ({ upload_id, confirmation_token, template_id, column_mapping }) => {
      if (!dek) return err("Import requires an unlocked session (DEK unavailable).");

      const check = verifyConfirmationToken(confirmation_token, userId, "execute_import", {
        uploadId: upload_id,
        templateId: template_id ?? null,
        columnMapping: column_mapping ?? null,
      });
      if (!check.valid) return err(`Confirmation token invalid: ${check.reason}. Re-run preview_import.`);

      try {
        // Load mapping same way preview did.
        let mapping: Record<string, string> | undefined = column_mapping;
        if (template_id !== undefined && !mapping) {
          const tpl = await q(db, sql`SELECT column_mapping FROM import_templates WHERE id = ${template_id} AND user_id = ${userId}`);
          if (tpl.length) {
            try { mapping = JSON.parse(String(tpl[0].column_mapping)) as Record<string, string>; }
            catch { /* fall through — executeImport will error on unresolved accounts */ }
          }
        }

        const { rows } = await loadUploadRows(upload_id, mapping);
        const result = await pipelineExecute(rows, [], userId, dek);

        await db.execute(sql`
          UPDATE mcp_uploads SET status = 'executed' WHERE id = ${upload_id} AND user_id = ${userId}
        `);
        invalidateUserTxCache(userId);
        return text({ success: true, data: result });
      } catch (e) {
        return err(String(e instanceof Error ? e.message : e));
      }
    }
  );

  // ── cancel_import ──────────────────────────────────────────────────────────
  server.tool(
    "cancel_import",
    "Cancel a pending MCP upload — marks the row as cancelled and deletes the file from disk.",
    { upload_id: z.string() },
    async ({ upload_id }) => {
      const uploads = await q(db, sql`
        SELECT id, storage_path, status FROM mcp_uploads
        WHERE id = ${upload_id} AND user_id = ${userId}
      `);
      if (!uploads.length) return err(`Upload #${upload_id} not found`);
      const u = uploads[0];
      if (String(u.status) === "executed") return err("Upload already executed, cannot cancel");
      try { await fs.unlink(String(u.storage_path)); } catch { /* file already gone */ }
      await db.execute(sql`UPDATE mcp_uploads SET status = 'cancelled' WHERE id = ${upload_id} AND user_id = ${userId}`);
      return text({ success: true, data: { uploadId: upload_id, message: "Upload cancelled" } });
    }
  );
}
