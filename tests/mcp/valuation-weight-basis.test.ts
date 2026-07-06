/**
 * FINLYNQ-268 — tc-2 (code, not-primary): weights are NEVER computed on
 * lifetime_cost.
 *
 * The FINLYNQ-251/253 bug was weighting rebalancing / diversification on
 * `aggregateHoldings().buy_amount` (lifetime book cost), which inflated cash
 * sleeves to their flow-through total. Phase 3 rebased both weight paths onto the
 * shared `valuePortfolio` / `weightBasis` layer. This suite locks that in TWO
 * ways:
 *
 *   1. RUNTIME guard (the `weightBasis` unit under test): it returns
 *      market-else-active_cost and NEVER lifetime_cost/ledger — throwing in dev
 *      / coercing to active_cost in prod if a bad valuation reaches a weight
 *      computation.
 *   2. STRUCTURAL guard (grep, mirrors FINLYNQ-267's resolve-entity-migrated
 *      test): the rebalancing + diversification weight branches in
 *      `mcp-server/tools/portfolio.ts` call `valuePortfolio(...)` + `weightBasis(
 *      ...)` and do NOT weight off an inline `aggregateHoldings().buy_amount`.
 *      The only surviving `buy_amount` uses are the NON-weight paths
 *      (per-holding cost-basis fields + the benchmark `totalInvested`, which is
 *      deliberately lifetime_cost and labelled as such).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

// The layer imports @/db (only db.execute is used on the ledger branch); stub it
// so importing weightBasis needs no live DB.
import { vi } from "vitest";
vi.mock("../../src/db", () => ({ db: { execute: vi.fn(async () => ({ rows: [] })) }, schema: {} }));

import {
  weightBasis,
  type PortfolioValuation,
} from "../../src/lib/portfolio/valuation";

const PORTFOLIO_TS = join(__dirname, "..", "..", "mcp-server", "tools", "portfolio.ts");
const VALUATION_TS = join(__dirname, "..", "..", "src", "lib", "portfolio", "valuation.ts");

describe("FINLYNQ-268 tc-2 — weightBasis runtime guard", () => {
  it("returns 'market' for a market valuation", () => {
    expect(weightBasis({ basis: "market" } as PortfolioValuation)).toBe("market");
  });

  it("returns 'active_cost' for an active_cost valuation", () => {
    expect(weightBasis({ basis: "active_cost" } as PortfolioValuation)).toBe("active_cost");
  });

  it("NEVER returns lifetime_cost — throws in dev when handed one", () => {
    expect(() => weightBasis({ basis: "lifetime_cost" } as PortfolioValuation)).toThrow(
      /never lifetime_cost/i,
    );
  });

  it("NEVER returns ledger — throws in dev when handed one", () => {
    expect(() => weightBasis({ basis: "ledger" } as PortfolioValuation)).toThrow();
  });

  it("weightBasis's signature can only produce 'market' | 'active_cost'", () => {
    // The source restricts the return type — grep-assert there's no lifetime_cost
    // return in the guard body.
    const src = readFileSync(VALUATION_TS, "utf8");
    const fnBody = src.slice(src.indexOf("export function weightBasis"));
    expect(fnBody).not.toMatch(/return\s+["']lifetime_cost["']/);
    expect(fnBody).not.toMatch(/return\s+["']ledger["']/);
  });
});

describe("FINLYNQ-268 tc-2 — weight paths go through the shared layer (grep)", () => {
  const src = readFileSync(PORTFOLIO_TS, "utf8");

  it("portfolio.ts imports valuePortfolio + weightBasis from the shared layer", () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\bvaluePortfolio\b[^}]*\bweightBasis\b[^}]*\}\s*from\s*["'][^"']*portfolio\/valuation["']/,
    );
  });

  it("both weight branches call valuePortfolio + weightBasis (rebalancing + diversification)", () => {
    // Exactly two weight-computing branches consume the layer: the rebalancing
    // allocation-% path and the diversification/concentration path. Each pairs a
    // valuePortfolio(...) call with a weightBasis(...) guard.
    const valuePortfolioCalls = src.match(/valuePortfolio\(userId,\s*dek,\s*\{\s*basis:\s*["']market["']/g) ?? [];
    const weightBasisCalls = src.match(/weightBasis\(/g) ?? [];
    expect(valuePortfolioCalls.length, "expected ≥2 market-basis valuePortfolio calls (rebalancing + diversification)").toBeGreaterThanOrEqual(2);
    expect(weightBasisCalls.length, "expected ≥2 weightBasis guard calls").toBeGreaterThanOrEqual(2);
  });

  it("no weight branch derives its allocation set from an inline aggregateHoldings().buy_amount", () => {
    // The two weight branches build their per-holding value set from
    // `valuation.byHolding` (the layer output), NOT from aggregateHoldings.
    // buy_amount survives ONLY in NON-weight paths: the per-holding cost-basis
    // fields in get_portfolio_analysis / get_portfolio_performance, and the
    // benchmark `totalInvested` (deliberately lifetime_cost, labelled basis:
    // 'lifetime_cost'). Assert those are the ONLY buy_amount neighborhoods, i.e.
    // no buy_amount appears inside a rebalancing/diversification weight block.
    //
    // Structural proof: the rebalancing branch (opens `if (m === "rebalancing")`)
    // and the diversification block (the FINLYNQ-253 comment marker) must each
    // build from `valuation.byHolding` / `diversificationValuation.byHolding` and
    // must NOT reference `.buy_amount` between their valuePortfolio call and the
    // dataResponse.
    const rebalStart = src.indexOf('if (m === "rebalancing")');
    expect(rebalStart, "rebalancing branch not found").toBeGreaterThan(-1);
    const rebalValuation = src.indexOf("valuePortfolio(userId, dek", rebalStart);
    const rebalResponse = src.indexOf('mode: "rebalancing"', rebalValuation);
    expect(rebalValuation).toBeGreaterThan(rebalStart);
    expect(rebalResponse).toBeGreaterThan(rebalValuation);
    const rebalWeightBlock = src.slice(rebalValuation, rebalResponse);
    expect(rebalWeightBlock, "rebalancing weight block must not reference buy_amount").not.toMatch(/buy_amount/);
    expect(rebalWeightBlock).toMatch(/weightBasis\(/);
    expect(rebalWeightBlock).toMatch(/\.byHolding/);

    // Diversification: from its valuePortfolio call to the patterns response.
    const divValuation = src.indexOf("diversificationValuation = await valuePortfolio");
    expect(divValuation, "diversification valuePortfolio call not found").toBeGreaterThan(-1);
    const divResponse = src.indexOf('mode: "patterns"', divValuation);
    expect(divResponse).toBeGreaterThan(divValuation);
    const divWeightBlock = src.slice(divValuation, divResponse);
    expect(divWeightBlock, "diversification weight block must not reference buy_amount").not.toMatch(/buy_amount/);
    expect(divWeightBlock).toMatch(/weightBasis\(/);
    expect(divWeightBlock).toMatch(/\.byHolding/);
  });
});
