import { describe, it, expect } from "vitest";
import {
  applyEmailTransform,
  flipAmountSign,
  type TransformInput,
} from "@/lib/email-import/apply-transform";

const CAND: TransformInput = { date: "2026-06-05", amount: -42.17, payee: "STARBUCKS" };
const RECEIVED = "2026-06-10";

describe("flipAmountSign", () => {
  it("flips a negative to positive and vice versa", () => {
    expect(flipAmountSign(-42.17)).toBeCloseTo(42.17);
    expect(flipAmountSign(42.17)).toBeCloseTo(-42.17);
  });
  it("keeps +0 as +0 (never produces -0)", () => {
    expect(Object.is(flipAmountSign(0), -0)).toBe(false);
    expect(flipAmountSign(0)).toBe(0);
  });
});

describe("applyEmailTransform — raw passthrough", () => {
  it("returns the candidate verbatim with an empty transform", () => {
    expect(applyEmailTransform(CAND, {}, RECEIVED)).toEqual(CAND);
  });
});

describe("applyEmailTransform — flipSign (rule)", () => {
  it("flips the parsed amount", () => {
    const out = applyEmailTransform(CAND, { flipSign: true }, RECEIVED);
    expect(out.amount).toBeCloseTo(42.17);
    expect(out.date).toBe("2026-06-05");
    expect(out.payee).toBe("STARBUCKS");
  });
  it("0-guard: a 0 amount stays +0 when flipped", () => {
    const out = applyEmailTransform({ ...CAND, amount: 0 }, { flipSign: true }, RECEIVED);
    expect(out.amount).toBe(0);
    expect(Object.is(out.amount, -0)).toBe(false);
  });
});

describe("applyEmailTransform — dateSource (rule)", () => {
  it("'received' uses the email received date", () => {
    const out = applyEmailTransform(CAND, { dateSource: "received" }, RECEIVED);
    expect(out.date).toBe(RECEIVED);
  });
  it("'received' with a null receivedDate falls back to the candidate date", () => {
    const out = applyEmailTransform(CAND, { dateSource: "received" }, null);
    expect(out.date).toBe("2026-06-05");
  });
  it("'parsed' (default) keeps the candidate date", () => {
    expect(applyEmailTransform(CAND, { dateSource: "parsed" }, RECEIVED).date).toBe("2026-06-05");
  });
});

describe("applyEmailTransform — payeeOverride (rule)", () => {
  it("forces the rule payee when non-empty", () => {
    expect(applyEmailTransform(CAND, { payeeOverride: "Acme Renamed" }, RECEIVED).payee).toBe(
      "Acme Renamed",
    );
  });
  it("ignores an empty/whitespace rule payee (keeps the candidate)", () => {
    expect(applyEmailTransform(CAND, { payeeOverride: "   " }, RECEIVED).payee).toBe("STARBUCKS");
    expect(applyEmailTransform(CAND, { payeeOverride: "" }, RECEIVED).payee).toBe("STARBUCKS");
  });
});

describe("applyEmailTransform — per-email overrides win (precedence)", () => {
  it("amountOverride is authoritative; flip is NOT re-applied on top of it", () => {
    const out = applyEmailTransform(
      CAND,
      { flipSign: true, amountOverride: -99.5 },
      RECEIVED,
    );
    expect(out.amount).toBeCloseTo(-99.5);
  });
  it("dateOverride beats dateSource:'received'", () => {
    const out = applyEmailTransform(
      CAND,
      { dateSource: "received", dateOverride: "2026-01-01" },
      RECEIVED,
    );
    expect(out.date).toBe("2026-01-01");
  });
  it("per-email payee beats the rule-level payeeOverride", () => {
    const out = applyEmailTransform(
      CAND,
      { payeeOverride: "Rule Payee", payeeOverridePerEmail: "Manual Payee" },
      RECEIVED,
    );
    expect(out.payee).toBe("Manual Payee");
  });
  it("amountOverride of 0 is respected (not treated as absent)", () => {
    const out = applyEmailTransform(CAND, { flipSign: true, amountOverride: 0 }, RECEIVED);
    expect(out.amount).toBe(0);
  });
});

describe("applyEmailTransform — combined rule transforms", () => {
  it("applies flip + received-date + rename together", () => {
    const out = applyEmailTransform(
      CAND,
      { flipSign: true, dateSource: "received", payeeOverride: "Rent" },
      RECEIVED,
    );
    expect(out).toEqual({ date: RECEIVED, amount: 42.17, payee: "Rent" });
  });
});
