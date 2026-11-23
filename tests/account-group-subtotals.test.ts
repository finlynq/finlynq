/**
 * GH #440: subtotals per account group on the Balance Sheet (in the order
 * saved on the Accounts page) and a total in each Accounts page group header.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { groupWithSubtotals } from "@/lib/accounts/groups";

type Row = { accountGroup: string; name: string; convertedBalance: number };
const rows: Row[] = [
  { accountGroup: "Credit Cards", name: "Visa", convertedBalance: 1830 },
  { accountGroup: "Loans", name: "Car", convertedBalance: 15400 },
  { accountGroup: "Credit Cards", name: "Overpaid card", convertedBalance: -6.16 },
  { accountGroup: "", name: "Loose", convertedBalance: 10 },
  { accountGroup: "Loans", name: "Mortgage", convertedBalance: 200000 },
];

describe("groupWithSubtotals", () => {
  it("groups, subtotals and follows the saved order, Other last", () => {
    const out = groupWithSubtotals(rows, (r) => r.accountGroup, (r) => r.convertedBalance, ["Loans", "Credit Cards"]);
    expect(out.map((g) => [g.group, g.rows.map((r) => r.name), g.subtotal])).toEqual([
      ["Loans", ["Car", "Mortgage"], 215400],
      ["Credit Cards", ["Visa", "Overpaid card"], 1823.84],
      ["Other", ["Loose"], 10],
    ]);
  });

  it("without a saved order, groups are alphabetical", () => {
    const out = groupWithSubtotals(rows, (r) => r.accountGroup, (r) => r.convertedBalance, []);
    expect(out.map((g) => g.group)).toEqual(["Credit Cards", "Loans", "Other"]);
  });

  it("merges groups that differ only in case", () => {
    const out = groupWithSubtotals(
      [{ g: "Cash" }, { g: "cash" }],
      (r) => r.g,
      () => 1,
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0].subtotal).toBe(2);
  });
});

describe("wiring", () => {
  it("the Balance Sheet renders grouped rows for assets and liabilities", () => {
    const src = readFileSync(join(__dirname, "../src/app/(app)/reports/page.tsx"), "utf8");
    expect(src).toMatch(/<BalanceSheetGroupRows[\s\S]*?kind="asset"/);
    expect(src).toMatch(/<BalanceSheetGroupRows[\s\S]*?kind="liability"/);
  });

  it("the Accounts page shows a total in each group header", () => {
    const src = readFileSync(join(__dirname, "../src/app/(app)/accounts/page.tsx"), "utf8");
    expect(src).toMatch(/accts\.reduce\(\(s, a\) => s \+ \(a\.convertedBalance \?\? a\.balance\), 0\)/);
  });
});
