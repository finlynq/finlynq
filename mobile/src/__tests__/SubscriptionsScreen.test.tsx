import React from "react";
import { render, waitFor, fireEvent } from "@testing-library/react-native";
import SubscriptionsScreen from "../screens/SubscriptionsScreen";
import { endpoints } from "../api/client";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import { localDateISO, addDays } from "../lib/subscriptions";

const mockNavigate = jest.fn();
jest.mock("@react-navigation/native", () => ({
  ...jest.requireActual("@react-navigation/native"),
  useIsFocused: jest.fn(() => true),
  useNavigation: () => ({ navigate: mockNavigate, goBack: jest.fn() }),
}));

jest.mock("../api/client", () => ({
  endpoints: {
    getSubscriptions: jest.fn(),
    getRecurring: jest.fn(),
    createSubscription: jest.fn(),
    updateSubscription: jest.fn(),
  },
}));

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};

function renderScreen() {
  return render(
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
      <SubscriptionsScreen />
    </ThemeContext.Provider>,
  );
}

const today = localDateISO();
const subs = [
  { id: 1, name: "Netflix", amount: 15.99, currency: "USD", frequency: "monthly", nextDate: addDays(today, 3), status: "active", categoryId: null, accountId: null, cancelReminderDate: null, notes: null, displayAmount: 15.99, displayCurrency: "USD" },
  { id: 2, name: "Car insurance", amount: 600, currency: "USD", frequency: "semiannual", nextDate: addDays(today, 40), status: "active", categoryId: null, accountId: null, cancelReminderDate: null, notes: null, displayAmount: 600, displayCurrency: "USD" },
  { id: 3, name: "Old gym", amount: 40, currency: "USD", frequency: "monthly", nextDate: null, status: "cancelled", categoryId: null, accountId: null, cancelReminderDate: null, notes: null, displayAmount: 40, displayCurrency: "USD" },
];
const recurring = [
  { payee: "Spotify", avgAmount: -11.99, currency: "USD", avgAmountDisplay: -11.99, frequency: "monthly", count: 8, lastDate: addDays(today, -20), nextDate: addDays(today, 10), accountId: 4, categoryId: null },
  { payee: "netflix", avgAmount: -15.99, currency: "USD", avgAmountDisplay: -15.99, frequency: "monthly", count: 12, lastDate: addDays(today, -27), nextDate: addDays(today, 3), accountId: 4, categoryId: null },
];

describe("SubscriptionsScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (endpoints.getSubscriptions as jest.Mock).mockResolvedValue({ success: true, data: subs });
    (endpoints.getRecurring as jest.Mock).mockResolvedValue({ success: true, data: { recurring, displayCurrency: "USD" } });
  });

  it("lists tracked subscriptions grouped by status with monthly totals", async () => {
    const { getByText } = renderScreen();
    await waitFor(() => expect(getByText("Netflix")).toBeTruthy());
    expect(getByText("Car insurance")).toBeTruthy();
    expect(getByText("ACTIVE (2)")).toBeTruthy();
    expect(getByText("CANCELLED (1)")).toBeTruthy();
    // 15.99 + 600/6 = 115.99 per month
    expect(getByText("$115.99")).toBeTruthy();
  });

  it("suggests untracked recurring payments and tracks one in a tap", async () => {
    (endpoints.createSubscription as jest.Mock).mockResolvedValue({ success: true, data: { id: 9 } });
    const { getByText, queryByText } = renderScreen();
    await waitFor(() => expect(getByText("Found in your transactions")).toBeTruthy());
    expect(getByText("Spotify")).toBeTruthy();
    // "netflix" is already tracked (case-insensitive) — not re-suggested.
    expect(queryByText("netflix")).toBeNull();
    fireEvent.press(getByText("Track"));
    await waitFor(() => expect(endpoints.createSubscription).toHaveBeenCalledTimes(1));
    expect((endpoints.createSubscription as jest.Mock).mock.calls[0][0]).toMatchObject({
      name: "Spotify",
      amount: 11.99,
      currency: "USD",
      frequency: "monthly",
      accountId: 4,
    });
  });

  it("switches to the calendar view", async () => {
    const { getByText } = renderScreen();
    await waitFor(() => expect(getByText("Netflix")).toBeTruthy());
    fireEvent.press(getByText("Calendar"));
    await waitFor(() => expect(getByText("Bills this month")).toBeTruthy());
    expect(getByText("Income this month")).toBeTruthy();
  });

  it("explains a server that predates the merged feature", async () => {
    (endpoints.getSubscriptions as jest.Mock).mockResolvedValue({ success: false, error: "Not found" });
    const { getByText } = renderScreen();
    await waitFor(() => expect(getByText(/need a newer Finlynq server/)).toBeTruthy());
  });
});
