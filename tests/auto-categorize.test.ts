import { describe, it, expect } from "vitest";
import {
  applyRules,
  suggestCategory,
  applyRulesToBatch,
  pickInvestmentCategoryByPayee,
  fallbackInvestmentCategory,
  type TransactionInput,
  type RuleMatch,
  type InvestmentCategoryHint,
} from "@/lib/auto-categorize";

function makeRule(overrides: Partial<{
  id: number; userId: string; name: string; matchField: string; matchType: string;
  matchValue: string; assignCategoryId: number | null; assignTags: string | null;
  renameTo: string | null; isActive: number; priority: number; createdAt: string;
}>) {
  return {
    id: 1, userId: "default", name: "Rule", matchField: "payee", matchType: "contains",
    matchValue: "", assignCategoryId: null, assignTags: null,
    renameTo: null, isActive: 1, priority: 0, createdAt: "2024-01-01",
    ...overrides,
  };
}

describe("applyRules", () => {
  it("matches payee contains rule", () => {
    const rules = [makeRule({ matchField: "payee", matchType: "contains", matchValue: "Starbucks", assignCategoryId: 5 })];
    const txn: TransactionInput = { payee: "Starbucks Coffee", amount: -5.50 };
    const result = applyRules(txn, rules);
    expect(result).not.toBeNull();
    expect(result!.assignCategoryId).toBe(5);
  });

  it("is case-insensitive for string matching", () => {
    const rules = [makeRule({ matchField: "payee", matchType: "contains", matchValue: "NETFLIX" })];
    const result = applyRules({ payee: "netflix subscription" }, rules);
    expect(result).not.toBeNull();
  });

  it("matches payee exact rule", () => {
    const rules = [makeRule({ matchField: "payee", matchType: "exact", matchValue: "Employer Inc." })];
    expect(applyRules({ payee: "Employer Inc." }, rules)).not.toBeNull();
    expect(applyRules({ payee: "Employer Inc. Canada" }, rules)).toBeNull();
  });

  it("matches payee regex rule", () => {
    const rules = [makeRule({ matchField: "payee", matchType: "regex", matchValue: "^Star.*ks$" })];
    expect(applyRules({ payee: "Starbucks" }, rules)).not.toBeNull();
    expect(applyRules({ payee: "Tim Hortons" }, rules)).toBeNull();
  });

  it("handles invalid regex gracefully", () => {
    const rules = [makeRule({ matchField: "payee", matchType: "regex", matchValue: "[invalid" })];
    expect(applyRules({ payee: "test" }, rules)).toBeNull();
  });

  it("matches amount greater_than", () => {
    const rules = [makeRule({ matchField: "amount", matchType: "greater_than", matchValue: "100" })];
    expect(applyRules({ amount: 150 }, rules)).not.toBeNull();
    expect(applyRules({ amount: 50 }, rules)).toBeNull();
  });

  it("matches amount less_than", () => {
    const rules = [makeRule({ matchField: "amount", matchType: "less_than", matchValue: "0" })];
    expect(applyRules({ amount: -50 }, rules)).not.toBeNull();
    expect(applyRules({ amount: 50 }, rules)).toBeNull();
  });

  it("matches amount exact", () => {
    const rules = [makeRule({ matchField: "amount", matchType: "exact", matchValue: "99.99" })];
    expect(applyRules({ amount: 99.99 }, rules)).not.toBeNull();
    expect(applyRules({ amount: 100 }, rules)).toBeNull();
  });

  it("skips inactive rules", () => {
    const rules = [makeRule({ isActive: 0, matchField: "payee", matchType: "contains", matchValue: "test" })];
    expect(applyRules({ payee: "test" }, rules)).toBeNull();
  });

  it("uses highest priority rule", () => {
    const rules = [
      makeRule({ id: 1, matchField: "payee", matchType: "contains", matchValue: "coffee", assignCategoryId: 1, priority: 0 }),
      makeRule({ id: 2, matchField: "payee", matchType: "contains", matchValue: "coffee", assignCategoryId: 2, priority: 10 }),
    ];
    const result = applyRules({ payee: "coffee shop" }, rules);
    expect(result!.assignCategoryId).toBe(2);
  });

  it("returns null when no rules match", () => {
    const rules = [makeRule({ matchField: "payee", matchType: "exact", matchValue: "XYZ Corp" })];
    expect(applyRules({ payee: "ABC Inc" }, rules)).toBeNull();
  });

  it("matches tags field", () => {
    const rules = [makeRule({ matchField: "tags", matchType: "contains", matchValue: "business" })];
    expect(applyRules({ tags: "business,travel" }, rules)).not.toBeNull();
  });
});

describe("suggestCategory", () => {
  const transactions = [
    { payee: "Starbucks", categoryId: 5 },
    { payee: "Starbucks", categoryId: 5 },
    { payee: "Starbucks", categoryId: 3 },
    { payee: "McDonald's", categoryId: 5 },
  ];

  it("suggests most common category for payee", () => {
    expect(suggestCategory("Starbucks", transactions)).toBe(5);
  });

  it("is case-insensitive", () => {
    expect(suggestCategory("starbucks", transactions)).toBe(5);
  });

  it("returns null for unknown payee", () => {
    expect(suggestCategory("Unknown Store", transactions)).toBeNull();
  });

  it("returns null for empty payee", () => {
    expect(suggestCategory("", transactions)).toBeNull();
    expect(suggestCategory("   ", transactions)).toBeNull();
  });

  it("returns null for empty transactions list", () => {
    expect(suggestCategory("Starbucks", [])).toBeNull();
  });
});

