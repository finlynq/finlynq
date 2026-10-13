import React from "react";
import { render, waitFor, fireEvent, act } from "@testing-library/react-native";
import { Alert } from "react-native";
import LoanInterestScreen from "../screens/LoanInterestScreen";
import { endpoints } from "../api/client";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import type {
  LoanInterestEntry,
  LoanInterestState,
  LoanScheduleRow,
  LoanScheduleState,
  LoanSummary,
} from "../../../shared/types";

jest.mock("../api/client", () => ({
  endpoints: {
    getLoanSchedule: jest.fn(),
    getLoanInterest: jest.fn(),
    getCategories: jest.fn(),
    setLoanInterestCategory: jest.fn(),
    postLoanInterest: jest.fn(),
    updateLoan: jest.fn(),
  },
}));

jest.mock("../lib/subscriptions", () => ({
  ...jest.requireActual("../lib/subscriptions"),
  localDateISO: () => "2026-10-12",
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
    type: "loan",
    currency: "USD",
    principal: 12000,
    annualRate: 6,
    termMonths: 24,
    startDate: "2026-07-01",
    paymentFrequency: "monthly",
    monthlyPayment: 531.85,
    paymentPerPeriod: 531.85,
    totalInterest: 764.34,
    payoffDate: "2028-07-01",
    remainingBalance: 11000,
    balanceSource: "account",
    principalPaid: 1000,
    interestPaid: 60,
    periodsRemaining: 22,
    accountId: 3,
    accountName: "Auto finance",
    scheduleMode: "calculated",
    interestMethod: "rate",
    ...over,
  };
}

const row = (period: number, date: string, interest: number): LoanScheduleRow => ({
  period,
  date,
  payment: 531.85,
  principal: 531.85 - interest,
  interest,
  balance: 12000 - period * 450,
});

// Three payments have come due by "today" (2026-10-12); the fourth is next.
const rows = [
  row(1, "2026-08-01", 90),
  row(2, "2026-09-01", 88.5),
  row(3, "2026-10-01", 87),
  row(4, "2026-11-01", 85.4),
];

const schedule = (r: LoanScheduleRow[] = rows, mode: "calculated" | "manual" = "calculated") => ({
  success: true,
  data: {
    mode,
    manualSchedule: null,
    interestOverrides: {},
    summary: { schedule: r, totalInterest: 764.34, payoffDate: "2028-07-01", scheduleMode: mode },
  } as LoanScheduleState,
});

const interest = (categoryId: number | null, entries: LoanInterestEntry[] = []) => ({
  success: true,
  data: { accountId: 3, interestCategoryId: categoryId, categoryId, entries } as LoanInterestState,
});
const tx = (transactionId: number, date: string, amount: number): LoanInterestEntry => ({ transactionId, date, amount });

const getSchedule = endpoints.getLoanSchedule as jest.Mock;
const getInterest = endpoints.getLoanInterest as jest.Mock;
const setCategory = endpoints.setLoanInterestCategory as jest.Mock;
const postInterest = endpoints.postLoanInterest as jest.Mock;
const updateLoan = endpoints.updateLoan as jest.Mock;
const alert = Alert.alert as jest.Mock;
const goBack = jest.fn();
const navigate = jest.fn();

function screen(l: LoanSummary = loan()) {
  const props = {
    navigation: { goBack, navigate },
    route: { params: { loan: l } },
  } as unknown as React.ComponentProps<typeof LoanInterestScreen>;
  return (
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
      <LoanInterestScreen {...props} />
    </ThemeContext.Provider>
  );
}

const pressAlert = async (label: string) => {
  const buttons = alert.mock.calls[alert.mock.calls.length - 1][2] as { text: string; onPress?: () => unknown }[];
  await act(async () => {
    await buttons.find((b) => b.text === label)?.onPress?.();
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  getSchedule.mockResolvedValue(schedule());
  getInterest.mockResolvedValue(interest(40, [tx(1, "2026-08-01", -90)]));
  (endpoints.getCategories as jest.Mock).mockResolvedValue({
    success: true,
    data: [
      { id: 40, type: "E", group: "Debt", name: "Loan interest", note: "" },
      { id: 41, type: "E", group: "Bills", name: "Bank fees", note: "" },
      { id: 50, type: "I", group: "Income", name: "Salary", note: "" },
    ],
  });
  setCategory.mockResolvedValue({ success: true, data: { interestCategoryId: 41 } });
  postInterest.mockResolvedValue({ success: true, data: { created: [{ periodDate: "2026-09-01" }] } });
  updateLoan.mockResolvedValue({ success: true, data: { id: 9 } });
});

describe("LoanInterestScreen", () => {
  it("shows each payment's calculated interest beside what is booked", async () => {
    const { findByText, getByText, getAllByText } = render(screen());
    expect(await findByText("Loan interest")).toBeTruthy();
    expect(getByText("Booked $90.00")).toBeTruthy();
    expect(getByText("Calculated $88.50")).toBeTruthy();
    expect(getAllByText("Not booked")).toHaveLength(2);
    // The next payment is listed too, marked as not due yet.
    expect(getByText("Not due yet")).toBeTruthy();
    expect(getSchedule).toHaveBeenCalledWith(9);
    expect(getInterest).toHaveBeenCalledWith(9);
  });

  // Interest the lender charged that differs from the schedule is worth seeing.
  it("says how far a booked amount is from the calculated one", async () => {
    getInterest.mockResolvedValue(interest(40, [tx(1, "2026-08-01", -95.25)]));
    const { findByText } = render(screen());
    expect(await findByText("$5.25 more than calculated")).toBeTruthy();
  });

  it("books one payment's interest, with the amount the lender charged", async () => {
    const { findByLabelText, getByLabelText, findByText } = render(screen());
    fireEvent.press(await findByLabelText("Book interest for 2026-09-01"));
    // The form starts from what the schedule calculates.
    expect(getByLabelText("Interest amount").props.value).toBe("88.5");
    fireEvent.changeText(getByLabelText("Interest amount"), "91,20");
    fireEvent.press(getByLabelText("Book interest"));
    await waitFor(() =>
      expect(postInterest).toHaveBeenCalledWith(9, 40, [{ periodDate: "2026-09-01", amount: 91.2 }]),
    );
    expect(await findByText("Booked 1 interest entry.")).toBeTruthy();
    // What the ledger has now is read again.
    expect(getInterest).toHaveBeenCalledTimes(2);
  });

  it("refuses an amount under a cent without asking the server", async () => {
    const { findByLabelText, getByLabelText, getByText } = render(screen());
    fireEvent.press(await findByLabelText("Book interest for 2026-09-01"));
    fireEvent.changeText(getByLabelText("Interest amount"), "0");
    fireEvent.press(getByLabelText("Book interest"));
    expect(getByText("Enter the interest, at least 0.01.")).toBeTruthy();
    expect(postInterest).not.toHaveBeenCalled();
  });

  // The server refuses a payment already booked, or interest as the first
  // entry on an empty account; its words are shown where the user is looking.
  it("keeps the form open with the server's reason when a booking is refused", async () => {
    postInterest.mockResolvedValue({ success: false, error: "Interest for 2026-09-01 is already booked." });
    const { findByLabelText, getByLabelText, findByText } = render(screen());
    fireEvent.press(await findByLabelText("Book interest for 2026-09-01"));
    fireEvent.press(getByLabelText("Book interest"));
    expect(await findByText("Interest for 2026-09-01 is already booked.")).toBeTruthy();
    expect(getByLabelText("Interest amount")).toBeTruthy();
  });

  it("books everything that has come due in one go, after asking", async () => {
    postInterest.mockResolvedValue({ success: true, data: { created: [{}, {}] } });
    const { findByText } = render(screen());
    fireEvent.press(await findByText("Book 2 due entries ($175.50)"));
    expect(postInterest).not.toHaveBeenCalled();
    expect(alert.mock.calls[0][0]).toBe("Book 2 interest entries?");
    expect(alert.mock.calls[0][1]).toContain("$175.50 of interest is added to Auto finance");
    await pressAlert("Book");
    expect(postInterest).toHaveBeenCalledWith(9, 40, [
      { periodDate: "2026-09-01", amount: 88.5 },
      { periodDate: "2026-10-01", amount: 87 },
    ]);
    expect(await findByText("Booked 2 interest entries.")).toBeTruthy();
  });

  // A lender often posts interest a day or two before the payment date.
  it("lets the next payment be booked ahead of its date, but not as part of what is due", async () => {
    const { findByLabelText, getByLabelText } = render(screen());
    fireEvent.press(await findByLabelText("Book interest for 2026-11-01"));
    fireEvent.press(getByLabelText("Book interest"));
    await waitFor(() =>
      expect(postInterest).toHaveBeenCalledWith(9, 40, [{ periodDate: "2026-11-01", amount: 85.4 }]),
    );
  });

  it("with no category yet, asks for one and offers nothing to book", async () => {
    getInterest.mockResolvedValue(interest(null));
    const { findByText, getAllByText, queryByText, queryByLabelText } = render(screen());
    expect(await findByText("Pick an expense category")).toBeTruthy();
    expect(getAllByText("Pick a category to see").length).toBeGreaterThan(0);
    expect(queryByText(/^Book \d+ due/)).toBeNull();
    expect(queryByLabelText("Book interest for 2026-09-01")).toBeNull();
  });

  it("offers expense categories only, and remembers the one picked", async () => {
    getInterest.mockResolvedValue(interest(null));
    const { findByLabelText, getByText, queryByText } = render(screen());
    fireEvent.press(await findByLabelText("Interest category"));
    expect(queryByText("Salary")).toBeNull();
    getInterest.mockResolvedValue(interest(41));
    fireEvent.press(getByText("Bank fees"));
    await waitFor(() => expect(setCategory).toHaveBeenCalledWith(9, 41));
    await waitFor(() => expect(getInterest).toHaveBeenCalledTimes(2));
  });

  it("a new category can be made from here", async () => {
    const { findByText } = render(screen());
    fireEvent.press(await findByText("New"));
    expect(navigate).toHaveBeenCalledWith("AddCategory");
  });

  // Interest is booked on the loan's account, so there has to be one.
  it("a loan with no linked account says so and leads to linking one", async () => {
    const unlinked = loan({ accountId: null, accountName: null });
    const { findByText, queryByText } = render(screen(unlinked));
    fireEvent.press(await findByText("Link an account"));
    expect(navigate).toHaveBeenCalledWith("AddLoan", { loan: unlinked });
    expect(queryByText("Interest category")).toBeNull();
  });

  it("shows the server's message when the entries cannot be loaded", async () => {
    getInterest.mockResolvedValue({ success: false, error: "Session locked. Sign in again." });
    const { findByText, queryByText } = render(screen());
    expect(await findByText("Session locked. Sign in again.")).toBeTruthy();
    expect(queryByText("Payments")).toBeNull();
  });

  it("says when an entry falls outside the schedule and is not counted", async () => {
    getInterest.mockResolvedValue(interest(40, [tx(1, "2026-08-01", -90), tx(2, "2024-01-15", -50)]));
    const { findByText } = render(screen());
    expect(await findByText(/1 interest entry on this account falls outside the schedule's dates/)).toBeTruthy();
  });
});

describe("LoanInterestScreen: booked against calculated", () => {
  // The lender charged double on the last three payments.
  const doubled = [tx(1, "2026-08-01", -180), tx(2, "2026-09-01", -177), tx(3, "2026-10-01", -174)];

  it("says nothing until two recent payments are booked", async () => {
    const { findByText, queryByText } = render(screen());
    await findByText("Booked $90.00");
    expect(queryByText(/Your lender charged/)).toBeNull();
  });

  // The owner's rule: the comparison names the payments it is based on.
  it("names the payments compared, and suggests the rate that explains them", async () => {
    getInterest.mockResolvedValue(interest(40, doubled));
    const { findByText, getByText } = render(screen());
    expect(await findByText("Your lender charged more than this schedule calculates.")).toBeTruthy();
    expect(getByText(/Over your last 3 booked payments \(2026-08-01 to 2026-10-01\)/)).toBeTruthy();
    expect(getByText(/A rate of about 12% would produce what was charged\. The loan is set to 6%\./)).toBeTruthy();
    expect(getByText(/Only the 3 most recent booked payments from the last 12 months are compared/)).toBeTruthy();
  });

  // A suggestion is never applied on its own.
  it("changes the rate only when the user says so", async () => {
    getInterest.mockResolvedValue(interest(40, doubled));
    const { findByText } = render(screen());
    fireEvent.press(await findByText("Use 12%"));
    expect(updateLoan).not.toHaveBeenCalled();
    expect(alert.mock.calls[0][0]).toBe("Change the rate to 12%?");
    expect(alert.mock.calls[0][1]).toContain("Interest and payments already booked are not changed.");
    await pressAlert("Use 12%");
    expect(updateLoan).toHaveBeenCalledWith({ id: 9, annualRate: 12 });
    expect(await findByText("The loan's rate is now 12%.")).toBeTruthy();
  });

  // A schedule the user wrote is not worked out from a rate, so none is offered.
  it("compares a manual schedule too, without suggesting a rate", async () => {
    getSchedule.mockResolvedValue(schedule(rows, "manual"));
    getInterest.mockResolvedValue(interest(40, doubled));
    const { findByText, queryByText } = render(screen(loan({ scheduleMode: "manual" })));
    expect(await findByText("Your lender charged more than this schedule calculates.")).toBeTruthy();
    expect(queryByText(/^Use \d/)).toBeNull();
    expect(queryByText(/A rate of about/)).toBeNull();
  });

  it("a loan with a fixed interest amount gets no rate suggestion either", async () => {
    getInterest.mockResolvedValue(interest(40, doubled));
    const { findByText, queryByText } = render(screen(loan({ interestMethod: "flat", annualRate: 0 })));
    expect(await findByText("Your lender charged more than this schedule calculates.")).toBeTruthy();
    expect(queryByText(/^Use \d/)).toBeNull();
  });
});
