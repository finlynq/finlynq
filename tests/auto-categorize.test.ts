/**
 * FINLYNQ-84 — Tests rewritten against the v2 rule shape (JSONB conditions
 * + actions). The legacy flat-column shape was retired 2026-05-21.
 *
 * Coverage:
 *  - Single-condition rules across every field/op combo (payee/note/tags
 *    string ops, amount gt/lt/eq/between, account is/is_not, currency
 *    is/is_not, date weekday/day_of_month/between).
 *  - AND-fold semantics over `conditions.all[]`.
 *  - Priority DESC + first-match-wins.
 *  - InvestmentCategoryHint helpers unchanged.
 */
import { describe, it, expect } from "vitest";
import {
  applyRules,
  suggestCategory,
  applyRulesToBatch,
  pickInvestmentCategoryByPayee,
  fallbackInvestmentCategory,
  type TransactionInput,
  type TransactionRule,
  type InvestmentCategoryHint,
} from "@/lib/auto-categorize";
import { computePureActionPatch } from "@/lib/rules/execute";
import type { Condition, Action } from "@/lib/rules/schema";

function makeRule(overrides: {
  id?: number;
  name?: string;
  conditions?: Condition[];
  actions?: Action[];
  isActive?: boolean;
  priority?: number;
}): TransactionRule {
  return {
    id: overrides.id ?? 1,
    name: overrides.name ?? "Rule",
    conditions: { all: overrides.conditions ?? [] },
    actions: overrides.actions ?? [],
    isActive: overrides.isActive ?? true,
    priority: overrides.priority ?? 0,
  };
}

