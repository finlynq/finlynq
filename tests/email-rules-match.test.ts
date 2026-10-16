import { describe, it, expect } from "vitest";
import {
  ruleMatchesEmail,
  firstMatchingRule,
  type ActiveEmailRule,
  type EmailMatchContext,
} from "@/lib/email-rules/load";
import type { EmailCondition } from "@/lib/email-rules/schema";

function rule(conditions: EmailCondition[], extra: Partial<ActiveEmailRule> = {}): ActiveEmailRule {
  return {
    id: 1,
    name: "r",
    conditions,
    accountId: 1,
    categoryId: null,
    transferDestAccountId: null,
    mode: "auto",
    flipSign: false,
    dateSource: "parsed",
    payeeOverride: null,
    currency: null,
    priority: 0,
    ...extra,
  };
}

const ctx = (over: Partial<EmailMatchContext> = {}): EmailMatchContext => ({
  fromAddress: "alerts@chase.com",
  subject: "You spent $42 at Cafe",
  body: "Your account was charged $42.17 at STARBUCKS. Card ending 1234.",
  payee: "STARBUCKS",
  amount: -42.17,
  ...over,
});

describe("ruleMatchesEmail — text fields", () => {
  it("sender contains is case-insensitive", () => {
    expect(ruleMatchesEmail(rule([{ field: "sender", op: "contains", value: "CHASE.com" }]), ctx())).toBe(true);
    expect(ruleMatchesEmail(rule([{ field: "sender", op: "contains", value: "bank" }]), ctx())).toBe(false);
  });
  it("subject / body / payee fields read the right haystack", () => {
    expect(ruleMatchesEmail(rule([{ field: "subject", op: "contains", value: "spent" }]), ctx())).toBe(true);
    expect(ruleMatchesEmail(rule([{ field: "body", op: "contains", value: "starbucks" }]), ctx())).toBe(true);
    expect(ruleMatchesEmail(rule([{ field: "payee", op: "exact", value: " starbucks " }]), ctx())).toBe(true);
  });
  it("body regex matches; malformed regex never throws", () => {
    expect(ruleMatchesEmail(rule([{ field: "body", op: "regex", value: "charged \\$\\d+" }]), ctx())).toBe(true);
    expect(ruleMatchesEmail(rule([{ field: "body", op: "regex", value: "[" }]), ctx())).toBe(false);
  });
});

describe("ruleMatchesEmail — whitespace counts as one space", () => {
  // Rogers Bank purchase alert as its plain-text part arrives: hard-wrapped at
  // 76 columns, which falls exactly between "AMZN" and "Mktp".
  const rogers = ctx({
    fromAddress: "onlineservices@rogersbank.com",
    subject: "Purchase amount alert",
    body:
      "$15.81 on Oct 10, 2026 on your credit card ending in 4034. Details: AMZN\r\n" +
      "Mktp CA*592YT6GL2.\r\n\r\nLearn how to manage account alerts.\r\n\r\nThank you for choosing Rogers Bank.",
    payee: "Purchase amount",
    amount: -15.81,
  });

  it("matches a contains value across a wrapped line (the reported rule)", () => {
    const r = rule([
      { field: "sender", op: "contains", value: "onlineservices@rogersbank.com" },
      { field: "body", op: "contains", value: "AMZN Mktp CA" },
    ]);
    expect(ruleMatchesEmail(r, rogers)).toBe(true);
  });

  it("treats tabs, non-breaking spaces and repeated spaces as one space", () => {
    const body = "Details: AMZN  Mktp\t CA*1";
    expect(ruleMatchesEmail(rule([{ field: "body", op: "contains", value: "AMZN Mktp CA" }]), ctx({ body }))).toBe(true);
    // ...in the rule's value too.
    expect(ruleMatchesEmail(rule([{ field: "body", op: "contains", value: "AMZN  Mktp\nCA" }]), rogers)).toBe(true);
  });

  it("applies to exact and to the other text fields", () => {
    expect(
      ruleMatchesEmail(rule([{ field: "subject", op: "exact", value: "purchase amount alert" }]), ctx({ subject: "Purchase\n  amount alert " })),
    ).toBe(true);
    expect(ruleMatchesEmail(rule([{ field: "payee", op: "contains", value: "Whole Foods" }]), ctx({ payee: "WHOLE FOODS #12" }))).toBe(true);
  });

  it("lets a regex with a literal space match across the wrap", () => {
    expect(ruleMatchesEmail(rule([{ field: "body", op: "regex", value: "AMZN Mktp CA\\*\\w+" }]), rogers)).toBe(true);
    expect(ruleMatchesEmail(rule([{ field: "body", op: "regex", value: "AMZN\\s+Mktp" }]), rogers)).toBe(true);
  });

  it("still needs the space: words run together don't match", () => {
    expect(ruleMatchesEmail(rule([{ field: "body", op: "contains", value: "AMZN Mktp" }]), ctx({ body: "Details: AMZNMktp CA" }))).toBe(false);
  });
});

