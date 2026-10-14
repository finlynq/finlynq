/**
 * The cost-basis method setting and the MCP lot tools (2026-10-13).
 *
 * Lots have been recorded for every trade for months, but the figures a user
 * saw only came from them when an operator flipped a database flag by hand.
 * This makes it a setting the user (or their assistant) controls, and gives
 * the MCP the lot operations the web app already had.
 *
 * Mostly static wiring: what matters is that the web and MCP surfaces share
 * one implementation, and that the switch is safe (it never rebuilds lots a
 * user may have matched by hand).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reassignErrorMessage } from "@/lib/portfolio/lots/reassign-errors";
import { MCP_TOOL_COUNTS } from "@/lib/mcp/tool-counts";
import { combineLotCost, costMetrics, lotCostInCurrency, simpleCostMetrics } from "@/lib/portfolio/cost-metrics";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
/** Strip comments so a rule quoted in prose can't satisfy a code assertion. */
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("reassignErrorMessage", () => {
  it("explains each refusal in words a user can act on", () => {
    expect(reassignErrorMessage({ ok: false, code: "close_tx_not_found" })).toMatch(/not found/);
    expect(reassignErrorMessage({ ok: false, code: "no_closures" })).toMatch(/no lot closures/);
    expect(reassignErrorMessage({ ok: false, code: "not_reassignable", closeKind: "transfer_out" })).toContain(
      "transfer_out",
    );
    expect(reassignErrorMessage({ ok: false, code: "qty_mismatch", expected: 100, got: 90 })).toBe(
      "The chosen quantities (90) must total the closure quantity (100)",
    );
    expect(reassignErrorMessage({ ok: false, code: "lot_not_in_scope", lotId: 7 })).toContain("Lot #7");
  });

  it("is the wording both the REST route and the MCP tool use", () => {
    expect(code("src/app/api/portfolio/holdings/[holdingId]/lots/reassign/route.ts")).toContain(
      "reassignErrorMessage(err)",
    );
    expect(code("mcp-server/tools/lots.ts")).toContain("reassignErrorMessage(result)");
  });
});