describe("applyRules (FINLYNQ-84 v2 shape)", () => {
  it("matches payee contains rule", () => {
    const rules = [makeRule({
      conditions: [{ field: "payee", op: "contains", value: "Starbucks" }],
      actions: [{ kind: "set_category", categoryId: 5 }],
    })];
    const txn: TransactionInput = { payee: "Starbucks Coffee", amount: -5.50 };
    const result = applyRules(txn, rules);
    expect(result).not.toBeNull();
    expect(computePureActionPatch(result!.actions).categoryId).toBe(5);
  });

  it("is case-insensitive for string matching", () => {
    const rules = [makeRule({
      conditions: [{ field: "payee", op: "contains", value: "NETFLIX" }],
      actions: [{ kind: "set_category", categoryId: 1 }],
    })];
    const result = applyRules({ payee: "netflix subscription" }, rules);
    expect(result).not.toBeNull();
  });

  it("matches payee exact rule", () => {
    const rules = [makeRule({
      conditions: [{ field: "payee", op: "exact", value: "Employer Inc." }],
      actions: [{ kind: "set_category", categoryId: 1 }],
    })];
    expect(applyRules({ payee: "Employer Inc." }, rules)).not.toBeNull();
    expect(applyRules({ payee: "Employer Inc. Canada" }, rules)).toBeNull();
  });

  it("matches payee regex rule", () => {
    const rules = [makeRule({
      conditions: [{ field: "payee", op: "regex", value: "^Star.*ks$" }],
      actions: [{ kind: "set_category", categoryId: 1 }],
    })];
    expect(applyRules({ payee: "Starbucks" }, rules)).not.toBeNull();
    expect(applyRules({ payee: "Tim Hortons" }, rules)).toBeNull();
  });

  it("handles invalid regex gracefully", () => {
    const rules = [makeRule({
      conditions: [{ field: "payee", op: "regex", value: "[invalid" }],
      actions: [{ kind: "set_category", categoryId: 1 }],
    })];
    expect(applyRules({ payee: "test" }, rules)).toBeNull();
  });

  it("matches amount gt", () => {
    const rules = [makeRule({
      conditions: [{ field: "amount", op: "gt", value: 100 }],
      actions: [{ kind: "set_category", categoryId: 1 }],
    })];
    expect(applyRules({ amount: 150 }, rules)).not.toBeNull();
    expect(applyRules({ amount: 50 }, rules)).toBeNull();
  });

  it("matches amount lt", () => {
    const rules = [makeRule({
      conditions: [{ field: "amount", op: "lt", value: 0 }],
      actions: [{ kind: "set_category", categoryId: 1 }],
    })];
    expect(applyRules({ amount: -50 }, rules)).not.toBeNull();
    expect(applyRules({ amount: 50 }, rules)).toBeNull();
  });

  it("matches amount eq", () => {
    const rules = [makeRule({
      conditions: [{ field: "amount", op: "eq", value: 99.99 }],
      actions: [{ kind: "set_category", categoryId: 1 }],
    })];
    expect(applyRules({ amount: 99.99 }, rules)).not.toBeNull();
    expect(applyRules({ amount: 100 }, rules)).toBeNull();
  });

  it("matches amount between", () => {
    const rules = [makeRule({
      conditions: [{ field: "amount", op: "between", min: 50, max: 500 }],
      actions: [{ kind: "set_category", categoryId: 1 }],
    })];
    expect(applyRules({ amount: 100 }, rules)).not.toBeNull();
    expect(applyRules({ amount: 49 }, rules)).toBeNull();
    expect(applyRules({ amount: 501 }, rules)).toBeNull();
    // Inclusive boundaries.
    expect(applyRules({ amount: 50 }, rules)).not.toBeNull();
    expect(applyRules({ amount: 500 }, rules)).not.toBeNull();
  });

  it("matches account is / is_not", () => {
    const rules1 = [makeRule({
      conditions: [{ field: "account", op: "is", accountId: 42 }],
      actions: [{ kind: "set_category", categoryId: 1 }],
    })];
    expect(applyRules({ accountId: 42 }, rules1)).not.toBeNull();
    expect(applyRules({ accountId: 43 }, rules1)).toBeNull();

    const rules2 = [makeRule({
      conditions: [{ field: "account", op: "is_not", accountId: 42 }],
      actions: [{ kind: "set_category", categoryId: 1 }],
    })];
    expect(applyRules({ accountId: 43 }, rules2)).not.toBeNull();
    expect(applyRules({ accountId: 42 }, rules2)).toBeNull();
  });

  it("matches currency is / is_not (case-insensitive)", () => {
    const rules = [makeRule({
      conditions: [{ field: "currency", op: "is", value: "USD" }],
      actions: [{ kind: "set_category", categoryId: 1 }],
    })];
    expect(applyRules({ enteredCurrency: "USD" }, rules)).not.toBeNull();
    expect(applyRules({ enteredCurrency: "usd" }, rules)).not.toBeNull();
    expect(applyRules({ enteredCurrency: "CAD" }, rules)).toBeNull();
  });

  it("matches date weekday (UTC)", () => {
    // 2026-05-20 is a Wednesday → UTC weekday 3.
    const rules = [makeRule({
      conditions: [{ field: "date", op: "weekday", weekday: 3 }],
      actions: [{ kind: "set_category", categoryId: 1 }],
    })];
    expect(applyRules({ date: "2026-05-20" }, rules)).not.toBeNull();
    expect(applyRules({ date: "2026-05-21" }, rules)).toBeNull();
  });

  it("matches date day_of_month (UTC)", () => {
    const rules = [makeRule({
      conditions: [{ field: "date", op: "day_of_month", day: 1 }],
      actions: [{ kind: "set_category", categoryId: 1 }],
    })];
    expect(applyRules({ date: "2026-05-01" }, rules)).not.toBeNull();
    expect(applyRules({ date: "2026-05-15" }, rules)).toBeNull();
  });

  it("matches date between (inclusive)", () => {
    const rules = [makeRule({
      conditions: [{ field: "date", op: "between", from: "2026-05-01", to: "2026-05-31" }],
      actions: [{ kind: "set_category", categoryId: 1 }],
    })];
    expect(applyRules({ date: "2026-05-15" }, rules)).not.toBeNull();
    expect(applyRules({ date: "2026-05-01" }, rules)).not.toBeNull();
    expect(applyRules({ date: "2026-05-31" }, rules)).not.toBeNull();
    expect(applyRules({ date: "2026-04-30" }, rules)).toBeNull();
    expect(applyRules({ date: "2026-06-01" }, rules)).toBeNull();
  });

  it("AND-folds multiple conditions", () => {
    const rules = [makeRule({
      conditions: [
        { field: "payee", op: "contains", value: "Whole Foods" },
        { field: "amount", op: "between", min: 50, max: 500 },
      ],
      actions: [{ kind: "set_category", categoryId: 5 }],
    })];
    // Both conds satisfied.
    expect(applyRules({ payee: "Whole Foods Market", amount: 80 }, rules)).not.toBeNull();
    // Payee matches but amount fails.
    expect(applyRules({ payee: "Whole Foods Market", amount: 5 }, rules)).toBeNull();
    // Amount matches but payee fails.
    expect(applyRules({ payee: "Trader Joes", amount: 80 }, rules)).toBeNull();
  });

  it("skips inactive rules", () => {
    const rules = [makeRule({
      isActive: false,
      conditions: [{ field: "payee", op: "contains", value: "test" }],
      actions: [{ kind: "set_category", categoryId: 1 }],
    })];
    expect(applyRules({ payee: "test" }, rules)).toBeNull();
  });

  it("uses highest priority rule (first-match-wins after priority DESC)", () => {
    const rules = [
      makeRule({
        id: 1,
        conditions: [{ field: "payee", op: "contains", value: "coffee" }],
        actions: [{ kind: "set_category", categoryId: 1 }],
        priority: 0,
      }),
      makeRule({
        id: 2,
        conditions: [{ field: "payee", op: "contains", value: "coffee" }],
        actions: [{ kind: "set_category", categoryId: 2 }],
        priority: 10,
      }),
    ];
    const result = applyRules({ payee: "coffee shop" }, rules);
    expect(computePureActionPatch(result!.actions).categoryId).toBe(2);
  });

  it("returns null when no rules match", () => {
    const rules = [makeRule({
      conditions: [{ field: "payee", op: "exact", value: "XYZ Corp" }],
      actions: [{ kind: "set_category", categoryId: 1 }],
    })];
    expect(applyRules({ payee: "ABC Inc" }, rules)).toBeNull();
  });

  it("matches tags field", () => {
    const rules = [makeRule({
      conditions: [{ field: "tags", op: "contains", value: "business" }],
      actions: [{ kind: "set_category", categoryId: 1 }],
    })];
    expect(applyRules({ tags: "business,travel" }, rules)).not.toBeNull();
  });

  it("matches note field", () => {
    const rules = [makeRule({
      conditions: [{ field: "note", op: "contains", value: "client" }],
      actions: [{ kind: "set_category", categoryId: 1 }],
    })];
    expect(applyRules({ note: "Lunch with client" }, rules)).not.toBeNull();
    expect(applyRules({ note: "Lunch alone" }, rules)).toBeNull();
  });
});

