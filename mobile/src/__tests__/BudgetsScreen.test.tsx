import React from "react";
import { Alert } from "react-native";
import { render, waitFor, fireEvent } from "@testing-library/react-native";
import BudgetsScreen, { monthFromOffset } from "../screens/BudgetsScreen";
import { endpoints } from "../api/client";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";

const mockNavigate = jest.fn();
jest.mock("@react-navigation/native", () => ({
  ...jest.requireActual("@react-navigation/native"),
  useIsFocused: jest.fn(() => true),
  useNavigation: () => ({ navigate: mockNavigate, goBack: jest.fn() }),
}));

jest.mock("../api/client", () => ({
  endpoints: {
    getBudgets: jest.fn(),
    getCategories: jest.fn(),
    getDisplayCurrency: jest.fn(),
    saveBudget: jest.fn(),
    deleteBudget: jest.fn(),
  },
}));

const mockBudgets = [
  {
    id: 1,
    categoryId: 1,
    month: "2026-03",
    amount: 500,
    currency: "USD",
    categoryName: "Groceries",
    categoryGroup: "Needs",
    convertedAmount: 500,
    convertedSpent: 350,
    displayCurrency: "USD",
  },
  {
    id: 2,
    categoryId: 2,
    month: "2026-03",
    amount: 200,
    currency: "USD",
    categoryName: "Entertainment",
    categoryGroup: "Wants",
    convertedAmount: 200,
    convertedSpent: 250,
    displayCurrency: "USD",
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
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
      {component}
    </ThemeContext.Provider>
  );
}

function mockLoad(budgets: unknown[] = mockBudgets, displayCurrency = "USD") {
  (endpoints.getBudgets as jest.Mock).mockResolvedValue({ success: true, data: budgets });
  (endpoints.getCategories as jest.Mock).mockResolvedValue({ success: true, data: mockCategories });
  (endpoints.getDisplayCurrency as jest.Mock).mockResolvedValue({
    success: true,
    data: { displayCurrency },
  });
}

/** Make Alert.alert immediately press the button with the given label. */
function pressAlertButton(label: string) {
  return jest.spyOn(Alert, "alert").mockImplementation((_title, _msg, buttons) => {
    buttons?.find((b) => b.text === label)?.onPress?.();
  });
}

describe("monthFromOffset", () => {
  it("does not skip a month from the 31st", () => {
    // setMonth on Jan 31 overflows to March; day-1 construction must not.
    expect(monthFromOffset(1, new Date(2026, 0, 31))).toBe("2026-02");
    expect(monthFromOffset(-1, new Date(2026, 2, 31))).toBe("2026-02");
    expect(monthFromOffset(0, new Date(2026, 4, 31))).toBe("2026-05");
  });

  it("rolls the year over in both directions", () => {
    expect(monthFromOffset(1, new Date(2026, 11, 31))).toBe("2027-01");
    expect(monthFromOffset(-1, new Date(2026, 0, 15))).toBe("2025-12");
  });
});

