// The calendar date field that replaced typed YYYY-MM-DD on the transaction
// screens (owner request 2026-10-15).
import React, { useState } from "react";
import { render, fireEvent } from "@testing-library/react-native";
import { DateField } from "../components/DateField";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import { dateFieldLabel, pickerStartMonth } from "../lib/date-field";

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};

function Harness({ initial, allowClear, onChange }: { initial: string; allowClear?: boolean; onChange: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
      <DateField
        title="Date"
        value={value}
        allowClear={allowClear}
        onChange={(v) => {
          setValue(v);
          onChange(v);
        }}
      />
    </ThemeContext.Provider>
  );
}

describe("date-field helpers", () => {
  it("labels a date the same way on every device", () => {
    expect(dateFieldLabel("2026-10-15")).toBe("Thu, Oct 15, 2026");
    expect(dateFieldLabel("2024-02-29")).toBe("Thu, Feb 29, 2024");
    expect(dateFieldLabel("")).toBeNull();
    expect(dateFieldLabel("2026-13-01")).toBeNull();
  });

  it("opens on the field's month, or today's when it has none", () => {
    expect(pickerStartMonth("2025-03-09", "2026-10-15")).toEqual({ year: 2025, month: 2 });
    expect(pickerStartMonth("", "2026-10-15")).toEqual({ year: 2026, month: 9 });
    expect(pickerStartMonth("not a date", "2026-10-15")).toEqual({ year: 2026, month: 9 });
  });
});

describe("DateField", () => {
  it("shows the date and picks a new one from the calendar", () => {
    const onChange = jest.fn();
    const { getByText, getByTestId, queryByTestId } = render(<Harness initial="2026-09-15" onChange={onChange} />);
    expect(getByText("Tue, Sep 15, 2026")).toBeTruthy();
    expect(queryByTestId("calendar-day-20")).toBeNull(); // closed until tapped

    fireEvent.press(getByText("Tue, Sep 15, 2026"));
    fireEvent.press(getByTestId("calendar-day-20"));
    expect(onChange).toHaveBeenCalledWith("2026-09-20");
    expect(getByText("Sun, Sep 20, 2026")).toBeTruthy();
    expect(queryByTestId("calendar-day-20")).toBeNull(); // closed again
  });

  it("moves a month, or a year, before picking", () => {
    const onChange = jest.fn();
    const { getByText, getByTestId, getByLabelText } = render(<Harness initial="2026-09-15" onChange={onChange} />);
    fireEvent.press(getByText("Tue, Sep 15, 2026"));
    fireEvent.press(getByLabelText("Previous month"));
    fireEvent.press(getByText("‹ Year"));
    fireEvent.press(getByTestId("calendar-day-3"));
    expect(onChange).toHaveBeenCalledWith("2025-08-03");
  });

  it("tapping the chosen day again keeps it", () => {
    const onChange = jest.fn();
    const { getByText, getByTestId } = render(<Harness initial="2026-09-15" onChange={onChange} />);
    fireEvent.press(getByText("Tue, Sep 15, 2026"));
    fireEvent.press(getByTestId("calendar-day-15"));
    expect(onChange).toHaveBeenCalledWith("2026-09-15");
  });

  it("offers No date only when the date is optional", () => {
    const onChange = jest.fn();
    const { getByText, queryByText, rerender } = render(<Harness initial="2026-09-15" onChange={onChange} />);
    fireEvent.press(getByText("Tue, Sep 15, 2026"));
    expect(queryByText("No date")).toBeNull();

    rerender(<Harness initial="2026-09-15" allowClear onChange={onChange} />);
    fireEvent.press(getByText("No date"));
    expect(onChange).toHaveBeenCalledWith("");
  });
});
