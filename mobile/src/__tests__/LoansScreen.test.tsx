import React from "react";
import { render, waitFor, fireEvent } from "@testing-library/react-native";
import LoansScreen from "../screens/LoansScreen";
import {
  buildLoanPayload,
  isLoanCompleted,
  loanFormInit,
  loanPaidPct,
  loanRateLabel,
  loanTotals,
  loanTypeLabel,
  splitLoans,
  splitSchedule,
} from "../lib/loans";
import { endpoints } from "../api/client";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import type { LoanSummary } from "../../../shared/types";

const mockNavigate = jest.fn();
jest.mock("@react-navigation/native", () => ({
  ...jest.requireActual("@react-navigation/native"),
  useIsFocused: jest.fn(() => true),
  useNavigation: () => ({ navigate: mockNavigate }),
}));

jest.mock("../api/client", () => ({
  endpoints: { getLoans: jest.fn() },
}));

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};

function screen() {
  return (
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
      <LoansScreen />
    </ThemeContext.Provider>
  );
}

function loan(over: Partial<LoanSummary>): LoanSummary {
  return {
    id: 1,
    name: "Car loan",
    type: "auto",
    currency: "USD",
    principal: 12000,
    annualRate: 6,
    termMonths: 24,
    startDate: "2026-01-15",
    paymentFrequency: "monthly",
    monthlyPayment: 531.85,
    paymentPerPeriod: 531.85,
    totalInterest: 764.34,
    payoffDate: "2028-01-15",
    remainingBalance: 8000,
    balanceSource: "projection",
    principalPaid: 4000,
    interestPaid: 300,
    periodsRemaining: 16,
    accountId: null,
    accountName: null,
    scheduleMode: "calculated",
    displayCurrency: "USD",
    remainingBalanceDisplay: 8000,
    monthlyEquivalentPaymentDisplay: 531.85,
    ...over,
  };
}

const getLoans = endpoints.getLoans as jest.Mock;
const ok = (data: LoanSummary[]) => ({ success: true, data });

beforeEach(() => jest.clearAllMocks());

describe("isLoanCompleted", () => {
  it("is true once nothing is left to pay", () => {
    expect(isLoanCompleted({ remainingBalance: 0, periodsRemaining: 0, scheduleMode: "calculated" })).toBe(true);
    expect(isLoanCompleted({ remainingBalance: 0.4, periodsRemaining: 3, scheduleMode: "calculated" })).toBe(true);
    expect(isLoanCompleted({ remainingBalance: 5000, periodsRemaining: 0, scheduleMode: "calculated" })).toBe(true);
  });

  it("is false while a balance and periods remain", () => {
    expect(isLoanCompleted({ remainingBalance: 8000, periodsRemaining: 16, scheduleMode: "calculated" })).toBe(false);
  });

  // null <= 0.5 is true in JS; an unscheduled loan must never read as paid off.
  it("is false for a loan the server could not schedule", () => {
    expect(isLoanCompleted({ remainingBalance: null, periodsRemaining: null, scheduleMode: undefined })).toBe(false);
  });

  // A manual schedule is only as long as the rows supplied.
  it("a manual schedule that stops short of payoff is not paid off", () => {
    expect(isLoanCompleted({ remainingBalance: 9487, periodsRemaining: 0, scheduleMode: "manual" })).toBe(false);
    expect(isLoanCompleted({ remainingBalance: 0, periodsRemaining: 0, scheduleMode: "manual" })).toBe(true);
  });
});

