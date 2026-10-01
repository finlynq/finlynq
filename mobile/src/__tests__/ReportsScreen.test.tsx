import React from "react";
import { render, waitFor, fireEvent, act } from "@testing-library/react-native";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import ReportsScreen from "../screens/ReportsScreen";
import { endpoints } from "../api/client";
import type { IncomeStatement, BalanceSheet } from "../../../shared/types";

jest.mock("../api/client", () => ({
  endpoints: { getIncomeStatement: jest.fn(), getBalanceSheet: jest.fn() },
}));

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};

function renderWithTheme(el: React.ReactElement) {
  return render(
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
      {el}
    </ThemeContext.Provider>
  );
}

const income: IncomeStatement = {
  type: "income-statement",
  displayCurrency: "CAD",
  period: { startDate: "2026-01-01", endDate: "2026-06-02" },
  income: [
    { categoryId: 1, categoryType: "I", categoryGroup: "Income", categoryName: "Salary", total: 5000, count: 2 },
  ],
  expenses: [
    { categoryId: 2, categoryType: "E", categoryGroup: "Food", categoryName: "Groceries", total: 1200, count: 8 },
  ],
  totalIncome: 5000,
  totalExpenses: 1200,
  netSavings: 3800,
  savingsRate: 76,
  unrealized: {
    totals: { costBasis: 0, marketValue: 0, valuationGL: 0, fxGL: 0, totalGL: 0 },
    accounts: [],
  },
};

const balance: BalanceSheet = {
  type: "balance-sheet",
  displayCurrency: "CAD",
  date: "2026-06-02",
  assets: [
    {
      accountId: 1, accountType: "A", accountGroup: "Cash", accountName: "Chequing",
      currency: "CAD", balance: 10000, convertedBalance: 10000, displayCurrency: "CAD",
    },
  ],
  liabilities: [
    {
      accountId: 2, accountType: "L", accountGroup: "Cards", accountName: "Visa",
      currency: "CAD", balance: 2000, convertedBalance: 2000, displayCurrency: "CAD",
    },
  ],
  totalAssets: 10000,
  totalLiabilities: 2000,
  netWorth: 8000,
};

describe("ReportsScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (endpoints.getIncomeStatement as jest.Mock).mockResolvedValue({ success: true, data: income });
    (endpoints.getBalanceSheet as jest.Mock).mockResolvedValue({ success: true, data: balance });
  });

  it("renders the summary grid, net worth and detail links from the fixtures", async () => {
    const { findByText, getByText } = renderWithTheme(<ReportsScreen />);
    // Async fetch resolves → summary + net worth render.
    expect(await findByText("Savings rate")).toBeTruthy();
    expect(getByText("76%")).toBeTruthy();
    // The balance sheet is always current balances, and says so.
    expect(getByText("Net worth · today")).toBeTruthy();
    expect(getByText("Income statement")).toBeTruthy();
    expect(getByText("Balance sheet")).toBeTruthy();
  });

  it("shows an inline error per card when both report fetches fail", async () => {
    (endpoints.getIncomeStatement as jest.Mock).mockResolvedValue({ success: false, error: "Unauthorized" });
    (endpoints.getBalanceSheet as jest.Mock).mockResolvedValue({ success: false, error: "Unauthorized" });
    const { findByText, getByText } = renderWithTheme(<ReportsScreen />);
    await waitFor(() => expect(endpoints.getIncomeStatement).toHaveBeenCalled());
    expect(await findByText("Couldn't load the summary: Unauthorized")).toBeTruthy();
    expect(getByText("Couldn't load net worth: Unauthorized")).toBeTruthy();
    // The links stay usable even when both cards failed.
    expect(getByText("Income statement")).toBeTruthy();
  });

  it("keeps the other card when only one fetch fails", async () => {
    (endpoints.getBalanceSheet as jest.Mock).mockResolvedValue({ success: false, error: "Server error" });
    const { findByText, getByText, queryByText } = renderWithTheme(<ReportsScreen />);
    expect(await findByText("Couldn't load net worth: Server error")).toBeTruthy();
    expect(getByText("76%")).toBeTruthy();
    expect(queryByText("Couldn't load the summary", { exact: false })).toBeNull();
  });

  it("treats a thrown fetch as a card error instead of crashing", async () => {
    (endpoints.getIncomeStatement as jest.Mock).mockRejectedValue(new Error("boom"));
    const { findByText, getByText } = renderWithTheme(<ReportsScreen />);
    expect(await findByText("Couldn't load the summary: Cannot connect to server")).toBeTruthy();
    expect(getByText("Net worth · today")).toBeTruthy();
  });

  it("shows '—' (not a green 0%) for the savings rate when there is no income", async () => {
    (endpoints.getIncomeStatement as jest.Mock).mockResolvedValue({
      success: true,
      data: { ...income, totalIncome: 0, netSavings: -1200, savingsRate: 0 },
    });
    const { findByText, getByText, queryByText } = renderWithTheme(<ReportsScreen />);
    expect(await findByText("Savings rate")).toBeTruthy();
    expect(getByText("—")).toBeTruthy();
    expect(queryByText("0%")).toBeNull();
  });

  it("asks the balance sheet for today and labels it as current", async () => {
    const { findByText } = renderWithTheme(<ReportsScreen />);
    expect(await findByText("Net worth · today")).toBeTruthy();
    const arg = (endpoints.getBalanceSheet as jest.Mock).mock.calls[0][0];
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    expect(arg.endDate).toBe(today);
  });

  it("drops a slower response from a previous range so it can't overwrite the newer one", async () => {
    // First (YTD) request hangs until we release it; the MTD one answers at once.
    let releaseStale: (v: unknown) => void = () => {};
    const stale = new Promise((resolve) => {
      releaseStale = resolve;
    });
    (endpoints.getIncomeStatement as jest.Mock)
      .mockReturnValueOnce(stale)
      .mockResolvedValue({ success: true, data: { ...income, savingsRate: 76 } });

    const { getByText, findByText, queryByText } = renderWithTheme(<ReportsScreen />);
    await waitFor(() => expect(endpoints.getIncomeStatement).toHaveBeenCalledTimes(1));

    fireEvent.press(getByText("MTD"));
    expect(await findByText("76%")).toBeTruthy();

    // The stale YTD answer arrives late — it must be ignored.
    await act(async () => {
      releaseStale({ success: true, data: { ...income, savingsRate: 11 } });
      await stale;
    });
    expect(getByText("76%")).toBeTruthy();
    expect(queryByText("11%")).toBeNull();
  });
});
