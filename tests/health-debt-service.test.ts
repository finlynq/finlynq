/**
 * Debt-service numerator (GH #333 follow-up).
 *
 * The old numerator was raw SQL with nothing pure to test, which is part of why
 * it stayed wrong for so long. The replacement is a pure function, so this is a
 * real behavioural suite rather than a source-text gate.
 */

import { describe, it, expect } from "vitest";
import {
  monthsOverlapping,
  scheduledServiceForLoan,
  computeDebtService,
  type DebtServiceLoan,
} from "@/lib/health/debt-service";

const WINDOW_START = "2025-08-22";
const WINDOW_END = "2026-08-22";

function loan(over: Partial<DebtServiceLoan> = {}): DebtServiceLoan {
  return {
    id: 1,
    accountId: null,
    currency: "USD",
    principal: 24000,
    annualRate: 6,
    termMonths: 60,
    startDate: "2024-01-01",
    paymentAmount: null,
    paymentFrequency: "monthly",
    extraPayment: 0,
    residualValue: null,
    ...over,
  };
}

describe("monthsOverlapping", () => {
  it("returns ~12 for a debt that spans the whole window", () => {
    expect(monthsOverlapping("2020-01-01", "2030-01-01", WINDOW_START, WINDOW_END)).toBeCloseTo(12, 1);
  });

  it("counts only the months a mid-window loan actually existed", () => {
    // Opened 3 months before the window closes — charging it a full 12 months
    // is the same class of error as the opening-balance bug this replaced.
    const months = monthsOverlapping("2026-05-22", null, WINDOW_START, WINDOW_END);
    expect(months).toBeGreaterThan(2.8);
    expect(months).toBeLessThan(3.2);
  });

  it("stops at payoff for a loan that ended mid-window", () => {
    const months = monthsOverlapping("2020-01-01", "2025-11-22", WINDOW_START, WINDOW_END);
    expect(months).toBeGreaterThan(2.8);
    expect(months).toBeLessThan(3.2);
  });

  it("is 0 when the debt closed before the window opened", () => {
    expect(monthsOverlapping("2019-01-01", "2020-01-01", WINDOW_START, WINDOW_END)).toBe(0);
  });

  it("is 0 when the debt starts after the window closes", () => {
    expect(monthsOverlapping("2027-01-01", null, WINDOW_START, WINDOW_END)).toBe(0);
  });

  it("treats a null end as still-open", () => {
    expect(monthsOverlapping("2020-01-01", null, WINDOW_START, WINDOW_END)).toBeCloseTo(12, 1);
  });
});

describe("scheduledServiceForLoan", () => {
  it("returns roughly 12x the monthly payment for a full-window loan", () => {
    // 24000 @ 6% over 60 months ≈ 463.97/mo.
    const service = scheduledServiceForLoan(loan(), WINDOW_START, WINDOW_END);
    expect(service).toBeGreaterThan(5300);
    expect(service).toBeLessThan(5700);
  });

  it("scales down for a loan opened part-way through the window", () => {
    const full = scheduledServiceForLoan(loan(), WINDOW_START, WINDOW_END);
    const partial = scheduledServiceForLoan(
      loan({ startDate: "2026-05-22" }),
      WINDOW_START,
      WINDOW_END,
    );
    expect(partial).toBeLessThan(full / 3);
    expect(partial).toBeGreaterThan(0);
  });

  it("returns 0 rather than throwing when the loan cannot be scheduled", () => {
    // A payment far too small to ever amortize raises LoanValidationError; it
    // must not take the whole health score down with it.
    const service = scheduledServiceForLoan(
      loan({ termMonths: null, paymentAmount: 0.01 }),
      WINDOW_START,
      WINDOW_END,
    );
    expect(service).toBe(0);
  });
});

describe("computeDebtService", () => {
  const identity = (amount: number) => amount;

  it("sums scheduled loan service and reports it as reliable", () => {
    const r = computeDebtService({
      loans: [loan()],
      untrackedPayments: [],
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      convert: identity,
    });
    expect(r.loansCounted).toBe(1);
    expect(r.realized).toBe(0);
    expect(r.total).toBe(r.scheduled);
    expect(r.reliable).toBe(true);
  });

  it("adds realized payments on untracked liabilities and drops reliable", () => {
    // A card transactor's realized payments equal their card SPEND, which
    // overstates debt service — the UI must caveat rather than assert.
    const r = computeDebtService({
      loans: [],
      untrackedPayments: [{ currency: "USD", total: 4800 }],
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      convert: identity,
    });
    expect(r.scheduled).toBe(0);
    expect(r.realized).toBe(4800);
    expect(r.total).toBe(4800);
    expect(r.reliable).toBe(false);
  });

  it("converts each source at its own currency's rate (FINLYNQ-123)", () => {
    const rates: Record<string, number> = { USD: 1, EUR: 2 };
    const r = computeDebtService({
      loans: [],
      untrackedPayments: [
        { currency: "USD", total: 100 },
        { currency: "EUR", total: 100 },
      ],
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      convert: (amount, cur) => amount * (rates[cur ?? "USD"] ?? 1),
    });
    expect(r.total).toBe(300);
  });

  it("ignores non-positive and non-finite realized rows", () => {
    const r = computeDebtService({
      loans: [],
      untrackedPayments: [
        { currency: "USD", total: 0 },
        { currency: "USD", total: -50 },
        { currency: "USD", total: Number.NaN },
      ],
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      convert: identity,
    });
    expect(r.total).toBe(0);
    expect(r.reliable).toBe(true);
  });

  it("does not count a loan that was fully repaid before the window", () => {
    const r = computeDebtService({
      loans: [loan({ startDate: "2015-01-01", termMonths: 12 })],
      untrackedPayments: [],
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      convert: identity,
    });
    expect(r.loansCounted).toBe(0);
    expect(r.total).toBe(0);
  });
});