describe("loan helpers", () => {
  it("splits active from paid off", () => {
    const { active, completed } = splitLoans([
      loan({ id: 1 }),
      loan({ id: 2, remainingBalance: 0, periodsRemaining: 0 }),
    ]);
    expect(active.map((l) => l.id)).toEqual([1]);
    expect(completed.map((l) => l.id)).toEqual([2]);
  });

  it("works out the share paid, bounded to 0..100", () => {
    expect(loanPaidPct({ principal: 12000, remainingBalance: 8000 })).toBeCloseTo(33.33, 1);
    expect(loanPaidPct({ principal: 12000, remainingBalance: 13000 })).toBe(0);
    expect(loanPaidPct({ principal: 12000, remainingBalance: null })).toBe(0);
    expect(loanPaidPct({ principal: 0, remainingBalance: 0 })).toBe(0);
  });

  // Native amounts are in each loan's own currency; only the display-currency
  // companions may be added together.
  it("totals use the display-currency companions, never the native amounts", () => {
    const totals = loanTotals([
      loan({ currency: "USD", remainingBalance: 8000, remainingBalanceDisplay: 8000, monthlyEquivalentPaymentDisplay: 500 }),
      loan({ currency: "RUB", remainingBalance: 8_000_000, remainingBalanceDisplay: 100_000, monthlyEquivalentPaymentDisplay: 900 }),
    ]);
    expect(totals).toEqual({ owed: 108_000, monthly: 1400 });
  });

  // A loan quoted as a fixed interest amount is not driven by annualRate; the
  // comparable yearly rate is what the server sends and what must be shown.
  it("shows the effective rate for fixed-amount and total-interest loans", () => {
    expect(loanRateLabel({ annualRate: 6, interestMethod: "rate", effectiveAnnualRate: 6, scheduleMode: "calculated" })).toBe("6%");
    expect(loanRateLabel({ annualRate: 0, interestMethod: "flat", effectiveAnnualRate: 6.43, scheduleMode: "calculated" })).toBe("6.43% effective");
    expect(loanRateLabel({ annualRate: 0, interestMethod: "total", effectiveAnnualRate: 6.43, scheduleMode: "calculated" })).toBe("6.43% effective");
    // An older server that does not send the fields yet.
    expect(loanRateLabel({ annualRate: 6, interestMethod: undefined, effectiveAnnualRate: undefined, scheduleMode: undefined })).toBe("6%");
    expect(loanRateLabel({ annualRate: 6, interestMethod: "flat", effectiveAnnualRate: 6.4, scheduleMode: "manual" })).toBe("Manual schedule");
  });

  it("splits a schedule at today; a payment due today is still to come", () => {
    const rows = [{ date: "2026-02-15" }, { date: "2026-03-15" }, { date: "2026-04-15" }];
    expect(splitSchedule(rows, "2026-03-15")).toEqual({
      past: [{ date: "2026-02-15" }],
      upcoming: [{ date: "2026-03-15" }, { date: "2026-04-15" }],
    });
    expect(splitSchedule(rows, "2027-01-01").upcoming).toEqual([]);
    expect(splitSchedule([], "2026-03-15")).toEqual({ past: [], upcoming: [] });
  });

  it("labels loan types, including ones it has no entry for", () => {
    expect(loanTypeLabel("mortgage")).toBe("Mortgage");
    expect(loanTypeLabel("home_equity")).toBe("Home equity");
    expect(loanTypeLabel(null)).toBe("Loan");
  });
});

