/**
 * A loan can't be linked to an investment account, and its interest category
 * can be made where it is picked (2026-10-14).
 *
 * A linked account's balance BECOMES the loan's balance, and the loan's
 * interest is booked as an expense on it. An investment account fits neither
 * (its ledger sums to net contributions; `postLoanInterest` refuses to book
 * there), yet the web form offered every account and both write surfaces took
 * any id. The rule lives once in `loanAccountRefusal`; the wiring gates below
 * make sure each surface still calls it, since a correct helper nobody calls
 * passes its own unit tests.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import {
  INVESTMENT_LOAN_ACCOUNT_MESSAGE,
  isInvestmentAccount,
  loanAccountRefusal,
} from "../src/lib/loans/linked-account";

const ROOT = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** An executor answering the account lookup with `rows`, recording each call. */
function fakeDb(rows: Array<{ is_investment: unknown }>) {
  const calls: unknown[] = [];
  return {
    calls,
    execute: async (q: unknown) => {
      calls.push(q);
      return { rows };
    },
  };
}

describe("loanAccountRefusal", () => {
  it("refuses an investment account", async () => {
    const db = fakeDb([{ is_investment: true }]);
    expect(await loanAccountRefusal(db, "u1", 7)).toBe(INVESTMENT_LOAN_ACCOUNT_MESSAGE);
  });

  it("accepts a regular account", async () => {
    expect(await loanAccountRefusal(fakeDb([{ is_investment: false }]), "u1", 7)).toBeNull();
  });

  it("accepts no account at all, without asking the database", async () => {
    const db = fakeDb([{ is_investment: true }]);
    expect(await loanAccountRefusal(db, "u1", null)).toBeNull();
    expect(await loanAccountRefusal(db, "u1", undefined)).toBeNull();
    expect(db.calls).toHaveLength(0);
  });

  // A loan linked before this rule keeps its account, so editing its rate or
  // name must not start failing.
  it("lets a loan keep the account it already has", async () => {
    const db = fakeDb([{ is_investment: true }]);
    expect(await loanAccountRefusal(db, "u1", 7, 7)).toBeNull();
    expect(db.calls).toHaveLength(0);
  });

  it("checks a CHANGE of account", async () => {
    const db = fakeDb([{ is_investment: true }]);
    expect(await loanAccountRefusal(db, "u1", 8, 7)).toBe(INVESTMENT_LOAN_ACCOUNT_MESSAGE);
  });

  // Someone else's account id finds no row here (the ownership check refuses
  // it separately), and an unknown account is not an investment account.
  it("an account with no row is not treated as an investment account", async () => {
    expect(await isInvestmentAccount(fakeDb([]), "u1", 99)).toBe(false);
  });

  it("only a real true counts, not a truthy string", async () => {
    expect(await isInvestmentAccount(fakeDb([{ is_investment: "t" }]), "u1", 7)).toBe(false);
  });
});

describe("wiring: every surface that links a loan to an account checks it", () => {
  it("REST create refuses before inserting, REST update compares with the stored account", () => {
    const src = codeOnly(read("src/app/api/loans/route.ts"));
    expect(src).toMatch(/loanAccountRefusal\(db, userId, d\.accountId\)/);
    expect(src).toMatch(/loanAccountRefusal\(db, userId, data\.accountId, existing\[0\]\.accountId\)/);
    // Create: the check comes before the INSERT.
    const post = src.slice(src.indexOf("createLoanSchema);"));
    expect(post.indexOf("loanAccountRefusal(")).toBeGreaterThan(-1);
    expect(post.indexOf("loanAccountRefusal(")).toBeLessThan(post.indexOf(".insert(schema.loans)"));
  });

  it("MCP manage_loans checks on add and on update", () => {
    const src = codeOnly(read("mcp-server/tools/loans.ts"));
    expect(src).toMatch(/loanAccountRefusal\(db, userId, accountId\)/);
    expect(src).toMatch(/loanAccountRefusal\(\s*db,\s*userId,\s*accountIdUpdate,/);
    // The update reads the stored account to compare against.
    expect(src).toMatch(/interest_method, interest_amount,\s*account_id\s*FROM loans WHERE id = \$\{id\}/);
  });

  it("the web loan form leaves investment accounts out, except one already linked", () => {
    const src = codeOnly(read("src/app/(app)/loans/page.tsx"));
    expect(src).toContain(".filter((a) => a.isInvestment !== true || a.id === editingLoan?.accountId)");
  });

  it("the web interest panel can create the expense category it needs", () => {
    const src = codeOnly(read("src/app/(app)/loans/_components/interest-entries.tsx"));
    expect(src).toContain('fetch("/api/categories", {');
    expect(src).toContain('type: "E"');
    // The new category is then picked, which also saves it on the loan.
    expect(src).toMatch(/await pickCategory\(String\(id\)\)/);
  });
});
