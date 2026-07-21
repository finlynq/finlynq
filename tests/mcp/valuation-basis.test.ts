/**
 * FINLYNQ-268 — tc-1 (mcp_agent, primary): every money-bearing MCP response
 * carries an explicit `basis`.
 *
 * This is the end-state acceptance contract for child F. It enumerates EVERY
 * money-bearing response — the §2.1 POSITION set + the §2.2/flow set from
 * plan/mcp-surface-v4-F-valuation-basis.md — registers the tools against a
 * seeded `finlynq_test` Postgres via the SAME harness the readonly-contract
 * suite uses, invokes each handler, and asserts:
 *   (a) a `basis` field is PRESENT (top-level, per-row, or per-goal),
 *   (b) its value ∈ the allowed enum (position axis {lifetime_cost |
 *       active_cost | ledger | market} for position tools; flow axis {realized
 *       | cash_flow} for flow tools),
 *   (c) `asOf` is present IFF the basis is `market` (position tools only —
 *       flow bases never carry asOf),
 *   (d) NO money-bearing response omits `basis`.
 *
 * DB: reuses `tests/mcp/readonly-contract-seed.ts` (which refuses any
 * DATABASE_URL not naming a `*_test` DB). When no test DB is configured the
 * DB-backed cases SKIP, but a DB-free STRUCTURAL guard still runs — it scans the
 * tool source to assert every money-bearing tool emits a `basis` literal, so the
 * contract is guarded even in CI's unit-only path.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPgTools } from "../../mcp-server/register-tools-pg";
import { CONTRACT_DEK, seedContractWorld, type SeededWorld } from "./readonly-contract-seed";
import { shutdownTestDb } from "../helpers/portfolio-fixtures";

// ─── DB availability gate (mirrors readonly-contract.test.ts) ─────────────────
const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);

// ─── The two basis value-spaces (plan §5) ─────────────────────────────────────
const POSITION_BASES = ["lifetime_cost", "active_cost", "ledger", "market"] as const;
const FLOW_BASES = ["realized", "cash_flow"] as const;
const ALL_BASES = new Set<string>([...POSITION_BASES, ...FLOW_BASES]);

type ToolResponse = { content: Array<{ type: string; text: string }> };
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * How to reach the `basis`-bearing object(s) inside a response's `data`:
 *   - "top"   → data itself carries `basis`.
 *   - "rows"  → data is/contains an array whose ELEMENTS each carry `basis`
 *               (per-row: get_account_balances accounts, get_goals goals).
 * `axis` picks which value-space is legal. `args(world)` supplies minimal valid
 * args (defaults from the seeded world for id-bearing / required-arg tools).
 */
type Placement = "top" | "rows";
type Entry = {
  axis: "position" | "flow";
  placement: Placement;
  /** For "rows": pull the row array out of the data envelope. */
  rows?: (data: unknown) => unknown[];
  /** For "top": pull the basis-bearing object out of the RESPONSE ENVELOPE when
   * it isn't `data` itself — either nested inside data, or a SIBLING of data at
   * the envelope level. `manage_subscriptions(op:list, include_summary:true)`
   * returns `{ success, data:[rows], summary:{…, basis} }`, so its basis lives at
   * `payload.summary` (a sibling of `data`, not inside it). Receives the whole
   * parsed envelope; defaults to `data`. */
  pick?: (payload: Record<string, unknown>) => unknown;
  args?: (w: SeededWorld) => Record<string, unknown>;
};

/**
 * The money-bearing surface. This table IS the tc-1 ledger — every §2.1 position
 * response + §2.2/flow response is here, and each must carry `basis` at the
 * declared placement/axis. Loans (get_loans / get_loan_amortization /
 * get_debt_payoff_plan) are DELIBERATELY absent — they report scheduled/ledger
 * loan balances, NOT portfolio valuation (plan §2.2), so they carry no `basis`.
 */
