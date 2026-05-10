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
import {
  getLatestFxRate,
  getRate,
  getRateToUsdDetailed,
  validateCurrencyCode,
  validateFxDate,
  collapseLegSources,
} from "../src/lib/fx-service.js";
import { SUPPORTED_CURRENCIES } from "../src/lib/fx/supported-currencies.js";
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
import { validateSignVsCategory } from "../src/lib/transactions/sign-category-invariant.js";
import { ymdDate, ymPeriod, parseYmdSafe } from "./lib/date-validators.js";
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

/**
 * Strict resolver for portfolio_holdings DELETE/destructive operations
 * (issue #127). Mirrors `resolvePortfolioHoldingStrict` in
 * register-tools-pg.ts — searches both `name` and `symbol`, then gates the
 * substring/reverse-substring tier on a length-≥3 token overlap. Without
 * the gate, a 1-char holding name like "S" silently wins against any
 * longer input ("testv".includes("s") is true) and the destructive call
 * deletes the wrong row.
 *
 * On stdio post Stream D Phase 4 the rows' decrypted name/symbol fields
 * carry raw `v1:...` ciphertext (no DEK on this transport). The matcher
 * simply finds nothing and the caller surfaces "not found" — that's the
 * documented stdio-Phase-4 degradation; callers should use HTTP MCP or
 * the web UI for destructive holding ops.
 */
type StdioHoldingResolveResult =
  | { ok: true; holding: SqliteRow; tier: "exact-name" | "exact-symbol" | "startsWith-name" | "startsWith-symbol" | "substring" }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "low_confidence"; suggestion: SqliteRow };
