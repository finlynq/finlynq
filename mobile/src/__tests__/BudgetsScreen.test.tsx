import React from "react";
import { render, waitFor, fireEvent } from "@testing-library/react-native";
import BudgetsScreen from "../screens/BudgetsScreen";
import { endpoints, api } from "../api/client";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";

jest.mock("../api/client", () => ({
  endpoints: {
    getBudgets: jest.fn(),
    getCategories: jest.fn(),
  },
  api: {
    post: jest.fn(),
    delete: jest.fn(),
  },
}));

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
  {
    id: 2,
    categoryId: 2,
    month: "2026-03",
    amount: 200,
    currency: "CAD",
    categoryName: "Entertainment",
    categoryGroup: "Wants",
    convertedAmount: 200,
    convertedSpent: 250,
  },
];

const mockCategories = [
  { id: 1, type: "E", group: "Needs", name: "Groceries", note: "" },
  { id: 2, type: "E", group: "Wants", name: "Entertainment", note: "" },
  { id: 3, type: "E", group: "Needs", name: "Transport", note: "" },
  { id: 4, type: "I", group: "Income", name: "Salary", note: "" },
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

describe("BudgetsScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("shows loading indicator initially", () => {
    (endpoints.getBudgets as jest.Mock).mockReturnValue(new Promise(() => {}));
    (endpoints.getCategories as jest.Mock).mockReturnValue(new Promise(() => {}));

    const { UNSAFE_queryAllByType } = renderWithTheme(<BudgetsScreen />);
    const { ActivityIndicator } = require("react-native");
    const indicators = UNSAFE_queryAllByType(ActivityIndicator);
    expect(indicators.length).toBeGreaterThan(0);
  });

  it("renders budget list", async () => {
    (endpoints.getBudgets as jest.Mock).mockResolvedValue({
      success: true,
      data: mockBudgets,
    });
    (endpoints.getCategories as jest.Mock).mockResolvedValue({
      success: true,
      data: mockCategories,
    });

    const { getByText } = renderWithTheme(<BudgetsScreen />);

    await waitFor(() => {
      expect(getByText("Budgets")).toBeTruthy();
      expect(getByText("Groceries")).toBeTruthy();
      expect(getByText("Entertainment")).toBeTruthy();
    });
  });

  it("shows overall budget summary", async () => {
    (endpoints.getBudgets as jest.Mock).mockResolvedValue({
      success: true,
      data: mockBudgets,
    });
    (endpoints.getCategories as jest.Mock).mockResolvedValue({
      success: true,
      data: mockCategories,
    });

    const { getByText } = renderWithTheme(<BudgetsScreen />);

    await waitFor(() => {
      expect(getByText("Spent")).toBeTruthy();
      expect(getByText("Budgeted")).toBeTruthy();
    });
  });

  it("shows empty state when no budgets", async () => {
    (endpoints.getBudgets as jest.Mock).mockResolvedValue({
      success: true,
      data: [],
    });
    (endpoints.getCategories as jest.Mock).mockResolvedValue({
      success: true,
      data: mockCategories,
    });

    const { getByText } = renderWithTheme(<BudgetsScreen />);

    await waitFor(() => {
      expect(getByText(/No budgets set for/)).toBeTruthy();
    });
  });

  it("has month navigation", async () => {
    (endpoints.getBudgets as jest.Mock).mockResolvedValue({
      success: true,
      data: mockBudgets,
    });
    (endpoints.getCategories as jest.Mock).mockResolvedValue({
      success: true,
      data: mockCategories,
    });

    const { getByText } = renderWithTheme(<BudgetsScreen />);

    await waitFor(() => {
      expect(getByText("← Prev")).toBeTruthy();
      expect(getByText("Next →")).toBeTruthy();
    });
  });

  it("shows over budget indicator", async () => {
    (endpoints.getBudgets as jest.Mock).mockResolvedValue({
      success: true,
      data: mockBudgets,
    });
    (endpoints.getCategories as jest.Mock).mockResolvedValue({
      success: true,
      data: mockCategories,
    });

    const { getByText } = renderWithTheme(<BudgetsScreen />);

    await waitFor(() => {
      // Entertainment is over budget (250 spent of 200)
      expect(getByText("$50 over budget")).toBeTruthy();
    });
  });

  it("shows remaining amount for under-budget items", async () => {
    (endpoints.getBudgets as jest.Mock).mockResolvedValue({
      success: true,
      data: mockBudgets,
    });
    (endpoints.getCategories as jest.Mock).mockResolvedValue({
      success: true,
      data: mockCategories,
    });

    const { getByText } = renderWithTheme(<BudgetsScreen />);

    await waitFor(() => {
      // Groceries: 500 - 350 = 150 remaining
      expect(getByText("$150 remaining")).toBeTruthy();
    });
  });

  it("has Add button", async () => {
    (endpoints.getBudgets as jest.Mock).mockResolvedValue({
      success: true,
      data: mockBudgets,
    });
    (endpoints.getCategories as jest.Mock).mockResolvedValue({
      success: true,
      data: mockCategories,
    });

    const { getByText } = renderWithTheme(<BudgetsScreen />);

    await waitFor(() => {
      expect(getByText("+ Add")).toBeTruthy();
    });
  });

  it("shows add form when Add is pressed", async () => {
    (endpoints.getBudgets as jest.Mock).mockResolvedValue({
      success: true,
      data: mockBudgets,
    });
    (endpoints.getCategories as jest.Mock).mockResolvedValue({
      success: true,
      data: mockCategories,
    });

    const { getByText } = renderWithTheme(<BudgetsScreen />);

    await waitFor(() => {
      expect(getByText("+ Add")).toBeTruthy();
    });

    fireEvent.press(getByText("+ Add"));

    await waitFor(() => {
      expect(getByText("New Budget")).toBeTruthy();
      expect(getByText("Add Budget")).toBeTruthy();
      // Transport should show as unbudgeted expense category
      expect(getByText("Transport")).toBeTruthy();
    });
  });

  it("shows hint text for long press", async () => {
    (endpoints.getBudgets as jest.Mock).mockResolvedValue({
      success: true,
      data: mockBudgets,
    });
    (endpoints.getCategories as jest.Mock).mockResolvedValue({
      success: true,
      data: mockCategories,
    });

    const { getByText } = renderWithTheme(<BudgetsScreen />);

    await waitFor(() => {
      expect(getByText("Long press a budget to edit or delete")).toBeTruthy();
    });
  });
});
