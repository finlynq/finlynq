import React from "react";
import { render, waitFor, fireEvent } from "@testing-library/react-native";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import IncomeStatementScreen from "../screens/IncomeStatementScreen";
import TrendsScreen from "../screens/TrendsScreen";
import YearOverYearScreen from "../screens/YearOverYearScreen";
import BalanceSheetScreen from "../screens/BalanceSheetScreen";
import CashFlowSankeyScreen from "../screens/CashFlowSankeyScreen";
import { endpoints } from "../api/client";
import { formatCurrency } from "../lib/format";
import type { IncomeStatement, ReportTrends, YoYReport, BalanceSheet } from "../../../shared/types";

jest.mock("../api/client", () => ({
  endpoints: {
    getIncomeStatement: jest.fn(),
    getReportTrends: jest.fn(),
    getYoY: jest.fn(),
    getBalanceSheet: jest.fn(),
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

const navigate = jest.fn();
const navigation = { navigate, goBack: jest.fn() } as never;
const rangeRoute = (name: string) =>
  ({
    key: name,
    name,
    params: {
      startDate: "2026-01-01",
      endDate: "2026-09-30",
      isBusiness: false,
      displayCurrency: "USD",
      rangeLabel: "Jan 2026 – Sep 2026",
    },
  }) as never;

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("IncomeStatementScreen", () => {
  const statement: IncomeStatement = {
    type: "income-statement",
    displayCurrency: "USD",
    period: { startDate: "2026-01-01", endDate: "2026-09-30" },
    income: [{ categoryId: 1, categoryType: "I", categoryGroup: "Income", categoryName: "Salary", total: 5000, count: 2 }],
    expenses: [{ categoryId: 7, categoryType: "E", categoryGroup: "Food", categoryName: "Groceries", total: 1200, count: 8 }],
    totalIncome: 5000,
    totalExpenses: 1200,
    netSavings: 3800,
    savingsRate: 76,
    unrealized: { totals: { costBasis: 0, marketValue: 0, valuationGL: 0, fxGL: 0, totalGL: 0 }, accounts: [] },
  };

  it("taps a category through to CategoryDetail with the server's categoryId", async () => {
    (endpoints.getIncomeStatement as jest.Mock).mockResolvedValue({ success: true, data: statement });
    const { findByText, getByText } = wrap(
      <IncomeStatementScreen navigation={navigation} route={rangeRoute("IncomeStatement")} />
    );
    fireEvent.press(await findByText("Food")); // expand the group
    fireEvent.press(getByText("Groceries"));
    expect(navigate).toHaveBeenCalledWith("CategoryDetail", { categoryId: 7, name: "Groceries" });
  });

  it("shows '—' for the savings rate when there is no income", async () => {
    (endpoints.getIncomeStatement as jest.Mock).mockResolvedValue({
      success: true,
      data: { ...statement, income: [], totalIncome: 0, netSavings: -1200, savingsRate: 0 },
    });
    const { findByText } = wrap(<IncomeStatementScreen navigation={navigation} route={rangeRoute("IncomeStatement")} />);
    expect(await findByText("— savings rate")).toBeTruthy();
  });
});

describe("TrendsScreen", () => {
  const base: ReportTrends = {
    period: "monthly",
    groupBy: "category",
    startDate: "2026-01-01",
    endDate: "2026-09-30",
    displayCurrency: "EUR",
    timeseries: [
      { period: "2026-08", label: "Aug 2026", income: 5000, expenses: 1000, net: 4000 },
      { period: "2026-09", label: "Sep 2026", income: 5000, expenses: 1400, net: 3600 },
    ],
    income: [{ name: "Salary", group: "Income", categoryId: 1, total: 10000, count: 2, periods: {} }],
    expenses: [{ name: "Groceries", group: "Food", categoryId: 7, total: 2400, count: 3, periods: {} }],
    totalIncome: 10000,
    totalExpenses: 2400,
    netSavings: 7600,
    savingsRate: 76,
  };

  it("formats amounts in the currency the server echoes, not the route param", async () => {
    (endpoints.getReportTrends as jest.Mock).mockResolvedValue({ success: true, data: base });
    const { findByText, getAllByText } = wrap(<TrendsScreen navigation={navigation} route={rangeRoute("Trends")} />);
    expect(await findByText("Savings rate")).toBeTruthy();
    expect(getAllByText(formatCurrency(10000, "EUR", { decimals: 0 })).length).toBeGreaterThan(0);
  });

  it("taps a category through to CategoryDetail in category mode", async () => {
    (endpoints.getReportTrends as jest.Mock).mockResolvedValue({ success: true, data: base });
    const { findByText, getByText } = wrap(<TrendsScreen navigation={navigation} route={rangeRoute("Trends")} />);
    fireEvent.press(await findByText("Food"));
    fireEvent.press(getByText("Groceries"));
    expect(navigate).toHaveBeenCalledWith("CategoryDetail", { categoryId: 7, name: "Groceries" });
  });

  it("renders group mode as flat rows (no one-item collapsibles) and doesn't navigate", async () => {
    (endpoints.getReportTrends as jest.Mock).mockImplementation(async (p: { groupBy: string }) => ({
      success: true,
      data:
        p.groupBy === "group"
          ? {
              ...base,
              groupBy: "group",
              expenses: [{ name: "Food", group: "Food", categoryId: null, total: 2400, count: 3, periods: {} }],
            }
          : base,
    }));
    const { findByText, getByText, queryByText } = wrap(
      <TrendsScreen navigation={navigation} route={rangeRoute("Trends")} />
    );
    await findByText("Expense categories");
    fireEvent.press(getByText("By group"));
    expect(await findByText("Expense groups")).toBeTruthy();
    // Flat: the row's meta line is visible without expanding anything.
    expect(getByText("3 txns · 100%")).toBeTruthy();
    fireEvent.press(getByText("Food"));
    expect(navigate).not.toHaveBeenCalled();
    expect(queryByText("Groceries")).toBeNull();
  });

  it("shows '—' for the savings rate when there is no income", async () => {
    (endpoints.getReportTrends as jest.Mock).mockResolvedValue({
      success: true,
      data: { ...base, income: [], totalIncome: 0, netSavings: -2400, savingsRate: 0 },
    });
    const { findByText, getByText } = wrap(<TrendsScreen navigation={navigation} route={rangeRoute("Trends")} />);
    expect(await findByText("Savings rate")).toBeTruthy();
    expect(getByText("—")).toBeTruthy();
  });
});

describe("YearOverYearScreen (partial current year)", () => {
  const now = new Date();
  const year = now.getFullYear();
  const monthIdx = now.getMonth();
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const report: YoYReport = {
    year1: year - 1,
    year2: year,
    displayCurrency: "USD",
    categories: [{ name: "Rent", year1Amount: 12000, year2Amount: 9000, change: -25 }],
    monthly: MONTHS.map((month, i) => ({
      month,
      year1Income: 1000,
      year1Expenses: 100,
      // A future-dated row in the current year must not leak into the totals.
      year2Income: i > monthIdx ? 777 : 1000,
      year2Expenses: i > monthIdx ? 77 : 50,
    })),
  };

  it("totals Jan → this month on both sides, dashes future months, and captions YTD", async () => {
    (endpoints.getYoY as jest.Mock).mockResolvedValue({ success: true, data: report });
    const route = { key: "YearOverYear", name: "YearOverYear", params: { displayCurrency: "USD" } } as never;
    const { findAllByText, getAllByText, getByText } = wrap(
      <YearOverYearScreen navigation={navigation} route={route} />
    );

    // Header reads "YYYY YTD" (totals card + monthly table).
    expect((await findAllByText(`${year} YTD`)).length).toBe(2);

    // Income totals: (monthIdx + 1) months × 1000 on BOTH sides (like for like).
    const ytdIncome = formatCurrency((monthIdx + 1) * 1000, "USD", { decimals: 0 });
    expect(getAllByText(ytdIncome).length).toBe(2);

    // Future months of the current year render "—" instead of an amount.
    expect(getAllByText("—").length).toBe(11 - monthIdx);

    // The category comparison is full-year server-side → caveat.
    expect(getByText(/Category amounts are full calendar years/)).toBeTruthy();
  });
});

describe("BalanceSheetScreen", () => {
  const sheet: BalanceSheet = {
    type: "balance-sheet",
    displayCurrency: "USD",
    date: "2026-10-01",
    assets: [],
    liabilities: [],
    totalAssets: 0,
    totalLiabilities: 0,
    netWorth: 0,
  };

  it("asks for today and labels the result as current balances (server ignores endDate)", async () => {
    (endpoints.getBalanceSheet as jest.Mock).mockResolvedValue({ success: true, data: sheet });
    const route = {
      key: "BalanceSheet",
      name: "BalanceSheet",
      params: { endDate: "2025-12-31", displayCurrency: "USD" },
    } as never;
    const { findByText } = wrap(<BalanceSheetScreen navigation={navigation} route={route} />);
    expect(await findByText(/^Current balances · today/)).toBeTruthy();
    await waitFor(() => expect(endpoints.getBalanceSheet).toHaveBeenCalledWith({ endDate: localToday() }));
  });
});

describe("CashFlowSankeyScreen", () => {
  it("folds the expense tail into 'Other (n)' instead of dropping it", async () => {
    const expenses = Array.from({ length: 13 }, (_, i) => ({
      name: `Cat ${i + 1}`,
      group: "G",
      categoryId: i + 1,
      total: (13 - i) * 10,
      count: 1,
      periods: {},
    }));
    (endpoints.getReportTrends as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        period: "monthly",
        groupBy: "category",
        startDate: "2026-01-01",
        endDate: "2026-09-30",
        displayCurrency: "USD",
        timeseries: [],
        income: [{ name: "Salary", group: "Income", categoryId: 99, total: 5000, count: 1, periods: {} }],
        expenses,
        totalIncome: 5000,
        totalExpenses: expenses.reduce((s, e) => s + e.total, 0),
        netSavings: 0,
        savingsRate: 0,
      } satisfies ReportTrends,
    });
    const { findByText } = wrap(<CashFlowSankeyScreen navigation={navigation} route={rangeRoute("CashFlowSankey")} />);
    expect(await findByText(/the 3 smaller ones are combined into “Other \(3\)”/)).toBeTruthy();
  });
});
