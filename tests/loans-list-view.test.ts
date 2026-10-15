/**
 * Loans page list helpers (in-app feedback 2026-10-15: with 17 loans the
 * cards the list replaced fitted about three to a screen).
 */

import { describe, it, expect } from "vitest";
import {
  loanPaidPct,
  loanShownRate,
  loanTypeLabel,
  PAYMENT_FREQUENCY_SHORT,
} from "@/lib/loans/list-view";

describe("loanPaidPct", () => {
  it("is the share of the principal paid", () => {
    expect(loanPaidPct({ principal: 10_000, remainingBalance: 7_500 })).toBe(25);
  });

  it("reads 0 for a loan the server could not schedule, not 100", () => {
    expect(loanPaidPct({ principal: 10_000, remainingBalance: null })).toBe(0);
  });

  it("stays within 0 to 100", () => {
    expect(loanPaidPct({ principal: 10_000, remainingBalance: 12_000 })).toBe(0);
    expect(loanPaidPct({ principal: 10_000, remainingBalance: -50 })).toBe(100);
    expect(loanPaidPct({ principal: 0, remainingBalance: 0 })).toBe(0);
  });
});

describe("loanShownRate", () => {
  it("shows the yearly rate for a rate-priced loan", () => {
    expect(loanShownRate({ annualRate: 4.5, interestMethod: "rate", effectiveAnnualRate: 4.5 })).toEqual({ rate: 4.5, effective: false });
    expect(loanShownRate({ annualRate: 4.5 })).toEqual({ rate: 4.5, effective: false });
  });

  it("shows the effective rate for a flat or total-interest loan", () => {
    expect(loanShownRate({ annualRate: 3.48, interestMethod: "flat", effectiveAnnualRate: 6.5 })).toEqual({ rate: 6.5, effective: true });
    expect(loanShownRate({ annualRate: 3.48, interestMethod: "total", effectiveAnnualRate: null })).toEqual({ rate: 3.48, effective: true });
  });
});

describe("loanTypeLabel", () => {
  it("names the known types", () => {
    expect(loanTypeLabel("student_loan")).toBe("Student loan");
    expect(loanTypeLabel("credit_card")).toBe("Credit card");
    expect(loanTypeLabel("mortgage")).toBe("Mortgage");
  });

  it("tidies an unknown type instead of hiding it", () => {
    expect(loanTypeLabel("line_of_credit")).toBe("Line of credit");
    expect(loanTypeLabel(null)).toBe("Loan");
  });
});

describe("PAYMENT_FREQUENCY_SHORT", () => {
  it("covers every frequency the loan form offers", () => {
    for (const f of ["weekly", "biweekly", "semi_monthly", "monthly", "quarterly", "annual"]) {
      expect(PAYMENT_FREQUENCY_SHORT[f]).toBeTruthy();
    }
  });
});
