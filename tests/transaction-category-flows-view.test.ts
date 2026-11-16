/**
 * Static gates for transaction_category_flows (2026-11-16).
 *
 * 1. The view's SELECT is written twice: the migration that creates it and
 *    `TRANSACTION_CATEGORY_FLOWS_SELECT` in schema-pg.ts (so `drizzle-kit
 *    push` builds the same view). They must stay identical.
 * 2. Every report that totals money BY CATEGORY reads the view, not
 *    `transactions`, so a split transaction counts by its split rows' own
 *    categories. A reader that drifts back to `transactions` silently drops
 *    split rows again, which no unit test of that reader would notice.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TRANSACTION_CATEGORY_FLOWS_SELECT } from "@/db/schema-pg";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

describe("transaction_category_flows definition", () => {
  it("the migration and schema-pg.ts define the same view", () => {
    const mig = read("scripts/migrations/20261116_transaction_category_flows_view.sql");
    const body = mig.split("CREATE VIEW transaction_category_flows AS")[1].trim().replace(/;\s*$/, "");
    expect(squash(body)).toBe(squash(TRANSACTION_CATEGORY_FLOWS_SELECT));
  });

  it("an unsplit transaction keeps its stored amounts and every split row keeps the parent's link ids", () => {
    const s = squash(TRANSACTION_CATEGORY_FLOWS_SELECT);
    expect(s).toContain("CASE WHEN s.split_total IS NULL THEN t.amount");
    expect(s).toContain("WHEN s.split_total IS NULL OR t.reporting_amount IS NULL THEN t.reporting_amount");
    expect(s.match(/t\.link_id, t\.trade_link_id, t\.swap_link_id/g)?.length).toBe(2);
  });
});

// file → how many separate queries in it must read the view.
const READERS: Array<[string, RegExp, number]> = [
  ["src/lib/queries.ts", /\.from\(flows\)/g, 6],
  ["src/app/api/reports/route.ts", /\.from\(schema\.transactionCategoryFlows\)/g, 2],
  ["src/app/api/reports/trends/route.ts", /\.from\(schema\.transactionCategoryFlows\)/g, 3],
  ["src/app/api/reports/yoy/route.ts", /\.from\(schema\.transactionCategoryFlows\)/g, 2],
  ["src/app/api/reports/categories/route.ts", /\.from\(schema\.transactionCategoryFlows\)/g, 1],
  ["src/app/api/reports/category/route.ts", /\.from\(schema\.transactionCategoryFlows\)/g, 3],
  ["src/app/api/transactions/calendar/route.ts", /const t = schema\.transactionCategoryFlows;/g, 1],
  ["src/app/api/notifications/route.ts", /schema\.transactionCategoryFlows, eq\(/g, 1],
  ["src/lib/budgets/load-month.ts", /FROM transaction_category_flows/g, 2],
  ["src/lib/financial-health.ts", /FROM transaction_category_flows t/g, 2],
  ["src/lib/spotlight.ts", /\.(from|leftJoin)\(flows[,)]/g, 4],
  ["src/lib/weekly-recap.ts", /\.(from|leftJoin)\(flows[,)]/g, 4],
  ["src/lib/chat-engine.ts", /\.from\(schema\.transactionCategoryFlows\)/g, 3],
  ["src/lib/age-of-money.ts", /\.from\(flows\)/g, 3],
  ["mcp-server/tools/reads.ts", /FROM transaction_category_flows t/g, 7],
];

describe("reports total by category through the view", () => {
  for (const [file, pattern, count] of READERS) {
    it(file, () => {
      expect(read(file).match(pattern)?.length ?? 0).toBe(count);
    });
  }

  it("the dashboard's uncategorized count counts transactions, not split rows", () => {
    expect(read("src/lib/spotlight.ts")).toContain("COUNT(DISTINCT ${flows.id})");
  });
});