function resolvePortfolioHoldingStrict(input: string, options: SqliteRow[]): StdioHoldingResolveResult {
  if (!input || !options.length) return { ok: false, reason: "missing" };
  const lo = input.toLowerCase().trim();
  const exactName = options.find(o => String(o.name ?? "").toLowerCase() === lo);
  if (exactName) return { ok: true, holding: exactName, tier: "exact-name" };
  const exactSymbol = options.find(o => String(o.symbol ?? "").toLowerCase() === lo);
  if (exactSymbol) return { ok: true, holding: exactSymbol, tier: "exact-symbol" };
  const startsName = options.find(o => {
    const n = String(o.name ?? "").toLowerCase();
    return n !== "" && n.startsWith(lo);
  });
  if (startsName) return { ok: true, holding: startsName, tier: "startsWith-name" };
  const startsSymbol = options.find(o => {
    const s = String(o.symbol ?? "").toLowerCase();
    return s !== "" && s.startsWith(lo);
  });
  if (startsSymbol) return { ok: true, holding: startsSymbol, tier: "startsWith-symbol" };
  const tokenize = (s: string) =>
    new Set(s.split(/\s+/).map(t => t.replace(/[^a-z0-9]/g, "")).filter(t => t.length >= 3));
  const inputTokens = tokenize(lo);
  const sharesToken = (text: string) => {
    if (!inputTokens.size) return false;
    for (const t of tokenize(text)) if (inputTokens.has(t)) return true;
    return false;
  };
  const sub = options.find(o => {
    const n = String(o.name ?? "").toLowerCase();
    if (n === "") return false;
    if (!n.includes(lo) && !lo.includes(n)) return false;
    return sharesToken(n);
  });
  if (sub) return { ok: true, holding: sub, tier: "substring" };
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
  // Issue #214 — schema is (match_field, match_type, match_value), NOT
  // `match_payee`. The previous SELECT 500'd on every record_transaction call
  // when the user had any active rule (column "match_payee" does not exist).
  // SQL-filter active payee-rules with an assigned category, then evaluate
  // contains/exact/regex semantics in memory using the shared `matchesRule`
  // helper. Identical pattern to the HTTP `autoCategory` fix in
  // register-tools-pg.ts (commit 7d70677).
  const rules = await sqlite.prepare(
    `SELECT id, name, match_field, match_type, match_value,
            assign_category_id, assign_tags, rename_to, is_active, priority
     FROM transaction_rules
     WHERE user_id = ?
       AND is_active = 1
       AND match_field = 'payee'
       AND assign_category_id IS NOT NULL
     ORDER BY priority DESC`
  ).all(userId) as Array<{
    id: number; name: string; match_field: string; match_type: string;
    match_value: string; assign_category_id: number | null;
    assign_tags: string | null; rename_to: string | null;
    is_active: number; priority: number;
  }>;
  for (const rule of rules) {
    // autoCategory only resolves on payee at write-time; amount/tags rules
    // run at apply_rules_to_uncategorized time after the row is committed.
    if (matchesRule({ payee, amount: 0, tags: "" }, rule) && rule.assign_category_id) {
      return rule.assign_category_id;
    }
  }
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

// Issue #206 — currency enum widened to the full SUPPORTED_CURRENCIES list
// (32 fiats + 4 cryptos + 4 metals). Mirrors register-tools-pg.ts.
const supportedCurrencyEnum = z.enum(
  SUPPORTED_CURRENCIES as unknown as [string, ...string[]]
);

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
 * Use this helper at the very top of every gated tool's handler.
 */
function streamDRefuse(table: "accounts" | "categories" | "goals" | "loans" | "subscriptions" | "portfolio_holdings") {
  return sqliteErr(
    `Stdio MCP cannot create or update ${table} after Stream D Phase 4. The display name requires a DEK that the stdio transport doesn't carry. Use the HTTP MCP transport instead, or set the row up via the web UI.`,
  );
}

/**
 * Stream D Phase 4 refusal helper for READ tools (issue #131, 2026-05-04).
 *
 * Phase 4 dropped the plaintext `name`/`alias`/`symbol` columns on the 6
 * in-scope tables. Stdio MCP read tools that SELECT those columns or rely on
 * them for fuzzy-matching now 500 with `column "name" does not exist`.
 *
 * Without a DEK on the stdio transport, these tools cannot decrypt `name_ct`
 * or compute the `name_lookup` HMAC, so the entire query is unimplementable
 * here. Refuse cleanly and point the user at HTTP MCP / the web UI.
 */
function streamDRefuseRead(tool: string, table: "accounts" | "categories" | "goals" | "loans" | "subscriptions" | "portfolio_holdings") {
  return sqliteErr(
    `${tool} requires an unlocked DEK to decrypt ${table} names after Stream D Phase 4. Stdio MCP cannot decrypt — use the HTTP MCP transport at /mcp or the web UI for this query.`,
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
    "Get current balances for all accounts, grouped by type (asset/liability). Each balance is in its own (account) currency; the response surfaces reportingCurrency for cross-currency context. Stream D Phase 4: stdio cannot decrypt account names — use HTTP MCP or the web UI for this query.",
    {
      currency: z.enum(["CAD", "USD", "all"]).optional().describe("Filter by currency"),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency. Returned as response metadata for cross-currency aggregation context."),
    },
    async () => streamDRefuseRead("get_account_balances", "accounts"),
  );

  server.tool(
    "get_budget_summary",
    "Get budget vs actual spending for a specific month. Stream D Phase 4: stdio cannot decrypt category names — use HTTP MCP or the web UI for this query.",
    {
      month: ymPeriod.describe("Month in YYYY-MM format"),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async () => streamDRefuseRead("get_budget_summary", "categories"),
  );

  server.tool(
    "get_spending_trends",
    "Get spending trends over time grouped by category. Stream D Phase 4: stdio cannot decrypt category names — use HTTP MCP or the web UI for this query.",
    {
      period: z.enum(["weekly", "monthly", "yearly"]).describe("Aggregation period"),
      months: z.number().optional().describe("Months to look back (default 12)"),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async () => streamDRefuseRead("get_spending_trends", "categories"),
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

  server.tool(
    "get_categories",
    "List all available transaction categories. Stream D Phase 4: stdio cannot decrypt category names — use HTTP MCP or the web UI for this query.",
    {},
    async () => streamDRefuseRead("get_categories", "categories"),
  );

  server.tool(
    "get_loans",
    "Get all loans with amortization summary. Stream D Phase 4: stdio cannot decrypt loan names — use HTTP MCP or the web UI for this query.",
    {},
    async () => streamDRefuseRead("get_loans", "loans"),
  );

  server.tool("get_goals", "Get all financial goals with progress. Stdio cannot decrypt names (no DEK on this transport) — `name` and per-account display names come back null. Each goal carries `accountIds: number[]` (issue #130 multi-account linking) — use HTTP MCP or the web UI to see the decrypted names.", {}, async () => {
    // Stream D Phase 4 — plaintext g.name and a.name dropped. Stdio has no
    // DEK, so we can't decrypt name_ct. Return ids only and let the caller
    // hop to HTTP MCP / web UI for names.
    const goals = await sqlite.prepare(`SELECT g.id, g.type, g.target_amount, g.deadline, g.status, g.priority FROM goals g WHERE g.user_id = ? ORDER BY g.priority`).all(userId) as Array<{ id: number }>;
    if (!goals.length) {
      return { content: [{ type: "text" as const, text: JSON.stringify([], null, 2) }] };
    }
    // Issue #130 — JOIN through goal_accounts. Don't decrypt account names.
    const goalIds = goals.map((g) => g.id);
    const placeholders = goalIds.map(() => "?").join(",");
    const links = await sqlite.prepare(
      `SELECT goal_id, account_id FROM goal_accounts WHERE user_id = ? AND goal_id IN (${placeholders})`
    ).all(userId, ...goalIds) as Array<{ goal_id: number; account_id: number }>;
    const linksByGoal = new Map<number, number[]>();
    for (const l of links) {
      const list = linksByGoal.get(l.goal_id) ?? [];
      list.push(l.account_id);
      linksByGoal.set(l.goal_id, list);
    }
    const out = goals.map((g) => ({
      ...g,
      name: null,
      accountIds: linksByGoal.get(g.id) ?? [],
    }));
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
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
    "Generate income statement for a period. Stream D Phase 4: stdio cannot decrypt category names — use HTTP MCP or the web UI for this query.",
    {
      start_date: ymdDate.describe("Start date (YYYY-MM-DD)"),
      end_date: ymdDate.describe("End date (YYYY-MM-DD)"),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async () => streamDRefuseRead("get_income_statement", "categories"),
  );

  // ============ WRITE TOOLS ============

  server.tool(
    "set_budget",
    "Set or update a budget for a category in a specific month. Stream D Phase 4: stdio cannot resolve category names — pass the category id via HTTP MCP, or use the web UI.",
    {
      category: z.string().describe("Category name (refused on stdio — Stream D Phase 4)"),
      month: ymPeriod.describe("Month (YYYY-MM)"),
      amount: z.number().describe("Budget amount (positive number)"),
    },
    async () => streamDRefuseRead("set_budget", "categories"),
  );

  server.tool(
    "add_goal",
    "Create a new financial goal. Refused on stdio (Stream D Phase 4 — no DEK).",
    {
      name: z.string().describe("Goal name"),
      type: z.enum(["savings", "debt_payoff", "investment", "emergency_fund"]).describe("Goal type"),
      target_amount: z.number().describe("Target amount"),
      deadline: ymdDate.optional().describe("Deadline (YYYY-MM-DD)"),
      account: z.string().optional().describe("Legacy single-account linker — name or alias (fuzzy matched). Use HTTP MCP for multi-account."),
      account_ids: z.array(z.number().int()).optional().describe("Multi-account linker (issue #130). Refused on stdio — use HTTP MCP."),
    },
    async ({ name, type, target_amount, deadline, account, account_ids }) => {
      // Stream D Phase 4 — stdio cannot create goals.
      void name; void type; void target_amount; void deadline; void account; void account_ids;
      return streamDRefuse("goals");
    }
  );

  server.tool(
    "add_snapshot",
    "Record a net worth snapshot for an asset (e.g. house value, car value). Stream D Phase 4: stdio cannot resolve account names — use HTTP MCP or the web UI.",
    {
      account: z.string().describe("Account name or alias (refused on stdio — Stream D Phase 4)"),
      value: z.number().describe("Current value"),
      date: ymdDate.optional().describe("Snapshot date (defaults to today)"),
      note: z.string().optional().describe("Optional note"),
    },
    async () => streamDRefuseRead("add_snapshot", "accounts"),
  );

  // ============ TRANSACTION RULES TOOLS ============

  server.tool(
    "get_transaction_rules",
    "List all transaction auto-categorization rules. Stream D Phase 4: stdio cannot decrypt the joined category name — `category_name` field is omitted; `assign_category_id` is still returned.",
    {},
    async () => {
      const rows = await sqlite.prepare(
        `SELECT r.id, r.name, r.match_field, r.match_type, r.match_value,
                r.assign_category_id,
                r.assign_tags, r.rename_to, r.is_active, r.priority
         FROM transaction_rules r
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
    "Get current attention items. Stream D Phase 4: stdio cannot decrypt category/subscription names — use HTTP MCP or the web UI for this query.",
    {
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async () => streamDRefuseRead("get_spotlight_items", "categories"),
  );

  server.tool(
    "get_weekly_recap",
    "Get a weekly financial recap. Stream D Phase 4: stdio cannot decrypt category names — use HTTP MCP or the web UI for this query.",
    {
      date: ymdDate.optional().describe("End date for the week (YYYY-MM-DD). Defaults to current week."),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async () => streamDRefuseRead("get_weekly_recap", "categories"),
  );

  // ── record_transaction ─────────────────────────────────────────────────────
  server.tool(
    "record_transaction",
    "Record a transaction. Stream D Phase 4 (stdio): pass `account_id` (numeric) — `account` (name) is refused because stdio has no DEK to resolve names. `category` (name) is also refused; pass `category_id` instead, or omit for auto-detection. For cross-currency entries pass enteredAmount + enteredCurrency. Pass `dryRun: true` to validate + resolve without writing.",
    {
      amount: z.number().describe("Amount in account currency (negative=expense, positive=income)."),
      payee: z.string().describe("Payee or merchant name"),
      account: z.string().optional().describe("REFUSED on stdio (Stream D Phase 4). Pass `account_id` instead."),
      account_id: z.number().int().optional().describe("Account FK (accounts.id). Required on stdio."),
      date: ymdDate.optional().describe("YYYY-MM-DD (default: today)"),
      category: z.string().optional().describe("REFUSED on stdio (Stream D Phase 4). Pass `category_id` instead, or omit for auto-detection."),
      category_id: z.number().int().optional().describe("Category FK (categories.id). Use this instead of `category` on stdio."),
      note: z.string().optional(),
      tags: z.string().optional().describe("Comma-separated tags"),
      enteredAmount: z.number().optional().describe("User-typed amount in enteredCurrency."),
      enteredCurrency: z.string().optional().describe("ISO code (USD/CAD/...) of enteredAmount; defaults to account currency."),
      dryRun: z.boolean().optional().describe("When true, run validation/resolution and return a preview WITHOUT writing."),
    },
    async ({ amount, payee, date, account, account_id, category, category_id, note, tags, enteredAmount, enteredCurrency, dryRun }) => {
      // Stream D Phase 4: name-fuzzy paths refused — DEK is not available on stdio.
      if (account != null) {
        return sqliteErr("`account` (name) is refused on stdio after Stream D Phase 4. Pass `account_id` instead, or use HTTP MCP / the web UI.");
      }
      if (category != null) {
        return sqliteErr("`category` (name) is refused on stdio after Stream D Phase 4. Pass `category_id` instead, or omit for auto-detection.");
      }
      if (account_id == null) {
        return sqliteErr("Pass `account_id` (numeric). Stdio cannot resolve account names after Stream D Phase 4.");
      }

      const today = new Date().toISOString().split("T")[0];
      const txDate = date ?? today;

      // Stream D Phase 4: SELECT only ciphertext-free columns (id/currency/is_investment).
      const acct = await sqlite.prepare(
        `SELECT id, currency, is_investment FROM accounts WHERE user_id = ? AND id = ?`
      ).get(userId, account_id) as SqliteRow | undefined;
      if (!acct) return sqliteErr(`Account #${account_id} not found or not owned by you.`);

      // Investment-account constraint: stdio MCP record_transaction has no
      // portfolio-holding parameter, so it can't satisfy the FK requirement.
      if (acct.is_investment) {
        return sqliteErr(`Account #${account_id} is an investment account — record_transaction over stdio MCP can't bind to a portfolio holding. Use the HTTP MCP at /mcp (record_transaction has portfolioHolding/portfolioHoldingId there) or the web app to record transactions in this account.`);
      }

      let catId: number | null = null;
      let catType: string | null = null;
      if (category_id != null) {
        // Validate ownership + grab `type` for the issue #212 sign-vs-category
        // invariant. `type` is plaintext on `categories` so stdio (no DEK) can
        // still enforce the rule — only the error message degrades to
        // `category #<id>`.
        const cat = await sqlite.prepare(
          `SELECT id, type FROM categories WHERE user_id = ? AND id = ?`
        ).get(userId, category_id) as { id: number; type?: string } | undefined;
        if (!cat) return sqliteErr(`Category #${category_id} not found or not owned by you.`);
        catId = Number(cat.id);
        catType = cat.type != null ? String(cat.type) : null;
      } else {
        catId = await autoCategory(sqlite, userId, payee);
        // Re-fetch type when autoCategory picked one — keeps the validator
        // path symmetric with the explicit `category_id` branch above.
        if (catId != null) {
          const c = await sqlite.prepare(
            `SELECT type FROM categories WHERE user_id = ? AND id = ?`,
          ).get(userId, catId) as { type?: string } | undefined;
          catType = c?.type != null ? String(c.type) : null;
        }
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

      // Issue #212 — sign-vs-category invariant. Hard reject before any INSERT.
      // Stdio has no DEK so the error message uses `category #<id>` as the
      // category name; the rule itself fires identically across transports.
      if (catId != null) {
        const sErr = validateSignVsCategory({
          amount: resolved.amount,
          categoryType: catType,
          categoryName: `category #${catId}`,
        });
        if (sErr) return sqliteErr(sErr.message);
      }

      const resolvedAccountInfo = { id: Number(acct.id) };
      const resolvedCategory = catId != null ? { id: Number(catId) } : null;

      if (dryRun) {
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
          message: `Dry run OK — would record: ${resolved.amount > 0 ? "+" : ""}${resolved.amount} ${resolved.currency} on ${txDate} — "${payee}" → account #${Number(acct.id)}${catId != null ? ` (category #${catId})` : ""}`,
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
        message: `Recorded: ${resolved.amount > 0 ? "+" : ""}${resolved.amount} ${resolved.currency} on ${txDate} — "${payee}" → account #${Number(acct.id)}${catId != null ? ` (category #${catId})` : ""}`,
      });
    }
  );

  // ── bulk_record_transactions ───────────────────────────────────────────────
  server.tool(
    "bulk_record_transactions",
    "Record multiple transactions at once. Stream D Phase 4: stdio cannot resolve account/category names without a DEK and the helper SELECTs that fuzzy-match names hit dropped plaintext columns — refused entirely. Use HTTP MCP at /mcp (full feature set) or the web UI.",
    {
      account_id: z.number().int().optional(),
      dryRun: z.boolean().optional(),
      idempotencyKey: z.string().uuid().optional(),
      transactions: z.array(z.object({
        amount: z.number(),
        payee: z.string(),
        account: z.string().optional(),
        account_id: z.number().int().optional(),
        date: z.string().optional().describe("YYYY-MM-DD calendar date. Per-row validation in HTTP MCP; stdio refuses entirely (Stream D Phase 4)."),
        category: z.string().optional(),
        note: z.string().optional(),
        tags: z.string().optional(),
        enteredAmount: z.number().optional(),
        enteredCurrency: z.string().optional(),
      })).describe("Array of transactions to record"),
    },
    async ({ transactions, account_id: defaultAccountId, dryRun, idempotencyKey }) => {
      void transactions; void defaultAccountId; void dryRun; void idempotencyKey;
      return streamDRefuseRead("bulk_record_transactions", "accounts");
    }
  );

  // ── update_transaction ─────────────────────────────────────────────────────
  server.tool(
    "update_transaction",
    "Update fields of an existing transaction by ID. Stream D Phase 4 (stdio): pass `category_id` (numeric) — `category` (name) is refused because stdio cannot resolve names. Pass enteredAmount + enteredCurrency to re-lock cross-currency rate; passing only `amount` updates the account-side without touching entered_*.",
    {
      id: z.number().describe("Transaction ID"),
      date: ymdDate.optional(),
      amount: z.number().optional().describe("Amount in account currency. Doesn't touch entered_* side."),
      payee: z.string().optional(),
      category: z.string().optional().describe("REFUSED on stdio (Stream D Phase 4). Pass `category_id` instead."),
      category_id: z.number().int().optional().describe("Category FK (categories.id). Use this instead of `category` on stdio."),
      note: z.string().optional(),
      tags: z.string().optional(),
      enteredAmount: z.number().optional(),
      enteredCurrency: z.string().optional(),
    },
    async ({ id, date, amount, payee, category, category_id, note, tags, enteredAmount, enteredCurrency }) => {
      if (category !== undefined) {
        return sqliteErr("`category` (name) is refused on stdio after Stream D Phase 4. Pass `category_id` instead.");
      }
      const existing = await sqlite.prepare(`
        SELECT t.id, t.account_id, t.category_id, t.amount, t.date, a.currency AS account_currency
          FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
         WHERE t.id = ? AND t.user_id = ?
      `).get(id, userId) as { id: number; date: string; account_currency?: string; category_id?: number | null; amount?: number | null } | undefined;
      if (!existing) return sqliteErr(`Transaction #${id} not found or not owned by user`);
      const existingAmountStdio = existing.amount != null ? Number(existing.amount) : null;
      const existingCategoryIdStdio = existing.category_id != null ? Number(existing.category_id) : null;

      let catId: number | undefined;
      let catTypeStdio: string | null = null;
      let resolvedCategory: { id: number } | null = null;
      if (category_id !== undefined) {
        // Fetch `type` alongside ownership for issue #212.
        const cat = await sqlite.prepare(
          `SELECT id, type FROM categories WHERE user_id = ? AND id = ?`
        ).get(userId, category_id) as { id: number; type?: string } | undefined;
        if (!cat) return sqliteErr(`Category #${category_id} not found or not owned by you.`);
        catId = Number(cat.id);
        catTypeStdio = cat.type != null ? String(cat.type) : null;
        resolvedCategory = { id: catId };
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
      // Track post-merge amount for the issue #212 sign-vs-category check
      // below. Set in the entered/account-side branches.
      let postMergeAmountStdio: number | null = existingAmountStdio;
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
        postMergeAmountStdio = resolved.amount;
      } else if (amount !== undefined) {
        updates.push("amount = ?");
        params.push(amount);
        fieldsUpdated.push("amount");
        postMergeAmountStdio = amount;
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

      // Issue #212 — sign-vs-category invariant on the post-merge state.
      // Reuses the existing row's category_id when the patch doesn't touch
      // it, and the existing amount when the patch doesn't touch amount.
      // Stdio path: error message degrades to `category #<id>` (no DEK).
      if (postMergeAmountStdio != null) {
        const postMergeCatId = catId !== undefined ? catId : existingCategoryIdStdio;
        let postMergeCatType = catTypeStdio;
        if (postMergeCatId != null && catId === undefined) {
          // Patch is not touching category — fetch the existing row's type.
          const c = await sqlite.prepare(
            `SELECT type FROM categories WHERE user_id = ? AND id = ?`,
          ).get(userId, postMergeCatId) as { type?: string } | undefined;
          postMergeCatType = c?.type != null ? String(c.type) : null;
        }
        if (postMergeCatId != null) {
          const sErr = validateSignVsCategory({
            amount: postMergeAmountStdio,
            categoryType: postMergeCatType,
            categoryName: `category #${postMergeCatId}`,
          });
          if (sErr) return sqliteErr(sErr.message);
        }
      }

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
    "Record a transfer between two of the user's accounts. Stream D Phase 4 (stdio): pass `from_account_id` and `to_account_id` (numeric) — the `fromAccount`/`toAccount`/`holding`/`destHolding` name fields are refused because stdio cannot resolve names. Use `record_trade` only on HTTP MCP. Auto-creates a Transfer category (type='R') if missing. For cross-currency transfers pass `receivedAmount` to lock the bank's landed amount.",
    {
      fromAccount: z.string().optional().describe("REFUSED on stdio (Stream D Phase 4). Pass `from_account_id` instead."),
      toAccount: z.string().optional().describe("REFUSED on stdio (Stream D Phase 4). Pass `to_account_id` instead."),
      from_account_id: z.number().int().optional().describe("Source account FK (accounts.id). Required on stdio."),
      to_account_id: z.number().int().optional().describe("Destination account FK (accounts.id). Required on stdio."),
      amount: z.number().nonnegative().describe("Cash amount sent, in SOURCE account's currency."),
      date: ymdDate.optional().describe("YYYY-MM-DD (default: today)"),
      receivedAmount: z.number().nonnegative().optional().describe("Cross-currency override: actual amount that landed in the destination."),
      holding: z.string().optional().describe("REFUSED on stdio (Stream D Phase 4). In-kind transfers require name resolution — use HTTP MCP."),
      destHolding: z.string().optional().describe("REFUSED on stdio (Stream D Phase 4)."),
      quantity: z.number().positive().optional().describe("REFUSED on stdio when paired with `holding`."),
      destQuantity: z.number().positive().optional(),
      note: z.string().optional(),
      tags: z.string().optional(),
    },
    async ({ fromAccount, toAccount, from_account_id, to_account_id, amount, date, receivedAmount, holding, destHolding, quantity, destQuantity, note, tags }) => {
      if (fromAccount != null || toAccount != null) {
        return sqliteErr("`fromAccount`/`toAccount` (names) are refused on stdio after Stream D Phase 4. Pass `from_account_id` and `to_account_id` instead.");
      }
      if (holding != null || destHolding != null) {
        return sqliteErr("In-kind (share) transfers require resolving holding names, which is not available on stdio after Stream D Phase 4. Use HTTP MCP at /mcp or the web UI.");
      }
      if (from_account_id == null || to_account_id == null) {
        return sqliteErr("Pass both `from_account_id` and `to_account_id` (numeric). Stdio cannot resolve account names after Stream D Phase 4.");
      }

      // Stream D Phase 4: SELECT only ciphertext-free columns to validate ownership.
      const fromAcct = await sqlite.prepare(
        `SELECT id, currency FROM accounts WHERE user_id = ? AND id = ?`
      ).get(userId, from_account_id) as { id: number; currency: string } | undefined;
      if (!fromAcct) return sqliteErr(`Source account #${from_account_id} not found or not owned by you.`);
      const toAcct = await sqlite.prepare(
        `SELECT id, currency FROM accounts WHERE user_id = ? AND id = ?`
      ).get(userId, to_account_id) as { id: number; currency: string } | undefined;
      if (!toAcct) return sqliteErr(`Destination account #${to_account_id} not found or not owned by you.`);

      const { createTransferPairViaSql } = await import("../src/lib/transfer.js");
      let result: Awaited<ReturnType<typeof createTransferPairViaSql>>;
      try {
        result = await createTransferPairViaSql(sqlite.pool, userId, null, {
          fromAccountId: Number(fromAcct.id),
          toAccountId: Number(toAcct.id),
          enteredAmount: amount,
          date,
          receivedAmount,
          holdingName: undefined,
          destHoldingName: undefined,
          quantity: undefined,
          destQuantity: undefined,
          note,
          tags,
          // Issue #28: MCP stdio transport.
          txSource: "mcp_stdio",
        });
        void quantity; void destQuantity;
      } catch (e) {
        if (e instanceof InvestmentHoldingRequiredError) return sqliteErr(e.message);
        throw e;
      }
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
        resolvedFromAccount: { id: Number(fromAcct.id) },
        resolvedToAccount: { id: Number(toAcct.id) },
        message: result.isCrossCurrency
          ? `Transferred ${amount} ${result.fromCurrency} from account #${Number(fromAcct.id)} to account #${Number(toAcct.id)} — landed as ${result.toAmount} ${result.toCurrency} (rate ${result.enteredFxRate.toFixed(6)})`
          : `Transferred ${amount} ${result.fromCurrency} from account #${Number(fromAcct.id)} to account #${Number(toAcct.id)}`,
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
    "Record a stock/ETF/crypto buy or sell. Stream D Phase 4: refused entirely on stdio. The cash-sleeve auto-create path INSERTs plaintext name+symbol (Phase-4 dropped) and the symbol pre-flight does LOWER(name)/LOWER(symbol). Use HTTP MCP at /mcp or the web UI.",
    {
      account: z.string().optional(),
      account_id: z.number().int().optional(),
      side: z.enum(["buy", "sell"]),
      symbol: z.string().min(1).max(50),
      quantity: z.number().positive(),
      price: z.number().positive(),
      currency: z.string().optional(),
      fees: z.number().nonnegative().optional(),
      fxRate: z.number().positive().optional(),
      date: ymdDate.optional(),
      note: z.string().optional(),
    },
    async () => streamDRefuseRead("record_trade", "portfolio_holdings"),
  );

  // ── update_transfer ────────────────────────────────────────────────────────
  server.tool(
    "update_transfer",
    "Update both legs of an existing transfer pair atomically. Stream D Phase 4 (stdio): pass `from_account_id`/`to_account_id` (numeric) — `fromAccount`/`toAccount` (names) are refused. Identify pair by linkId OR by either leg's transaction id.",
    {
      linkId: z.string().optional(),
      transactionId: z.number().int().optional(),
      fromAccount: z.string().optional().describe("REFUSED on stdio (Stream D Phase 4). Pass `from_account_id` instead."),
      toAccount: z.string().optional().describe("REFUSED on stdio (Stream D Phase 4). Pass `to_account_id` instead."),
      from_account_id: z.number().int().optional(),
      to_account_id: z.number().int().optional(),
      amount: z.number().positive().optional(),
      date: ymdDate.optional(),
      receivedAmount: z.number().positive().optional(),
      note: z.string().optional(),
      tags: z.string().optional(),
    },
    async ({ linkId, transactionId, fromAccount, toAccount, from_account_id, to_account_id, amount, date, receivedAmount, note, tags }) => {
      if (linkId == null && transactionId == null) return sqliteErr("Either linkId or transactionId is required");

      if (fromAccount != null || toAccount != null) {
        return sqliteErr("`fromAccount`/`toAccount` (names) are refused on stdio after Stream D Phase 4. Pass `from_account_id`/`to_account_id` instead.");
      }

      let fromAccountId: number | undefined = from_account_id ?? undefined;
      let toAccountId: number | undefined = to_account_id ?? undefined;
      if (fromAccountId != null) {
        const acct = await sqlite.prepare(
          `SELECT id FROM accounts WHERE user_id = ? AND id = ?`
        ).get(userId, fromAccountId) as { id: number } | undefined;
        if (!acct) return sqliteErr(`Source account #${fromAccountId} not found or not owned by you.`);
      }
      if (toAccountId != null) {
        const acct = await sqlite.prepare(
          `SELECT id FROM accounts WHERE user_id = ? AND id = ?`
        ).get(userId, toAccountId) as { id: number } | undefined;
        if (!acct) return sqliteErr(`Destination account #${toAccountId} not found or not owned by you.`);
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
    "Delete a budget entry for a category/month. Stream D Phase 4 (stdio): pass `category_id` (numeric) — `category` (name) is refused.",
    {
      category: z.string().optional().describe("REFUSED on stdio (Stream D Phase 4). Pass `category_id` instead."),
      category_id: z.number().int().optional().describe("Category FK (categories.id)."),
      month: ymPeriod.describe("Month (YYYY-MM)"),
    },
    async ({ category, category_id, month }) => {
      if (category != null) {
        return sqliteErr("`category` (name) is refused on stdio after Stream D Phase 4. Pass `category_id` instead.");
      }
      if (category_id == null) {
        return sqliteErr("Pass `category_id` (numeric).");
      }
      const cat = await sqlite.prepare(
        `SELECT id FROM categories WHERE user_id = ? AND id = ?`
      ).get(userId, category_id) as { id: number } | undefined;
      if (!cat) return sqliteErr(`Category #${category_id} not found or not owned by you.`);
      const existing = await sqlite.prepare(`SELECT id FROM budgets WHERE user_id = ? AND category_id = ? AND month = ?`).get(userId, cat.id, month) as { id: number } | undefined;
      if (!existing) return sqliteErr(`No budget for category #${Number(cat.id)} in ${month}`);
      await sqlite.prepare(`DELETE FROM budgets WHERE id = ? AND user_id = ?`).run(existing.id, userId);
      return txt({ success: true, message: `Budget deleted: category #${Number(cat.id)} for ${month}` });
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
      currency: supportedCurrencyEnum.optional().describe("Currency (default CAD)"),
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
      currency: supportedCurrencyEnum.optional(),
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
    "Delete an account by id (only if it has no transactions, unless force=true). Stream D Phase 4 (stdio): pass `account_id` (numeric) — `account` (name) is refused.",
    {
      account: z.string().optional().describe("REFUSED on stdio (Stream D Phase 4). Pass `account_id` instead."),
      account_id: z.number().int().optional().describe("Account FK (accounts.id)."),
      force: z.boolean().optional(),
    },
    async ({ account, account_id, force }) => {
      if (account != null) {
        return sqliteErr("`account` (name) is refused on stdio after Stream D Phase 4. Pass `account_id` instead.");
      }
      if (account_id == null) {
        return sqliteErr("Pass `account_id` (numeric).");
      }
      const acct = await sqlite.prepare(
        `SELECT id FROM accounts WHERE user_id = ? AND id = ?`
      ).get(userId, account_id) as { id: number } | undefined;
      if (!acct) return sqliteErr(`Account #${account_id} not found or not owned by you.`);
      const count = (await sqlite.prepare(`SELECT COUNT(*) as cnt FROM transactions WHERE user_id = ? AND account_id = ?`).get(userId, acct.id) as { cnt: number }).cnt;
      if (count > 0 && !force) return sqliteErr(`Account #${Number(acct.id)} has ${count} transaction(s). Pass force=true to delete.`);
      await sqlite.prepare(`DELETE FROM accounts WHERE id = ? AND user_id = ?`).run(acct.id, userId);
      return txt({ success: true, message: `Account #${Number(acct.id)} deleted${count > 0 ? ` (${count} transactions also removed)` : ""}` });
    }
  );

  // ── update_goal ────────────────────────────────────────────────────────────
  server.tool(
    "update_goal",
    "Update a financial goal's target, deadline, status, or linked accounts. Refused on stdio (Stream D Phase 4 — no DEK).",
    {
      goal: z.string().describe("Goal name (fuzzy matched)"),
      target_amount: z.number().optional(),
      deadline: ymdDate.optional(),
      status: z.enum(["active", "completed", "paused"]).optional(),
      name: z.string().optional().describe("Rename the goal"),
      account_ids: z.array(z.number().int()).optional().describe("Replace linked accounts (issue #130). Refused on stdio — use HTTP MCP."),
    },
    async ({ goal, target_amount, deadline, status, name, account_ids }) => {
      // Stream D Phase 4 — stdio cannot update goals (would touch name_ct).
      void goal; void target_amount; void deadline; void status; void name; void account_ids;
      return streamDRefuse("goals");
    }
  );

  // ── delete_goal ────────────────────────────────────────────────────────────
  server.tool(
    "delete_goal",
    "Delete a financial goal by id. Stream D Phase 4 (stdio): pass `goal_id` (numeric) — `goal` (name) is refused.",
    {
      goal: z.string().optional().describe("REFUSED on stdio (Stream D Phase 4). Pass `goal_id` instead."),
      goal_id: z.number().int().optional().describe("Goal FK (goals.id)."),
    },
    async ({ goal, goal_id }) => {
      if (goal != null) {
        return sqliteErr("`goal` (name) is refused on stdio after Stream D Phase 4. Pass `goal_id` instead.");
      }
      if (goal_id == null) {
        return sqliteErr("Pass `goal_id` (numeric).");
      }
      const g = await sqlite.prepare(
        `SELECT id FROM goals WHERE user_id = ? AND id = ?`
      ).get(userId, goal_id) as { id: number } | undefined;
      if (!g) return sqliteErr(`Goal #${goal_id} not found or not owned by you.`);
      await sqlite.prepare(`DELETE FROM goals WHERE id = ? AND user_id = ?`).run(g.id, userId);
      return txt({ success: true, message: `Goal #${Number(g.id)} deleted` });
    }
  );

  // ── create_category ────────────────────────────────────────────────────────
  server.tool(
    "create_category",
    "Create a new transaction category",
    {
      name: z.string().describe("Category name (must be unique)"),
      // Issue #211 (Bug d): aligned with the rest of the system on
      // 'R' for transfer (was 'T'). Stdio create_category refuses
      // post Stream D Phase 4 anyway, but keeping the enum honest
      // so a future stdio-with-DEK transport doesn't reintroduce
      // the orphan-type bug.
      type: z.enum(["E", "I", "R"]).describe("'E'=expense, 'I'=income, 'R'=transfer"),
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
    "Create an auto-categorization rule for future imports. Stream D Phase 4 (stdio): pass `assign_category_id` (numeric) — `assign_category` (name) is refused.",
    {
      match_payee: z.string().describe("Payee pattern (supports % wildcards)"),
      assign_category: z.string().optional().describe("REFUSED on stdio (Stream D Phase 4). Pass `assign_category_id` instead."),
      assign_category_id: z.number().int().optional().describe("Category FK (categories.id)."),
      rename_to: z.string().optional(),
      assign_tags: z.string().optional(),
      priority: z.number().optional().describe("Default 0"),
    },
    async ({ match_payee, assign_category, assign_category_id, rename_to, assign_tags, priority }) => {
      if (assign_category != null) {
        return sqliteErr("`assign_category` (name) is refused on stdio after Stream D Phase 4. Pass `assign_category_id` instead.");
      }
      if (assign_category_id == null) {
        return sqliteErr("Pass `assign_category_id` (numeric).");
      }
      const cat = await sqlite.prepare(
        `SELECT id FROM categories WHERE user_id = ? AND id = ?`
      ).get(userId, assign_category_id) as { id: number } | undefined;
      if (!cat) return sqliteErr(`Category #${assign_category_id} not found or not owned by you.`);
      // Issue #214 — schema is (match_field, match_type, match_value), NOT
      // `match_payee`. Synthesize the new triplet from the user-facing
      // `match_payee` alias (legacy `%` wildcards stripped) and stamp the
      // synthesized name + created_at (both NOT NULL with no DB default).
      const cleanedValue = match_payee.replace(/%/g, "");
      const synthName = `Match "${cleanedValue}" → category #${Number(cat.id)}`.slice(0, 200);
      const todayISO = new Date().toISOString().split("T")[0];
      await sqlite.prepare(
        `INSERT INTO transaction_rules
           (user_id, name, match_field, match_type, match_value,
            assign_category_id, rename_to, assign_tags, priority, is_active, created_at)
         VALUES (?, ?, 'payee', 'contains', ?, ?, ?, ?, ?, 1, ?)`
      ).run(userId, synthName, cleanedValue, cat.id, rename_to ?? null, assign_tags ?? null, priority ?? 0, todayISO);
      return txt({ success: true, message: `Rule created: "${cleanedValue}" → category #${Number(cat.id)}` });
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
      currency: supportedCurrencyEnum.optional(),
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
      currency: supportedCurrencyEnum.optional(),
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
      // Stream D Phase 4 (2026-05-03): plaintext `name`/`symbol` columns
      // were physically dropped on dev. Read the ciphertext siblings; with
      // no DEK on stdio, the row's effective `name`/`symbol` are the raw
      // `v1:...` strings. The strict matcher will simply not find a hit
      // for plaintext user input (e.g. "TESTV") — graceful degradation
      // (call returns "not found" rather than 500'ing on a missing column).
      const rawHoldings = await sqlite.prepare(
        `SELECT id, name_ct, symbol_ct FROM portfolio_holdings WHERE user_id = ?`
      ).all(userId) as SqliteRow[];
      const allHoldings: SqliteRow[] = rawHoldings.map((r) => {
        const out: SqliteRow = { ...r };
        const nameCt = (r.name_ct ?? r.nameCt) as string | null | undefined;
        const symbolCt = (r.symbol_ct ?? r.symbolCt) as string | null | undefined;
        if (nameCt) out.name = nameCt;
        if (symbolCt) out.symbol = symbolCt;
        return out;
      });
      // Issue #127: strict matcher gated on token overlap so a 1-char
      // holding name (e.g. decrypted "S") cannot silently swallow a longer
      // input (e.g. "TESTV") via reverse-includes and DELETE the wrong row.
      const resolved = resolvePortfolioHoldingStrict(holding, allHoldings);
      if (!resolved.ok) {
        if (resolved.reason === "low_confidence") {
          const sName = String(resolved.suggestion.name ?? "");
          return sqliteErr(`Holding "${holding}" did not match strongly — did you mean "${sName}" (id=${Number(resolved.suggestion.id)})? Re-call with the exact name to confirm.`);
        }
        return sqliteErr(`Holding "${holding}" not found`);
      }
      const h = resolved.holding;
      const matchedName = String(h.name ?? "");

      const count = (await sqlite.prepare(
        `SELECT COUNT(*) as cnt FROM transactions WHERE user_id = ? AND portfolio_holding_id = ?`
      ).get(userId, h.id) as { cnt: number }).cnt;

      await sqlite.prepare(`DELETE FROM portfolio_holdings WHERE id = ? AND user_id = ?`).run(h.id, userId);
      // Per CLAUDE.md "Every MCP tx-mutating write must call invalidateUser":
      // FK ON DELETE SET NULL mutates linked transactions' portfolio_holding_id,
      // so the per-user tx cache must be invalidated.
      invalidateUserTxCache(userId);
      return txt({
        success: true,
        message: count > 0
          ? `Holding "${matchedName}" deleted; ${count} transaction(s) unlinked (still queryable, no longer aggregated under this holding).`
          : `Holding "${matchedName}" deleted.`,
      });
    }
  );

  // ── get_portfolio_analysis ─────────────────────────────────────────────────
  // Issue #123: schema kept symmetric with HTTP (account_id / account filters
  // accepted) so a single client can target either transport with the same
  // payload. Stdio still refuses the call wholesale under Stream D Phase 4
  // because account + holding names are encrypted and there's no DEK on this
  // transport — the params are documented as accepted-but-unused.
  server.tool(
    "get_portfolio_analysis",
    "Portfolio holdings with allocation breakdown. Stream D Phase 4: stdio cannot decrypt holding/account names — use HTTP MCP or the web UI for this query. Schema includes `account_id` / `account` filters for parity with HTTP, but they are unused on this transport.",
    {
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
      symbols: z.array(z.string()).optional(),
      account_id: z.number().int().optional().describe("Account FK (parity with HTTP transport — unused on stdio under Stream D Phase 4)."),
      account: z.string().optional().describe("Account name/alias (parity with HTTP — unused on stdio under Stream D Phase 4)."),
    },
    async ({ account_id, account }) => {
      void account_id; void account;
      return streamDRefuseRead("get_portfolio_analysis", "portfolio_holdings");
    },
  );

  // ── get_portfolio_performance ──────────────────────────────────────────────
  server.tool(
    "get_portfolio_performance",
    "Portfolio performance: cost basis and realized P&L by holding. Stream D Phase 4: stdio cannot decrypt holding names — use HTTP MCP or the web UI for this query.",
    {
      period: z.enum(["1m", "3m", "6m", "1y", "all"]).optional(),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async () => streamDRefuseRead("get_portfolio_performance", "portfolio_holdings"),
  );

  // ── analyze_holding ────────────────────────────────────────────────────────
  server.tool(
    "analyze_holding",
    "Deep-dive analysis of a single holding. Stream D Phase 4: stdio cannot decrypt holding/account names — use HTTP MCP or the web UI for this query.",
    {
      symbol: z.string().optional(),
      holdingId: z.number().int().optional(),
      reportingCurrency: z.string().optional(),
    },
    async ({ symbol, holdingId, reportingCurrency }) => {
      void symbol; void holdingId; void reportingCurrency;
      return streamDRefuseRead("analyze_holding", "portfolio_holdings");
    }
  );

  // ── trace_holding_quantity ─────────────────────────────────────────────────
  server.tool(
    "trace_holding_quantity",
    "Per-transaction quantity contributions for a single holding. Stream D Phase 4 (stdio): pass `holdingId` (numeric) — `symbol` (name) is refused because stdio cannot decrypt names.",
    {
      symbol: z.string().optional().describe("REFUSED on stdio (Stream D Phase 4). Pass `holdingId` instead."),
      holdingId: z.number().int().optional().describe("Filter to this exact portfolio_holdings.id."),
    },
    async ({ symbol, holdingId }) => {
      if (symbol != null) {
        return sqliteErr("`symbol` (name) is refused on stdio after Stream D Phase 4. Pass `holdingId` instead.");
      }
      if (holdingId == null) {
        return sqliteErr("Pass `holdingId` (numeric).");
      }

      // Validate ownership without reading dropped columns.
      const owns = await sqlite.prepare(
        `SELECT id FROM portfolio_holdings WHERE user_id = ? AND id = ?`
      ).get(userId, holdingId) as { id: number } | undefined;
      if (!owns) return sqliteErr(`Holding #${holdingId} not found or not owned by you.`);

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
      `).get(userId, holdingId, userId) as { cnt: number };
      const unjoinedTransactionCount = Number(unjoinedRow?.cnt ?? 0);

      // Stream D Phase 4: SELECT only ciphertext-free columns from accounts.
      const legsRaw = await sqlite.prepare(`
        SELECT t.id, t.date, t.account_id, t.quantity, t.amount, t.source, t.payee
        FROM transactions t
        INNER JOIN holding_accounts ha
          ON ha.holding_id = t.portfolio_holding_id
         AND ha.account_id = t.account_id
         AND ha.user_id = ?
        WHERE t.user_id = ?
          AND t.portfolio_holding_id = ?
        ORDER BY t.date ASC, t.id ASC
      `).all(userId, userId, holdingId) as SqliteRow[];

      let runningSum = 0;
      const legs = legsRaw.map((row) => {
        const qty = Number(row.quantity ?? 0);
        runningSum += qty;
        const source: string | null = row.source == null ? null : String(row.source);
        const payee: string | null = row.payee == null ? null : String(row.payee);
        return {
          transactionId: Number(row.id),
          date: row.date,
          accountId: Number(row.account_id),
          quantity: qty,
          amount: Number(row.amount ?? 0),
          source,
          payee,
          runningSum: Math.round(runningSum * 10000) / 10000,
        };
      });

      const totalQty = Math.round(runningSum * 10000) / 10000;
      const perAccount = new Map<number, { accountId: number; qty: number; legCount: number }>();
      for (const l of legs) {
        const e = perAccount.get(l.accountId);
        if (e) { e.qty += l.quantity; e.legCount += 1; }
        else perAccount.set(l.accountId, { accountId: l.accountId, qty: l.quantity, legCount: 1 });
      }
      const perAccountArr = [...perAccount.values()].map((e) => ({
        ...e,
        qty: Math.round(e.qty * 10000) / 10000,
      }));

      return txt({
        holdingId,
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
    "Portfolio-level investment analytics. Stream D Phase 4: stdio cannot decrypt holding names — use HTTP MCP or the web UI for this query.",
    {
      mode: z.enum(["patterns", "rebalancing", "benchmark"]).optional(),
      targets: z.array(z.object({
        holding: z.string(),
        target_pct: z.number(),
      })).optional(),
      benchmark: z.enum(["SP500", "TSX", "MSCI_WORLD", "BONDS_CA"]).optional(),
      reportingCurrency: z.string().optional(),
    },
    async () => streamDRefuseRead("get_investment_insights", "portfolio_holdings"),
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
          delete_account: "delete_account(account_id, force?) — stdio refuses `account` (name) post Stream D Phase 4; pass account_id (numeric).",
          add_goal: "add_goal(name, type, target_amount, deadline?, account?)",
          update_goal: "update_goal(goal, target_amount?, deadline?, status?, name?)",
          delete_goal: "delete_goal(goal)",
          create_category: "create_category(name, type, group?, note?) — type: E/I/R",
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
          transaction_rules: "id, name, match_field, match_type, match_value, assign_category_id, rename_to, assign_tags, priority, is_active, created_at",
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
    "List all loans. Stream D Phase 4: stdio cannot decrypt loan / linked-account names — use HTTP MCP or the web UI for this query.",
    {},
    async () => streamDRefuseRead("list_loans", "loans"),
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
      start_date: ymdDate,
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
      start_date: ymdDate.optional(),
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
      const existing = await sqlite.prepare(`SELECT id FROM loans WHERE id = ? AND user_id = ?`).get(id, userId) as { id: number } | undefined;
      if (!existing) return sqliteErr(`Loan #${id} not found`);
      await sqlite.prepare(`DELETE FROM loans WHERE id = ? AND user_id = ?`).run(id, userId);
      return txt({ success: true, data: { id, message: `Loan #${id} deleted` } });
    }
  );

  // ── get_loan_amortization ─────────────────────────────────────────────────
  server.tool(
    "get_loan_amortization",
    "Full amortization schedule for a loan. Amounts are in the loan's own currency; the response surfaces both the loan currency and reportingCurrency for context.",
    {
      loan_id: z.number(),
      as_of_date: ymdDate.optional().describe("YYYY-MM-DD (default: today)"),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async ({ loan_id, as_of_date, reportingCurrency }) => {
      const reporting = await resolveReportingCurrencyStdio(sqlite, userId, reportingCurrency);
      const loan = await sqlite.prepare(
        `SELECT id, principal, annual_rate, term_months, start_date, payment_frequency, extra_payment, currency FROM loans WHERE id = ? AND user_id = ?`
      ).get(loan_id, userId) as SqliteRow | undefined;
      if (!loan) return sqliteErr(`Loan #${loan_id} not found`);
      // Issue #213 — guard against legacy bad start_date so this tool no
      // longer throws Invalid time value when one slipped past the
      // pre-validator code paths.
      if (parseYmdSafe(String(loan.start_date)) === null) {
        return txt({
          success: false,
          error: "invalid start_date",
          loanId: loan_id,
          value: loan.start_date,
        });
      }
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
          // Stream D Phase 4: loanName omitted on stdio (cannot decrypt name_ct).
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
        `SELECT id, principal, annual_rate, term_months, start_date, payment_amount, payment_frequency, extra_payment FROM loans WHERE user_id = ?`
      ).all(userId) as SqliteRow[];
      if (!loans.length) return txt({ success: true, data: { message: "No loans found", strategies: {} } });
      const today = new Date().toISOString().split("T")[0];
      // Issue #213 — split out legacy bad rows so one bad start_date no
      // longer poisons the whole strategy computation.
      const excluded: Array<{ loanId: number; error: string; value: unknown }> = [];
      const validLoans = loans.filter((l) => {
        if (parseYmdSafe(String(l.start_date)) === null) {
          excluded.push({ loanId: Number(l.id), error: "invalid start_date", value: l.start_date });
          return false;
        }
        return true;
      });
      const debts: Debt[] = validLoans.map((l) => {
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
          // Stream D Phase 4: stdio cannot decrypt loan name — surface id only.
          name: `Loan #${Number(l.id)}`,
          balance: Math.round(balance * 100) / 100,
          rate: Number(l.annual_rate),
          minPayment,
        };
      });
      const strat = strategy ?? "both";
      const extra = extra_payment ?? 0;
      const result: Record<string, unknown> = { inputs: { extraPayment: extra, debts }, reportingCurrency: reporting };
      if (excluded.length) result.excluded = excluded;
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
      date: ymdDate.optional(),
    },
    async ({ from, to, date }) => {
      // Issue #206 — validate currencies + date at the MCP boundary.
      let fromCode: string;
      let toCode: string;
      let d: string;
      try {
        fromCode = validateCurrencyCode(from);
        toCode = validateCurrencyCode(to);
        d = validateFxDate(date ?? new Date().toISOString().split("T")[0]);
      } catch (e) {
        return sqliteErr(e instanceof Error ? e.message : String(e));
      }
      if (fromCode === toCode) {
        return txt({ success: true, data: { from: fromCode, to: toCode, date: d, rate: 1, source: "identity" } });
      }
      // Issue #231 — surface per-leg source + worst-case top-level source.
      const fromLookup = await getRateToUsdDetailed(fromCode, d, userId);
      const toLookup = await getRateToUsdDetailed(toCode, d, userId);
      if (toLookup.rate === 0) return sqliteErr(`Cannot convert into ${toCode} (rate is zero)`);
      const rate = fromLookup.rate / toLookup.rate;
      const ratePrecise = Math.round(rate * 100000000) / 100000000;
      const collapsedSource = collapseLegSources([fromLookup, toLookup]);
      const effectiveDate =
        fromLookup.effectiveDate < toLookup.effectiveDate
          ? fromLookup.effectiveDate
          : toLookup.effectiveDate;
      return txt({ success: true, data: {
        from: fromCode, to: toCode, date: d,
        rate: ratePrecise,
        source: collapsedSource,
        effectiveDate,
        legs: {
          from: { ...fromLookup, currency: fromCode },
          to: { ...toLookup, currency: toCode },
        },
      } });
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
      date: ymdDate,
      rate: z.number().positive(),
      dateTo: ymdDate.optional(),
      note: z.string().optional(),
    },
    async ({ from, to, date, rate, dateTo, note }) => {
      // Issue #206 — validate currencies + dates at the MCP boundary so a
      // future-dated or unknown-currency override can't poison the cache.
      let fromU: string;
      let toU: string;
      let dateFrom: string;
      let dateToFinal: string;
      try {
        fromU = validateCurrencyCode(from);
        toU = validateCurrencyCode(to);
        dateFrom = validateFxDate(date);
        dateToFinal = validateFxDate(dateTo ?? date);
      } catch (e) {
        return sqliteErr(e instanceof Error ? e.message : String(e));
      }
      if (dateToFinal < dateFrom) {
        return sqliteErr(`dateTo (${dateToFinal}) must be on or after date (${dateFrom}).`);
      }
      let currency: string;
      let rateToUsd: number;
      if (fromU === "USD") { currency = toU; rateToUsd = 1 / rate; }
      else if (toU === "USD") { currency = fromU; rateToUsd = rate; }
      else return sqliteErr(`Cross-pair overrides aren't supported. Anchor against USD: pin ${fromU}→USD and ${toU}→USD separately.`);

      const result = await sqlite.prepare(
        `INSERT INTO fx_overrides (user_id, currency, date_from, date_to, rate_to_usd, note) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
      ).get(userId, currency, dateFrom, dateToFinal, rateToUsd, note ?? "") as { id: number } | undefined;
      return txt({ success: true, data: { id: result?.id, currency, dateFrom, dateTo: dateToFinal, rateToUsd, action: "created" } });
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
      date: ymdDate.optional(),
    },
    async ({ amount, from, to, date }) => {
      // Issue #206 — validate currencies + date at the MCP boundary.
      let fromCode: string;
      let toCode: string;
      let d: string;
      try {
        fromCode = validateCurrencyCode(from);
        toCode = validateCurrencyCode(to);
        d = validateFxDate(date ?? new Date().toISOString().split("T")[0]);
      } catch (e) {
        return sqliteErr(e instanceof Error ? e.message : String(e));
      }
      if (fromCode === toCode) {
        return txt({ success: true, data: { amount, from: fromCode, to: toCode, rate: 1, converted: amount } });
      }
      // Issue #231 — per-leg source + worst-case top-level source (mirrors HTTP).
      const fromLookup = await getRateToUsdDetailed(fromCode, d, userId);
      const toLookup = await getRateToUsdDetailed(toCode, d, userId);
      if (toLookup.rate === 0) return sqliteErr(`Cannot convert into ${toCode} (rate is zero)`);
      const rate = fromLookup.rate / toLookup.rate;
      const converted = Math.round(amount * rate * 100) / 100;
      const ratePrecise = Math.round(rate * 100000000) / 100000000;
      const collapsedSource = collapseLegSources([fromLookup, toLookup]);
      const effectiveDate =
        fromLookup.effectiveDate < toLookup.effectiveDate
          ? fromLookup.effectiveDate
          : toLookup.effectiveDate;
      return txt({ success: true, data: {
        amount, from: fromCode, to: toCode,
        rate: ratePrecise, converted, date: d,
        source: collapsedSource,
        effectiveDate,
        legs: {
          from: { ...fromLookup, currency: fromCode },
          to: { ...toLookup, currency: toCode },
        },
      } });
    }
  );

  // ── list_subscriptions ────────────────────────────────────────────────────
  server.tool(
    "list_subscriptions",
    "List all subscriptions. Stream D Phase 4: stdio cannot decrypt subscription/category/account names — use HTTP MCP or the web UI for this query.",
    { status: z.enum(["active", "paused", "cancelled", "all"]).optional() },
    async () => streamDRefuseRead("list_subscriptions", "subscriptions"),
  );

  // ── add_subscription ──────────────────────────────────────────────────────
  server.tool(
    "add_subscription",
    "Create a new subscription",
    {
      name: z.string(),
      amount: z.number(),
      cadence: z.enum(["weekly", "monthly", "quarterly", "annual", "yearly"]),
      next_billing_date: ymdDate,
      currency: supportedCurrencyEnum.optional(),
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
      next_billing_date: ymdDate.optional(),
      currency: supportedCurrencyEnum.optional(),
      category: z.string().optional().describe("Empty string clears"),
      account: z.string().optional().describe("Account name or alias (fuzzy matched against name; exact match on alias). Empty string clears."),
      status: z.enum(["active", "paused", "cancelled"]).optional(),
      cancel_reminder_date: ymdDate.optional(),
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
      const existing = await sqlite.prepare(`SELECT id FROM subscriptions WHERE id = ? AND user_id = ?`).get(id, userId) as { id: number } | undefined;
      if (!existing) return sqliteErr(`Subscription #${id} not found`);
      await sqlite.prepare(`DELETE FROM subscriptions WHERE id = ? AND user_id = ?`).run(id, userId);
      return txt({ success: true, data: { id, message: `Subscription #${id} deleted` } });
    }
  );

  // ── list_rules ────────────────────────────────────────────────────────────
  server.tool(
    "list_rules",
    "List all auto-categorization rules. Stream D Phase 4: `category_name` is omitted on stdio (cannot decrypt categories.name_ct); `assign_category_id` is still returned.",
    {},
    async () => {
      const rows = await sqlite.prepare(
        `SELECT r.id, r.name, r.match_field, r.match_type, r.match_value,
                r.assign_category_id,
                r.assign_tags, r.rename_to, r.is_active, r.priority, r.created_at
         FROM transaction_rules r
         WHERE r.user_id = ? ORDER BY r.priority DESC, r.id`
      ).all(userId);
      return txt({ success: true, data: rows });
    }
  );

  // ── update_rule ───────────────────────────────────────────────────────────
  server.tool(
    "update_rule",
    "Update any field of an existing transaction rule. Stream D Phase 4 (stdio): pass `assign_category_id` (numeric) — `assign_category` (name) is refused.",
    {
      id: z.number(),
      name: z.string().optional(),
      match_field: z.enum(["payee", "amount", "tags"]).optional(),
      match_type: z.enum(["contains", "exact", "regex", "greater_than", "less_than"]).optional(),
      match_value: z.string().optional(),
      match_payee: z.string().optional(),
      assign_category: z.string().optional().describe("REFUSED on stdio (Stream D Phase 4). Pass `assign_category_id` instead."),
      assign_category_id: z.number().int().nullable().optional().describe("Category FK (categories.id). Pass null to clear."),
      assign_tags: z.string().optional(),
      rename_to: z.string().optional(),
      is_active: z.boolean().optional(),
      priority: z.number().optional(),
    },
    async ({ id, name, match_field, match_type, match_value, match_payee, assign_category, assign_category_id, assign_tags, rename_to, is_active, priority }) => {
      if (assign_category !== undefined) {
        return sqliteErr("`assign_category` (name) is refused on stdio after Stream D Phase 4. Pass `assign_category_id` instead.");
      }
      const existing = await sqlite.prepare(`SELECT id FROM transaction_rules WHERE id = ? AND user_id = ?`).get(id, userId);
      if (!existing) return sqliteErr(`Rule #${id} not found`);

      let assignCategoryIdUpdate: number | null | undefined;
      if (assign_category_id !== undefined) {
        if (assign_category_id === null) assignCategoryIdUpdate = null;
        else {
          const cat = await sqlite.prepare(
            `SELECT id FROM categories WHERE user_id = ? AND id = ?`
          ).get(userId, assign_category_id) as { id: number } | undefined;
          if (!cat) return sqliteErr(`Category #${assign_category_id} not found or not owned by you.`);
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
    "Dry-run a rule pattern against the user's existing transactions. Stream D Phase 4: stdio cannot decrypt category/account names — use HTTP MCP or the web UI for this query.",
    {
      match_payee: z.string().optional(),
      match_field: z.enum(["payee", "amount", "tags"]).optional(),
      match_type: z.enum(["contains", "exact", "regex", "greater_than", "less_than"]).optional(),
      match_value: z.string().optional(),
      match_amount: z.number().optional(),
      sample_size: z.number().optional(),
    },
    async () => streamDRefuseRead("test_rule", "categories"),
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
  server.tool(
    "suggest_transaction_details",
    "Suggest category + tags for a transaction. Stream D Phase 4: stdio cannot decrypt category names — use HTTP MCP at /mcp or the web UI.",
    {
      payee: z.string(),
      amount: z.number().optional(),
      account_id: z.number().optional(),
      top_n: z.number().optional(),
    },
    async () => streamDRefuseRead("suggest_transaction_details", "categories"),
  );

  // ── list_splits ───────────────────────────────────────────────────────────
  server.tool(
    "list_splits",
    "List all splits for a transaction. Stream D Phase 4 (stdio): `category_name` / `account_name` are omitted (cannot decrypt name_ct); ids are still returned.",
    { transaction_id: z.number() },
    async ({ transaction_id }) => {
      const owner = await sqlite.prepare(`SELECT id FROM transactions WHERE id = ? AND user_id = ?`).get(transaction_id, userId);
      if (!owner) return sqliteErr(`Transaction #${transaction_id} not found`);
      const rows = await sqlite.prepare(
        `SELECT s.id, s.transaction_id, s.category_id,
                s.account_id,
                s.amount, s.note, s.description, s.tags
         FROM transaction_splits s
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
    start_date: ymdDate.optional(),
    end_date: ymdDate.optional(),
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
    // Issue #213 — date validation runs in `resolveBulkChanges` (not the
    // schema) so a single bad date surfaces in `unappliedChanges` rather
    // than collapsing the whole zod parse.
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
    // Issue #213 — date validation gate. A bad date NEVER lands in
    // `resolved.date` (commitBulkUpdate writes unconditionally when the
    // key is present); surfaced via `unappliedChanges`.
    if (changes.date !== undefined) {
      if (parseYmdSafe(changes.date) === null) {
        unapplied.push({
          field: "date",
          requestedValue: changes.date,
          reason: `Invalid date "${changes.date}" — expected YYYY-MM-DD calendar date.`,
        });
      } else {
        resolved.date = changes.date;
      }
    }
    if (changes.note !== undefined) resolved.note = changes.note;
    if (changes.payee !== undefined) resolved.payee = changes.payee;
    if (changes.is_business !== undefined) resolved.is_business = changes.is_business;
    if (changes.tags !== undefined) resolved.tags = changes.tags;

    if (changes.category !== undefined) {
      // Stream D Phase 4: stdio cannot resolve category names without a DEK.
      // Refuse the `category` (name) path; callers must pass `category_id` instead.
      unapplied.push({
        field: "category",
        requestedValue: changes.category,
        reason: "`category` (name) is refused on stdio after Stream D Phase 4. Pass `category_id` instead.",
      });
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
    // Stream D Phase 4: stdio cannot decrypt account/category names — surface ids only.
    const before = await sqlite.prepare(
      `SELECT t.id, t.date, t.account_id, t.category_id,
              t.currency, t.amount, t.payee, t.note, t.tags, t.is_business
       FROM transactions t
       WHERE t.id IN (${placeholders}) AND t.user_id = ?
       ORDER BY t.id`
    ).all(...sampleIds, userId) as Record<string, unknown>[];
    const after = before.map((r) => applyChangesToRow(r, resolved));
    // Issue #213 — refuse to mint a token when every requested change
    // failed to resolve. Mirrors the HTTP gate at register-tools-pg.ts.
    const writableKeys = (Object.keys(resolved) as Array<keyof typeof resolved>).filter(
      (k) => k !== "category_name",
    );
    if (writableKeys.length === 0 && unapplied.length > 0) {
      return {
        affectedCount: ids.length,
        sampleBefore: before,
        sampleAfter: after,
        unappliedChanges: unapplied,
        ids: [],
        confirmationToken: "",
      };
    }
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
        // Stream D Phase 4: stdio cannot decrypt account/category names — surface ids only.
        const sample = await sqlite.prepare(
          `SELECT t.id, t.date, t.account_id, t.category_id, t.currency, t.amount, t.payee, t.note, t.tags
           FROM transactions t
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
        const cat = await sqlite.prepare(`SELECT id FROM categories WHERE id = ? AND user_id = ?`).get(category_id, userId) as { id: number } | undefined;
        if (!cat) return sqliteErr(`Category #${category_id} not found`);
        const changes: BulkChanges = { category_id };
        const { affectedCount, sampleBefore, sampleAfter, confirmationToken } = await previewBulk(filter, changes, "bulk_categorize");
        // Stream D Phase 4: stdio cannot decrypt category name — surface id only.
        return txt({ success: true, data: { categoryId: category_id, affectedCount, sampleBefore, sampleAfter, confirmationToken } });
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
        next_billing_date: ymdDate.optional(),
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
    "Preview an uploaded CSV/OFX/QFX file. Stream D Phase 4: stdio cannot resolve account names from the import file (cannot decrypt accounts.name_ct) — use HTTP MCP or the web UI for imports.",
    {
      upload_id: z.string().optional(),
      file_path: z.string().optional(),
      template_id: z.number().optional(),
      column_mapping: z.record(z.string(), z.string()).optional(),
    },
    async ({ upload_id, file_path, template_id, column_mapping }) => {
      void upload_id; void file_path; void template_id; void column_mapping;
      return streamDRefuseRead("preview_import", "accounts");
    }
  );

  // Stream D Phase 4 — the original preview_import body has been deleted.
  // It fuzzy-matched account names from CSV against the (dropped) plaintext
  // accounts.name column. The HTTP MCP at /mcp continues to support imports
  // with full DEK-backed name resolution.

  // ── execute_import ─────────────────────────────────────────────────────────
  server.tool(
    "execute_import",
    "Commit an uploaded file. Stream D Phase 4: stdio cannot resolve account/category names without a DEK — refused entirely. Use HTTP MCP at /mcp or the web UI.",
    {
      upload_id: z.string().optional(),
      file_path: z.string().optional(),
      confirmation_token: z.string(),
      template_id: z.number().optional(),
      column_mapping: z.record(z.string(), z.string()).optional(),
    },
    async () => streamDRefuseRead("execute_import", "accounts"),
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

  // ─────────────────────────────────────────────────────────────────────────
  // Staging review tools — stdio refusals (issue #156, 2026-05-06)
  //
  // The seven staging-review tools all require either (a) the user's DEK
  // (writes that re-encrypt fields under user-tier; approve materializes
  // into encrypted `transactions`) or (b) per-row tier-branched decryption
  // that would silently surface raw `v1:` ciphertext to Claude on user-tier
  // rows when no DEK is available.
  //
  // Stdio MCP carries no DEK and has no per-request user context beyond
  // PF_USER_ID. Every tool refuses cleanly and points at the HTTP MCP
  // transport. The refusal message MUST NOT echo PF_USER_ID — the load-
  // bearing rule is "don't surface user IDs in stdio errors."
  // ─────────────────────────────────────────────────────────────────────────
  const stagingHttpOnlyError = () =>
    sqliteErr(
      "This tool requires the HTTP MCP transport because staging operations need to read or write encrypted data under your DEK. Connect via the HTTP MCP at /mcp instead, or use the web UI at /import/pending.",
    );

  server.tool(
    "list_staged_imports",
    "List the user's staged imports (HTTP MCP only — stdio refuses; staging needs the DEK).",
    {
      status: z.enum(["pending", "imported", "rejected"]).optional(),
      limit: z.number().int().positive().optional(),
    },
    async () => stagingHttpOnlyError(),
  );

  server.tool(
    "get_staged_import",
    "Fetch full detail for one staged import (HTTP MCP only — stdio refuses; staging needs the DEK).",
    { stagedImportId: z.string() },
    async () => stagingHttpOnlyError(),
  );

  server.tool(
    "list_staged_transactions",
    "Flat list of staged transaction rows (HTTP MCP only — stdio refuses; staging needs the DEK).",
    {
      stagedImportId: z.string().optional(),
      dedupStatus: z.enum(["new", "existing", "probable_duplicate"]).optional(),
      rowStatus: z.enum(["pending", "approved", "rejected"]).optional(),
      txType: z.enum(["E", "I", "R"]).optional(),
      limit: z.number().int().positive().optional(),
    },
    async () => stagingHttpOnlyError(),
  );

  server.tool(
    "update_staged_transaction",
    "Edit a single staged transaction row (HTTP MCP only — stdio refuses; staging needs the DEK).",
    {
      stagedTransactionId: z.string(),
      txType: z.enum(["E", "I", "R"]).optional(),
      payee: z.string().optional(),
      category: z.string().optional(),
      note: z.string().optional(),
      tags: z.string().optional(),
      quantity: z.number().nullable().optional(),
      portfolioHoldingId: z.number().int().nullable().optional(),
      enteredAmount: z.number().nullable().optional(),
      enteredCurrency: z.string().nullable().optional(),
      peerStagedId: z.string().nullable().optional(),
      targetAccountId: z.number().int().nullable().optional(),
      forceCommit: z.boolean().optional(),
    },
    async () => stagingHttpOnlyError(),
  );

  server.tool(
    "link_staged_transfer_pair",
    "Sugar over update_staged_transaction (HTTP MCP only — stdio refuses; staging needs the DEK).",
    { rowAId: z.string(), rowBId: z.string() },
    async () => stagingHttpOnlyError(),
  );

  server.tool(
    "approve_staged_rows",
    "Materialize staged rows into the live transactions table (HTTP MCP only — stdio refuses; staging needs the DEK).",
    {
      stagedImportId: z.string(),
      rowIds: z.array(z.string()).optional(),
      forceImportIndices: z.array(z.number().int()).optional(),
      idempotencyKey: z.string().uuid().optional(),
      confirmation_token: z.string().optional(),
    },
    async () => stagingHttpOnlyError(),
  );

  server.tool(
    "reject_staged_import",
    "Reject (hard-delete) a staged import (HTTP MCP only — stdio refuses; staging needs the DEK).",
    {
      stagedImportId: z.string(),
      confirmation_token: z.string().optional(),
    },
    async () => stagingHttpOnlyError(),
  );
}
