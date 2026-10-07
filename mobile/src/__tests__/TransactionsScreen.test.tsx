import React from "react";
import { render, waitFor, fireEvent } from "@testing-library/react-native";
import TransactionsScreen from "../screens/TransactionsScreen";
import { endpoints } from "../api/client";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import { localDateISO } from "../lib/subscriptions";
import {
  datePartsOf,
  dayTitle,
  isoDay,
  monthKeyOf,
  monthTitle,
  periodRange,
  shiftAnchor,
  shiftYearMonth,
} from "../lib/month-calendar";
import { addDays } from "../lib/subscriptions";

jest.mock("../api/client", () => ({
  endpoints: {
    getTransactions: jest.fn(),
    getTransactionsCalendar: jest.fn(),
    getTransactionsCalendarRange: jest.fn(),
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
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
      {component}
    </ThemeContext.Provider>
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

// ─── Calendar view ──────────────────────────────────────────────────────────
// The grid opens on the device's current month, so fixtures are built from it.
const now = datePartsOf(localDateISO());
const monthKey = monthKeyOf(now.year, now.month);
const day4 = isoDay(now.year, now.month, 4);
const day10 = isoDay(now.year, now.month, 10);

const calendarPayload = {
  month: monthKey,
  displayCurrency: "USD",
  days: [
    { date: day4, income: 3000, spending: 45.5, count: 2 },
    { date: day10, income: 0, spending: 120, count: 1 },
  ],
  totals: { income: 3000, spending: 165.5, count: 3 },
};

const dayRows = [
  { ...mockTransactions[0], id: 41, date: day4, payee: "Corner Bakery" },
  { ...mockTransactions[1], id: 42, date: day4, payee: "Payroll Deposit" },
];

/** List fetches get the 50-row list; a one-day query gets that day's rows. */
function mockTransactionsByQuery() {
  (endpoints.getTransactions as jest.Mock).mockImplementation((params?: string) =>
    Promise.resolve({
      success: true,
      data: params && params.includes("startDate=") ? dayRows : mockTransactions,
    }),
  );
}

async function openCalendar() {
  const utils = renderWithTheme(
    <TransactionsScreen navigation={mockNavigation} route={{ params: {} } as any} />
  );
  await waitFor(() => expect(utils.getByText("Grocery Store")).toBeTruthy());
  fireEvent.press(utils.getByText("Calendar"));
  await waitFor(() => expect(endpoints.getTransactionsCalendar).toHaveBeenCalledWith(monthKey));
  return utils;
}

describe("TransactionsScreen calendar view", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTransactionsByQuery();
    (endpoints.getTransactionsCalendar as jest.Mock).mockResolvedValue({ success: true, data: calendarPayload });
    (endpoints.getTransactionsCalendarRange as jest.Mock).mockImplementation((start: string, end: string) =>
      Promise.resolve({ success: true, data: { ...calendarPayload, month: undefined, start, end } }),
    );
  });

  it("toggles between the list and the calendar", async () => {
    const { getByText, queryByPlaceholderText, getByPlaceholderText, getByLabelText } = await openCalendar();
    expect(queryByPlaceholderText("Search transactions...")).toBeNull();
    expect(getByLabelText("Next month")).toBeTruthy();

    fireEvent.press(getByText("List"));
    await waitFor(() => expect(getByPlaceholderText("Search transactions...")).toBeTruthy());
    expect(getByText("Grocery Store")).toBeTruthy();
  });

  it("shows the month's totals and each day's indicators from the calendar API", async () => {
    const { getByText, getByTestId, queryByTestId, getByLabelText } = await openCalendar();
    await waitFor(() => expect(getByText("$3,000.00")).toBeTruthy());
    expect(getByText("$165.50")).toBeTruthy();
    expect(getByText("+$2,834.50")).toBeTruthy(); // net = income − spending

    // Day 4 had income and spending; day 10 spending only.
    expect(getByTestId(`income-dot-${day4}`)).toBeTruthy();
    expect(getByTestId(`spending-dot-${day4}`)).toBeTruthy();
    expect(queryByTestId(`income-dot-${day10}`)).toBeNull();
    expect(getByTestId(`spending-dot-${day10}`)).toBeTruthy();
    expect(getByLabelText(/ 4, 2 transactions, income \$3,000\.00, spending \$45\.50$/)).toBeTruthy();
  });

  it("lists a tapped day's transactions and clears them on a second tap", async () => {
    const { getByText, getByTestId, queryByText } = await openCalendar();
    await waitFor(() => expect(getByText("$3,000.00")).toBeTruthy());

    fireEvent.press(getByTestId("calendar-day-4"));
    await waitFor(() =>
      expect(endpoints.getTransactions).toHaveBeenLastCalledWith(
        expect.stringContaining(`startDate=${day4}&endDate=${day4}`),
      ),
    );
    await waitFor(() => expect(getByText("Corner Bakery")).toBeTruthy());
    expect(getByText("Payroll Deposit")).toBeTruthy();
    expect(getByText(dayTitle(now.year, now.month, 4))).toBeTruthy();
    expect(queryByText("$3,000.00")).toBeNull(); // the month tiles give way to the day

    // Same row component as the list: tapping opens TransactionDetail.
    fireEvent.press(getByText("Corner Bakery"));
    expect(mockNavigate).toHaveBeenCalledWith("TransactionDetail", {
      transaction: expect.objectContaining({ id: 41 }),
    });

    fireEvent.press(getByTestId("calendar-day-4"));
    await waitFor(() => expect(queryByText("Corner Bakery")).toBeNull());
    expect(getByText("$3,000.00")).toBeTruthy();
  });

  it("says when a day has no transactions", async () => {
    (endpoints.getTransactions as jest.Mock).mockImplementation((params?: string) =>
      Promise.resolve({ success: true, data: params && params.includes("startDate=") ? [] : mockTransactions }),
    );
    const { getByText, getByTestId } = await openCalendar();
    fireEvent.press(getByTestId("calendar-day-12"));
    await waitFor(() => expect(getByText("No transactions on this day.")).toBeTruthy());
  });

  it("moves to the next month and back to today", async () => {
    const { getByText, getByLabelText } = await openCalendar();
    fireEvent.press(getByLabelText("Next month"));
    const next = shiftYearMonth(now.year, now.month, 1);
    await waitFor(() =>
      expect(endpoints.getTransactionsCalendar).toHaveBeenLastCalledWith(monthKeyOf(next.year, next.month)),
    );

    fireEvent.press(getByText("Back to today"));
    const today = localDateISO();
    await waitFor(() => expect(endpoints.getTransactionsCalendar).toHaveBeenLastCalledWith(monthKey));
    await waitFor(() =>
      expect(endpoints.getTransactions).toHaveBeenLastCalledWith(
        expect.stringContaining(`startDate=${today}&endDate=${today}`),
      ),
    );
  });

  it("shows an error banner with Retry, and explains an older server", async () => {
    (endpoints.getTransactionsCalendar as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: "HTTP 404" })
      .mockResolvedValueOnce({ success: true, data: calendarPayload });
    const { getByText, queryByText } = await openCalendar();
    await waitFor(() => expect(getByText(/needs a newer Finlynq server/)).toBeTruthy());
    // The grid still renders under the banner.
    expect(getByText("Retry")).toBeTruthy();

    fireEvent.press(getByText("Retry"));
    await waitFor(() => expect(getByText("$3,000.00")).toBeTruthy());
    expect(queryByText(/needs a newer Finlynq server/)).toBeNull();
  });
});