const MONEY_BEARING: Record<string, Entry> = {
  // ── §2.1 position axis ──
  get_net_worth: { axis: "position", placement: "top" },
  get_account_balances: {
    axis: "position",
    placement: "rows",
    rows: (d) => {
      // data is { accounts: [...], ... } (or an array in edge cases).
      if (Array.isArray(d)) return d;
      const accts = isObj(d) ? (d as Record<string, unknown>).accounts : undefined;
      return Array.isArray(accts) ? accts : [];
    },
  },
  // get_goals folded into manage_goals(op:list) in the v4.1 clean break; the
  // per-goal basis emission stays in goals.ts on the same handler.
  manage_goals: {
    axis: "position",
    placement: "rows",
    args: () => ({ op: "list" }),
    rows: (d) => (Array.isArray(d) ? d : []),
  },
  get_financial_health_score: { axis: "position", placement: "top" },
  get_portfolio_analysis: { axis: "position", placement: "top" },
  get_portfolio_performance: { axis: "position", placement: "top" },
  get_portfolio_returns: { axis: "position", placement: "top" },
  analyze_holding: {
    axis: "position",
    placement: "top",
    args: (w) => ({ symbol: w.holdingSymbol }),
  },
  get_investment_insights: {
    // Rebalancing mode emits `basis` (market-else-active_cost) at the TOP level
    // of `data` (patterns nests it under `data.summary`). Rebalancing is the
    // primary asOf-forwarding fix path (FINLYNQ-268 cycle 2), so exercise it:
    // a target matching the seeded holding drives a non-empty valuation.
    axis: "position",
    placement: "top",
    args: (w) => ({ mode: "rebalancing", targets: [{ holding: w.holdingSymbol, target_pct: 100 }] }),
  },

  // ── §2.1 flow axis (realized / dividends) ──
  get_realized_gains: { axis: "flow", placement: "top" },
  get_dividend_income: { axis: "flow", placement: "top" },

  // ── §2.2 cash-flow reports ──
  get_spending_trends: { axis: "flow", placement: "top" },
  get_income_statement: {
    axis: "flow",
    placement: "top",
    args: () => ({ start_date: "2000-01-01", end_date: "2999-12-31" }),
  },
  get_spending_anomalies: { axis: "flow", placement: "top" },
  get_weekly_recap: { axis: "flow", placement: "top" },
  get_cash_flow_forecast: { axis: "flow", placement: "top" },
  get_spotlight_items: { axis: "flow", placement: "top" },
  get_budget_summary: {
    axis: "flow",
    placement: "top",
    args: () => ({ month: new Date().toISOString().slice(0, 7) }),
  },
  // get_subscription_summary folded into manage_subscriptions(op:list,
  // include_summary:true) in the v4.1 clean break.
  manage_subscriptions: {
    axis: "flow",
    placement: "top",
    args: () => ({ op: "list", include_summary: true }),
    // basis rides on the envelope-level `summary` (sibling of data), not data.
    pick: (p) => p.summary,
  },
};

function legalBasisFor(axis: "position" | "flow"): Set<string> {
  return new Set<string>(axis === "position" ? POSITION_BASES : FLOW_BASES);
}

/** Assert one basis-bearing object satisfies (a)+(b)+(c). */
function assertBasisObject(obj: unknown, entry: Entry, label: string): void {
  expect(isObj(obj), `${label} is not an object`).toBe(true);
  const o = obj as Record<string, unknown>;
  // (a) present, (d) never omitted.
  expect("basis" in o, `${label} omits basis`).toBe(true);
  const basis = o.basis;
  expect(typeof basis, `${label} basis not a string`).toBe("string");
  // (b) value in the axis-legal enum (and globally known).
  expect(ALL_BASES.has(basis as string), `${label} basis '${String(basis)}' not a known value`).toBe(true);
  expect(
    legalBasisFor(entry.axis).has(basis as string),
    `${label} basis '${String(basis)}' not legal for the ${entry.axis} axis`,
  ).toBe(true);
  // (c) asOf present IFF market (only meaningful on the position axis; flow
  //     bases are never 'market' so this also asserts they carry no asOf).
  const hasAsOf = "asOf" in o && o.asOf != null;
  if (basis === "market") {
    expect(hasAsOf, `${label} basis='market' but asOf missing`).toBe(true);
    expect(typeof o.asOf, `${label} asOf not a string`).toBe("string");
  } else {
    expect(hasAsOf, `${label} basis='${String(basis)}' must NOT carry asOf`).toBe(false);
  }
}

function firstTextBlock(res: ToolResponse): string {
  expect(Array.isArray(res.content)).toBe(true);
  expect(res.content.length).toBeGreaterThan(0);
  expect(res.content[0].type).toBe("text");
  return res.content[0].text;
}