describe("the cost-basis switch", () => {
  const mode = code("src/lib/portfolio/lots/allocation-mode.ts");

  it("the settings route and the MCP tool both go through the one write path", () => {
    expect(code("src/app/api/settings/lot-allocation/route.ts")).toContain("setLotAllocationEnabled(");
    expect(code("mcp-server/tools/lots.ts")).toContain("setLotAllocationEnabled(");
    for (const p of ["src/app/api/settings/lot-allocation/route.ts", "mcp-server/tools/lots.ts"]) {
      expect(code(p), p).not.toMatch(/portfolioLotsStatus|portfolio_lots_status/);
    }
  });

  // A rebuild matches every sale first in, first out and so resets any
  // matching the user chose by hand. Turning the setting on may therefore only
  // build lots where there are none to lose.
  it("turning it on builds lots only for positions that have none", () => {
    const start = mode.indexOf("export async function setLotAllocationEnabled");
    const body = mode.slice(start);
    expect(body).toContain(".filter((r) => r.noLots)");
    expect(body).not.toContain("buildLotsForUser(");
    const rebuild = body.indexOf("rebuildLotsForPosition(");
    expect(rebuild).toBeGreaterThan(-1);
    expect(body.slice(0, rebuild)).toContain("if (enabled)");
  });

  // The flag is cached per process for 30 seconds; without a bust the next
  // page load would still show the old method.
  it("clears the cached flag after writing it", () => {
    const start = mode.indexOf("export async function setLotAllocationEnabled");
    const write = mode.indexOf("insert(schema.portfolioLotsStatus)", start);
    expect(write).toBeGreaterThan(start);
    expect(mode.indexOf("clearLotsEnabledCache(userId)", write)).toBeGreaterThan(write);
  });

  it("turning it off deletes nothing", () => {
    expect(mode).not.toMatch(/\.delete\(/);
  });

  it("stays the simple method until a user chooses otherwise", () => {
    // No row, or a row never set, reads as off.
    expect(code("src/lib/portfolio/lots/read.ts")).toContain("rows[0]?.enabled ?? false");
  });
});

// Buy 100 at 10, buy 100 at 20, sell 100 for 2,500, buy 100 at 30. 200 held.
const tallies = { buyQty: 300, buyAmt: 6000, sellQty: 100, sellAmt: 2500, remainingQty: 200 };

describe("costMetrics", () => {
  it("simple: the average of every purchase, sold shares included", () => {
    expect(simpleCostMetrics(tallies)).toEqual({ avgCost: 20, costBasis: 4000, realizedGain: 500 });
    expect(costMetrics(tallies)).toEqual(simpleCostMetrics(tallies));
  });

  // First in, first out: the sale used the 100 bought at 10.
  it("lot allocation: the cost of the lots still held, and what the sale really closed", () => {
    const lot = { qty: 200, costBasis: 5000, realizedGain: 1500 };
    expect(costMetrics(tallies, lot)).toEqual({ avgCost: 25, costBasis: 5000, realizedGain: 1500 });
  });

  // The two methods split the same money differently: cost + realized is the
  // total paid less the proceeds either way.
  it("both methods account for the same money", () => {
    const simple = simpleCostMetrics(tallies);
    const lot = costMetrics(tallies, { qty: 200, costBasis: 5000, realizedGain: 1500 });
    const check = (m: { costBasis: number | null; realizedGain: number }) =>
      tallies.buyAmt - (m.costBasis ?? 0) + m.realizedGain;
    expect(check(simple)).toBe(tallies.sellAmt);
    expect(check(lot)).toBe(tallies.sellAmt);
  });

  it("a position with no shares left has no cost basis but keeps its realized gain", () => {
    const sold = { buyQty: 100, buyAmt: 1000, sellQty: 100, sellAmt: 2500, remainingQty: 0 };
    expect(costMetrics(sold, { qty: 0, costBasis: 0, realizedGain: 1500 })).toEqual({
      avgCost: null,
      costBasis: null,
      realizedGain: 1500,
    });
    expect(simpleCostMetrics(sold)).toEqual({ avgCost: 10, costBasis: null, realizedGain: 1500 });
  });

  it("nothing bought yet has no figures", () => {
    const none = { buyQty: 0, buyAmt: 0, sellQty: 0, sellAmt: 0, remainingQty: 0 };
    expect(simpleCostMetrics(none)).toEqual({ avgCost: null, costBasis: null, realizedGain: 0 });
  });
});

describe("combineLotCost", () => {
  const map = new Map([
    [1, { qty: 100, costBasis: 2000, realizedGain: 300 }],
    [2, { qty: 50, costBasis: 1500, realizedGain: 0 }],
  ]);

  it("adds up a name held in two accounts", () => {
    expect(combineLotCost(map, [1, 2])).toEqual({ qty: 150, costBasis: 3500, realizedGain: 300 });
  });

  // A lot-based row added to a simple one would be a figure under neither method.
  it("gives nothing unless every row has lot figures", () => {
    expect(combineLotCost(map, [1, 3])).toBeUndefined();
    expect(combineLotCost(map, [])).toBeUndefined();
    expect(combineLotCost(null, [1])).toBeUndefined();
  });
});

// Found on the prod demo 2026-10-13: a Toronto-listed fund bought on a USD row
// for 750. Its market value is quoted in CAD (670.50), its lots are kept in USD.
describe("lotCostInCurrency", () => {
  const lot = { qty: 30, costBasis: 750, realizedGain: 40 };

  it("carries cost and realized gain across, and leaves the share count alone", () => {
    expect(lotCostInCurrency(lot, 1.5)).toEqual({ qty: 30, costBasis: 1125, realizedGain: 60 });
  });

  it("is a no-op when the two currencies are the same", () => {
    expect(lotCostInCurrency(lot, 1)).toBe(lot);
  });

  // Subtracting the unconverted 750 from 670.50 gave a loss of 79.50 (10.6%);
  // the position was really down 37.4%.
  it("gives the same unrealized % as the simple method for a position with no sales", () => {
    const usdToCad = 1070.97 / 750;
    const marketValueCad = 670.5;
    const { costBasis } = costMetrics(
      { buyQty: 30, buyAmt: 1070.97, sellQty: 0, sellAmt: 0, remainingQty: 30 },
      lotCostInCurrency({ qty: 30, costBasis: 750, realizedGain: 0 }, usdToCad),
    );
    expect(costBasis).toBeCloseTo(1070.97, 2);
    expect(((marketValueCad - costBasis!) / costBasis!) * 100).toBeCloseTo(-37.39, 2);
  });
});

describe("the figures follow the setting wherever cost basis is shown", () => {
  it("the Portfolio page asks which method the user is on", () => {
    expect(code("src/app/api/portfolio/overview/route.ts")).toContain("isLotsEnabledForUser(userId)");
  });

  // The page prices a holding in its QUOTE currency; lots are kept in the
  // position row's currency. The raw lot figures must never reach `m`.
  it("the Portfolio page converts lot figures into the quote currency first", () => {
    const route = code("src/app/api/portfolio/overview/route.ts");
    const start = route.indexOf("for (const lm of lotMetrics) {");
    const block = route.slice(start, route.indexOf("const rgBase", start));
    expect(start).toBeGreaterThan(-1);
    expect(block).toContain("quoteCurrencyById.get(lm.holdingId)");
    expect(block).toContain("lotCostInCurrency(");
    expect(block).not.toMatch(/m\.(totalCostBasis|avgCostPerShare|realizedGain) = [^;]*\blm\.(costBasis|realizedGainAllTime)\b/);
  });

  it("the shared valuation and the three MCP portfolio tools use one loader", () => {
    expect(code("src/lib/holdings-value.ts")).toContain("loadLotCostByHolding(");
    const mcp = code("mcp-server/tools/portfolio.ts");
    expect((mcp.match(/loadLotCostByHolding\(/g) ?? []).length).toBe(3);
    expect((mcp.match(/costMetrics\(/g) ?? []).length).toBe(3);
  });

  // Each tool used to carry its own copy of the simple formula, which is how
  // an assistant kept reporting 4,000 after the page had moved to 5,000.
  it("no MCP tool computes the simple formula on its own any more", () => {
    expect(code("mcp-server/tools/portfolio.ts")).not.toMatch(/sellAmt - \(sellQty \* avgCost\)/);
  });

  it("each of those tools says which method its figures use", () => {
    expect((code("mcp-server/tools/portfolio.ts").match(/^\s+costBasisMethod,$/gm) ?? []).length).toBe(3);
  });

  // Net-worth history values many past dates and only reads market value.
  // Loading every lot for each of them would be wasted work.
  it("the shared valuation loads lots for a current valuation only", () => {
    const hv = code("src/lib/holdings-value.ts");
    const gate = hv.indexOf("if (isToday) {");
    expect(gate).toBeGreaterThan(-1);
    expect(hv.indexOf("loadLotCostByHolding(", gate) - gate).toBeLessThan(200);
  });

  it("cash sleeves keep the ledger path", () => {
    expect(code("src/lib/portfolio/lots/cost-basis.ts")).toContain("if (cash.has(lm.holdingId)) continue;");
    expect(code("src/lib/holdings-value.ts")).toContain(
      "h.isCash === true ? undefined : lotCostBasisByHolding.get(h.id)",
    );
  });

  it("on the simple method the loader returns nothing, so callers fall through", () => {
    expect(code("src/lib/portfolio/lots/cost-basis.ts")).toContain(
      "if (!(await isLotsEnabledForUser(userId))) return null;",
    );
  });
});

describe("MCP manage_lots", () => {
  const mcp = code("mcp-server/tools/lots.ts");

  it("is registered, counted and marked destructive", () => {
    expect(code("mcp-server/register-tools-pg.ts")).toContain("registerLotsTools(server, ctx)");
    expect(MCP_TOOL_COUNTS.http).toBe(55);
    expect(read("README.md")).toContain("55 HTTP / 89 stdio");
    expect(code("mcp-server/auto-annotations.ts")).toContain("manage_lots: { destructiveHint: true }");
    expect(read("scripts/generate-mcp-tool-catalog.mjs")).toContain('"lots",');
  });

  it("reads lots through the same function as the web Lot inspector", () => {
    expect(mcp).toContain("loadHoldingLotsAndClosures(");
    expect(code("src/app/api/portfolio/holdings/[holdingId]/lots/route.ts")).toContain(
      "loadHoldingLotsAndClosures(",
    );
  });

  it("changes a sale's lots and rebuilds a position through the web app's own functions", () => {
    expect(mcp).toContain("reassignClosureLots(");
    expect(mcp).toContain("rebuildLotsForPosition(");
    expect(mcp).toContain("resolvePositionScope(");
    expect(code("src/app/api/portfolio/holdings/[holdingId]/lots/rebuild/route.ts")).toContain(
      "resolvePositionScope(",
    );
  });

  it("previews a reassignment unless told to apply it", () => {
    expect(mcp).toContain("const dryRun = args.preview !== false");
  });

  it("refuses a reassignment with the web route's own wording (incl. a lot bought after the sale)", () => {
    expect(mcp).toContain("err(reassignErrorMessage(result))");
    expect(code("src/app/api/portfolio/holdings/[holdingId]/lots/reassign/route.ts")).toContain(
      'case "lot_bought_after_sale":',
    );
    expect(code("src/lib/portfolio/lots/write-hooks.ts")).toContain("findLotBoughtAfterSale(");
  });

  it("refuses a rebuild without an explicit confirmation, before touching anything", () => {
    const start = mcp.indexOf("async function opRebuild");
    const guard = mcp.indexOf("args.confirm_reset !== true", start);
    const rebuild = mcp.indexOf("rebuildLotsForPosition(", start);
    expect(guard).toBeGreaterThan(start);
    expect(rebuild).toBeGreaterThan(guard);
  });

  it("never writes a transaction", () => {
    expect(mcp).not.toMatch(/createTransaction|INSERT INTO transactions|UPDATE transactions|DELETE FROM transactions/i);
  });
});

describe("the explanation", () => {
  const ui = read("src/components/portfolio/cost-basis-method.tsx");

  // Buy 100 at 10, buy 100 at 20, sell 100, buy 100 at 30: 200 shares held.
  it("its worked example adds up", () => {
    const simple = ((100 * 10 + 100 * 20 + 100 * 30) / 300) * 200;
    const fifo = 100 * 20 + 100 * 30;
    expect(simple).toBe(4000);
    expect(fifo).toBe(5000);
    expect(ui).toContain("4,000");
    expect(ui).toContain("5,000");
  });

  it("is on the settings page and referenced from the Portfolio page", () => {
    expect(read("src/app/(app)/settings/investments/page.tsx")).toContain("<CostBasisSetting />");
    expect(read("src/app/(app)/portfolio/_components/holdings-table.tsx")).toContain("<CostBasisNote />");
    expect(ui).toContain('"/settings/investments#cost-basis"');
    expect(ui).toContain('id="cost-basis"');
  });
});
