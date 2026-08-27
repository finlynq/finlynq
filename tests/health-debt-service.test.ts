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
  type UntrackedLiabilityAccount,
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

/** One untracked liability account. Defaults describe a REVOLVER — carrying
 *  more than they paid — so a test only opts into the pay-in-full shape when
 *  that is what it is exercising. */
function card(over: Partial<UntrackedLiabilityAccount> = {}): UntrackedLiabilityAccount {
  return {
    accountId: 1,
    currency: "USD",
    payments: [{ currency: "USD", total: 4800 }],
    owedAtWindowStart: 10000,
    owedAtWindowEnd: 10000,
    ...over,
  };
}

describe("computeDebtService", () => {
  const identity = (amount: number) => amount;

  it("sums scheduled loan service and reports it as reliable", () => {
    const r = computeDebtService({
      loans: [loan()],
      untrackedLiabilities: [],
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      convert: identity,
    });
    expect(r.loansCounted).toBe(1);
    expect(r.realized).toBe(0);
    expect(r.total).toBe(r.scheduled);
    expect(r.reliable).toBe(true);
  });

  it("counts realized payments in full when they stay under the debt carried", () => {
    // A revolver paying less than they owe is measured exactly — the cap must
    // never reduce genuine debt service, and this stays RELIABLE.
    const r = computeDebtService({
      loans: [],
      untrackedLiabilities: [card()],
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      convert: identity,
    });
    expect(r.scheduled).toBe(0);
    expect(r.realized).toBe(4800);
    expect(r.total).toBe(4800);
    expect(r.cappedAccounts).toBe(0);
    expect(r.excludedPayInFull).toBe(0);
    expect(r.reliable).toBe(true);
  });

  it("excludes a card paid in full — nothing carried means no debt service", () => {
    // The headline case: $6,600 of card payments against a card that owes
    // nothing at either end of the window is $6,600 of SPENDING, already
    // counted on the expense side. Counting it as debt service measured card
    // spend / income and labelled the result debt-to-income.
    const r = computeDebtService({
      loans: [],
      untrackedLiabilities: [
        card({
          payments: [{ currency: "USD", total: 6600 }],
          owedAtWindowStart: 0,
          owedAtWindowEnd: 0,
        }),
      ],
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      convert: identity,
    });
    expect(r.realized).toBe(0);
    expect(r.total).toBe(0);
    expect(r.cappedAccounts).toBe(1);
    expect(r.excludedPayInFull).toBe(6600);
    expect(r.reliable).toBe(false);
  });

  it("caps a transactor at the balance carried, not at zero", () => {
    // Someone who revolves one statement cycle still services that cycle.
    const r = computeDebtService({
      loans: [],
      untrackedLiabilities: [
        card({
          payments: [{ currency: "USD", total: 6600 }],
          owedAtWindowStart: 1100,
          owedAtWindowEnd: 900,
        }),
      ],
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      convert: identity,
    });
    expect(r.realized).toBe(1100);
    expect(r.excludedPayInFull).toBe(5500);
  });

  it("uses the LARGER endpoint, so a card opened mid-window still counts", () => {
    // Opening balance 0 (the account did not exist yet) but carrying 5,000
    // today. Capping on the opening balance alone would erase every new debt.
    const r = computeDebtService({
      loans: [],
      untrackedLiabilities: [
        card({
          payments: [{ currency: "USD", total: 2000 }],
          owedAtWindowStart: 0,
          owedAtWindowEnd: 5000,
        }),
      ],
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      convert: identity,
    });
    expect(r.realized).toBe(2000);
    expect(r.cappedAccounts).toBe(0);
    expect(r.reliable).toBe(true);
  });

  it("caps PER ACCOUNT so a transactor cannot subsidise a revolver", () => {
    // Aggregating first would let the paid-in-full card's headroom absorb the
    // revolver's excess (or the reverse) and silently mis-state both.
    const r = computeDebtService({
      loans: [],
      untrackedLiabilities: [
        card({
          accountId: 1,
          payments: [{ currency: "USD", total: 6600 }],
          owedAtWindowStart: 0,
          owedAtWindowEnd: 0,
        }),
        card({
          accountId: 2,
          payments: [{ currency: "USD", total: 3000 }],
          owedAtWindowStart: 9000,
          owedAtWindowEnd: 8000,
        }),
      ],
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      convert: identity,
    });
    expect(r.realized).toBe(3000);
    expect(r.cappedAccounts).toBe(1);
  });

  it("treats an account in credit as carrying nothing", () => {
    // An overpaid card has a POSITIVE ledger balance, so the caller hands us a
    // negative "owed"; clamping here too keeps a negative cap from ever turning
    // into negative debt service.
    const r = computeDebtService({
      loans: [],
      untrackedLiabilities: [
        card({
          payments: [{ currency: "USD", total: 500 }],
          owedAtWindowStart: -250,
          owedAtWindowEnd: -250,
        }),
      ],
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      convert: identity,
    });
    expect(r.realized).toBe(0);
    expect(r.total).toBe(0);
  });

  it("converts each source at its own currency's rate (FINLYNQ-123)", () => {
    const rates: Record<string, number> = { USD: 1, EUR: 2 };
    const r = computeDebtService({
      loans: [],
      untrackedLiabilities: [
        card({ accountId: 1, currency: "USD", payments: [{ currency: "USD", total: 100 }] }),
        card({ accountId: 2, currency: "EUR", payments: [{ currency: "EUR", total: 100 }] }),
      ],
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      convert: (amount, cur) => amount * (rates[cur ?? "USD"] ?? 1),
    });
    expect(r.total).toBe(300);
  });

  it("compares payments to the cap in ONE currency, not natively", () => {
    // A EUR card with a EUR balance: converting only one side would make a
    // fully-covered revolver look like a transactor, or the reverse.
    const rates: Record<string, number> = { USD: 1, EUR: 2 };
    const r = computeDebtService({
      loans: [],
      untrackedLiabilities: [
        card({
          currency: "EUR",
          payments: [{ currency: "EUR", total: 100 }],
          owedAtWindowStart: 150,
          owedAtWindowEnd: 150,
        }),
      ],
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      convert: (amount, cur) => amount * (rates[cur ?? "USD"] ?? 1),
    });
    // 200 reporting paid against a 300 reporting cap: uncapped, counted in full.
    expect(r.total).toBe(200);
    expect(r.cappedAccounts).toBe(0);
  });

  it("ignores non-positive and non-finite realized rows", () => {
    const r = computeDebtService({
      loans: [],
      untrackedLiabilities: [
        card({
          payments: [
            { currency: "USD", total: 0 },
            { currency: "USD", total: -50 },
            { currency: "USD", total: Number.NaN },
          ],
        }),
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
      untrackedLiabilities: [],
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      convert: identity,
    });
    expect(r.loansCounted).toBe(0);
    expect(r.total).toBe(0);
  });
});