describe("TransactionsScreen calendar — week and year views", () => {
  const today = localDateISO();
  const thisYear = today.slice(0, 4);
  // Two months that are never the current one, so the rollup is date-proof.
  const mA = (now.month + 4) % 12;
  const mB = (now.month + 8) % 12;
  const keyA = monthKeyOf(now.year, mA);
  const keyB = monthKeyOf(now.year, mB);
  const nameA = monthTitle(now.year, mA).split(" ")[0];

  beforeEach(() => {
    jest.clearAllMocks();
    mockTransactionsByQuery();
    (endpoints.getTransactionsCalendar as jest.Mock).mockResolvedValue({ success: true, data: calendarPayload });
    (endpoints.getTransactionsCalendarRange as jest.Mock).mockImplementation((start: string, end: string) =>
      Promise.resolve({
        success: true,
        data: {
          start,
          end,
          displayCurrency: "USD",
          // Two months of the year, so the year tiles have something to roll up.
          days: [
            { date: `${keyA}-02`, income: 1000, spending: 200, count: 3 },
            { date: `${keyA}-20`, income: 0, spending: 50.25, count: 1 },
            { date: `${keyB}-05`, income: 0, spending: 10, count: 1 },
          ],
          totals: { income: 4000, spending: 305.75, count: 7 },
        },
      }),
    );
  });

  it("week view asks for the Sunday–Saturday range and draws seven days", async () => {
    const { getByText, getByTestId, queryByLabelText, getByLabelText } = await openCalendar();
    fireEvent.press(getByText("Week"));
    const week = periodRange("week", today);
    await waitFor(() =>
      expect(endpoints.getTransactionsCalendarRange).toHaveBeenLastCalledWith(week.start, week.end),
    );
    expect(new Date(`${week.start}T00:00:00Z`).getUTCDay()).toBe(0);
    for (let i = 0; i < 7; i++) expect(getByTestId(`week-day-${addDays(week.start, i)}`)).toBeTruthy();
    expect(getByLabelText("Next week")).toBeTruthy();
    expect(queryByLabelText("Next month")).toBeNull();
    // Whole-week totals with no day selected.
    await waitFor(() => expect(getByText("Net for the week")).toBeTruthy());
    expect(getByText("+$3,694.25")).toBeTruthy();

    // A day in the week lists that day's transactions.
    fireEvent.press(getByTestId(`week-day-${week.start}`));
    await waitFor(() =>
      expect(endpoints.getTransactions).toHaveBeenLastCalledWith(
        expect.stringContaining(`startDate=${week.start}&endDate=${week.start}`),
      ),
    );

    // Next week moves the range by seven days and clears the selection.
    fireEvent.press(getByLabelText("Next week"));
    const next = periodRange("week", shiftAnchor("week", today, 1));
    await waitFor(() =>
      expect(endpoints.getTransactionsCalendarRange).toHaveBeenLastCalledWith(next.start, next.end),
    );
    expect(getByText("Back to today")).toBeTruthy();
  });

  it("year view rolls the year up into twelve tiles, and a tile opens its month", async () => {
    const { getByText, getByTestId, getByLabelText } = await openCalendar();
    fireEvent.press(getByText("Year"));
    await waitFor(() =>
      expect(endpoints.getTransactionsCalendarRange).toHaveBeenLastCalledWith(`${thisYear}-01-01`, `${thisYear}-12-31`),
    );
    for (let m = 1; m <= 12; m++) {
      expect(getByTestId(`year-month-${thisYear}-${String(m).padStart(2, "0")}`)).toBeTruthy();
    }
    expect(getByText(thisYear)).toBeTruthy();
    await waitFor(() => expect(getByText("Net for the year")).toBeTruthy());
    // Month A = two days rolled up.
    expect(getByLabelText(`Open ${nameA} ${thisYear}, 4 transactions`)).toBeTruthy();
    expect(getByText("+$1,000")).toBeTruthy();
    expect(getByText("−$250")).toBeTruthy();
    expect(getByText("4 tx")).toBeTruthy();

    fireEvent.press(getByTestId(`year-month-${keyA}`));
    await waitFor(() => expect(endpoints.getTransactionsCalendar).toHaveBeenLastCalledWith(keyA));
    expect(getByLabelText("Next month")).toBeTruthy();
    expect(getByText("Net for the month")).toBeTruthy();
  });

  it("keeps the selected day across a switch to Week, and clears it for Year", async () => {
    const { getByText, getByTestId, queryByText } = await openCalendar();
    fireEvent.press(getByTestId("calendar-day-4"));
    await waitFor(() => expect(getByText("Corner Bakery")).toBeTruthy());

    fireEvent.press(getByText("Week"));
    const week = periodRange("week", day4);
    await waitFor(() =>
      expect(endpoints.getTransactionsCalendarRange).toHaveBeenLastCalledWith(week.start, week.end),
    );
    expect(getByTestId(`week-day-${day4}`).props.accessibilityState).toEqual({ selected: true });
    expect(getByText("Corner Bakery")).toBeTruthy();

    fireEvent.press(getByText("Year"));
    await waitFor(() => expect(queryByText("Corner Bakery")).toBeNull());
    expect(getByText("Net for the year")).toBeTruthy();
  });

  it("Back to today in Year view goes to this year without selecting a day", async () => {
    const { getByText, getByLabelText } = await openCalendar();
    fireEvent.press(getByText("Year"));
    fireEvent.press(getByLabelText("Previous year"));
    const lastYear = String(Number(thisYear) - 1);
    await waitFor(() =>
      expect(endpoints.getTransactionsCalendarRange).toHaveBeenLastCalledWith(`${lastYear}-01-01`, `${lastYear}-12-31`),
    );
    (endpoints.getTransactions as jest.Mock).mockClear();
    fireEvent.press(getByText("Back to today"));
    await waitFor(() =>
      expect(endpoints.getTransactionsCalendarRange).toHaveBeenLastCalledWith(`${thisYear}-01-01`, `${thisYear}-12-31`),
    );
    expect(endpoints.getTransactions).not.toHaveBeenCalled();
  });

  it("explains a server that only knows month=", async () => {
    (endpoints.getTransactionsCalendarRange as jest.Mock).mockResolvedValue({
      success: false,
      error: "month must be YYYY-MM",
    });
    const { getByText } = await openCalendar();
    fireEvent.press(getByText("Week"));
    await waitFor(() => expect(getByText(/Week and Year views need a newer Finlynq server/)).toBeTruthy());
  });
});