describe("applyRulesToBatch", () => {
  it("applies rules to multiple transactions", () => {
    const rules = [makeRule({ matchField: "payee", matchType: "contains", matchValue: "coffee", assignCategoryId: 5 })];
    const txns: TransactionInput[] = [
      { payee: "Coffee Shop" },
      { payee: "Grocery Store" },
      { payee: "Coffee Bean" },
    ];
    const results = applyRulesToBatch(txns, rules);
    expect(results.length).toBe(3);
    expect(results[0].match).not.toBeNull();
    expect(results[1].match).toBeNull();
    expect(results[2].match).not.toBeNull();
  });
});

describe("pickInvestmentCategoryByPayee", () => {
  // Realistic mix: a few expense categories the legacy auto-categorizer
  // could have picked, plus the income / transfer ones we want for
  // brokerage rows.
  const cats: InvestmentCategoryHint[] = [
    { id: 1, name: "Groceries", type: "E" },
    { id: 2, name: "Bank Fees", type: "E" },
    { id: 10, name: "Dividends", type: "I" },
    { id: 11, name: "Credit Interest", type: "I" },
    { id: 12, name: "Currency Revaluation", type: "R" },
    { id: 13, name: "Transfers", type: "R" },
  ];

  it("routes 'Dividend' payees to Dividends", () => {
    expect(pickInvestmentCategoryByPayee("Dividend reinvestment - VFV.TO", cats)).toBe(10);
  });

  it("routes 'Credit Interest' payees to Credit Interest (income)", () => {
    expect(pickInvestmentCategoryByPayee("Credit Interest - August", cats)).toBe(11);
  });

  it("routes 'Forex Trade' to Currency Revaluation when present", () => {
    expect(pickInvestmentCategoryByPayee("Forex Trade USD/CAD", cats)).toBe(12);
  });

  it("routes 'FX' payees to Currency Revaluation", () => {
    expect(pickInvestmentCategoryByPayee("FX conversion", cats)).toBe(12);
  });

  it("does NOT match the bare letters 'fx' inside another word", () => {
    // \bfx\b — "affix" must not trigger the forex branch.
    expect(pickInvestmentCategoryByPayee("Affixed plate", cats)).toBeNull();
  });

  it("routes 'currency' to Currency Revaluation", () => {
    expect(pickInvestmentCategoryByPayee("Currency adjustment", cats)).toBe(12);
  });

  it("routes 'disbursement' to Transfers", () => {
    expect(pickInvestmentCategoryByPayee("Cash Disbursement", cats)).toBe(13);
  });

  it("routes 'withdrawal' to Transfers", () => {
    expect(pickInvestmentCategoryByPayee("Withdrawal to chequing", cats)).toBe(13);
  });

  it("falls back to Transfers when Currency Revaluation is missing for a forex row", () => {
    const minimal: InvestmentCategoryHint[] = [{ id: 13, name: "Transfers", type: "R" }];
    expect(pickInvestmentCategoryByPayee("Forex Trade USD/CAD", minimal)).toBe(13);
  });

  it("returns null when nothing matches AND no fallback name exists", () => {
    const minimal: InvestmentCategoryHint[] = [{ id: 1, name: "Groceries", type: "E" }];
    expect(pickInvestmentCategoryByPayee("Random brokerage row", minimal)).toBeNull();
  });

  it("returns null on empty payee", () => {
    expect(pickInvestmentCategoryByPayee("", cats)).toBeNull();
  });

  it("is case-insensitive on both payee and category names", () => {
    const upper: InvestmentCategoryHint[] = [{ id: 10, name: "DIVIDENDS", type: "I" }];
    expect(pickInvestmentCategoryByPayee("dividend", upper)).toBe(10);
  });
});

describe("fallbackInvestmentCategory", () => {
  it("prefers Transfers when present", () => {
    const cats: InvestmentCategoryHint[] = [
      { id: 13, name: "Transfers", type: "R" },
      { id: 99, name: "Investment Activity", type: "R" },
    ];
    expect(fallbackInvestmentCategory(cats)).toBe(13);
  });

  it("falls back to Investment Activity when Transfers is missing", () => {
    const cats: InvestmentCategoryHint[] = [
      { id: 99, name: "Investment Activity", type: "R" },
    ];
    expect(fallbackInvestmentCategory(cats)).toBe(99);
  });

  it("returns null when neither category exists", () => {
    const cats: InvestmentCategoryHint[] = [
      { id: 1, name: "Groceries", type: "E" },
    ];
    expect(fallbackInvestmentCategory(cats)).toBeNull();
  });

  it("matches case-insensitively (Stream-D-decrypted names may have any case)", () => {
    const cats: InvestmentCategoryHint[] = [
      { id: 13, name: "transfers", type: "R" },
    ];
    expect(fallbackInvestmentCategory(cats)).toBe(13);
  });
});
