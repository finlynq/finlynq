/**
 * GH #433: a liability in credit (an overpaid card, positive balance) reduces
 * Total Liabilities on the Balance Sheet instead of being counted as debt.
 *
 * The issue's own numbers: one card +6.16 (credit), six cards -6,712.57 owed
 * in total. Accounts page: 6,706.41 owed. The old Math.abs gave 6,718.73.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { liabilityOwed } from "@/lib/reports/liability-owed";

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("liabilityOwed", () => {
  it("owed is positive, a credit is negative", () => {
    expect(liabilityOwed(-500)).toBe(500);
    expect(liabilityOwed(6.16)).toBe(-6.16);
    expect(Object.is(liabilityOwed(0), 0)).toBe(true);
  });

  it("the issue's cards total 6,706.41 owed, matching the Accounts page", () => {
    const balances = [6.16, -6712.57];
    const total = balances.reduce((s, b) => s + liabilityOwed(b), 0);
    expect(Math.round(total * 100) / 100).toBe(6706.41);
  });
});

describe("no liability total uses Math.abs", () => {
  it("the balance-sheet branch of /api/reports", () => {
    const src = stripComments(readFileSync(join(__dirname, "../src/app/api/reports/route.ts"), "utf8"));
    const start = src.indexOf('type === "balance-sheet"');
    const end = src.indexOf('type === "tax-summary"');
    expect(start).toBeGreaterThan(-1);
    const branch = src.slice(start, end);
    expect(branch).toContain("liabilityOwed(b.convertedBalance)");
    expect(branch).not.toMatch(/Math\.abs\(b\.(convertedBalance|balance)\)/);
  });

  it("the financial-health liability total", () => {
    const src = stripComments(readFileSync(join(__dirname, "../src/lib/financial-health.ts"), "utf8"));
    expect(src).toContain('if (b.type === "L") totalLiabilities += liabilityOwed(converted)');
    expect(src).not.toMatch(/totalLiabilities \+= Math\.abs/);
  });
});
