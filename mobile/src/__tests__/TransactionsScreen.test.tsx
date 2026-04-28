import React from "react";
import { render, waitFor, fireEvent } from "@testing-library/react-native";
import TransactionsScreen from "../screens/TransactionsScreen";
import { endpoints } from "../api/client";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";

jest.mock("../api/client", () => ({
  endpoints: {
    getTransactions: jest.fn(),
    deleteTransaction: jest.fn(),
  },
}));

const mockNavigate = jest.fn();
const mockNavigation = {
  navigate: mockNavigate,
  goBack: jest.fn(),
  dispatch: jest.fn(),
  setOptions: jest.fn(),
  reset: jest.fn(),
  addListener: jest.fn(() => jest.fn()),
} as any;

jest.mock("@react-navigation/native", () => ({
  ...jest.requireActual("@react-navigation/native"),
  useIsFocused: jest.fn(() => true),
}));

const mockTransactions = [
  {
    id: 1,
    date: "2026-03-15",
    amount: -45.5,
    payee: "Grocery Store",
    note: "Weekly groceries",
    currency: "CAD",
    accountId: 1,
    categoryId: 1,
    tags: "",
    quantity: null,
    portfolioHolding: null,
    isBusiness: 0,
    splitPerson: null,
    splitRatio: null,
    importHash: null,
    fitId: null,
  },
  {
    id: 2,
    date: "2026-03-14",
    amount: 3000,
    payee: "Salary",
    note: "",
    currency: "CAD",
    accountId: 1,
    categoryId: 2,
    tags: "",
    quantity: null,
    portfolioHolding: null,
    isBusiness: 0,
    splitPerson: null,
    splitRatio: null,
    importHash: null,
    fitId: null,
  },
];

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};

function renderWithTheme(component: React.ReactElement) {
  return render(
    <ThemeContext.Provider value={theme}>{component}</ThemeContext.Provider>
  );
}

describe("TransactionsScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("shows loading indicator initially", () => {
    (endpoints.getTransactions as jest.Mock).mockReturnValue(new Promise(() => {}));

    const { UNSAFE_queryAllByType } = renderWithTheme(
      <TransactionsScreen navigation={mockNavigation} route={{ params: {} } as any} />
    );
    const { ActivityIndicator } = require("react-native");
    const indicators = UNSAFE_queryAllByType(ActivityIndicator);
    expect(indicators.length).toBeGreaterThan(0);
  });

  it("renders transactions list", async () => {
    (endpoints.getTransactions as jest.Mock).mockResolvedValue({
      success: true,
      data: mockTransactions,
    });

    const { getByText } = renderWithTheme(
      <TransactionsScreen navigation={mockNavigation} route={{ params: {} } as any} />
    );

    await waitFor(() => {
      expect(getByText("Transactions")).toBeTruthy();
      expect(getByText("Grocery Store")).toBeTruthy();
      expect(getByText("Salary")).toBeTruthy();
    });
  });

  it("shows empty state when no transactions", async () => {
    (endpoints.getTransactions as jest.Mock).mockResolvedValue({
      success: true,
      data: [],
    });

    const { getByText } = renderWithTheme(
      <TransactionsScreen navigation={mockNavigation} route={{ params: {} } as any} />
    );

    await waitFor(() => {
      expect(getByText("No transactions yet")).toBeTruthy();
    });
  });

  it("shows error message on failure", async () => {
    (endpoints.getTransactions as jest.Mock).mockResolvedValue({
      success: false,
      error: "Server error",
    });

    const { getByText } = renderWithTheme(
      <TransactionsScreen navigation={mockNavigation} route={{ params: {} } as any} />
    );

    await waitFor(() => {
      expect(getByText("Server error")).toBeTruthy();
    });
  });

  it("shows network error", async () => {
    (endpoints.getTransactions as jest.Mock).mockRejectedValue(new Error("Network error"));

    const { getByText } = renderWithTheme(
      <TransactionsScreen navigation={mockNavigation} route={{ params: {} } as any} />
    );

    await waitFor(() => {
      expect(getByText("Cannot connect to server")).toBeTruthy();
    });
  });

  it("has Add button", async () => {
    (endpoints.getTransactions as jest.Mock).mockResolvedValue({
      success: true,
      data: mockTransactions,
    });

    const { getByText } = renderWithTheme(
      <TransactionsScreen navigation={mockNavigation} route={{ params: {} } as any} />
    );

    await waitFor(() => {
      expect(getByText("+ Add")).toBeTruthy();
    });
  });

  it("navigates to AddTransaction on Add button press", async () => {
    (endpoints.getTransactions as jest.Mock).mockResolvedValue({
      success: true,
      data: mockTransactions,
    });

    const { getByText } = renderWithTheme(
      <TransactionsScreen navigation={mockNavigation} route={{ params: {} } as any} />
    );

    await waitFor(() => {
      expect(getByText("+ Add")).toBeTruthy();
    });

    fireEvent.press(getByText("+ Add"));
    expect(mockNavigate).toHaveBeenCalledWith("AddTransaction");
  });

  it("has search input", async () => {
    (endpoints.getTransactions as jest.Mock).mockResolvedValue({
      success: true,
      data: mockTransactions,
    });

    const { getByPlaceholderText } = renderWithTheme(
      <TransactionsScreen navigation={mockNavigation} route={{ params: {} } as any} />
    );

    await waitFor(() => {
      expect(getByPlaceholderText("Search transactions...")).toBeTruthy();
    });
  });

  it("shows hint text", async () => {
    (endpoints.getTransactions as jest.Mock).mockResolvedValue({
      success: true,
      data: mockTransactions,
    });

    const { getByText } = renderWithTheme(
      <TransactionsScreen navigation={mockNavigation} route={{ params: {} } as any} />
    );

    await waitFor(() => {
      expect(getByText("Tap to view • Long press for actions")).toBeTruthy();
    });
  });
});
