import React from "react";
import { render, waitFor, fireEvent } from "@testing-library/react-native";
import LoanDetailScreen from "../screens/LoanDetailScreen";
import { endpoints } from "../api/client";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import type { LoanSchedule, LoanScheduleRow, LoanSummary } from "../../../shared/types";

jest.mock("../api/client", () => ({
  endpoints: { getLoanSchedule: jest.fn() },
}));

// "Today" is pinned so the split between earlier and upcoming payments is fixed.
jest.mock("../lib/subscriptions", () => ({
  ...jest.requireActual("../lib/subscriptions"),
  localDateISO: () => "2026-03-10",
}));

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};

function loan(over: Partial<LoanSummary> = {}): LoanSummary {
  return {
    id: 9,
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
    remainingBalance: 11000,
    balanceSource: "projection",
    principalPaid: 1000,
    interestPaid: 60,
    periodsRemaining: 22,
    accountId: null,
    accountName: null,
    scheduleMode: "calculated",
    displayCurrency: "USD",
    remainingBalanceDisplay: 11000,
    monthlyEquivalentPaymentDisplay: 531.85,
    ...over,
  };
}

const row = (period: number, date: string, over: Partial<LoanScheduleRow> = {}): LoanScheduleRow => ({
  period,
  date,
  payment: 531.85,
  principal: 471.85,
  interest: 60,
  balance: 12000 - period * 471.85,
  ...over,
});

const schedule = (rows: LoanScheduleRow[], over: Partial<LoanSchedule> = {}): LoanSchedule => ({
  schedule: rows,
  totalInterest: 764.34,
  payoffDate: "2028-01-15",
  scheduleMode: "calculated",
  ...over,
});

const getSchedule = endpoints.getLoanSchedule as jest.Mock;
const goBack = jest.fn();

function screen(l: LoanSummary = loan()) {
  const props = {
    navigation: { goBack },
    route: { params: { loan: l } },
  } as unknown as React.ComponentProps<typeof LoanDetailScreen>;
  return (
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
      <LoanDetailScreen {...props} />
    </ThemeContext.Provider>
  );
}

const fourRows = [
  row(1, "2026-02-15"),
  row(2, "2026-03-15"),
  row(3, "2026-04-15", { interest: 75, interestOverridden: true }),
  row(4, "2026-05-15"),
];

beforeEach(() => jest.clearAllMocks());

describe("LoanDetailScreen", () => {
  it("shows the loan's terms and asks for its own schedule", async () => {
    getSchedule.mockResolvedValue({ success: true, data: schedule(fourRows) });
    const { getByText, findByText } = render(screen());
    expect(await findByText("Payment schedule")).toBeTruthy();
    expect(getByText("Car loan")).toBeTruthy();
    expect(getByText("Auto loan · USD")).toBeTruthy();
    expect(getByText("Monthly payment")).toBeTruthy();
    expect(getByText("6%")).toBeTruthy();
    expect(getByText("2028-01-15")).toBeTruthy();
    // The id is what makes the server apply the loan's own schedule settings.
    expect(getSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ action: "amortization", loanId: 9, principal: 12000, startDate: "2026-01-15" }),
    );
  });

  it("lists the payments still to come and marks the next one", async () => {
    getSchedule.mockResolvedValue({ success: true, data: schedule(fourRows) });
    const { findByText, queryByText, getByText } = render(screen());
    expect(await findByText(/#2 · next/)).toBeTruthy();
    expect(getByText(/#3/)).toBeTruthy();
    expect(getByText(/#4/)).toBeTruthy();
    // The payment already due stays out of the way.
    expect(queryByText(/#1/)).toBeNull();
  });

  it("shows earlier payments when asked", async () => {
    getSchedule.mockResolvedValue({ success: true, data: schedule(fourRows) });
    const { findByText, getByText, queryByText } = render(screen());
    fireEvent.press(await findByText("Show 1 earlier payment"));
    expect(getByText(/#1/)).toBeTruthy();
    fireEvent.press(getByText("Hide earlier payments"));
    expect(queryByText(/#1/)).toBeNull();
  });

  it("marks interest the user set by hand", async () => {
    getSchedule.mockResolvedValue({ success: true, data: schedule(fourRows) });
    const { findByText } = render(screen());
    expect(await findByText(/Interest \$75\.00 \(edited\)/)).toBeTruthy();
  });

  it("says when the schedule is the user's own", async () => {
    getSchedule.mockResolvedValue({ success: true, data: schedule(fourRows, { scheduleMode: "manual" }) });
    const { findByText } = render(screen(loan({ scheduleMode: "manual" })));
    expect(await findByText("Payment schedule · your own")).toBeTruthy();
  });

  // The balance of a linked loan follows its account; the schedule is the plan.
  it("explains a balance that comes from the linked account", async () => {
    getSchedule.mockResolvedValue({ success: true, data: schedule(fourRows) });
    const { findByText, getByText } = render(
      screen(loan({ balanceSource: "account", accountId: 3, accountName: "Auto finance" })),
    );
    expect(await findByText(/comes from the linked account/)).toBeTruthy();
    expect(getByText("Auto finance")).toBeTruthy();
  });

  it("says so when every payment is already in the past", async () => {
    getSchedule.mockResolvedValue({ success: true, data: schedule([row(1, "2026-01-15"), row(2, "2026-02-15")]) });
    const { findByText, getByText } = render(screen());
    expect(await findByText("Every scheduled payment is in the past.")).toBeTruthy();
    expect(getByText("Show 2 earlier payments")).toBeTruthy();
  });

  it("shows the server's message when the schedule cannot be loaded", async () => {
    getSchedule.mockResolvedValue({ success: false, error: "Session locked. Sign in again." });
    const { findByText, getByText } = render(screen());
    expect(await findByText("Session locked. Sign in again.")).toBeTruthy();
    // The loan's own figures are still shown.
    expect(getByText("Car loan")).toBeTruthy();
  });

  it("does not crash on a reply that is not a schedule", async () => {
    getSchedule.mockResolvedValue({ success: true, data: { error: "nope" } });
    const { findByText } = render(screen());
    expect(await findByText("The schedule could not be read.")).toBeTruthy();
  });

  it("goes back to the loans list", async () => {
    getSchedule.mockResolvedValue({ success: true, data: schedule(fourRows) });
    const { getByLabelText, findByText } = render(screen());
    await findByText("Payment schedule");
    fireEvent.press(getByLabelText("Back to loans"));
    expect(goBack).toHaveBeenCalled();
  });
});
