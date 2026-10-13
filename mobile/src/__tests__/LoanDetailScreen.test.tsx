import React from "react";
import { render, waitFor, fireEvent, act } from "@testing-library/react-native";
import { Alert } from "react-native";
import LoanDetailScreen from "../screens/LoanDetailScreen";
import { endpoints } from "../api/client";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import type { LoanScheduleRow, LoanScheduleState, LoanSummary } from "../../../shared/types";

jest.mock("../api/client", () => ({
  endpoints: { getLoanSchedule: jest.fn(), getLoans: jest.fn(), saveLoanSchedule: jest.fn() },
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

const state = (rows: LoanScheduleRow[], over: Partial<LoanScheduleState> = {}): LoanScheduleState => {
  const mode = over.mode ?? "calculated";
  return {
    mode,
    manualSchedule: null,
    interestOverrides: {},
    summary: { schedule: rows, totalInterest: 764.34, payoffDate: "2028-01-15", scheduleMode: mode },
    ...over,
  };
};

const getSchedule = endpoints.getLoanSchedule as jest.Mock;
const getLoans = endpoints.getLoans as jest.Mock;
const saveSchedule = endpoints.saveLoanSchedule as jest.Mock;
const alert = Alert.alert as jest.Mock;
const goBack = jest.fn();
const navigate = jest.fn();

function screen(l: LoanSummary = loan()) {
  const props = {
    navigation: { goBack, navigate },
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
const edited = { interestOverrides: { "2026-04-15": 75 } };
const ok = (s: LoanScheduleState) => ({ success: true, data: s });

/** Press the button of the last confirmation that was asked. */
const confirm = (label: string) => {
  const buttons = alert.mock.calls[alert.mock.calls.length - 1][2] as { text: string; onPress?: () => void }[];
  act(() => {
    buttons.find((b) => b.text === label)?.onPress?.();
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  getLoans.mockResolvedValue({ success: true, data: [] });
});

describe("LoanDetailScreen", () => {
  it("shows the loan's terms and reads the loan's own schedule", async () => {
    getSchedule.mockResolvedValue(ok(state(fourRows)));
    const { getByText, findByText } = render(screen());
    expect(await findByText("Payment schedule")).toBeTruthy();
    expect(getByText("Car loan")).toBeTruthy();
    expect(getByText("Auto loan · USD")).toBeTruthy();
    expect(getByText("$531.85 · monthly")).toBeTruthy();
    expect(getByText("6%")).toBeTruthy();
    expect(getByText("2028-01-15")).toBeTruthy();
    // By id: the server applies the loan's manual schedule, edited interest and
    // interest method, so this is the schedule every other surface shows.
    expect(getSchedule).toHaveBeenCalledWith(9);
  });

  // An edit made on the form has to show when coming back.
  it("shows the loan as the server has it now, not as it was when opened", async () => {
    getSchedule.mockResolvedValue(ok(state(fourRows)));
    getLoans.mockResolvedValue({ success: true, data: [loan({ name: "Truck loan", annualRate: 4.5 })] });
    const { findByText, getByText } = render(screen());
    expect(await findByText("Truck loan")).toBeTruthy();
    expect(getByText("4.5%")).toBeTruthy();
  });

  // "Every 2 weeks payment" read badly; the frequency follows the amount.
  it("puts the payment frequency after the amount, or leaves it out when unknown", async () => {
    getSchedule.mockResolvedValue(ok(state(fourRows)));
    const biweekly = render(screen(loan({ paymentFrequency: "biweekly", paymentPerPeriod: 250 })));
    expect(await biweekly.findByText("$250.00 · every 2 weeks")).toBeTruthy();
    biweekly.unmount();

    const unknown = render(screen(loan({ paymentFrequency: "fortnightly-ish", paymentPerPeriod: 250 })));
    expect(await unknown.findByText("$250.00")).toBeTruthy();
  });

  it("lists the payments still to come and marks the next one", async () => {
    getSchedule.mockResolvedValue(ok(state(fourRows)));
    const { findByText, queryByText, getByText } = render(screen());
    expect(await findByText(/#2 · next/)).toBeTruthy();
    expect(getByText(/#3/)).toBeTruthy();
    expect(getByText(/#4/)).toBeTruthy();
    // The payment already due stays out of the way.
    expect(queryByText(/#1/)).toBeNull();
  });

  it("shows earlier payments when asked", async () => {
    getSchedule.mockResolvedValue(ok(state(fourRows)));
    const { findByText, getByText, queryByText } = render(screen());
    fireEvent.press(await findByText("Show 1 earlier payment"));
    expect(getByText(/#1/)).toBeTruthy();
    fireEvent.press(getByText("Hide earlier payments"));
    expect(queryByText(/#1/)).toBeNull();
  });

  it("marks interest the user set by hand", async () => {
    getSchedule.mockResolvedValue(ok(state(fourRows, edited)));
    const { findByText } = render(screen());
    expect(await findByText(/Interest \$75\.00 \(edited\)/)).toBeTruthy();
  });

  it("says when the schedule is the user's own", async () => {
    getSchedule.mockResolvedValue(ok(state(fourRows, { mode: "manual" })));
    const { findByText } = render(screen(loan({ scheduleMode: "manual" })));
    expect(await findByText("Payment schedule · your own")).toBeTruthy();
  });

  // The balance of a linked loan follows its account; the schedule is the plan.
  it("explains a balance that comes from the linked account", async () => {
    getSchedule.mockResolvedValue(ok(state(fourRows)));
    const { findByText, getByText } = render(
      screen(loan({ balanceSource: "account", accountId: 3, accountName: "Auto finance" })),
    );
    expect(await findByText(/comes from the linked account/)).toBeTruthy();
    expect(getByText("Auto finance")).toBeTruthy();
  });

  it("says so when every payment is already in the past", async () => {
    getSchedule.mockResolvedValue(ok(state([row(1, "2026-01-15"), row(2, "2026-02-15")])));
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
    getSchedule.mockResolvedValue(ok(state(fourRows)));
    const { getByLabelText, findByText } = render(screen());
    await findByText("Payment schedule");
    fireEvent.press(getByLabelText("Back to loans"));
    expect(goBack).toHaveBeenCalled();
  });

  it("opens the loan's form and its interest entries", async () => {
    getSchedule.mockResolvedValue(ok(state(fourRows)));
    const l = loan();
    const { getByLabelText, getByText, findByText } = render(screen(l));
    await findByText("Payment schedule");
    fireEvent.press(getByLabelText("Edit loan"));
    expect(navigate).toHaveBeenCalledWith("AddLoan", { loan: l });
    fireEvent.press(getByText("Interest entries"));
    expect(navigate).toHaveBeenCalledWith("LoanInterest", { loan: l });
  });
});

describe("LoanDetailScreen: changing the schedule", () => {
  // The payment stays what it is; only that payment's interest is replaced.
  it("sets the interest the lender really charged on one payment", async () => {
    getSchedule.mockResolvedValue(ok(state(fourRows)));
    saveSchedule.mockResolvedValue(
      ok(state([fourRows[0], row(2, "2026-03-15", { interest: 82.5, interestOverridden: true }), ...fourRows.slice(2)], {
        interestOverrides: { "2026-03-15": 82.5 },
      })),
    );
    const { findByText, getByLabelText, queryByLabelText } = render(screen());
    await findByText(/#2 · next/);
    fireEvent.press(getByLabelText("Payment on 2026-03-15"));
    // A calculated schedule keeps its payment, so only the interest is asked for.
    expect(queryByLabelText("Payment")).toBeNull();
    fireEvent.changeText(getByLabelText("Interest"), "82,5");
    fireEvent.press(getByLabelText("Save payment"));

    await waitFor(() =>
      expect(saveSchedule).toHaveBeenCalledWith({ loanId: 9, interestOverrides: { "2026-03-15": 82.5 } }),
    );
    expect(await findByText(/Interest \$82\.50 \(edited\)/)).toBeTruthy();
    // The form closes once the server has accepted the change.
    await waitFor(() => expect(queryByLabelText("Interest")).toBeNull());
  });

  it("refuses interest that is not a number of 0 or more, without asking the server", async () => {
    getSchedule.mockResolvedValue(ok(state(fourRows)));
    const { findByText, getByLabelText, getByText } = render(screen());
    await findByText(/#2 · next/);
    fireEvent.press(getByLabelText("Payment on 2026-03-15"));
    fireEvent.changeText(getByLabelText("Interest"), "-4");
    fireEvent.press(getByLabelText("Save payment"));
    expect(getByText("Enter the interest, 0 or more.")).toBeTruthy();
    expect(saveSchedule).not.toHaveBeenCalled();
  });

  it("keeps the form open with the server's message when a change is refused", async () => {
    getSchedule.mockResolvedValue(ok(state(fourRows)));
    saveSchedule.mockResolvedValue({ success: false, error: "The interest is more than the payment." });
    const { findByText, getByLabelText } = render(screen());
    await findByText(/#2 · next/);
    fireEvent.press(getByLabelText("Payment on 2026-03-15"));
    fireEvent.changeText(getByLabelText("Interest"), "900");
    fireEvent.press(getByLabelText("Save payment"));
    expect(await findByText("The interest is more than the payment.")).toBeTruthy();
    expect(getByLabelText("Interest")).toBeTruthy();
  });

  it("puts one payment back to its calculated interest", async () => {
    getSchedule.mockResolvedValue(ok(state(fourRows, edited)));
    saveSchedule.mockResolvedValue(ok(state([...fourRows.slice(0, 2), row(3, "2026-04-15"), fourRows[3]])));
    const { findByText, getByLabelText, getByText } = render(screen());
    await findByText(/\(edited\)/);
    fireEvent.press(getByLabelText("Payment on 2026-04-15"));
    fireEvent.press(getByText("Use the calculated interest"));
    await waitFor(() =>
      expect(saveSchedule).toHaveBeenCalledWith({ loanId: 9, interestOverrides: { "2026-04-15": null } }),
    );
  });

  it("offers to reset every edited payment, and only when there is one", async () => {
    getSchedule.mockResolvedValue(ok(state(fourRows)));
    const none = render(screen());
    await none.findByText("Make this schedule my own");
    expect(none.queryByText(/^Reset/)).toBeNull();
    none.unmount();

    getSchedule.mockResolvedValue(ok(state(fourRows, edited)));
    saveSchedule.mockResolvedValue(ok(state(fourRows)));
    const { findByText } = render(screen());
    fireEvent.press(await findByText("Reset 1 edited payment"));
    await waitFor(() => expect(saveSchedule).toHaveBeenCalledWith({ loanId: 9, clearInterestOverrides: true }));
  });

  // Every row becomes the user's, starting from what is on screen.
  it("makes the schedule the user's own, after asking", async () => {
    getSchedule.mockResolvedValue(ok(state(fourRows)));
    saveSchedule.mockResolvedValue(ok(state(fourRows, { mode: "manual" })));
    const { findByText } = render(screen());
    fireEvent.press(await findByText("Make this schedule my own"));
    // Nothing is sent until the user confirms.
    expect(saveSchedule).not.toHaveBeenCalled();
    confirm("Make it mine");
    await waitFor(() =>
      expect(saveSchedule).toHaveBeenCalledWith({
        loanId: 9,
        manualSchedule: [
          { date: "2026-02-15", payment: 531.85, interest: 60 },
          { date: "2026-03-15", payment: 531.85, interest: 60 },
          { date: "2026-04-15", payment: 531.85, interest: 75 },
          { date: "2026-05-15", payment: 531.85, interest: 60 },
        ],
      }),
    );
    expect(await findByText("Payment schedule · your own")).toBeTruthy();
  });

  it("changes one row of the user's own schedule, leaving the others", async () => {
    getSchedule.mockResolvedValue(ok(state(fourRows, { mode: "manual" })));
    saveSchedule.mockResolvedValue(ok(state(fourRows, { mode: "manual" })));
    const { findByText, getByLabelText } = render(screen(loan({ scheduleMode: "manual" })));
    await findByText("Payment schedule · your own");
    fireEvent.press(getByLabelText("Payment on 2026-03-15"));
    fireEvent.changeText(getByLabelText("Payment"), "600");
    fireEvent.changeText(getByLabelText("Interest"), "55");
    fireEvent.press(getByLabelText("Save payment"));
    await waitFor(() =>
      expect(saveSchedule).toHaveBeenCalledWith({
        loanId: 9,
        manualSchedule: [{ date: "2026-03-15", payment: 600, interest: 55 }],
        mergeRows: true,
      }),
    );
  });

  it("will not save a row whose interest is more than its payment", async () => {
    getSchedule.mockResolvedValue(ok(state(fourRows, { mode: "manual" })));
    const { findByText, getByLabelText, getByText } = render(screen(loan({ scheduleMode: "manual" })));
    await findByText("Payment schedule · your own");
    fireEvent.press(getByLabelText("Payment on 2026-03-15"));
    fireEvent.changeText(getByLabelText("Payment"), "50");
    fireEvent.press(getByLabelText("Save payment"));
    expect(getByText("The interest cannot be more than the payment.")).toBeTruthy();
    expect(saveSchedule).not.toHaveBeenCalled();
  });

  it("goes back to the calculated schedule, after asking", async () => {
    getSchedule.mockResolvedValue(ok(state(fourRows, { mode: "manual" })));
    saveSchedule.mockResolvedValue(ok(state(fourRows)));
    const { findByText } = render(screen(loan({ scheduleMode: "manual" })));
    fireEvent.press(await findByText("Back to the calculated schedule"));
    expect(saveSchedule).not.toHaveBeenCalled();
    confirm("Go back");
    await waitFor(() => expect(saveSchedule).toHaveBeenCalledWith({ loanId: 9, manualSchedule: null }));
    expect(await findByText("Payment schedule")).toBeTruthy();
  });
});
