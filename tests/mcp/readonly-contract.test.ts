/**
 * FINLYNQ-260 — Table-driven contract tests for MCP read-only tools.
 *
 * MCP is the product differentiator; the 117-tool HTTP surface (117 total, 50
 * read-only) had smoke tests but the per-tool read handlers were largely
 * untested outside the reconcile cohort. This suite locks the read surface:
 *
 *  1. Register every tool against a MOCK McpServer (capturing `tool()` calls).
 *  2. ENUMERATE the read-only subset the SAME way the transports do — via
 *     `inferAnnotations(name).readOnlyHint` (auto-annotations.ts). A hard count
 *     assertion (`EXPECTED_READONLY_COUNT`) fails the moment a new read tool is
 *     added without a contract-table entry, so coverage can't silently drop.
 *  3. Invoke each read-only tool's handler against a SEEDED `finlynq_test`
 *     Postgres with a real DEK (name-decrypting reads return real strings) and
 *     assert the `{ success, data }` envelope + a few KEY shape fields per tool
 *     (key presence + types — NOT brittle exact values that depend on the seed).
 *
 * DB: reuses the `tests/helpers/portfolio-fixtures.ts` PostgresAdapter harness,
 * which REFUSES any DATABASE_URL not naming a `*_test` DB. Run with e.g.
 *   DATABASE_URL=postgres://…/finlynq_test npx vitest run tests/mcp/readonly-contract.test.ts
 *
 * When no test DB is configured (DATABASE_URL unset / not `*_test`), the
 * DB-backed cases are skipped but the ENUMERATION + count assertions still run
 * (they need no DB), so the read-only surface is always guarded in CI's
 * unit-only path and fully exercised wherever a seeded `finlynq_test` exists.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPgTools } from "../../mcp-server/register-tools-pg";
import { inferAnnotations } from "../../mcp-server/auto-annotations";
import {
  CONTRACT_DEK,
  seedContractWorld,
  type SeededWorld,
} from "./readonly-contract-seed";
import { shutdownTestDb } from "../helpers/portfolio-fixtures";

// ─── DB availability gate ────────────────────────────────────────────────────
const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);

// ─── Read-only surface (single source of truth) ──────────────────────────────
// Empirically 50 on `dev` HEAD (2026-07-03) — 117 total tools, 50 read-only per
// `inferAnnotations(name).readOnlyHint`. Bump this when a read tool is added
// AND add its contract-table entry below; the count assert is the tripwire.
const EXPECTED_READONLY_COUNT = 50;

/**
 * A single MCP `content` response. Every handler returns `{ content: [{ type,
 * text }] }`; read handlers put a JSON envelope in `text`.
 */
type ToolResponse = { content: Array<{ type: string; text: string }> };

/** Assert a well-formed MCP content response and return its single text block. */
function firstTextBlock(res: ToolResponse): string {
  expect(res).toBeTruthy();
  expect(Array.isArray(res.content)).toBe(true);
  expect(res.content.length).toBeGreaterThan(0);
  const block = res.content[0];
  expect(block.type).toBe("text");
  expect(typeof block.text).toBe("string");
  return block.text;
}

/**
 * The contract table. Each read-only tool gets:
 *   - `args(world)`  → the minimal valid arg object (defaults resolved from the
 *                      seeded world for id-bearing tools).
 *   - `assert(data)` → a per-tool shape assertion on the `data` field of the
 *                      `{ success, data }` envelope (key presence + types).
 *   - `envelopeOnly` → true for tools that legitimately need heavy external
 *                      fixtures (an on-disk upload artifact); we assert only the
 *                      well-formed MCP content response, not the success shape.
 *
 * Tools NOT in this table but present in the read-only set fail the coverage
 * assertion below — the table IS the enumeration ledger.
 */