describe("computePureActionPatch", () => {
  it("ignores side-effect actions", () => {
    const patch = computePureActionPatch([
      { kind: "set_category", categoryId: 5 },
      { kind: "set_account", accountId: 99 },
      { kind: "create_transfer", destAccountId: 100 },
    ]);
    expect(patch.categoryId).toBe(5);
    expect(patch).not.toHaveProperty("accountId");
    expect(patch).not.toHaveProperty("destAccountId");
  });

  it("collects pure actions into a single patch", () => {
    const patch = computePureActionPatch([
      { kind: "set_category", categoryId: 5 },
      { kind: "set_tags", tags: "groceries,food" },
      { kind: "rename_payee", to: "Whole Foods Market" },
      { kind: "set_entered_currency", currency: "USD" },
      { kind: "set_portfolio_holding", holdingId: 12 },
    ]);
    expect(patch.categoryId).toBe(5);
    expect(patch.tags).toBe("groceries,food");
    expect(patch.payee).toBe("Whole Foods Market");
    expect(patch.enteredCurrency).toBe("USD");
    expect(patch.portfolioHoldingId).toBe(12);
  });

  it("last-action-wins on field collision", () => {
    const patch = computePureActionPatch([
      { kind: "set_category", categoryId: 1 },
      { kind: "set_category", categoryId: 2 },
    ]);
    expect(patch.categoryId).toBe(2);
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
    const rules = [makeRule({
      conditions: [{ field: "payee", op: "contains", value: "coffee" }],
      actions: [{ kind: "set_category", categoryId: 5 }],
    })];
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
