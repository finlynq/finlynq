import {
  accountFormFromRow,
  goalFormFromGoal,
  categoryFormFromCategory,
} from "../lib/edit-prefill";
import type {
  AccountDetailRow,
  Category,
  GoalWithProgress,
} from "../../../shared/types";

describe("accountFormFromRow", () => {
  it("returns create-mode defaults for null", () => {
    const f = accountFormFromRow(null);
    expect(f).toEqual({
      name: "",
      type: "A",
      group: "Cash",
      currency: "CAD",
      alias: "",
      note: "",
    });
  });

  it("maps a row's fields into input strings", () => {
    const row: AccountDetailRow = {
      id: 7,
      type: "L",
      group: "Credit Card",
      name: "Visa Rewards",
      alias: "Visa",
      currency: "USD",
      note: "main card",
      archived: false,
      isInvestment: false,
      mode: "approve",
    };
    expect(accountFormFromRow(row)).toEqual({
      name: "Visa Rewards",
      type: "L",
      group: "Credit Card",
      currency: "USD",
      alias: "Visa",
      note: "main card",
    });
  });

  it("coalesces a cold-DEK null name to '' and falls back an off-type group", () => {
    const row: AccountDetailRow = {
      id: 9,
      type: "A",
      group: "Credit Card", // belongs to L, not A → falls back to first A group
      name: null,
      currency: "CAD",
      mode: "manual",
    };
    const f = accountFormFromRow(row);
    expect(f.name).toBe("");
    expect(f.group).toBe("Cash");
    expect(f.alias).toBe("");
  });
});

describe("goalFormFromGoal", () => {
  it("returns create-mode defaults for null", () => {
    const f = goalFormFromGoal(null);
    expect(f.name).toBe("");
    expect(f.targetAmount).toBe("");
    expect(f.type).toBe("savings");
    expect(f.currency).toBe("CAD");
    expect(f.priority).toBe(1);
    expect(f.linkedAccountIds).toEqual([]);
  });

  it("stringifies the target and prefers accountIds", () => {
    const goal = {
      id: 3,
      name: "Emergency Fund",
      type: "emergency_fund",
      targetAmount: 10000,
      deadline: "2026-12-31",
      accountId: 1,
      accountIds: [1, 2],
      currency: "USD",
      priority: 2,
      status: "active",
      note: "6 months",
      currentAmount: 0,
      progress: 0,
      percentComplete: 0,
      remaining: 10000,
      monthlyNeeded: 0,
    } as GoalWithProgress;
    const f = goalFormFromGoal(goal);
    expect(f.targetAmount).toBe("10000");
    expect(f.deadline).toBe("2026-12-31");
    expect(f.linkedAccountIds).toEqual([1, 2]);
  });

  it("falls back to the legacy single accountId when accountIds is empty", () => {
    const goal = {
      id: 4,
      name: "Car",
      type: "savings",
      targetAmount: 5000,
      deadline: null,
      accountId: 8,
      accountIds: [],
      currency: null,
      priority: 1,
      status: "active",
      note: "",
      currentAmount: 0,
      progress: 0,
      percentComplete: 0,
      remaining: 5000,
      monthlyNeeded: 0,
    } as GoalWithProgress;
    expect(goalFormFromGoal(goal).linkedAccountIds).toEqual([8]);
  });
});

describe("categoryFormFromCategory", () => {
  it("returns create-mode defaults for null", () => {
    expect(categoryFormFromCategory(null)).toEqual({
      name: "",
      type: "E",
      group: "",
      note: "",
    });
  });

  it("maps a category's fields", () => {
    const cat: Category = {
      id: 5,
      type: "I",
      group: "Income",
      name: "Salary",
      note: "monthly",
    };
    expect(categoryFormFromCategory(cat)).toEqual({
      name: "Salary",
      type: "I",
      group: "Income",
      note: "monthly",
    });
  });
});
