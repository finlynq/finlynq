import React from "react";
import { render, waitFor, fireEvent } from "@testing-library/react-native";
import { HomeCalendarCard } from "../components/HomeCalendarCard";
import { endpoints } from "../api/client";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import { formatCurrency } from "../lib/format";
import { localDateISO } from "../lib/subscriptions";
import { datePartsOf, dayTitle, isoDay, monthKeyOf, monthTitle, shiftYearMonth } from "../lib/month-calendar";

jest.mock("../api/client", () => ({
  endpoints: { getTransactionsCalendar: jest.fn(), getSubscriptions: jest.fn(), getRecurring: jest.fn() },
}));
// A fixed "today" so expected payments (days AFTER today) are predictable.
jest.mock("../lib/subscriptions", () => ({
  ...jest.requireActual("../lib/subscriptions"),
  localDateISO: () => "2026-10-15",
}));

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};

// The card opens on the device's current month, so fixtures are built from it.
const now = datePartsOf(localDateISO());
const monthKey = monthKeyOf(now.year, now.month);
const day4 = isoDay(now.year, now.month, 4);
const day10 = isoDay(now.year, now.month, 10);

const payload = {
  month: monthKey,
  displayCurrency: "USD",
  days: [
    { date: day4, income: 3000, spending: 45.5, count: 2 },
    { date: day10, income: 0, spending: 120, count: 1 },
  ],
  totals: { income: 3000, spending: 165.5, count: 3 },
};

const getCalendar = endpoints.getTransactionsCalendar as jest.Mock;
const getSubscriptions = endpoints.getSubscriptions as jest.Mock;
const getRecurring = endpoints.getRecurring as jest.Mock;
const onOpenDay = jest.fn();
const onOpenMonth = jest.fn();

function card(refreshKey = 0) {
  return (
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
      <HomeCalendarCard fallbackCurrency="CAD" refreshKey={refreshKey} onOpenDay={onOpenDay} onOpenMonth={onOpenMonth} />
    </ThemeContext.Provider>
  );
}

/** Flatten nested style arrays (the RN mock's flatten goes one level deep). */
function flat(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flat));
  return style && typeof style === "object" ? (style as Record<string, unknown>) : {};
}

const whole = (n: number) => formatCurrency(n, "USD", { decimals: 0 });

beforeEach(() => {
  jest.clearAllMocks();
  getCalendar.mockResolvedValue({ success: true, data: payload });
  getSubscriptions.mockResolvedValue({ success: true, data: [] });
  getRecurring.mockResolvedValue({ success: true, data: { recurring: [], displayCurrency: "USD" } });
});

describe("HomeCalendarCard", () => {
  it("shows this month with its income, spending and net", async () => {
    const { getByText, findByText } = render(card());
    expect(await findByText(whole(3000))).toBeTruthy();
    expect(getCalendar).toHaveBeenCalledWith(monthKey);
    expect(getByText("Calendar")).toBeTruthy();
    expect(getByText(monthTitle(now.year, now.month))).toBeTruthy();
    expect(getByText(whole(165.5))).toBeTruthy();
    expect(getByText(`+${whole(2834.5)}`)).toBeTruthy();
  });

  it("shades each day by its spending and marks days with income", async () => {
    const { getByTestId, queryByTestId, findByText } = render(card());
    await findByText(whole(3000));
    // Day 10 is the month's biggest spending day: the deepest shade.
    expect(flat(getByTestId("calendar-day-10").props.style).backgroundColor).toBe(`${lightColors.neg}B0`);
    // Day 4 spent about a third of that: a middle shade, not the palest.
    expect(flat(getByTestId("calendar-day-4").props.style).backgroundColor).toBe(`${lightColors.neg}70`);
    // A day with nothing spent keeps the card's colour.
    expect(flat(getByTestId("calendar-day-12").props.style).backgroundColor).toBeUndefined();
    expect(getByTestId("home-income-dot-4")).toBeTruthy();
    expect(queryByTestId("home-income-dot-10")).toBeNull();
  });

  it("reads each day out for a screen reader", async () => {
    const { getByLabelText, findByText } = render(card());
    await findByText(whole(3000));
    expect(getByLabelText(/ 4, 2 transactions, spent \$45\.50, received \$3,000\.00$/)).toBeTruthy();
  });

  it("a tapped day swaps the month's totals for that day, with a way into its transactions", async () => {
    const { getByTestId, getByText, queryByText, findByText } = render(card());
    await findByText(whole(3000));
    fireEvent.press(getByTestId("calendar-day-4"));
    expect(getByText(dayTitle(now.year, now.month, 4))).toBeTruthy();
    expect(getByText("2 transactions")).toBeTruthy();
    expect(getByText("$45.50")).toBeTruthy();
    expect(getByText("$3,000.00")).toBeTruthy();
    expect(queryByText(`+${whole(2834.5)}`)).toBeNull();

    fireEvent.press(getByText("See this day's transactions ›"));
    expect(onOpenDay).toHaveBeenCalledWith(day4);

    // Tapping the same day again goes back to the month.
    fireEvent.press(getByTestId("calendar-day-4"));
    expect(getByText(`+${whole(2834.5)}`)).toBeTruthy();
  });

  it("says when a tapped day has no transactions", async () => {
    const { getByTestId, getByText, queryByText, findByText } = render(card());
    await findByText(whole(3000));
    fireEvent.press(getByTestId("calendar-day-12"));
    expect(getByText("No transactions on this day.")).toBeTruthy();
    expect(queryByText("See this day's transactions ›")).toBeNull();
  });

  it("moves between months and back to today", async () => {
    const next = shiftYearMonth(now.year, now.month, 1);
    const { getByLabelText, getByText, findByText } = render(card());
    await findByText(whole(3000));
    getCalendar.mockResolvedValue({
      success: true,
      data: { ...payload, month: monthKeyOf(next.year, next.month), days: [], totals: { income: 0, spending: 0, count: 0 } },
    });
    fireEvent.press(getByLabelText("Next month"));
    await waitFor(() => expect(getCalendar).toHaveBeenLastCalledWith(monthKeyOf(next.year, next.month)));
    expect(getByText(monthTitle(next.year, next.month))).toBeTruthy();

    getCalendar.mockResolvedValue({ success: true, data: payload });
    fireEvent.press(getByText("Back to today"));
    await waitFor(() => expect(getCalendar).toHaveBeenLastCalledWith(monthKey));
  });

  it("opens the month on the Transactions calendar", async () => {
    const { getByText, findByText } = render(card());
    await findByText(whole(3000));
    fireEvent.press(getByText("Open ›"));
    expect(onOpenMonth).toHaveBeenCalledWith(monthKey);
  });

  it("shows a failure with Retry, without breaking the grid", async () => {
    getCalendar.mockResolvedValue({ success: false, error: "Session locked. Sign in again." });
    const { findByText, getByText, getByTestId } = render(card());
    expect(await findByText("Session locked. Sign in again.")).toBeTruthy();
    expect(getByTestId("calendar-day-4")).toBeTruthy();
    getCalendar.mockResolvedValue({ success: true, data: payload });
    fireEvent.press(getByText("Retry"));
    expect(await findByText(whole(3000))).toBeTruthy();
  });

  it("says so when the server cannot be reached", async () => {
    getCalendar.mockRejectedValue(new Error("Network request failed"));
    const { findByText } = render(card());
    expect(await findByText("Cannot connect to server")).toBeTruthy();
  });

  // An older server has no calendar route: Home just goes without the card.
  it("hides itself on a server without the calendar", async () => {
    getCalendar.mockResolvedValue({ success: false, error: "Not found" });
    const { toJSON } = render(card());
    await waitFor(() => expect(toJSON()).toBeNull());
  });

  it("reloads when Home is pulled to refresh", async () => {
    const { rerender, findByText } = render(card(0));
    await findByText(whole(3000));
    expect(getCalendar).toHaveBeenCalledTimes(1);
    rerender(card(1));
    await waitFor(() => expect(getCalendar).toHaveBeenCalledTimes(2));
  });
});

