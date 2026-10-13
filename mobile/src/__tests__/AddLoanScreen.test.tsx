import React from "react";
import { render, waitFor, fireEvent, act } from "@testing-library/react-native";
import { Alert } from "react-native";
import AddLoanScreen from "../screens/AddLoanScreen";
import { endpoints } from "../api/client";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import type { LoanSummary } from "../../../shared/types";

const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
// Route params per test: no loan = a new one, a loan = edit it.
let mockRouteParams: { loan?: LoanSummary } | undefined;
jest.mock("@react-navigation/native", () => ({
  ...jest.requireActual("@react-navigation/native"),
  useNavigation: () => ({ goBack: mockGoBack, navigate: mockNavigate }),
  useRoute: () => ({ key: "AddLoan", name: "AddLoan", params: mockRouteParams }),
}));

jest.mock("../api/client", () => ({
  endpoints: {
    getAccounts: jest.fn(),
    getActiveCurrencies: jest.fn(),
    getDisplayCurrency: jest.fn(),
    createLoan: jest.fn(),
    updateLoan: jest.fn(),
    deleteLoan: jest.fn(),
  },
}));

jest.mock("../lib/subscriptions", () => ({
  ...jest.requireActual("../lib/subscriptions"),
  localDateISO: () => "2026-10-13",
}));

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};

const account = (id: number, name: string, currency: string, isInvestment = false) => ({
  id,
  name,
  currency,
  type: "L",
  group: "Loans",
  note: "",
  isInvestment,
});

function loan(over: Partial<LoanSummary> = {}): LoanSummary {
  return {
    id: 9,
    name: "Car loan",
    type: "loan",
    currency: "USD",
    principal: 12000,
    annualRate: 6,
    termMonths: 24,
    startDate: "2026-01-15",
    paymentFrequency: "monthly",
    paymentAmount: null,
    extraPayment: 0,
    residualValue: null,
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
    interestMethod: "rate",
    interestAmount: null,
    ...over,
  };
}

const createLoan = endpoints.createLoan as jest.Mock;
const updateLoan = endpoints.updateLoan as jest.Mock;
const deleteLoan = endpoints.deleteLoan as jest.Mock;
const alert = Alert.alert as jest.Mock;

/** Press a button of the last alert that was shown. */
const pressAlert = async (label: string) => {
  const buttons = alert.mock.calls[alert.mock.calls.length - 1][2] as { text: string; onPress?: () => unknown }[];
  await act(async () => {
    await buttons.find((b) => b.text === label)?.onPress?.();
  });
};

async function renderScreen() {
  const utils = render(
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
      <AddLoanScreen />
    </ThemeContext.Provider>,
  );
  // The currency chips arrive with the first requests.
  await waitFor(() => expect(utils.getByText("EUR")).toBeTruthy());
  return utils;
}

type Utils = Awaited<ReturnType<typeof renderScreen>>;
const fill = (u: Utils, label: string, value: string) => fireEvent.changeText(u.getByLabelText(label), value);

beforeEach(() => {
  jest.clearAllMocks();
  mockRouteParams = undefined;
  (endpoints.getAccounts as jest.Mock).mockResolvedValue({
    success: true,
    data: [account(1, "Auto finance", "USD"), account(2, "Euro mortgage", "EUR"), account(3, "Brokerage", "USD", true)],
  });
  (endpoints.getActiveCurrencies as jest.Mock).mockResolvedValue({ success: true, data: { active: ["USD", "EUR"] } });
  (endpoints.getDisplayCurrency as jest.Mock).mockResolvedValue({ success: true, data: { displayCurrency: "USD" } });
  createLoan.mockResolvedValue({ success: true, data: { id: 21 } });
  updateLoan.mockResolvedValue({ success: true, data: { id: 9 } });
  deleteLoan.mockResolvedValue({ success: true, data: { success: true } });
});

