import React from "react";
import { ActivityIndicator } from "react-native";
import { render, waitFor, act } from "@testing-library/react-native";
import { useIsFocused } from "@react-navigation/native";
import GoalsScreen, { splitGoalsByStatus } from "../screens/GoalsScreen";
import { endpoints } from "../api/client";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import type { GoalWithProgress } from "../../../shared/types";

const mockNavigate = jest.fn();
jest.mock("@react-navigation/native", () => ({
  ...jest.requireActual("@react-navigation/native"),
  useIsFocused: jest.fn(() => true),
  useNavigation: () => ({ navigate: mockNavigate, goBack: jest.fn() }),
}));

jest.mock("../api/client", () => ({
  endpoints: {
    getGoals: jest.fn(),
    getDisplayCurrency: jest.fn(),
  },
}));

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};

function screen() {
  return (
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
      <GoalsScreen />
    </ThemeContext.Provider>
  );
}

function goal(over: Partial<GoalWithProgress>): GoalWithProgress {
  return {
    id: 1,
    name: "Emergency Fund",
    type: "savings",
    targetAmount: 10000,
    deadline: null,
    accountId: null,
    currency: "USD",
    priority: 1,
    status: "active",
    note: "",
    currentAmount: 2500,
    progress: 25,
    percentComplete: 25,
    remaining: 7500,
    monthlyNeeded: 0,
    ...over,
  };
}

const goals = [
  goal({}),
  goal({
    id: 2,
    name: "Pay off Visa",
    type: "debt_payoff",
    targetAmount: 5000,
    currentAmount: -3200,
    progress: -64,
    remaining: 8200,
  }),
  goal({ id: 3, name: "Vacation", status: "completed", currentAmount: 3000, targetAmount: 3000, progress: 100, remaining: 0 }),
  goal({ id: 4, name: "Legacy", currency: null, currentAmount: 100, targetAmount: 1000, remaining: 900 }),
];

describe("splitGoalsByStatus", () => {
  it("puts only status 'completed' in the completed list", () => {
    const { active, completed } = splitGoalsByStatus([
      goal({ id: 1 }),
      goal({ id: 2, status: "completed" }),
      goal({ id: 3, status: "paused" }),
    ]);
    expect(active.map((g) => g.id)).toEqual([1, 3]);
    expect(completed.map((g) => g.id)).toEqual([2]);
  });
});

describe("GoalsScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useIsFocused as jest.Mock).mockReturnValue(true);
    (endpoints.getGoals as jest.Mock).mockResolvedValue({ success: true, data: goals });
    (endpoints.getDisplayCurrency as jest.Mock).mockResolvedValue({
      success: true,
      data: { displayCurrency: "CAD" },
    });
  });

  it("lists completed goals in their own section", async () => {
    const { getByText } = render(screen());
    await waitFor(() => expect(getByText("Emergency Fund")).toBeTruthy());
    expect(getByText("COMPLETED (1)")).toBeTruthy();
    expect(getByText("Vacation")).toBeTruthy();
    expect(getByText(/· Completed/)).toBeTruthy();
  });

  it("describes a debt goal as a balance, never as a negative amount paid", async () => {
    const { getByText, queryByText } = render(screen());
    await waitFor(() => expect(getByText("Pay off Visa")).toBeTruthy());
    expect(getByText(/current balance/)).toBeTruthy();
    expect(getByText("Target $5,000")).toBeTruthy();
    expect(queryByText(/paid/)).toBeNull();
    expect(queryByText(/remaining to pay off/)).toBeNull();
  });

  it("labels a goal saved without a currency in the display currency, not CAD-by-default", async () => {
    (endpoints.getDisplayCurrency as jest.Mock).mockResolvedValue({
      success: true,
      data: { displayCurrency: "EUR" },
    });
    const { getByText } = render(screen());
    await waitFor(() => expect(getByText("Legacy")).toBeTruthy());
    await waitFor(() => expect(getByText(/€900/)).toBeTruthy());
  });

  it("refreshes in place on refocus (no full-screen spinner) and shows a failed reload", async () => {
    const { getByText, queryByText, rerender, UNSAFE_queryAllByType } = render(screen());
    await waitFor(() => expect(getByText("Emergency Fund")).toBeTruthy());

    (endpoints.getGoals as jest.Mock).mockResolvedValue({ success: false, error: "Server down" });
    (useIsFocused as jest.Mock).mockReturnValue(false);
    rerender(screen());
    (useIsFocused as jest.Mock).mockReturnValue(true);
    rerender(screen());

    // The list stays up while the refetch runs — no full-screen spinner.
    expect(getByText("Emergency Fund")).toBeTruthy();
    expect(UNSAFE_queryAllByType(ActivityIndicator)).toHaveLength(0);

    await waitFor(() => expect(getByText("Server down")).toBeTruthy());
    expect(getByText("Emergency Fund")).toBeTruthy();

    // The next successful reload clears it.
    (endpoints.getGoals as jest.Mock).mockResolvedValue({ success: true, data: goals });
    (useIsFocused as jest.Mock).mockReturnValue(false);
    rerender(screen());
    (useIsFocused as jest.Mock).mockReturnValue(true);
    rerender(screen());
    // Let the refetch resolve and its state updates commit.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(endpoints.getGoals).toHaveBeenCalledTimes(3);
    expect(queryByText("Server down")).toBeNull();
    expect(getByText("Emergency Fund")).toBeTruthy();
  });
});
