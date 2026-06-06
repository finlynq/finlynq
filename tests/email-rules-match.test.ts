import { describe, it, expect } from "vitest";
import {
  ruleMatchesEmail,
  firstMatchingRule,
  type ActiveEmailRule,
} from "@/lib/email-rules/load";

function rule(p: Partial<ActiveEmailRule>): ActiveEmailRule {
  return {
    id: 1,
    name: "r",
    matchType: "sender",
    matchOp: "contains",
    matchValue: "",
    accountId: 1,
    categoryId: null,
    mode: "auto",
    flipSign: false,
    dateSource: "parsed",
    payeeOverride: null,
    priority: 0,
    ...p,
  };
}

describe("ruleMatchesEmail", () => {
  const ctx = { fromAddress: "alerts@chase.com", subject: "You spent $42 at Cafe" };

  it("contains (sender) is case-insensitive", () => {
    expect(ruleMatchesEmail(rule({ matchType: "sender", matchOp: "contains", matchValue: "CHASE.com" }), ctx)).toBe(true);
    expect(ruleMatchesEmail(rule({ matchType: "sender", matchOp: "contains", matchValue: "bank" }), ctx)).toBe(false);
  });

  it("exact (sender) trims + lowercases", () => {
    expect(ruleMatchesEmail(rule({ matchOp: "exact", matchValue: " alerts@chase.com " }), ctx)).toBe(true);
    expect(ruleMatchesEmail(rule({ matchOp: "exact", matchValue: "chase.com" }), ctx)).toBe(false);
  });

  it("subject matching reads the subject", () => {
    expect(ruleMatchesEmail(rule({ matchType: "subject", matchOp: "contains", matchValue: "spent" }), ctx)).toBe(true);
  });

  it("regex matches; malformed regex never throws", () => {
    expect(ruleMatchesEmail(rule({ matchOp: "regex", matchValue: "chase\\.(com|net)" }), ctx)).toBe(true);
    expect(ruleMatchesEmail(rule({ matchOp: "regex", matchValue: "[" }), ctx)).toBe(false);
  });

  it("empty needle never matches", () => {
    expect(ruleMatchesEmail(rule({ matchValue: "" }), ctx)).toBe(false);
  });
});

describe("firstMatchingRule", () => {
  const ctx = { fromAddress: "alerts@chase.com", subject: "hi" };
  it("returns the first (highest-priority) match in array order", () => {
    const rules = [
      rule({ id: 10, priority: 5, matchValue: "chase" }),
      rule({ id: 11, priority: 1, matchValue: "chase.com" }),
    ];
    expect(firstMatchingRule(rules, ctx)?.id).toBe(10);
  });
  it("returns null when nothing matches", () => {
    expect(firstMatchingRule([rule({ matchValue: "wellsfargo" })], ctx)).toBeNull();
  });
});
