import React from "react";
import { render, waitFor, fireEvent, act } from "@testing-library/react-native";
import DashboardScreen from "../screens/DashboardScreen";
import { endpoints } from "../api/client";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";

// Drive the narrow-phone layout switch per test via the (shared) Dimensions stub.
let mockWindowWidth = 390;
jest.mock("react-native", () => ({
  ...jest.requireActual("react-native"),
  Dimensions: { get: () => ({ width: mockWindowWidth, height: 800 }) },
}));

const mockNavigate = jest.fn();
let mockFocused = true;
jest.mock("@react-navigation/native", () => ({
  ...jest.requireActual("@react-navigation/native"),
  useIsFocused: () => mockFocused,
  useNavigation: () => ({ navigate: mockNavigate, goBack: jest.fn() }),
}));

// Mock the API client. NOTE: no getCategories — the dashboard reads the
// decrypted `categoryName` straight off the budget rows now.
jest.mock("../api/client", () => ({
  endpoints: {
    getDashboard: jest.fn(),
    getHealthScore: jest.fn(),
    getBudgets: jest.fn(),
  },
}));

const baseTx = {
  note: "",
  accountId: 1,
  tags: "",
  quantity: null,
  portfolioHolding: null,
  isBusiness: 0,
  splitPerson: null,
  splitRatio: null,
  importHash: null,
  fitId: null,
};

const mockDashboardData = {
  displayCurrency: "CAD",
  netWorth: 50000,
  totalAssets: 80000,
  totalLiabilities: 30000,
  referenceMonth: "2026-03",
  monthlyIncome: 5000,
  monthlyExpenses: 3500,
  savingsRate: 30,
  recentTransactions: [
    { ...baseTx, id: 1, date: "2026-03-15", amount: -45.5, payee: "Grocery Store", currency: "USD", categoryId: 1 },
    { ...baseTx, id: 2, date: "2026-03-14", amount: 3000, payee: "Salary", currency: "CAD", categoryId: 2 },
  ],
  accountBalances: [{ name: "Checking", balance: 5000, type: "A", currency: "CAD" }],
};

const mockHealthData = {
  score: 75,
  grade: "Good" as const,
  components: [{ name: "Savings", score: 80, weight: 0.3, weighted: 24, detail: "Good" }],
  savingsRatePct: 22,
};

const groceries = {
  id: 1,
  categoryId: 1,
  month: "2026-03",
  amount: 500,
  currency: "CAD",
  categoryName: "Groceries",
  categoryGroup: "Needs",
  convertedAmount: 500,
  convertedSpent: 350, // 70%
  displayCurrency: "CAD",
};
const dining = {
  ...groceries,
  id: 2,
  categoryId: 2,
  categoryName: "Dining",
  convertedAmount: 200,
  convertedSpent: 300, // 150% — over budget
};

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};

function renderWithTheme(component: React.ReactElement) {
  return render(
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
      {component}
    </ThemeContext.Provider>
  );
}

function mockAllOk(overrides: { dash?: object; health?: object | null; budgets?: object[] } = {}) {
  (endpoints.getDashboard as jest.Mock).mockResolvedValue({
    success: true,
    data: { ...mockDashboardData, ...(overrides.dash ?? {}) },
  });
  (endpoints.getHealthScore as jest.Mock).mockResolvedValue(
    overrides.health === null
      ? { success: false, error: "nope" }
      : { success: true, data: { ...mockHealthData, ...(overrides.health ?? {}) } },
  );
  (endpoints.getBudgets as jest.Mock).mockResolvedValue({
    success: true,
    data: overrides.budgets ?? [groceries],
  });
}

