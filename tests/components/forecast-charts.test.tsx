/**
 * @vitest-environment jsdom
 *
 * Forecast charts: the legend hides and shows a series; events are numbered
 * so close ones share or keep apart their markers without overlapping text.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import React from "react";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { SeriesLegend, numberMarkers } from "@/app/(app)/forecast/_components/forecast-charts";

afterEach(cleanup);

describe("SeriesLegend", () => {
  it("shows each series as a pressed toggle; a hidden one is not pressed", () => {
    const onToggle = vi.fn();
    const items = [{ key: "cash", label: "Cash", color: "#0f0" }, { key: "netWorth", label: "Net worth", color: "#00f" }];
    const { getByRole } = render(<SeriesLegend items={items} hidden={new Set(["cash"])} onToggle={onToggle} />);
    expect(getByRole("button", { name: "Cash" }).getAttribute("aria-pressed")).toBe("false");
    expect(getByRole("button", { name: "Net worth" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(getByRole("button", { name: "Cash" }));
    expect(onToggle).toHaveBeenCalledWith("cash");
  });
});

describe("numberMarkers", () => {
  const data = [
    { date: "2026-12-01", label: "2026" },
    { date: "2027-12-01", label: "2027" },
    { date: "2028-12-01", label: "2028" },
  ];
  it("numbers events by date, shares a marker on the same point, drops events past the end", () => {
    const r = numberMarkers(
      [
        { date: "2027-06-01", text: "Extra car payment" },
        { date: "2027-01-01", text: "Avalanche" },
        { date: "2028-03-01", text: "Buy a home" },
        { date: "2031-01-01", text: "Too late" },
      ],
      data,
    );
    expect(r.key).toEqual([
      { n: 1, text: "Avalanche", at: "2027" },
      { n: 2, text: "Extra car payment", at: "2027" },
      { n: 3, text: "Buy a home", at: "2028" },
    ]);
    expect(r.marks).toEqual([{ at: "2027", numbers: [1, 2] }, { at: "2028", numbers: [3] }]);
  });
});