describe("BudgetsScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it("shows loading indicator initially", () => {
    (endpoints.getBudgets as jest.Mock).mockReturnValue(new Promise(() => {}));
    (endpoints.getCategories as jest.Mock).mockReturnValue(new Promise(() => {}));
    (endpoints.getDisplayCurrency as jest.Mock).mockReturnValue(new Promise(() => {}));

    const { UNSAFE_queryAllByType } = renderWithTheme(<BudgetsScreen />);
    const { ActivityIndicator } = require("react-native");
    const indicators = UNSAFE_queryAllByType(ActivityIndicator);
    expect(indicators.length).toBeGreaterThan(0);
  });

  it("renders budget list using the server's decrypted category names", async () => {
    mockLoad();
    const { getByText } = renderWithTheme(<BudgetsScreen />);

    await waitFor(() => {
      expect(getByText("Budgets")).toBeTruthy();
      expect(getByText("Groceries")).toBeTruthy();
      expect(getByText("Entertainment")).toBeTruthy();
    });
  });

  it("shows overall budget summary", async () => {
    mockLoad();
    const { getByText } = renderWithTheme(<BudgetsScreen />);

    await waitFor(() => {
      expect(getByText("Spent")).toBeTruthy();
      expect(getByText("Budgeted")).toBeTruthy();
      // 700 budgeted − 600 spent
      expect(getByText("$100 remaining")).toBeTruthy();
    });
  });

  it("says 'over' (not a negative remaining) when the month is over budget", async () => {
    mockLoad([{ ...mockBudgets[1] }]); // 250 spent of 200
    const { getByText, queryByText } = renderWithTheme(<BudgetsScreen />);

    await waitFor(() => expect(getByText("$50 over")).toBeTruthy());
    expect(queryByText(/-\$50 remaining/)).toBeNull();
  });

  it("formats amounts in the server's display currency", async () => {
    mockLoad(
      mockBudgets.map((b) => ({ ...b, displayCurrency: "CAD" })),
      "CAD",
    );
    const { getByText } = renderWithTheme(<BudgetsScreen />);

    await waitFor(() => {
      expect(getByText("C$150 remaining")).toBeTruthy();
      expect(getByText("C$50 over budget")).toBeTruthy();
    });
  });

  it("shows empty state when no budgets", async () => {
    mockLoad([]);
    const { getByText } = renderWithTheme(<BudgetsScreen />);

    await waitFor(() => {
      expect(getByText(/No budgets set for/)).toBeTruthy();
    });
  });

  it("has month navigation", async () => {
    mockLoad();
    const { getByText } = renderWithTheme(<BudgetsScreen />);

    await waitFor(() => {
      expect(getByText("← Prev")).toBeTruthy();
      expect(getByText("Next →")).toBeTruthy();
    });
  });

  it("clears the previous month's rows when the next month fails to load", async () => {
    mockLoad();
    const { getByText, queryByText } = renderWithTheme(<BudgetsScreen />);
    await waitFor(() => expect(getByText("Groceries")).toBeTruthy());

    (endpoints.getBudgets as jest.Mock).mockResolvedValueOnce({
      success: false,
      error: "Server exploded",
    });
    fireEvent.press(getByText("Next →"));

    await waitFor(() => expect(getByText("Server exploded")).toBeTruthy());
    expect(queryByText("Groceries")).toBeNull();
    expect(queryByText("Entertainment")).toBeNull();
    expect(endpoints.getBudgets).toHaveBeenLastCalledWith(monthFromOffset(1));
  });

  it("shows over budget indicator", async () => {
    mockLoad();
    const { getByText } = renderWithTheme(<BudgetsScreen />);

    await waitFor(() => {
      // Entertainment is over budget (250 spent of 200)
      expect(getByText("$50 over budget")).toBeTruthy();
    });
  });

  it("shows remaining amount for under-budget items", async () => {
    mockLoad();
    const { getByText } = renderWithTheme(<BudgetsScreen />);

    await waitFor(() => {
      // Groceries: 500 - 350 = 150 remaining
      expect(getByText("$150 remaining")).toBeTruthy();
    });
  });

  it("has Add button", async () => {
    mockLoad();
    const { getByText } = renderWithTheme(<BudgetsScreen />);

    await waitFor(() => {
      expect(getByText("+ Add")).toBeTruthy();
    });
  });

  it("shows add form when Add is pressed", async () => {
    mockLoad();
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

  it("creates a budget in the display currency (never an implicit server default)", async () => {
    mockLoad([], "MXN");
    (endpoints.saveBudget as jest.Mock).mockResolvedValue({ success: true, data: {} });
    const { getByText, getByPlaceholderText } = renderWithTheme(<BudgetsScreen />);
    await waitFor(() => expect(getByText("+ Add")).toBeTruthy());

    fireEvent.press(getByText("+ Add"));
    await waitFor(() => expect(getByText("AMOUNT (MXN)")).toBeTruthy());
    fireEvent.press(getByText("Transport"));
    fireEvent.changeText(getByPlaceholderText("0"), "300");
    fireEvent.press(getByText("Add Budget"));

    await waitFor(() => expect(endpoints.saveBudget).toHaveBeenCalledTimes(1));
    expect(endpoints.saveBudget).toHaveBeenCalledWith({
      categoryId: 3,
      month: monthFromOffset(0),
      amount: 300,
      currency: "MXN",
    });
  });

  it("saves an edit with the display currency alongside the converted amount", async () => {
    // Stored as €400, shown converted to $460.13.
    mockLoad([
      {
        ...mockBudgets[0],
        amount: 400,
        currency: "EUR",
        convertedAmount: 460.1289,
      },
    ]);
    (endpoints.saveBudget as jest.Mock).mockResolvedValue({ success: true, data: {} });
    pressAlertButton("Edit Amount");
    const { getByText, getByDisplayValue } = renderWithTheme(<BudgetsScreen />);
    await waitFor(() => expect(getByText("Groceries")).toBeTruthy());

    fireEvent(getByText("Groceries"), "longPress");

    // Prefilled with the converted (display-currency) value, labelled as such,
    // and the re-denomination is spelled out.
    await waitFor(() => expect(getByDisplayValue("460.13")).toBeTruthy());
    expect(getByText(/This budget is set in EUR/)).toBeTruthy();
    expect(getByText(/Saving\s+stores it in USD/)).toBeTruthy();

    fireEvent.press(getByText("Save"));
    await waitFor(() => expect(endpoints.saveBudget).toHaveBeenCalledTimes(1));
    expect(endpoints.saveBudget).toHaveBeenCalledWith({
      categoryId: 1,
      month: "2026-03",
      amount: 460.13,
      currency: "USD",
    });
  });

  it("opens the category's spending history on tap", async () => {
    mockLoad();
    const { getByText } = renderWithTheme(<BudgetsScreen />);
    await waitFor(() => expect(getByText("Groceries")).toBeTruthy());

    fireEvent.press(getByText("Groceries"));
    expect(mockNavigate).toHaveBeenCalledWith("CategoryDetail", {
      categoryId: 1,
      name: "Groceries",
    });
  });

  it("reports a failed delete instead of silently refreshing", async () => {
    mockLoad();
    (endpoints.deleteBudget as jest.Mock).mockResolvedValue({ success: false, error: "Nope" });
    const alertSpy = jest
      .spyOn(Alert, "alert")
      .mockImplementation((_title, _msg, buttons) => {
        // Long-press menu → "Delete"; confirm dialog → "Delete" (destructive).
        buttons?.find((b) => b.text === "Delete")?.onPress?.();
      });
    const { getByText } = renderWithTheme(<BudgetsScreen />);
    await waitFor(() => expect(getByText("Groceries")).toBeTruthy());

    fireEvent(getByText("Groceries"), "longPress");

    await waitFor(() => expect(endpoints.deleteBudget).toHaveBeenCalledWith(1));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("Couldn't delete", "Nope"));
  });

  it("shows hint text", async () => {
    mockLoad();
    const { getByText } = renderWithTheme(<BudgetsScreen />);

    await waitFor(() => {
      expect(getByText(/long press to edit or delete/)).toBeTruthy();
    });
  });
});
