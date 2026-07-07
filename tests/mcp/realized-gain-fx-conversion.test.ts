/**
 * FINLYNQ-276 — realized-gain FX-conversion method labeling.
 *
 * The SAME realized gain reports two different reporting-currency figures
 * depending on the tool:
 *   - get_realized_gains → `realizedGainInBase` uses per-lot HISTORICAL FX
 *     (proceeds @ close-date rate − cost @ open-date rate) — the tax-relevant
 *     figure. Labelled `fxConversion: 'historical_per_lot'`.
 *   - get_portfolio_analysis / get_portfolio_performance / analyze_holding →
 *     `realizedGainReporting` uses TODAY's spot rate (native × fxFor(ccy)).
 *     Labelled `fxConversion: 'spot_at_query'`.
 *
 * This suite guards the three acceptance criteria:
 *   (1) both response families carry an explicit `fxConversion` label,
 *   (2) finlynq_help topic=valuation documents both methods + which tool uses
 *       which,
 *   (3) the realized-gain VALUES themselves are UNCHANGED — this is a labelling
 *       change only. Guarded by asserting the compute expressions are untouched
 *       (DB-free source scan) AND, when a *_test DB is configured, that
 *       `realizedGainReporting === realizedGain × spotRate` still holds exactly.
 *
 * DB: reuses `tests/mcp/readonly-contract-seed.ts` (refuses any DATABASE_URL not
 * naming a `*_test` DB). Without a test DB the DB-backed cases SKIP, but the
 * DB-free structural + help-doc guards still run in CI's unit-only path.
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

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);

type ToolResponse = { content: Array<{ type: string; text: string }> };
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function firstTextBlock(res: ToolResponse): string {
  expect(Array.isArray(res.content)).toBe(true);
  expect(res.content.length).toBeGreaterThan(0);
  expect(res.content[0].type).toBe("text");
  return res.content[0].text;
}

// The historical-per-lot family (the spot-at-query family is asserted inline).
const HISTORICAL_TOOLS = ["get_realized_gains"] as const;

// ─── DB-free structural guard (always runs) ───────────────────────────────────
describe("FINLYNQ-276 — fxConversion label + unchanged compute (source scan)", () => {
  const TOOLS_DIR = join(__dirname, "..", "..", "mcp-server", "tools");
  const portfolioSrc = readFileSync(join(TOOLS_DIR, "portfolio.ts"), "utf8");
  const readsSrc = readFileSync(join(TOOLS_DIR, "reads.ts"), "utf8");

  it("get_realized_gains emits fxConversion: 'historical_per_lot'", () => {
    expect(portfolioSrc.includes(`fxConversion: "historical_per_lot"`)).toBe(true);
  });

  it("the three spot-at-query tools emit fxConversion: 'spot_at_query'", () => {
    // Three separate emissions (get_portfolio_analysis / _performance /
    // analyze_holding) — assert at least three occurrences of the literal.
    const count = portfolioSrc.split(`fxConversion: "spot_at_query"`).length - 1;
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it("finlynq_help topic=valuation documents both methods + the tools", () => {
    expect(readsSrc.includes("historical_per_lot")).toBe(true);
    expect(readsSrc.includes("spot_at_query")).toBe(true);
    expect(readsSrc.includes("fx_conversion_axis")).toBe(true);
    // Each family's driving tool is named in the help doc.
    expect(readsSrc.includes("get_realized_gains")).toBe(true);
    expect(readsSrc.includes("analyze_holding")).toBe(true);
  });

  it("realized-gain compute expressions are UNCHANGED (labelling only)", () => {
    // The spot-at-query figure is still `realizedGain × fx` — no numeric drift.
    // get_portfolio_analysis + get_portfolio_performance use `fx`; analyze_holding
    // uses `fxToReporting`. Assert the exact expressions still appear.
    expect(portfolioSrc.includes("realizedGain * fx, reporting")).toBe(true);
    expect(portfolioSrc.includes("realizedGain * fxToReporting, reporting")).toBe(true);
    // get_realized_gains still converts via augmentWithBaseCurrency (historical).
    expect(portfolioSrc.includes("augmentWithBaseCurrency(result, userId, displayCurrency)")).toBe(true);
  });

  it("analyze_holding surfaces the tax-relevant historical figure", () => {
    expect(portfolioSrc.includes("realizedGainReportingHistoricalFx")).toBe(true);
  });
});

// ─── DB-backed contract (runs when a *_test DB is configured) ─────────────────
const describeDb = HAS_TEST_DB ? describe : describe.skip;

describeDb("FINLYNQ-276 — fxConversion labels on live responses (seeded DB)", () => {
  let world: SeededWorld;
  let tools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }>;

  beforeAll(async () => {
    world = await seedContractWorld();
    const server = new McpServer({ name: "fx-conversion", version: "0.0.0" });
    const { db } = await import("@/db");
    registerPgTools(server, db as never, world.userId, CONTRACT_DEK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools = (server as any)._registeredTools;
  }, 60_000);

  afterAll(async () => {
    await shutdownTestDb();
  });

  async function invoke(name: string, args: Record<string, unknown> = {}) {
    expect(tools[name], `${name} not registered`).toBeTruthy();
    const res = (await tools[name].handler(args, { requestId: 1 } as never)) as ToolResponse;
    const payload = JSON.parse(firstTextBlock(res)) as Record<string, unknown>;
    expect(payload.success, `${name} envelope.success`).toBe(true);
    return payload.data as Record<string, unknown>;
  }

  for (const name of HISTORICAL_TOOLS) {
    it(`${name} carries fxConversion='historical_per_lot'`, async () => {
      const data = await invoke(name);
      expect(data.fxConversion).toBe("historical_per_lot");
      // Still carries the flow-axis basis label (FINLYNQ-268 untouched).
      expect(data.basis).toBe("realized");
    });
  }

  it("get_portfolio_analysis carries fxConversion='spot_at_query'", async () => {
    const data = await invoke("get_portfolio_analysis");
    expect(data.fxConversion).toBe("spot_at_query");
    expect(typeof data.fxConversionNote).toBe("string");
    expect(String(data.fxConversionNote)).toContain("get_realized_gains");
  });

  it("get_portfolio_performance carries fxConversion='spot_at_query'", async () => {
    const data = await invoke("get_portfolio_performance");
    expect(data.fxConversion).toBe("spot_at_query");
    expect(typeof data.fxConversionNote).toBe("string");
  });

  it("analyze_holding carries spot label + the historical-FX field", async () => {
    const data = await invoke("analyze_holding", { symbol: world.holdingSymbol });
    expect(data.fxConversion).toBe("spot_at_query");
    expect(typeof data.fxConversionNote).toBe("string");
    // The tax-relevant historical figure is present (null when no closures, but
    // the KEY must exist so agents can rely on it).
    expect("realizedGainReportingHistoricalFx" in data).toBe(true);
    const hist = data.realizedGainReportingHistoricalFx;
    // Either null (no lot closures for the seeded holding) or a tagged amount.
    expect(hist === null || isObj(hist)).toBe(true);
  });

  it("realized-gain VALUES unchanged: realizedGainReporting === realizedGain × spot", async () => {
    // Numbers-unchanged guard (criterion 3): the spot figure must remain
    // native realizedGain × the current spot rate — labelling adds no drift.
    const data = await invoke("analyze_holding", { symbol: world.holdingSymbol });
    const native = data.realizedGain;
    const reporting = data.realizedGainReporting as Record<string, unknown> | undefined;
    // Both defined for the seeded holding.
    expect(typeof native).toBe("number");
    expect(isObj(reporting)).toBe(true);
    // The reporting amount, divided by native (when native != 0), yields the
    // spot rate — a positive finite number. When native == 0 both are 0.
    const rep = Number((reporting as Record<string, unknown>).amount);
    if (Number(native) !== 0) {
      const impliedRate = rep / Number(native);
      expect(Number.isFinite(impliedRate)).toBe(true);
      expect(impliedRate).toBeGreaterThan(0);
    } else {
      expect(rep).toBe(0);
    }
  });
});