describe("the loan form", () => {
  const filled = () => ({
    ...loanFormInit(null, "2026-10-13"),
    name: " Car loan ",
    principal: "12000",
    currency: "usd",
    annualRate: "6",
    termMonths: "24",
  });

  it("a new loan starts as a monthly loan on a yearly rate, dated today", () => {
    expect(loanFormInit(null, "2026-10-13")).toMatchObject({
      type: "loan",
      interestMethod: "rate",
      paymentFrequency: "monthly",
      startDate: "2026-10-13",
      accountId: null,
      currency: "",
    });
  });

  // Seeding from the display-currency companions would rewrite the loan in
  // another currency on save.
  it("an edit starts from the loan's own figures, never the display-currency ones", () => {
    const f = loanFormInit(
      loan({
        currency: "RUB",
        principal: 8_116_000,
        remainingBalanceDisplay: 100_000,
        paymentAmount: 75_000,
        extraPayment: 0,
        accountId: 3,
        interestMethod: "flat",
        interestAmount: 87,
      }),
      "2026-10-13",
    );
    expect(f).toMatchObject({
      currency: "RUB",
      principal: "8116000",
      paymentAmount: "75000",
      extraPayment: "",
      accountId: 3,
      interestMethod: "flat",
      interestAmount: "87",
      startDate: "2026-01-15",
    });
  });

  it("builds the request from a filled form", () => {
    expect(buildLoanPayload(filled())).toEqual({
      ok: true,
      body: {
        name: "Car loan",
        type: "loan",
        principal: 12000,
        currency: "USD",
        annualRate: 6,
        interestMethod: "rate",
        interestAmount: null,
        termMonths: 24,
        startDate: "2026-10-13",
        paymentAmount: null,
        paymentFrequency: "monthly",
        extraPayment: 0,
        residualValue: null,
        accountId: null,
      },
    });
  });

  it("says what is missing", () => {
    const err = (over: Partial<ReturnType<typeof filled>>) => {
      const r = buildLoanPayload({ ...filled(), ...over });
      return r.ok ? null : r.error;
    };
    expect(err({ name: "  " })).toBe("Please enter a name");
    expect(err({ principal: "0" })).toMatch(/amount borrowed/);
    expect(err({ currency: "" })).toBe("Please choose a currency");
    expect(err({ annualRate: "" })).toMatch(/yearly rate/);
    expect(err({ termMonths: "", paymentAmount: "" })).toBe("Enter a term in months, or the payment amount");
    expect(err({ termMonths: "24.5" })).toBe("The term must be a whole number of months");
    expect(err({ paymentAmount: "-5" })).toBe("The payment must be greater than 0");
    expect(err({ startDate: "13/10/2026" })).toMatch(/start date/);
    expect(err({ extraPayment: "-1" })).toBe("The extra payment must be 0 or more");
  });

  it("a payment alone is enough: the term is worked out from it", () => {
    const r = buildLoanPayload({ ...filled(), termMonths: "", paymentAmount: "531,85" });
    expect(r.ok && r.body).toMatchObject({ termMonths: null, paymentAmount: 531.85 });
  });

  // A loan quoted as "587 a payment, 87 of it interest" has no rate to give.
  it("a fixed interest amount needs the amount, not a rate", () => {
    const flat = { ...filled(), interestMethod: "flat" as const, annualRate: "", interestAmount: "87" };
    const r = buildLoanPayload(flat);
    expect(r.ok && r.body).toMatchObject({ interestMethod: "flat", interestAmount: 87, annualRate: 0 });
    const missing = buildLoanPayload({ ...flat, interestAmount: "" });
    expect(missing.ok ? null : missing.error).toBe("Please enter the interest in each payment, 0 or more");
    const total = buildLoanPayload({ ...flat, interestMethod: "total", interestAmount: "" });
    expect(total.ok ? null : total.error).toBe("Please enter the loan's total interest, 0 or more");
  });

  it("a buyout only exists for a lease, and must be less than what was borrowed", () => {
    const withBuyout = { ...filled(), residualValue: "4000" };
    const asLoan = buildLoanPayload(withBuyout);
    expect(asLoan.ok && asLoan.body.residualValue).toBeNull();
    const asLease = buildLoanPayload({ ...withBuyout, type: "lease" });
    expect(asLease.ok && asLease.body.residualValue).toBe(4000);
    const tooBig = buildLoanPayload({ ...withBuyout, type: "lease", residualValue: "12000" });
    expect(tooBig.ok ? null : tooBig.error).toBe("The buyout must be less than the amount borrowed");
  });
});