// ─── DB-free structural guard (always runs) ───────────────────────────────────
// Even without a seeded DB, assert the source emits a `basis` literal for every
// money-bearing tool. This keeps the contract enforced in CI's unit-only path.
describe("FINLYNQ-268 tc-1 — money-bearing tools emit a basis literal (source scan)", () => {
  const TOOLS_DIR = join(__dirname, "..", "..", "mcp-server", "tools");
  const sources: Record<string, string> = {
    "portfolio.ts": readFileSync(join(TOOLS_DIR, "portfolio.ts"), "utf8"),
    "reads.ts": readFileSync(join(TOOLS_DIR, "reads.ts"), "utf8"),
    "subscriptions.ts": readFileSync(join(TOOLS_DIR, "subscriptions.ts"), "utf8"),
    "goals.ts": readFileSync(join(TOOLS_DIR, "goals.ts"), "utf8"),
  };
  const allSrc = Object.values(sources).join("\n");

  it("every money-bearing tool name is registered", () => {
    for (const name of Object.keys(MONEY_BEARING)) {
      expect(allSrc.includes(`"${name}"`), `${name} not registered in a tool module`).toBe(true);
    }
  });

  it("a basis literal appears in the emitting module for each money-bearing tool", () => {
    // A coarse but effective guard: each money-bearing tool's module must
    // contain a `basis:` or `basis,` emission (the phase 1–4 edits). This
    // catches an accidental removal of the label.
    const moduleFor: Record<string, string> = {
      manage_goals: "goals.ts",
      manage_subscriptions: "subscriptions.ts",
      get_realized_gains: "portfolio.ts",
      get_dividend_income: "portfolio.ts",
      get_portfolio_analysis: "portfolio.ts",
      get_portfolio_performance: "portfolio.ts",
      get_portfolio_returns: "portfolio.ts",
      analyze_holding: "portfolio.ts",
      get_investment_insights: "portfolio.ts",
    };
    for (const [name, mod] of Object.entries(moduleFor)) {
      expect(/basis\s*[:,]/.test(sources[mod]), `${name}'s module ${mod} has no basis emission`).toBe(true);
    }
    // reads.ts hosts net worth / balances / health / all cash-flow reports.
    expect(/basis\s*[:,]/.test(sources["reads.ts"])).toBe(true);
  });
});

// ─── DB-backed contract (runs when a *_test DB is configured) ─────────────────
const describeDb = HAS_TEST_DB ? describe : describe.skip;

describeDb("FINLYNQ-268 tc-1 — basis on every money-bearing response (seeded DB)", () => {
  let world: SeededWorld;
  let tools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }>;

  beforeAll(async () => {
    world = await seedContractWorld();
    const server = new McpServer({ name: "valuation-basis", version: "0.0.0" });
    const { db } = await import("@/db");
    registerPgTools(server, db as never, world.userId, CONTRACT_DEK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools = (server as any)._registeredTools;
  }, 60_000);

  afterAll(async () => {
    await shutdownTestDb();
  });

  for (const [name, entry] of Object.entries(MONEY_BEARING)) {
    it(`${name} carries basis (${entry.axis} axis, ${entry.placement})`, async () => {
      expect(tools[name], `${name} not registered`).toBeTruthy();
      const args = entry.args ? entry.args(world) : {};
      const res = (await tools[name].handler(args, { requestId: 1 } as never)) as ToolResponse;
      const payload = JSON.parse(firstTextBlock(res)) as Record<string, unknown>;
      expect(payload.success, `${name} envelope.success`).toBe(true);
      const data = payload.data;

      if (entry.placement === "top") {
        assertBasisObject(entry.pick ? entry.pick(payload) : data, entry, name);
      } else {
        const rows = entry.rows!(data);
        // Per-row placement: EVERY row must carry a legal basis. An empty row
        // set is acceptable (no money-bearing rows to label) but the seed
        // provides ≥1 account and ≥1 goal, so we also assert non-empty for the
        // two per-row tools to prove the label actually fires.
        expect(Array.isArray(rows), `${name} rows not an array`).toBe(true);
        expect(rows.length, `${name} seeded world produced zero rows`).toBeGreaterThan(0);
        rows.forEach((row, i) => assertBasisObject(row, entry, `${name}[${i}]`));
      }
    });
  }
});
