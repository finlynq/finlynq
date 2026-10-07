import React from "react";
import { render, fireEvent } from "@testing-library/react-native";
import { Text } from "react-native";
import { MonthCalendar } from "../components/MonthCalendar";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import {
  datePartsOf,
  dayTitle,
  daysInMonth,
  firstWeekday,
  isoDay,
  monthKeyOf,
  monthTitle,
  periodRange,
  periodTitle,
  rollupByMonth,
  shiftAnchor,
  shiftYearMonth,
  weekStart,
} from "../lib/month-calendar";

describe("month-calendar date math", () => {
  it("counts days per month, leap years included", () => {
    expect(daysInMonth(2026, 0)).toBe(31);
    expect(daysInMonth(2026, 1)).toBe(28);
    expect(daysInMonth(2024, 1)).toBe(29);
    expect(daysInMonth(2026, 3)).toBe(30);
    expect(daysInMonth(2026, 11)).toBe(31);
  });

  it("finds the weekday of the 1st, Sunday first", () => {
    expect(firstWeekday(2026, 6)).toBe(3); // Wed 1 July 2026
    expect(firstWeekday(2026, 1)).toBe(0); // Sun 1 Feb 2026
    expect(firstWeekday(2026, 7)).toBe(6); // Sat 1 Aug 2026
  });

  it("builds zero-padded ISO days and month keys from a 0-based month", () => {
    expect(isoDay(2026, 0, 5)).toBe("2026-01-05");
    expect(isoDay(2026, 11, 31)).toBe("2026-12-31");
    expect(monthKeyOf(2026, 6)).toBe("2026-07");
    expect(monthKeyOf(2026, 11)).toBe("2026-12");
  });

  it("shifts months across year boundaries in both directions", () => {
    expect(shiftYearMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
    expect(shiftYearMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
    expect(shiftYearMonth(2026, 5, -18)).toEqual({ year: 2024, month: 11 });
    expect(shiftYearMonth(2026, 5, 0)).toEqual({ year: 2026, month: 5 });
  });

  it("splits an ISO date and round-trips through isoDay", () => {
    expect(datePartsOf("2026-07-04")).toEqual({ year: 2026, month: 6, day: 4 });
    const p = datePartsOf("2024-02-29");
    expect(isoDay(p.year, p.month, p.day)).toBe("2024-02-29");
  });

  it("labels months and days in UTC (no timezone shift)", () => {
    expect(monthTitle(2026, 6)).toBe("July 2026");
    expect(dayTitle(2026, 6, 4)).toBe("Saturday, July 4");
    expect(dayTitle(2026, 0, 1)).toBe("Thursday, January 1");
  });
});

describe("week / month / year periods", () => {
  it("finds the Sunday that starts a week", () => {
    expect(weekStart("2026-07-01")).toBe("2026-06-28"); // Wed → previous Sun
    expect(weekStart("2026-06-28")).toBe("2026-06-28"); // a Sunday is its own start
    expect(weekStart("2026-07-04")).toBe("2026-06-28"); // Sat → same week
    expect(weekStart("2026-01-01")).toBe("2025-12-28"); // across a year boundary
  });

  it("gives each mode's inclusive range, weeks crossing month and year ends", () => {
    expect(periodRange("week", "2026-07-01")).toEqual({ start: "2026-06-28", end: "2026-07-04" });
    expect(periodRange("week", "2026-01-01")).toEqual({ start: "2025-12-28", end: "2026-01-03" });
    expect(periodRange("month", "2026-02-17")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
    expect(periodRange("month", "2024-02-17")).toEqual({ start: "2024-02-01", end: "2024-02-29" });
    expect(periodRange("year", "2026-07-15")).toEqual({ start: "2026-01-01", end: "2026-12-31" });
  });

  it("shifts anchors; month and year steps land on the 1st", () => {
    expect(shiftAnchor("month", "2026-01-31", 1)).toBe("2026-02-01"); // never skips February
    expect(shiftAnchor("month", "2026-03-31", -1)).toBe("2026-02-01");
    expect(shiftAnchor("month", "2026-12-15", 1)).toBe("2027-01-01");
    expect(shiftAnchor("month", "2026-01-15", -1)).toBe("2025-12-01");
    expect(shiftAnchor("year", "2026-07-15", 1)).toBe("2027-07-01");
    expect(shiftAnchor("year", "2026-07-15", -1)).toBe("2025-07-01");
    expect(shiftAnchor("week", "2026-06-30", 1)).toBe("2026-07-07");
    expect(shiftAnchor("week", "2026-01-02", -1)).toBe("2025-12-26");
  });

  it("rolls days up by month, rounding to cents", () => {
    const out = rollupByMonth([
      { date: "2026-03-02", income: 1000.1, spending: 0.2, count: 3 },
      { date: "2026-03-20", income: 0, spending: 0.1, count: 1 },
      { date: "2026-11-05", income: 0, spending: -12.5, count: 2 },
    ]);
    expect(out.get("2026-03")).toEqual({ income: 1000.1, spending: 0.3, count: 4 });
    expect(out.get("2026-11")).toEqual({ income: 0, spending: -12.5, count: 2 });
    expect(out.has("2026-04")).toBe(false);
  });

  it("titles each period", () => {
    expect(periodTitle("week", "2026-07-01")).toBe("Jun 28 – Jul 4, 2026");
    expect(periodTitle("week", "2026-01-01")).toBe("Dec 28 – Jan 3, 2026");
    expect(periodTitle("month", "2026-07-19")).toBe("July 2026");
    expect(periodTitle("year", "2026-07-19")).toBe("2026");
  });
});

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};

function renderGrid(props: Partial<React.ComponentProps<typeof MonthCalendar>> = {}) {
  const handlers = { onSelectDay: jest.fn(), onShiftMonth: jest.fn(), onToday: jest.fn() };
  const utils = render(
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
      <MonthCalendar year={2026} month={6} today="2026-07-15" selectedDay={null} {...handlers} {...props} />
    </ThemeContext.Provider>,
  );
  return { ...utils, ...handlers };
}

describe("MonthCalendar", () => {
  it("draws one cell per day of the month", () => {
    const { getByText, getByTestId, queryByTestId } = renderGrid();
    expect(getByText("July 2026")).toBeTruthy();
    expect(getByTestId("calendar-day-1")).toBeTruthy();
    expect(getByTestId("calendar-day-31")).toBeTruthy();
    expect(queryByTestId("calendar-day-32")).toBeNull();
  });

  it("selects a day, and clears it when the selected day is tapped again", () => {
    const first = renderGrid();
    fireEvent.press(first.getByTestId("calendar-day-4"));
    expect(first.onSelectDay).toHaveBeenCalledWith(4);
    first.unmount();

    const second = renderGrid({ selectedDay: 4 });
    fireEvent.press(second.getByTestId("calendar-day-4"));
    expect(second.onSelectDay).toHaveBeenCalledWith(null);
  });

  it("navigates months and offers Back to today only off the current month", () => {
    const current = renderGrid();
    expect(current.queryByText("Back to today")).toBeNull();
    fireEvent.press(current.getByLabelText("Next month"));
    expect(current.onShiftMonth).toHaveBeenCalledWith(1);
    fireEvent.press(current.getByLabelText("Previous month"));
    expect(current.onShiftMonth).toHaveBeenCalledWith(-1);
    current.unmount();

    const other = renderGrid({ month: 5 });
    fireEvent.press(other.getByText("Back to today"));
    expect(other.onToday).toHaveBeenCalled();
  });

  it("renders each day's contents and screen-reader label from the render props", () => {
    const { getByText, getByLabelText } = renderGrid({
      renderDay: (day) => (day === 9 ? <Text>marker</Text> : null),
      dayLabel: (day) => (day === 9 ? "2 transactions" : ""),
    });
    expect(getByText("marker")).toBeTruthy();
    expect(getByLabelText("July 2026 9, 2 transactions")).toBeTruthy();
    expect(getByLabelText("July 2026 10")).toBeTruthy();
  });
});
