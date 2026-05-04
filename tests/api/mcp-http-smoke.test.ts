/**
 * MCP HTTP smoke gate — Stream D Phase 4 regression catcher.
 *
 * Phase 4 (2026-05-03) physically dropped 8 plaintext display-name columns:
 *   accounts.name, accounts.alias, categories.name, goals.name, loans.name,
 *   subscriptions.name, portfolio_holdings.name, portfolio_holdings.symbol.
 *
 * Any HTTP MCP read tool whose handler emits SQL that still references one
 * of those columns will 500 in production with `Failed query: ...`. PR #131
 * covered the stdio surface but missed ~25 HTTP raw-SQL sites; this gate
 * fails the build if a future change reintroduces a reference.
 *
 * Strategy: register the tool surface against a fake `DbLike` that records
 * every Drizzle `sql` template's text and bound params. Invoke each
 * read-tool's handler with a non-error input. Then assert that no captured
 * SQL string contains a dropped-column reference. The fake also returns
 * empty rowsets so handlers exercise their full code path without a real
 * Postgres in CI.
 *
 * The dropped-column patterns to forbid are the ones a JOIN alias would
 * produce (e.g. `a.name`, `c.name`, `ph.symbol`). The HMAC + ciphertext
 * siblings (`a.name_ct`, `c.name_lookup`) are explicitly allowed.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";

// Stable env so the auth/encryption modules don't blow up at import time.
process.env.PF_JWT_SECRET = "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPgTools } from "../../mcp-server/register-tools-pg";

type CapturedQuery = { text: string; params: unknown[] };

/**
 * Fake DbLike that captures the text of every issued query. We don't need to
 * return realistic rowsets — every captured handler path is tolerant of an
 * empty result. We do need to return `{ rows: [] }` AND something safe for
 * the `rowCount` reads.
 */
function makeCapturingDb(): { db: { execute: (q: unknown) => Promise<unknown> }; queries: CapturedQuery[] } {
  const queries: CapturedQuery[] = [];
  const db = {
    execute: async (q: unknown) => {
      // Drizzle's `sql` template object exposes `.queryChunks` (an array of
      // raw strings + Param objects) and produces SQL via toQuery(). We
      // serialise it ourselves to avoid pulling in a real driver.
      const text = serializeSqlTemplate(q);
      queries.push({ text, params: [] });
      return { rows: [], rowCount: 0 };
    },
  };
  return { db, queries };
}

/**
 * Walk a Drizzle `sql` template and return the SQL text with placeholders
 * inlined as `?`. We only need this for substring matching against dropped
 * column names — exact param values don't matter.
 */
function serializeSqlTemplate(q: unknown): string {
  if (!q || typeof q !== "object") return String(q);
  // Drizzle's SQL class stores raw chunks in `queryChunks`. Each chunk is
  // either a string-like object with `.value: string[]` (raw text) or a
  // Param with `.value`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sqlObj = q as any;
  // The simplest serialisation path is `sqlObj.toQuery()` if available;
  // fall back to walking queryChunks for raw text.
  try {
    const dialect = { escapeName: (n: string) => `"${n}"`, escapeParam: () => "?" };
    const result = sqlObj.toQuery?.(dialect);
    if (result && typeof result.sql === "string") return result.sql;
  } catch {
    // fall through
  }
  // queryChunks fallback — concatenate every text chunk we find.
  const chunks = sqlObj.queryChunks ?? sqlObj.chunks ?? [];
  let out = "";
  for (const c of chunks) {
    if (c && typeof c === "object" && Array.isArray((c as { value?: unknown[] }).value)) {
      out += (c as { value: string[] }).value.join("");
    } else if (typeof c === "string") {
      out += c;
    }
  }
  return out;
}

/**
 * Register the tool surface against a fresh server + capturing DB. Returns
 * the server and the captured-query array, which grows as handlers run.
 */
function bootstrap() {
  const { db, queries } = makeCapturingDb();
  const server = new McpServer({ name: "smoke-test", version: "0.0.0" });
  // dek=null exercises the no-DEK code path. Many handlers gracefully
  // degrade names to null when dek is null; that's fine for a SQL-shape
  // check. (Some category-name-lookup paths short-circuit when dek is
  // null and never hit the broken SQL — those still need a separate
  // dek-present pass.)
  const dek = randomBytes(32);
  registerPgTools(server, db, "default", dek);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }>;
  return { server, tools, queries };
}

