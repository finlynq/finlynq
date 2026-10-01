import React from "react";
import { render, waitFor, fireEvent } from "@testing-library/react-native";
import CategoryReportsScreen from "../screens/CategoryReportsScreen";
import CategoryDetailScreen from "../screens/CategoryDetailScreen";
import { endpoints } from "../api/client";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import { changeIsGood, changeLabel, monthLabel, sharePct, shiftMonth } from "../lib/reports/categories";

const mockNavigate = jest.fn();
let mockParams: Record<string, unknown> | undefined;
jest.mock("@react-navigation/native", () => ({
  ...jest.requireActual("@react-navigation/native"),
  useNavigation: () => ({ navigate: mockNavigate, goBack: jest.fn() }),
  useRoute: () => ({ params: mockParams }),
}));

jest.mock("../api/client", () => ({
  endpoints: {
    getCategoryOverview: jest.fn(),
    getCategoryDetail: jest.fn(),
  },
}));

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};
const wrap = (el: React.ReactElement) =>
  render(<ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>{el}</ThemeContext.Provider>);

const overview = {
  type: "E",
  displayCurrency: "USD",
  month: "2026-10",
  partial: true,
  windowMonths: ["2026-09", "2026-10"],
  windowMonthsCount: 12,
  total: 400,
  averageTotal: 500,
  categories: [
    { id: 1, name: "Groceries", group: "Food", amount: 300, share: 0.75, average: 400, change: -0.25, budget: 450, trend: [400, 300] },
    { id: 2, name: "Dining", group: "Food", amount: 100, share: 0.25, average: 80, change: 0.25, budget: null, trend: [80, 100] },
  ],
};

const detail = {
  category: { id: 1, name: "Groceries", type: "E", group: "Food" },
  windowMonths: 12,
  displayCurrency: "USD",
  payeesLocked: false,
  months: [
    { month: "2026-08", amount: 380, count: 9, budget: null, partial: false },
    { month: "2026-09", amount: 420, count: 11, budget: 450, partial: false },
    { month: "2026-10", amount: 120, count: 3, budget: 450, partial: true },
  ],
  stats: {
    thisMonth: 120, lastMonth: 420, sameMonthLastYear: 350, averageMonthly: 400, medianMonthly: 400,
    highestMonth: { month: "2026-09", amount: 420 }, total: 920, transactionCount: 23, averageTransaction: 40, shareOfType: 0.22,
  },
  hasBudget: true,
  topPayees: [{ payee: "Metro", amount: 500, count: 10, share: 0.54 }],
  recent: [{ id: 7, date: "2026-10-03", payee: "Metro", amount: -42.5, currency: "USD", accountName: "Visa" }],
};

describe("category report helpers", () => {
  it("formats months, changes and shares", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(monthLabel("2026-10")).toBe("October 2026");
    expect(monthLabel("2026-10", "short")).toBe("Oct 26");
    expect(changeLabel(-0.25)).toBe("-25%");
    expect(changeLabel(null)).toBeNull();
    expect(sharePct(0.075)).toBe("7.5%");
    expect(sharePct(0.22)).toBe("22%");
  });

  it("judges spending down and income up as good", () => {
    expect(changeIsGood(-0.1, false)).toBe(true);
    expect(changeIsGood(0.1, false)).toBe(false);
    expect(changeIsGood(0.1, true)).toBe(true);
    expect(changeIsGood(0, true)).toBeNull();
  });
});

describe("CategoryReportsScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = undefined;
    (endpoints.getCategoryOverview as jest.Mock).mockResolvedValue({ success: true, data: overview });
  });

  it("shows the month total, the usual month and each category vs its usual month", async () => {
    const { getByText, getAllByText } = wrap(<CategoryReportsScreen />);
    await waitFor(() => expect(getByText("$400.00")).toBeTruthy());
    expect(getByText(/Usual month \$500/)).toBeTruthy();
    expect(getAllByText(/Groceries/).length).toBeGreaterThan(0);
    expect(getByText("-25%")).toBeTruthy();
    expect(getByText("+25%")).toBeTruthy();
    expect((endpoints.getCategoryOverview as jest.Mock).mock.calls[0][0]).toMatchObject({ type: "E", months: 12 });
  });

  it("switches to income and opens a category", async () => {
    const { getByText, getAllByText } = wrap(<CategoryReportsScreen />);
    await waitFor(() => expect(getByText("Dining")).toBeTruthy());
    fireEvent.press(getByText("Income"));
    await waitFor(() =>
      expect((endpoints.getCategoryOverview as jest.Mock).mock.calls.at(-1)?.[0]).toMatchObject({ type: "I" }),
    );
    await waitFor(() => expect(getAllByText("Dining").length).toBeGreaterThan(0));
    fireEvent.press(getAllByText("Dining")[0]);
    expect(mockNavigate).toHaveBeenCalledWith("CategoryDetail", { categoryId: 2, name: "Dining" });
  });

  it("explains a server without the category reports", async () => {
    (endpoints.getCategoryOverview as jest.Mock).mockResolvedValue({ success: false, error: "HTTP 404" });
    const { getByText } = wrap(<CategoryReportsScreen />);
    await waitFor(() => expect(getByText(/need a newer Finlynq server/)).toBeTruthy());
  });
});

describe("CategoryDetailScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { categoryId: 1, name: "Groceries" };
    (endpoints.getCategoryDetail as jest.Mock).mockResolvedValue({ success: true, data: detail });
  });

  it("shows the stats, the selected month, payees and recent transactions", async () => {
    const { getByText, getAllByText } = wrap(<CategoryDetailScreen />);
    await waitFor(() => expect(getByText("Monthly spending")).toBeTruthy());
    expect(getByText("$400.00")).toBeTruthy(); // monthly average tile
    expect(getByText("+5% vs average")).toBeTruthy(); // last month 420 vs 400
    expect(getByText(/September 2026: \$420\.00/)).toBeTruthy(); // last complete month preselected
    expect(getAllByText("Metro")).toHaveLength(2); // top payee + recent transaction
    expect(getByText("-$42.50")).toBeTruthy();
    expect(getByText("Budget")).toBeTruthy();
  });

  it("reloads with a different window", async () => {
    const { getByText } = wrap(<CategoryDetailScreen />);
    await waitFor(() => expect(getByText("Monthly spending")).toBeTruthy());
    fireEvent.press(getByText("24 months"));
    await waitFor(() => expect(endpoints.getCategoryDetail).toHaveBeenLastCalledWith(1, 24));
  });
});
