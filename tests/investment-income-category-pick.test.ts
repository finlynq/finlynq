/**
 * pickInvestmentIncomeCategoryId is the ONE category rule for a portfolio
 * income/expense entry (web cash + income-as-shares branches, MCP
 * `portfolio_record_entry` income_expense). It was three hand-copied blocks
 * until 2026-11-13; this pins the decision table and that every caller uses it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { pickInvestmentIncomeCategoryId } from "@/lib/investment-income-category";

const DEK = Buffer.alloc(32, 0xaa);

/** A db whose first lookup finds an existing category with id 42. */
function fakeDb() {
  return { execute: vi.fn(async () => ({ rows: [{ id: 42 }] })) };
}

describe("pickInvestmentIncomeCategoryId", () => {
  it("an explicit category always wins and touches no table", async () => {
    const db = fakeDb();
    expect(await pickInvestmentIncomeCategoryId(db, "u", DEK, { categoryId: 7, incomeType: "dividend", amount: 10 })).toBe(7);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["dividend", 10],
    ["interest", 5],
    ["fee", -3],
  ] as const)("%s with a fitting sign resolves the canonical category", async (incomeType, amount) => {
    const db = fakeDb();
    expect(await pickInvestmentIncomeCategoryId(db, "u", DEK, { incomeType, amount })).toBe(42);
    expect(db.execute).toHaveBeenCalled();
  });

  it.each([
    ["dividend", -10],
    ["interest", -1],
    ["fee", 3],
    ["other", 10],
    [undefined, 10],
  ] as const)("%s with amount %s leaves the category unset", async (incomeType, amount) => {
    const db = fakeDb();
    expect(await pickInvestmentIncomeCategoryId(db, "u", DEK, { incomeType, amount })).toBeNull();
    expect(db.execute).not.toHaveBeenCalled();
  });
});

describe("every income/expense writer uses the shared rule", () => {
  const strip = (p: string) =>
    readFileSync(join(__dirname, "..", p), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("the web route calls it in both the cash and the shares branch", () => {
    const src = strip("src/app/api/portfolio/operations/income-expense/route.ts");
    expect(src.match(/pickInvestmentIncomeCategoryId\(/g)?.length).toBe(2);
    expect(src).not.toContain("resolveOrCreateInvestmentIncomeCategory");
  });

  it("MCP income_expense calls it on both paths, with no inline copy", () => {
    const src = strip("mcp-server/tools/portfolio.ts");
    const start = src.indexOf("async function opEntryIncomeExpense(");
    const end = src.indexOf("async function opEntryFxConversion(");
    const fn = src.slice(start, end);
    expect(fn.match(/pickInvestmentIncomeCategoryId\(/g)?.length).toBe(2);
    expect(src).not.toContain("resolveOrCreateInvestmentIncomeCategory");
  });
});