describe("AddLoanScreen: a new loan", () => {
  it("saves a loan in the user's own currency", async () => {
    const u = await renderScreen();
    expect(u.getByText("New loan")).toBeTruthy();
    fill(u, "NAME", "Car loan");
    fill(u, "AMOUNT BORROWED", "12000");
    fill(u, "YEARLY RATE (%)", "6");
    fill(u, "TERM (MONTHS)", "24");
    fireEvent.press(u.getByLabelText("Save"));

    await waitFor(() =>
      expect(createLoan).toHaveBeenCalledWith({
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
      }),
    );
    await waitFor(() => expect(mockGoBack).toHaveBeenCalled());
  });

  it("says what is missing instead of asking the server", async () => {
    const u = await renderScreen();
    fill(u, "NAME", "Car loan");
    fireEvent.press(u.getByLabelText("Save"));
    expect(alert).toHaveBeenCalledWith("Check the form", "Please enter the amount borrowed, greater than 0");
    expect(createLoan).not.toHaveBeenCalled();
  });

  // A loan tracked on a euro account is a euro loan.
  it("takes the currency of the account it is linked to", async () => {
    const u = await renderScreen();
    fill(u, "NAME", "Mortgage");
    fill(u, "AMOUNT BORROWED", "200000");
    fill(u, "YEARLY RATE (%)", "3");
    fill(u, "TERM (MONTHS)", "240");
    fireEvent.press(u.getByLabelText("Linked account"));
    fireEvent.press(u.getByText("Euro mortgage"));
    fireEvent.press(u.getByLabelText("Save"));
    await waitFor(() => expect(createLoan).toHaveBeenCalledWith(expect.objectContaining({ accountId: 2, currency: "EUR" })));
  });

  // Interest is booked on the linked account, which cannot be an investment account.
  it("does not offer an investment account to link", async () => {
    const u = await renderScreen();
    fireEvent.press(u.getByLabelText("Linked account"));
    expect(u.getByText("Auto finance")).toBeTruthy();
    expect(u.queryByText("Brokerage")).toBeNull();
  });

  // "60 payments of 587, 87 of it interest": no rate to give.
  it("takes a fixed interest amount in place of a rate", async () => {
    const u = await renderScreen();
    fill(u, "NAME", "Furniture");
    fill(u, "AMOUNT BORROWED", "30000");
    fill(u, "TERM (MONTHS)", "60");
    fireEvent.press(u.getByText("Fixed amount each payment"));
    expect(u.queryByLabelText("YEARLY RATE (%)")).toBeNull();
    fill(u, "INTEREST EACH PAYMENT", "87");
    fireEvent.press(u.getByLabelText("Save"));
    await waitFor(() =>
      expect(createLoan).toHaveBeenCalledWith(
        expect.objectContaining({ interestMethod: "flat", interestAmount: 87, annualRate: 0 }),
      ),
    );
  });

  it("asks for a lease's buyout, and only for a lease", async () => {
    const u = await renderScreen();
    expect(u.queryByLabelText("BUYOUT AT THE END (OPTIONAL)")).toBeNull();
    fireEvent.press(u.getByText("Lease"));
    expect(u.getByLabelText("BUYOUT AT THE END (OPTIONAL)")).toBeTruthy();
  });

  // The server refuses a payment that never pays the loan off; its words are shown.
  it("shows the server's reason and stays on the form when a loan is refused", async () => {
    createLoan.mockResolvedValue({ success: false, error: "The payment does not cover the interest." });
    const u = await renderScreen();
    fill(u, "NAME", "Car loan");
    fill(u, "AMOUNT BORROWED", "12000");
    fill(u, "YEARLY RATE (%)", "6");
    fill(u, "PAYMENT", "10");
    fireEvent.press(u.getByLabelText("Save"));
    await waitFor(() => expect(alert).toHaveBeenCalledWith("Couldn't save", "The payment does not cover the interest."));
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it("says so when the server cannot be reached", async () => {
    createLoan.mockRejectedValue(new Error("Network request failed"));
    const u = await renderScreen();
    fill(u, "NAME", "Car loan");
    fill(u, "AMOUNT BORROWED", "12000");
    fill(u, "YEARLY RATE (%)", "6");
    fill(u, "TERM (MONTHS)", "24");
    fireEvent.press(u.getByLabelText("Save"));
    await waitFor(() => expect(alert).toHaveBeenCalledWith("Error", "Cannot connect to server"));
    expect(mockGoBack).not.toHaveBeenCalled();
  });
});

describe("AddLoanScreen: changing a loan", () => {
  it("starts from the loan and saves the change to that loan", async () => {
    mockRouteParams = { loan: loan({ accountId: 1, accountName: "Auto finance" }) };
    const u = await renderScreen();
    expect(u.getByText("Edit loan")).toBeTruthy();
    expect(u.getByLabelText("NAME").props.value).toBe("Car loan");
    expect(u.getByLabelText("AMOUNT BORROWED").props.value).toBe("12000");
    await waitFor(() => expect(u.getByText("Auto finance")).toBeTruthy());

    fill(u, "YEARLY RATE (%)", "4.5");
    fireEvent.press(u.getByLabelText("Save"));
    await waitFor(() =>
      expect(updateLoan).toHaveBeenCalledWith(
        expect.objectContaining({ id: 9, name: "Car loan", annualRate: 4.5, accountId: 1, currency: "USD" }),
      ),
    );
    expect(createLoan).not.toHaveBeenCalled();
    await waitFor(() => expect(mockGoBack).toHaveBeenCalled());
  });

  // An existing loan keeps its own currency whatever account it is moved to.
  it("linking another account does not change the loan's currency", async () => {
    mockRouteParams = { loan: loan() };
    const u = await renderScreen();
    fireEvent.press(u.getByLabelText("Linked account"));
    fireEvent.press(u.getByText("Euro mortgage"));
    fireEvent.press(u.getByLabelText("Save"));
    await waitFor(() => expect(updateLoan).toHaveBeenCalledWith(expect.objectContaining({ accountId: 2, currency: "USD" })));
  });

  it("unlinks the account when it is cleared", async () => {
    mockRouteParams = { loan: loan({ accountId: 1, accountName: "Auto finance" }) };
    const u = await renderScreen();
    fireEvent.press(u.getByText("Clear"));
    fireEvent.press(u.getByLabelText("Save"));
    await waitFor(() => expect(updateLoan).toHaveBeenCalledWith(expect.objectContaining({ accountId: null })));
  });

  // The amounts are re-labelled, not converted, so the user is told first.
  it("asks before changing the currency, and says nothing is converted", async () => {
    mockRouteParams = { loan: loan() };
    const u = await renderScreen();
    fireEvent.press(u.getByText("EUR"));
    fireEvent.press(u.getByLabelText("Save"));
    expect(updateLoan).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith(
      "Change the currency to EUR?",
      expect.stringContaining("Nothing is converted."),
      expect.any(Array),
    );
    await pressAlert("Change");
    expect(updateLoan).toHaveBeenCalledWith(expect.objectContaining({ id: 9, currency: "EUR" }));
  });

  it("deletes the loan after asking, and goes back to the list", async () => {
    mockRouteParams = { loan: loan() };
    const u = await renderScreen();
    fireEvent.press(u.getByText("Delete loan"));
    expect(deleteLoan).not.toHaveBeenCalled();
    expect(alert.mock.calls[0][1]).toContain("Its account and your transactions are not affected.");
    await pressAlert("Delete");
    expect(deleteLoan).toHaveBeenCalledWith(9);
    expect(mockNavigate).toHaveBeenCalledWith("Loans");
  });

  it("a new loan has no delete button", async () => {
    const u = await renderScreen();
    expect(u.queryByText("Delete loan")).toBeNull();
  });
});