describe("ruleMatchesEmail — AND across mixed fields", () => {
  it("all conditions must match", () => {
    const r = rule([
      { field: "sender", op: "contains", value: "chase.com" },
      { field: "body", op: "contains", value: "starbucks" },
      { field: "amount", op: "lt", value: 500 },
    ]);
    expect(ruleMatchesEmail(r, ctx())).toBe(true);
  });
  it("fails when one condition fails", () => {
    const r = rule([
      { field: "sender", op: "contains", value: "chase.com" },
      { field: "body", op: "contains", value: "wholefoods" }, // not in body
    ]);
    expect(ruleMatchesEmail(r, ctx())).toBe(false);
  });
  it("an empty condition list never matches", () => {
    expect(ruleMatchesEmail(rule([]), ctx())).toBe(false);
  });
});

describe("ruleMatchesEmail — amount (magnitude)", () => {
  it("gt/lt compare |amount| (signed parser value)", () => {
    expect(ruleMatchesEmail(rule([{ field: "amount", op: "gt", value: 100 }]), ctx({ amount: -142.5 }))).toBe(true);
    expect(ruleMatchesEmail(rule([{ field: "amount", op: "lt", value: 100 }]), ctx({ amount: -142.5 }))).toBe(false);
    expect(ruleMatchesEmail(rule([{ field: "amount", op: "lt", value: 500 }]), ctx({ amount: -42.17 }))).toBe(true);
  });
  it("between tolerates swapped bounds + compares magnitude", () => {
    expect(ruleMatchesEmail(rule([{ field: "amount", op: "between", min: 100, max: 50 }]), ctx({ amount: -75 }))).toBe(true);
    expect(ruleMatchesEmail(rule([{ field: "amount", op: "between", min: 50, max: 100 }]), ctx({ amount: -200 }))).toBe(false);
  });
  it("null/absent amount fails an amount condition", () => {
    expect(ruleMatchesEmail(rule([{ field: "amount", op: "lt", value: 500 }]), ctx({ amount: null }))).toBe(false);
  });
});

describe("ruleMatchesEmail — body regex ReDoS cap", () => {
  it("matches within the 20KB cap and does not hang on a long body", () => {
    const longBody = "x".repeat(60_000) + " TOKEN-NEAR-START-IS-WITHIN-CAP";
    // Match a token within the first 20KB (present): "x{5}" matches the leading x's.
    expect(ruleMatchesEmail(rule([{ field: "body", op: "regex", value: "x{5}" }]), ctx({ body: longBody }))).toBe(true);
    // A token only AFTER the cap is not seen (sliced off) — proves the cap is applied.
    const tailOnly = "y".repeat(40_000) + "UNIQUETAIL";
    expect(ruleMatchesEmail(rule([{ field: "body", op: "regex", value: "UNIQUETAIL" }]), ctx({ body: tailOnly }))).toBe(false);
  });
});

describe("firstMatchingRule", () => {
  it("returns the first (array-order = priority) matching rule", () => {
    const rules = [
      rule([{ field: "sender", op: "contains", value: "chase" }], { id: 10, priority: 5 }),
      rule([{ field: "sender", op: "contains", value: "chase.com" }], { id: 11, priority: 1 }),
    ];
    expect(firstMatchingRule(rules, ctx())?.id).toBe(10);
  });
  it("returns null when nothing matches", () => {
    expect(firstMatchingRule([rule([{ field: "sender", op: "contains", value: "wellsfargo" }])], ctx())).toBeNull();
  });
});
