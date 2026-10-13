import React from "react";
import { render, waitFor, fireEvent } from "@testing-library/react-native";
import LoansScreen from "../screens/LoansScreen";
import {
  isLoanCompleted,
  loanPaidPct,
  loanRateLabel,
  loanScheduleRequest,
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

  // The id is what makes the server apply the loan's own schedule settings.
  it("asks for a schedule with the loan's stored terms and its id", () => {
    expect(loanScheduleRequest(loan({ id: 7, paymentAmount: 550, extraPayment: 25, residualValue: 1000 }))).toEqual({
      action: "amortization",
      loanId: 7,
      principal: 12000,
      annualRate: 6,
      termMonths: 24,
      startDate: "2026-01-15",
      paymentAmount: 550,
      paymentFrequency: "monthly",
      extraPayment: 25,
      residualValue: 1000,
    });
    // An older server's list has none of the optional terms.
    expect(loanScheduleRequest(loan({}))).toMatchObject({ paymentAmount: null, extraPayment: 0, residualValue: null });
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

describe("LoansScreen", () => {
  it("lists active loans with their balance, payment and end date", async () => {
    getLoans.mockResolvedValue(ok([loan({})]));
    const { getByText, queryByText } = render(screen());
    await waitFor(() => expect(getByText("Car loan")).toBeTruthy());
    expect(getByText("Auto loan · 6%")).toBeTruthy();
    expect(getByText(/33% paid of/)).toBeTruthy();
    expect(getByText("2028-01-15")).toBeTruthy();
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
    expect(getByText(/could not be scheduled/)).toBeTruthy();
  });

  it("opens a loan's payment schedule when it is tapped", async () => {
    const car = loan({ id: 4 });
    getLoans.mockResolvedValue(ok([car]));
    const { getByText } = render(screen());
    await waitFor(() => expect(getByText("Car loan")).toBeTruthy());
    fireEvent.press(getByText("Car loan"));
    expect(mockNavigate).toHaveBeenCalledWith("LoanDetail", { loan: car });
  });

  // No schedule exists for it, so there is nothing to open.
  it("a loan the server could not schedule cannot be opened", async () => {
    getLoans.mockResolvedValue(
      ok([loan({ remainingBalance: null, periodsRemaining: null, monthlyPayment: null, payoffDate: null, totalInterest: null })]),
    );
    const { getByText } = render(screen());
    await waitFor(() => expect(getByText("Car loan")).toBeTruthy());
    fireEvent.press(getByText("Car loan"));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("marks a manual schedule and does not treat a short one as paid off", async () => {
    getLoans.mockResolvedValue(ok([loan({ scheduleMode: "manual", remainingBalance: 9487, periodsRemaining: 0 })]));
    const { getByText, queryByText } = render(screen());
    await waitFor(() => expect(getByText("Car loan")).toBeTruthy());
    expect(getByText("Auto loan · Manual schedule")).toBeTruthy();
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