describe("LoansScreen", () => {
  it("opens the form for a new loan", async () => {
    getLoans.mockResolvedValue(ok([loan({})]));
    const { getByLabelText, getByText } = render(screen());
    await waitFor(() => expect(getByText("Car loan")).toBeTruthy());
    fireEvent.press(getByLabelText("Add loan"));
    expect(mockNavigate).toHaveBeenCalledWith("AddLoan");
  });

  it("lists active loans with their balance, payment and end date", async () => {
    getLoans.mockResolvedValue(ok([loan({})]));
    const { getByText, getAllByText, queryByText } = render(screen());
    await waitFor(() => expect(getByText("Car loan")).toBeTruthy());
    // One two-line row (in-app feedback 2026-10-15: with 17 loans, the cards
    // these replaced fitted about three to a screen).
    expect(getAllByText("$8,000")).toHaveLength(2); // the row and the total
    expect(getByText("$531.85/mo · 6%")).toBeTruthy();
    expect(getByText("33% paid · ends 2028-01")).toBeTruthy();
    expect(queryByText(/paid-off/)).toBeNull();
  });

  // In-app feedback: a loan at zero should hide itself, with a button to see it.
  it("keeps paid-off loans hidden until asked for", async () => {
    getLoans.mockResolvedValue(
      ok([loan({ id: 1 }), loan({ id: 2, name: "Old laptop", remainingBalance: 0, periodsRemaining: 0, remainingBalanceDisplay: 0 })]),
    );
    const { getByText, queryByText } = render(screen());
    await waitFor(() => expect(getByText("Car loan")).toBeTruthy());
    expect(queryByText("Old laptop")).toBeNull();

    fireEvent.press(getByText("Show 1 paid-off loan"));
    expect(getByText("Old laptop")).toBeTruthy();
    expect(getByText(/Paid off/)).toBeTruthy();

    fireEvent.press(getByText("Hide paid-off loans"));
    expect(queryByText("Old laptop")).toBeNull();
  });

  it("when every loan is paid off, shows the toggle and no totals", async () => {
    getLoans.mockResolvedValue(ok([loan({ remainingBalance: 0, periodsRemaining: 0 })]));
    const { getByText, queryByText } = render(screen());
    await waitFor(() => expect(getByText("Show 1 paid-off loan")).toBeTruthy());
    expect(queryByText("TOTAL OWED")).toBeNull();
    expect(queryByText("Car loan")).toBeNull();
  });

  it("a loan the server could not schedule stays visible and says what to do", async () => {
    getLoans.mockResolvedValue(
      ok([loan({ remainingBalance: null, periodsRemaining: null, monthlyPayment: null, payoffDate: null, totalInterest: null })]),
    );
    const { getByText } = render(screen());
    await waitFor(() => expect(getByText("Car loan")).toBeTruthy());
    expect(getByText("Could not be scheduled. Tap to fix.")).toBeTruthy();
  });

  it("opens a loan's payment schedule when it is tapped", async () => {
    const car = loan({ id: 4 });
    getLoans.mockResolvedValue(ok([car]));
    const { getByText } = render(screen());
    await waitFor(() => expect(getByText("Car loan")).toBeTruthy());
    fireEvent.press(getByText("Car loan"));
    expect(mockNavigate).toHaveBeenCalledWith("LoanDetail", { loan: car });
  });

  // No schedule exists for it, so there is nothing to show; its form is where
  // it can be put right, or deleted.
  it("a loan the server could not schedule opens its form instead of a schedule", async () => {
    const bad = loan({ remainingBalance: null, periodsRemaining: null, monthlyPayment: null, payoffDate: null, totalInterest: null });
    getLoans.mockResolvedValue(ok([bad]));
    const { getByText } = render(screen());
    await waitFor(() => expect(getByText("Car loan")).toBeTruthy());
    fireEvent.press(getByText("Car loan"));
    expect(mockNavigate).toHaveBeenCalledWith("AddLoan", { loan: bad });
    expect(mockNavigate).not.toHaveBeenCalledWith("LoanDetail", expect.anything());
  });

  it("marks a manual schedule and does not treat a short one as paid off", async () => {
    getLoans.mockResolvedValue(ok([loan({ scheduleMode: "manual", remainingBalance: 9487, periodsRemaining: 0 })]));
    const { getByText, queryByText } = render(screen());
    await waitFor(() => expect(getByText("Car loan")).toBeTruthy());
    expect(getByText("$531.85/mo · Manual schedule")).toBeTruthy();
    expect(queryByText(/paid-off/)).toBeNull();
  });

  it("shows the server's message when the list cannot be loaded", async () => {
    getLoans.mockResolvedValue({ success: false, error: "Not found" });
    const { getByText } = render(screen());
    await waitFor(() => expect(getByText("Not found")).toBeTruthy());
  });

  it("says where to add a loan when there are none", async () => {
    getLoans.mockResolvedValue(ok([]));
    const { getByText } = render(screen());
    await waitFor(() => expect(getByText(/No loans yet/)).toBeTruthy());
  });
});

describe("LoansScreen rows", () => {
  it("say how often a loan is paid", async () => {
    getLoans.mockResolvedValue(ok([loan({ paymentFrequency: "biweekly", paymentPerPeriod: 245.5 })]));
    const { getByText } = render(screen());
    await waitFor(() => expect(getByText("$245.50/2 wk · 6%")).toBeTruthy());
  });

  it("paid-off loans use the same rows once shown", async () => {
    getLoans.mockResolvedValue(
      ok([loan({ id: 1 }), loan({ id: 2, name: "Old laptop", remainingBalance: 0, periodsRemaining: 0, remainingBalanceDisplay: 0 })]),
    );
    const { getByText } = render(screen());
    await waitFor(() => expect(getByText("$531.85/mo · 6%")).toBeTruthy());
    fireEvent.press(getByText("Show 1 paid-off loan"));
    expect(getByText("Paid off · 6%")).toBeTruthy();
    expect(getByText("100% paid")).toBeTruthy();
  });
});