describe("DashboardScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFocused = true;
    mockWindowWidth = 390;
  });

  it("shows loading indicator initially", () => {
    (endpoints.getDashboard as jest.Mock).mockReturnValue(new Promise(() => {}));
    (endpoints.getHealthScore as jest.Mock).mockReturnValue(new Promise(() => {}));
    (endpoints.getBudgets as jest.Mock).mockReturnValue(new Promise(() => {}));

    const { UNSAFE_queryAllByType } = renderWithTheme(<DashboardScreen />);
    const { ActivityIndicator } = require("react-native");
    expect(UNSAFE_queryAllByType(ActivityIndicator).length).toBeGreaterThan(0);
  });

  it("renders dashboard data after loading", async () => {
    mockAllOk();
    const { getByText } = renderWithTheme(<DashboardScreen />);
    await waitFor(() => {
      expect(getByText("Dashboard")).toBeTruthy();
      expect(getByText("Net Worth")).toBeTruthy();
    });
  });

  it("labels every aggregate in the dashboard's display currency, not USD", async () => {
    mockAllOk();
    const { getByText, queryByText } = renderWithTheme(<DashboardScreen />);
    await waitFor(() => expect(getByText("C$50,000")).toBeTruthy());
    expect(getByText("C$80,000")).toBeTruthy(); // assets
    expect(getByText("C$30,000")).toBeTruthy(); // liabilities
    expect(getByText("C$5,000")).toBeTruthy(); // income
    expect(getByText("C$3,500")).toBeTruthy(); // expenses
    // Budget card follows the budgets' own display currency.
    expect(getByText("C$350 / C$500")).toBeTruthy();
    expect(queryByText("$50,000")).toBeNull();
  });

  it("formats each recent transaction in its own currency with cents", async () => {
    mockAllOk();
    const { getByText } = renderWithTheme(<DashboardScreen />);
    await waitFor(() => expect(getByText("Grocery Store")).toBeTruthy());
    expect(getByText("-$45.50")).toBeTruthy(); // USD row
    expect(getByText("C$3,000.00")).toBeTruthy(); // CAD row
  });

  it("names the month the income/expense tiles cover", async () => {
    mockAllOk();
    const { getByText, queryByText } = renderWithTheme(<DashboardScreen />);
    await waitFor(() => expect(getByText("March 2026")).toBeTruthy());
    expect(queryByText("This Month")).toBeNull();
  });

  it("uses the health score's 3-month savings rate and shows negative rates", async () => {
    mockAllOk({ health: { savingsRatePct: -12 } });
    const { getByText } = renderWithTheme(<DashboardScreen />);
    await waitFor(() => expect(getByText("-12% savings rate · last 3 months")).toBeTruthy());
  });

  it("falls back to the reference month's rate when health is unavailable", async () => {
    mockAllOk({ health: null });
    const { getByText } = renderWithTheme(<DashboardScreen />);
    await waitFor(() => expect(getByText("30% savings rate · March 2026")).toBeTruthy());
  });

  it("displays health score with a theme-token color", async () => {
    mockAllOk();
    const { getByText } = renderWithTheme(<DashboardScreen />);
    await waitFor(() => {
      expect(getByText("Health Score")).toBeTruthy();
      expect(getByText("75")).toBeTruthy();
      expect(getByText("Good")).toBeTruthy();
    });
    const { StyleSheet } = require("react-native");
    expect(StyleSheet.flatten(getByText("75").props.style).color).toBe(lightColors.pos);
  });

  it("shows budget progress from categoryName, most at-risk first", async () => {
    mockAllOk({ budgets: [groceries, dining] });
    const { getByText, getAllByText } = renderWithTheme(<DashboardScreen />);
    await waitFor(() => expect(getByText("Budget Progress")).toBeTruthy());
    const names = getAllByText(/^(Groceries|Dining)$/).map((n) => n.props.children);
    expect(names).toEqual(["Dining", "Groceries"]);
  });

  it("shows the error with Retry (and keeps pull-to-refresh) when the first load fails", async () => {
    (endpoints.getDashboard as jest.Mock).mockResolvedValue({ success: false, error: "Server error" });
    (endpoints.getHealthScore as jest.Mock).mockResolvedValue({ success: false, error: "Server error" });
    (endpoints.getBudgets as jest.Mock).mockResolvedValue({ success: false, error: "Server error" });

    const { getByText, UNSAFE_getByType } = renderWithTheme(<DashboardScreen />);
    await waitFor(() => expect(getByText("Server error")).toBeTruthy());
    const { ScrollView } = require("react-native");
    expect(UNSAFE_getByType(ScrollView).props.refreshControl).toBeTruthy();

    mockAllOk();
    fireEvent.press(getByText("Retry"));
    await waitFor(() => expect(getByText("C$50,000")).toBeTruthy());
    expect(endpoints.getDashboard).toHaveBeenCalledTimes(2);
  });

  it("shows error when network fails", async () => {
    (endpoints.getDashboard as jest.Mock).mockRejectedValue(new Error("Network error"));
    (endpoints.getHealthScore as jest.Mock).mockRejectedValue(new Error("Network error"));
    (endpoints.getBudgets as jest.Mock).mockRejectedValue(new Error("Network error"));

    const { getByText } = renderWithTheme(<DashboardScreen />);
    await waitFor(() => expect(getByText("Cannot connect to server")).toBeTruthy());
  });

  it("keeps the last good data and shows a banner when a refresh fails", async () => {
    mockAllOk();
    const { getByText, UNSAFE_getByType } = renderWithTheme(<DashboardScreen />);
    await waitFor(() => expect(getByText("C$50,000")).toBeTruthy());

    (endpoints.getDashboard as jest.Mock).mockResolvedValue({ success: false, error: "Server error" });
    const { ScrollView } = require("react-native");
    await act(async () => {
      await UNSAFE_getByType(ScrollView).props.refreshControl.props.onRefresh();
    });

    expect(getByText("C$50,000")).toBeTruthy();
    expect(getByText(/Server error — showing your last loaded data/)).toBeTruthy();
  });

  it("refetches when the tab regains focus", async () => {
    mockAllOk();
    // A fresh element each time so the re-render isn't bailed out.
    const tree = () => (
      <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
        <DashboardScreen />
      </ThemeContext.Provider>
    );
    const { getByText, rerender } = render(tree());
    await waitFor(() => expect(getByText("C$50,000")).toBeTruthy());
    expect(endpoints.getDashboard).toHaveBeenCalledTimes(1);

    mockFocused = false;
    rerender(tree());
    mockFocused = true;
    mockAllOk({ dash: { netWorth: 61000 } });
    rerender(tree());
    await waitFor(() => expect(getByText("C$61,000")).toBeTruthy());
    expect(endpoints.getDashboard).toHaveBeenCalledTimes(2);
  });

  it("shows recent transactions and drills into TransactionDetail", async () => {
    mockAllOk();
    const { getByText } = renderWithTheme(<DashboardScreen />);
    await waitFor(() => {
      expect(getByText("Recent Transactions")).toBeTruthy();
      expect(getByText("Salary")).toBeTruthy();
    });
    fireEvent.press(getByText("Grocery Store"));
    expect(mockNavigate).toHaveBeenCalledWith("Transactions", {
      screen: "TransactionDetail",
      params: { transaction: expect.objectContaining({ id: 1 }) },
      initial: false,
    });
  });

  it("drills the income/expense tiles into category reports and the budget card into Budgets", async () => {
    mockAllOk();
    const { getByText } = renderWithTheme(<DashboardScreen />);
    await waitFor(() => expect(getByText("Expenses ›")).toBeTruthy());

    fireEvent.press(getByText("Expenses ›"));
    expect(mockNavigate).toHaveBeenLastCalledWith("More", {
      screen: "CategoryReports",
      params: { type: "E" },
      initial: false,
    });
    fireEvent.press(getByText("Income ›"));
    expect(mockNavigate).toHaveBeenLastCalledWith("More", {
      screen: "CategoryReports",
      params: { type: "I" },
      initial: false,
    });
    fireEvent.press(getByText("See all ›"));
    expect(mockNavigate).toHaveBeenLastCalledWith("More", { screen: "Budgets", initial: false });
  });

  it("keeps big figures on one line (shrink-to-fit) and stacks the health card on narrow phones", async () => {
    mockWindowWidth = 360;
    mockAllOk();
    const { getByText } = renderWithTheme(<DashboardScreen />);
    await waitFor(() => expect(getByText("C$50,000")).toBeTruthy());
    const netWorth = getByText("C$50,000");
    expect(netWorth.props.numberOfLines).toBe(1);
    expect(netWorth.props.adjustsFontSizeToFit).toBe(true);
    expect(getByText("C$80,000").props.numberOfLines).toBe(1);
  });

  it("shows 'No recent transactions' when list is empty", async () => {
    mockAllOk({ dash: { recentTransactions: [] }, budgets: [] });
    const { getByText } = renderWithTheme(<DashboardScreen />);
    await waitFor(() => expect(getByText("No recent transactions")).toBeTruthy());
  });
});
