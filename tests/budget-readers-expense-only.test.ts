/**
 * Budget v2 lets income categories have budgets (expected income). Every older
 * reader of `budgets` that compares a budget with SPENDING must keep reading
 * expense categories only, or earning more than expected turns into an
 * "overspent" alert, a failed budget in the health score, a warning in the
 * weekly recap, chat and MCP. PURE source reads: this pins the filter itself.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const READERS: Array<[string, RegExp]> = [
  ["src/lib/spotlight.ts", /eq\(categories\.type, "E"\)/],
  ["src/app/api/notifications/route.ts", /eq\(schema\.categories\.type, "E"\)/],
  ["src/lib/weekly-recap.ts", /eq\(categories\.type, "E"\)/],
  ["src/lib/chat-engine.ts", /eq\(schema\.categories\.type, "E"\)/],
  ["src/lib/financial-health.ts", /FROM budgets b[\s\S]{0,400}c\.type = 'E'/],
  ["mcp-server/tools/reads.ts", /FROM budgets b LEFT JOIN categories c[\s\S]{0,400}c\.type = 'E'/],
];

describe("budget readers compare spending budgets only", () => {
  for (const [file, re] of READERS) {
    it(`${file} filters budgets to expense categories`, () => {
      expect(read(file)).toMatch(re);
    });
  }

  it("the phone app's per-category list leaves income budgets out", () => {
    expect(read("src/app/api/budgets/route.ts")).toMatch(/filter\(\(b\) => b\.categoryType !== "I"\)/);
  });
});
