import React from "react";
import { render, waitFor } from "@testing-library/react-native";
import DashboardScreen from "../screens/DashboardScreen";
import { endpoints } from "../api/client";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";

// Mock the API client
jest.mock("../api/client", () => ({
  endpoints: {
    getDashboard: jest.fn(),
    getHealthScore: jest.fn(),
    getBudgets: jest.fn(),
  },
}));

const mockDashboardData = {
  netWorth: 50000,
  totalAssets: 80000,
  totalLiabilities: 30000,
  monthlyIncome: 5000,
  monthlyExpenses: 3500,
  savingsRate: 30,
  recentTransactions: [
    {
      id: 1,
      date: "2026-03-15",
      amount: -45.5,
      payee: "Grocery Store",
      note: "",
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
  ],
  accountBalances: [{ name: "Checking", balance: 5000, type: "A", currency: "CAD" }],
};

const mockHealthData = {
  score: 75,
  grade: "Good" as const,
  components: [{ name: "Savings", score: 80, weight: 0.3, weighted: 24, detail: "Good" }],
};

const mockBudgets = [
  {
    id: 1,
    categoryId: 1,
    month: "2026-03",
    amount: 500,
    currency: "CAD",
    categoryName: "Groceries",
    categoryGroup: "Needs",
    convertedAmount: 500,
    convertedSpent: 350,
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

describe("DashboardScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("shows loading indicator initially", () => {
    (endpoints.getDashboard as jest.Mock).mockReturnValue(new Promise(() => {}));
    (endpoints.getHealthScore as jest.Mock).mockReturnValue(new Promise(() => {}));
    (endpoints.getBudgets as jest.Mock).mockReturnValue(new Promise(() => {}));

    const { getByTestId, UNSAFE_queryAllByType } = renderWithTheme(<DashboardScreen />);
    // ActivityIndicator should be present during loading
    const { ActivityIndicator } = require("react-native");
    const indicators = UNSAFE_queryAllByType(ActivityIndicator);
    expect(indicators.length).toBeGreaterThan(0);
  });

  it("renders dashboard data after loading", async () => {
    (endpoints.getDashboard as jest.Mock).mockResolvedValue({
      success: true,
      data: mockDashboardData,
    });
    (endpoints.getHealthScore as jest.Mock).mockResolvedValue({
      success: true,
      data: mockHealthData,
    });
    (endpoints.getBudgets as jest.Mock).mockResolvedValue({
      success: true,
      data: mockBudgets,
    });

    const { getByText } = renderWithTheme(<DashboardScreen />);

    await waitFor(() => {
      expect(getByText("Dashboard")).toBeTruthy();
    });

    await waitFor(() => {
      expect(getByText("Net Worth")).toBeTruthy();
    });
  });

  it("displays health score when available", async () => {
    (endpoints.getDashboard as jest.Mock).mockResolvedValue({
      success: true,
      data: mockDashboardData,
    });
    (endpoints.getHealthScore as jest.Mock).mockResolvedValue({
      success: true,
      data: mockHealthData,
    });
    (endpoints.getBudgets as jest.Mock).mockResolvedValue({
      success: true,
      data: mockBudgets,
    });

    const { getByText } = renderWithTheme(<DashboardScreen />);

    await waitFor(() => {
      expect(getByText("Health Score")).toBeTruthy();
      expect(getByText("75")).toBeTruthy();
      expect(getByText("Good")).toBeTruthy();
    });
  });

  it("shows error message on API failure", async () => {
    (endpoints.getDashboard as jest.Mock).mockResolvedValue({
      success: false,
      error: "Server error",
    });
    (endpoints.getHealthScore as jest.Mock).mockResolvedValue({
      success: false,
      error: "Server error",
    });
    (endpoints.getBudgets as jest.Mock).mockResolvedValue({
      success: false,
      error: "Server error",
    });

    const { getByText } = renderWithTheme(<DashboardScreen />);

    await waitFor(() => {
      expect(getByText("Server error")).toBeTruthy();
    });
  });

  it("shows error when network fails", async () => {
    (endpoints.getDashboard as jest.Mock).mockRejectedValue(new Error("Network error"));
    (endpoints.getHealthScore as jest.Mock).mockRejectedValue(new Error("Network error"));
    (endpoints.getBudgets as jest.Mock).mockRejectedValue(new Error("Network error"));

    const { getByText } = renderWithTheme(<DashboardScreen />);

    await waitFor(() => {
      expect(getByText("Cannot connect to server")).toBeTruthy();
    });
  });

  it("shows recent transactions", async () => {
    (endpoints.getDashboard as jest.Mock).mockResolvedValue({
      success: true,
      data: mockDashboardData,
    });
    (endpoints.getHealthScore as jest.Mock).mockResolvedValue({
      success: true,
      data: mockHealthData,
    });
    (endpoints.getBudgets as jest.Mock).mockResolvedValue({
      success: true,
      data: mockBudgets,
    });

    const { getByText } = renderWithTheme(<DashboardScreen />);

    await waitFor(() => {
      expect(getByText("Recent Transactions")).toBeTruthy();
      expect(getByText("Grocery Store")).toBeTruthy();
      expect(getByText("Salary")).toBeTruthy();
    });
  });

  it("shows budget progress", async () => {
    (endpoints.getDashboard as jest.Mock).mockResolvedValue({
      success: true,
      data: mockDashboardData,
    });
    (endpoints.getHealthScore as jest.Mock).mockResolvedValue({
      success: true,
      data: mockHealthData,
    });
    (endpoints.getBudgets as jest.Mock).mockResolvedValue({
      success: true,
      data: mockBudgets,
    });

    const { getByText } = renderWithTheme(<DashboardScreen />);

    await waitFor(() => {
      expect(getByText("Budget Progress")).toBeTruthy();
      expect(getByText("Groceries")).toBeTruthy();
    });
  });

  it("shows 'No recent transactions' when list is empty", async () => {
    (endpoints.getDashboard as jest.Mock).mockResolvedValue({
      success: true,
      data: { ...mockDashboardData, recentTransactions: [] },
    });
    (endpoints.getHealthScore as jest.Mock).mockResolvedValue({
      success: true,
      data: mockHealthData,
    });
    (endpoints.getBudgets as jest.Mock).mockResolvedValue({
      success: true,
      data: [],
    });

    const { getByText } = renderWithTheme(<DashboardScreen />);

    await waitFor(() => {
      expect(getByText("No recent transactions")).toBeTruthy();
    });
  });
});