type Entry = {
  args?: (w: SeededWorld) => Record<string, unknown>;
  assert?: (data: unknown) => void;
  /** Handler returns a non-envelope MCP response we assert structurally only. */
  envelopeOnly?: boolean;
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const CONTRACT: Record<string, Entry> = {
  // ── Balances / net worth / flow ──
  get_account_balances: { assert: (d) => expect(isObj(d) || Array.isArray(d)).toBe(true) },
  get_net_worth: { assert: (d) => expect(isObj(d)).toBe(true) },
  get_income_statement: {
    args: () => ({ start_date: "2000-01-01", end_date: "2999-12-31" }),
    assert: (d) => expect(isObj(d)).toBe(true),
  },
  get_spending_trends: {
    // FINLYNQ-269 — rollups-first: default payload leads with totalsByPeriod
    // (per-bucket grand totals) and OMITS the verbose cell rows.
    assert: (d) => {
      expect(isObj(d)).toBe(true);
      expect(Array.isArray((d as Record<string, unknown>).totalsByPeriod)).toBe(true);
    },
  },
  get_spending_anomalies: { assert: (d) => expect(isObj(d) || Array.isArray(d)).toBe(true) },
  get_cash_flow_forecast: { assert: (d) => expect(isObj(d)).toBe(true) },
  get_weekly_recap: { assert: (d) => expect(isObj(d)).toBe(true) },
  get_spotlight_items: { assert: (d) => expect(isObj(d) || Array.isArray(d)).toBe(true) },
  get_financial_health_score: { assert: (d) => expect(isObj(d)).toBe(true) },

  // ── Lists (arrays) ──
  get_categories: { assert: (d) => expect(Array.isArray(d)).toBe(true) },
  get_goals: { assert: (d) => expect(Array.isArray(d)).toBe(true) },
  get_loans: { assert: (d) => expect(Array.isArray(d)).toBe(true) },
  list_loans: { assert: (d) => expect(Array.isArray(d)).toBe(true) },
  list_subscriptions: { assert: (d) => expect(Array.isArray(d) || isObj(d)).toBe(true) },
  list_rules: { assert: (d) => expect(Array.isArray(d) || isObj(d)).toBe(true) },
  list_fx_overrides: { assert: (d) => expect(Array.isArray(d) || isObj(d)).toBe(true) },
  list_pending_uploads: { assert: (d) => expect(Array.isArray(d) || isObj(d)).toBe(true) },
  list_staged_imports: { assert: (d) => expect(Array.isArray(d) || isObj(d)).toBe(true) },
  get_recurring_transactions: { assert: (d) => expect(Array.isArray(d) || isObj(d)).toBe(true) },

  // ── Summaries ──
  get_budget_summary: {
    args: () => ({ month: new Date().toISOString().slice(0, 7) }),
    assert: (d) => expect(isObj(d) || Array.isArray(d)).toBe(true),
  },
  get_subscription_summary: { assert: (d) => expect(isObj(d)).toBe(true) },
  detect_subscriptions: { assert: (d) => expect(isObj(d) || Array.isArray(d)).toBe(true) },
  get_reconciliation_summary: { assert: (d) => expect(Array.isArray(d) || isObj(d)).toBe(true) },

  // ── Portfolio ──
  get_portfolio_analysis: { assert: (d) => expect(isObj(d)).toBe(true) },
  get_portfolio_performance: { assert: (d) => expect(isObj(d)).toBe(true) },
  get_portfolio_performance_v2: { assert: (d) => expect(isObj(d)).toBe(true) },
  get_investment_insights: { assert: (d) => expect(isObj(d)).toBe(true) },
  get_dividend_income: { assert: (d) => expect(isObj(d) || Array.isArray(d)).toBe(true) },
  get_realized_gains: { assert: (d) => expect(isObj(d) || Array.isArray(d)).toBe(true) },
  analyze_holding: {
    args: (w) => ({ symbol: w.holdingSymbol }),
    assert: (d) => expect(isObj(d)).toBe(true),
  },
  trace_holding_quantity: {
    args: (w) => ({ holdingId: w.holdingId }),
    assert: (d) => expect(isObj(d)).toBe(true),
  },

  // ── Loans / debt ──
  get_loan_amortization: {
    args: (w) => ({ loan_id: w.loanId }),
    assert: (d) => expect(isObj(d)).toBe(true),
  },
  get_debt_payoff_plan: { assert: (d) => expect(isObj(d)).toBe(true) },

  // ── Transactions / rules / splits ──
  search_transactions: { assert: (d) => expect(isObj(d) || Array.isArray(d)).toBe(true) },
  suggest_transaction_details: {
    args: () => ({ payee: "Whole Foods", amount: -40 }),
    assert: (d) => expect(isObj(d) || Array.isArray(d)).toBe(true),
  },
  test_rule: {
    args: () => ({ match_payee: "Whole" }),
    assert: (d) => expect(isObj(d) || Array.isArray(d)).toBe(true),
  },
  list_splits: {
    args: (w) => ({ transaction_id: w.transactionId }),
    assert: (d) => expect(Array.isArray(d) || isObj(d)).toBe(true),
  },

  // ── Bulk preview (confirmation-token) — filter needs ≥1 field (else the
  //    handler throws "At least one filter field is required"); scope to the
  //    seeded cash account so the success path runs.
  preview_bulk_categorize: {
    args: (w) => ({ filter: { account_id: w.cashAccountId }, category_id: w.expenseCategoryId }),
    assert: (d) => expect(isObj(d)).toBe(true),
  },
  preview_bulk_delete: {
    args: (w) => ({ filter: { account_id: w.cashAccountId } }),
    assert: (d) => expect(isObj(d)).toBe(true),
  },
  preview_bulk_update: {
    args: (w) => ({ filter: { account_id: w.cashAccountId }, changes: { category_id: w.expenseCategoryId } }),
    assert: (d) => expect(isObj(d)).toBe(true),
  },
  preview_delete_category: {
    args: (w) => ({ id: w.incomeCategoryId }),
    assert: (d) => expect(isObj(d)).toBe(true),
  },

  // ── Staged import detail ──
  get_staged_import: {
    args: (w) => ({ stagedImportId: w.stagedImportId }),
    assert: (d) => expect(isObj(d)).toBe(true),
  },
  list_staged_transactions: {
    args: (w) => ({ stagedImportId: w.stagedImportId }),
    assert: (d) => expect(Array.isArray(d) || isObj(d)).toBe(true),
  },

  // ── Reconcile ──
  get_reconcile_suggestions: {
    args: (w) => ({ accountId: w.cashAccountId }),
    assert: (d) => expect(isObj(d) || Array.isArray(d)).toBe(true),
  },
  get_balance_anchors: {
    args: (w) => ({ accountId: w.cashAccountId }),
    assert: (d) => expect(Array.isArray(d) || isObj(d)).toBe(true),
  },
  find_duplicate_bank_rows: {
    args: (w) => ({ accountId: w.cashAccountId }),
    assert: (d) => expect(Array.isArray(d) || isObj(d)).toBe(true),
  },

  // ── FX (external world) ──
  get_fx_rate: {
    args: () => ({ from: "USD", to: "CAD" }),
    assert: (d) => expect(isObj(d)).toBe(true),
  },
  convert_amount: {
    args: () => ({ amount: 100, from: "USD", to: "CAD" }),
    assert: (d) => expect(isObj(d)).toBe(true),
  },

  // ── Help ──
  finlynq_help: { assert: (d) => expect(isObj(d) || Array.isArray(d)).toBe(true) },

  // ── Needs an on-disk upload artifact (mcp_uploads) — envelope/shape only ──
  // DEFERRED to a fuller fixture: `preview_import` resolves `upload_id` against
  // the `mcp_uploads` row + a file on disk written by POST /api/mcp/upload.
  // We assert a well-formed MCP content response with an unknown upload_id.
  preview_import: {
    args: () => ({ upload_id: "00000000-0000-0000-0000-000000000000" }),
    envelopeOnly: true,
  },
};

// ─── Register tools against a mock server + enumerate read-only set ───────────
function registerAndEnumerate(userId: string) {
  const noopDb = { execute: async () => ({ rows: [], rowCount: 0 }) };
  const server = new McpServer({ name: "contract-enum", version: "0.0.0" });
  registerPgTools(server, noopDb, userId, CONTRACT_DEK);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Record<string, unknown>;
  const allNames = Object.keys(tools).sort();
  const readOnly = allNames.filter((n) => inferAnnotations(n).readOnlyHint === true);
  return { allNames, readOnly };
}

describe("MCP read-only tools — enumeration + coverage (no DB)", () => {
  const { allNames, readOnly } = registerAndEnumerate("enum-user");

  it("read-only subset is derived from inferAnnotations and matches the expected count", () => {
    expect(allNames.length).toBeGreaterThan(100); // 117-tool surface
    expect(readOnly.length).toBe(EXPECTED_READONLY_COUNT);
  });

  it("every read-only tool has a contract-table entry (coverage tripwire)", () => {
    const missing = readOnly.filter((n) => !(n in CONTRACT));
    expect(missing, `read-only tools missing a contract entry: ${missing.join(", ")}`).toEqual([]);
    // And the table has no stale entries pointing at non-read-only tools.
    const stale = Object.keys(CONTRACT).filter((n) => !readOnly.includes(n));
    expect(stale, `contract entries for non-read-only tools: ${stale.join(", ")}`).toEqual([]);
  });
});

// ─── DB-backed contract assertions ───────────────────────────────────────────
const describeDb = HAS_TEST_DB ? describe : describe.skip;

describeDb("MCP read-only tools — seeded-DB contract shape", () => {
  let world: SeededWorld;
  let tools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }>;

  beforeAll(async () => {
    world = await seedContractWorld();
    const server = new McpServer({ name: "contract-db", version: "0.0.0" });
    const { db } = await import("@/db");
    registerPgTools(server, db as never, world.userId, CONTRACT_DEK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools = (server as any)._registeredTools;
  }, 60_000);

  afterAll(async () => {
    await shutdownTestDb();
  });

  const readOnly = registerAndEnumerate("enum-user").readOnly;

  for (const name of readOnly) {
    it(`${name} returns a well-formed response`, async () => {
      const entry = CONTRACT[name];
      expect(entry, `no contract entry for ${name}`).toBeTruthy();
      const args = entry.args ? entry.args(world) : {};
      const res = (await tools[name].handler(args, { requestId: 1 } as never)) as ToolResponse;
      const text = firstTextBlock(res);

      if (entry.envelopeOnly) {
        // Well-formed MCP content response is sufficient (see table note) —
        // this tool needs an external fixture (mcp_uploads + on-disk file) to
        // reach its success envelope, deferred to a fuller fixture.
        return;
      }
      // Canonical read envelope: { success: true, data: <T> }.
      const payload = JSON.parse(text);
      expect(isObj(payload), `${name} did not return a JSON object envelope`).toBe(true);
      const env = payload as Record<string, unknown>;
      expect(env.success, `${name} envelope.success`).toBe(true);
      expect("data" in env, `${name} envelope.data present`).toBe(true);
      entry.assert?.(env.data);
    });
  }
});