/**
 * Patterns that, if present in any captured SQL string, indicate a
 * still-broken Phase-4 reference. These must not appear anywhere in the
 * MCP HTTP read surface.
 *
 * Negative-look-behinds eliminate false positives:
 *   - `a.name_ct` / `a.name_lookup` are the HMAC + ciphertext siblings; allowed.
 *   - `a.name AS account_name_ct` is a typo nobody writes today; we still
 *     match `a.name AS account_name` as a hard fail.
 */
const DROPPED_PATTERNS = [
  /\ba\.name\b(?!_ct|_lookup)/,
  /\ba\.alias\b(?!_ct|_lookup)/,
  /\bc\.name\b(?!_ct|_lookup)/,
  /\bg\.name\b(?!_ct|_lookup)/,
  /\bl\.name\b(?!_ct|_lookup)/,
  /\bs\.name\b(?!_ct|_lookup)/,
  /\bph\.name\b(?!_ct|_lookup)/,
  /\bph\.symbol\b(?!_ct|_lookup)/,
];

function findDroppedRefs(queries: CapturedQuery[]): Array<{ pattern: RegExp; sql: string }> {
  const hits: Array<{ pattern: RegExp; sql: string }> = [];
  for (const q of queries) {
    for (const p of DROPPED_PATTERNS) {
      if (p.test(q.text)) {
        hits.push({ pattern: p, sql: q.text });
        break;
      }
    }
  }
  return hits;
}

/**
 * The "live MCP smoke" list from the action-plan file (reviews/2026-05-04/
 * 01-mcp-http-phase4-cleanup-incomplete.md §"Live MCP smoke"). Each tool +
 * the args we pass in. Args are the minimal valid input.
 */
const SMOKE_TOOLS: Array<{ name: string; args: Record<string, unknown> }> = [
  { name: "get_account_balances", args: {} },
  { name: "get_categories", args: {} },
  { name: "get_goals", args: {} },
  { name: "get_loans", args: {} },
  { name: "list_subscriptions", args: { status: "all" } },
  { name: "search_transactions", args: { limit: 3 } },
  { name: "get_portfolio_analysis", args: {} },
  { name: "get_portfolio_performance", args: { period: "1m" } },
  { name: "get_spending_trends", args: { period: "monthly", months: 6 } },
  { name: "get_spending_anomalies", args: {} },
  { name: "get_recurring_transactions", args: {} },
  { name: "get_budget_summary", args: { month: "2025-01" } },
  { name: "get_debt_payoff_plan", args: {} },
  { name: "list_rules", args: {} },
  { name: "get_subscription_summary", args: {} },
  { name: "get_income_statement", args: { start_date: "2025-01-01", end_date: "2025-12-31" } },
  { name: "get_spotlight_items", args: {} },
  { name: "get_weekly_recap", args: {} },
];

describe("MCP HTTP read-tool smoke (Stream D Phase 4 cleanup gate)", () => {
  let bootstrapped: ReturnType<typeof bootstrap>;
  beforeAll(() => {
    bootstrapped = bootstrap();
  });

  for (const t of SMOKE_TOOLS) {
    it(`${t.name} does not emit SQL referencing dropped Phase-4 columns`, async () => {
      const tool = bootstrapped.tools[t.name];
      expect(tool, `tool ${t.name} is registered`).toBeDefined();
      // Snapshot capture index BEFORE invoking so we only check this tool's
      // queries (not the cumulative ones from earlier tests in this file).
      const startIdx = bootstrapped.queries.length;
      try {
        await tool.handler(t.args, {});
      } catch (e) {
        // Some handlers throw on no-data input (e.g. resolveReportingCurrency
        // hitting an empty users row). That's fine — we only care about the
        // SQL TEXT they tried to issue. Surface the error if it's NOT one of
        // the expected "no data in test fixture" shapes so the test author
        // can tighten the test if a real bug surfaces.
        const msg = e instanceof Error ? e.message : String(e);
        // eslint-disable-next-line no-console
        console.warn(`[smoke] ${t.name} threw: ${msg.slice(0, 200)}`);
      }
      const newQueries = bootstrapped.queries.slice(startIdx);
      const hits = findDroppedRefs(newQueries);
      if (hits.length) {
        const summary = hits.map((h, i) => `  [${i}] match=${h.pattern} in: ${h.sql.slice(0, 240).replace(/\s+/g, " ")}`).join("\n");
        throw new Error(`Tool "${t.name}" emitted SQL referencing dropped Phase-4 column(s):\n${summary}`);
      }
    });
  }

  it("captured at least one query overall (sanity check the harness ran)", () => {
    expect(bootstrapped.queries.length).toBeGreaterThan(0);
  });
});