// Owner request 2026-10-15: the Home calendar shows what is still to come.
describe("HomeCalendarCard expected payments", () => {
  const netflix = {
    id: 1,
    name: "Netflix",
    amount: 15.99,
    currency: "USD",
    frequency: "monthly",
    // Due on the 5th: this month's falls before today, so only next month's shows.
    nextDate: "2026-10-05",
    status: "active",
    displayAmount: 15.99,
  };
  const gym = { ...netflix, id: 2, name: "Gym", amount: 40, displayAmount: 40, nextDate: "2026-10-20" };
  const salary = {
    payee: "Employer",
    avgAmount: 2500,
    currency: "USD",
    avgAmountDisplay: 2500,
    frequency: "monthly",
    count: 6,
    lastDate: "2026-09-28",
    nextDate: "2026-10-28",
    accountId: 1,
    categoryId: null,
  };

  beforeEach(() => {
    getSubscriptions.mockResolvedValue({ success: true, data: [netflix, gym] });
    getRecurring.mockResolvedValue({ success: true, data: { recurring: [salary], displayCurrency: "USD" } });
  });

  it("marks the days still to come, never today or earlier", async () => {
    const { findByTestId, queryByTestId } = render(card());
    expect(await findByTestId("home-expected-dot-20")).toBeTruthy();
    expect(queryByTestId("home-expected-dot-28")).toBeTruthy();
    expect(queryByTestId("home-expected-dot-5")).toBeNull();
    expect(queryByTestId("home-expected-dot-15")).toBeNull();
  });

  it("sums what is still expected under the month's totals", async () => {
    const { findByText } = render(card());
    expect(await findByText("Still expected this month: $40 out, $2,500 in")).toBeTruthy();
  });

  it("lists a future day's expected payments when it is tapped", async () => {
    const { findByTestId, getByTestId, getByText, queryByText } = render(card());
    await findByTestId("home-expected-dot-20");
    fireEvent.press(getByTestId("calendar-day-20"));
    expect(getByText("EXPECTED")).toBeTruthy();
    expect(getByText(/Gym/)).toBeTruthy();
    expect(getByText("−$40.00")).toBeTruthy();
    expect(queryByText("No transactions on this day.")).toBeNull();

    fireEvent.press(getByTestId("calendar-day-28"));
    expect(getByText(/Employer/)).toBeTruthy();
    expect(getByText(/usual payment/)).toBeTruthy();
    expect(getByText("+$2,500.00")).toBeTruthy();
  });

  it("shows a whole future month", async () => {
    const { findByTestId, getByLabelText } = render(card());
    await findByTestId("home-expected-dot-20");
    fireEvent.press(getByLabelText("Next month"));
    expect(await findByTestId("home-expected-dot-5")).toBeTruthy();
  });

  it("shows no expected payments when the schedule can't be loaded", async () => {
    getSubscriptions.mockRejectedValue(new Error("offline"));
    const { findByText, queryByTestId } = render(card());
    await findByText(whole(3000));
    expect(queryByTestId("home-expected-dot-20")).toBeNull();
  });
});

