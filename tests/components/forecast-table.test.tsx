/**
 * @vitest-environment jsdom
 *
 * Forecast table: spending groups show their totals and collapse; sections
 * collapse but keep their totals; Collapse all / Expand all.
 */
import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { ForecastTable, groupTotals, type TableModel } from "@/app/(app)/forecast/_components/forecast-table";

afterEach(cleanup);

const model: TableModel = {
  columns: ["2027", "2028"],
  columnLabels: ["2027", "2028"],
  lines: [
    { key: "c:1", label: "Salary", type: "income", group: "Pay", amounts: [60000, 62000] },
    { key: "c:2", label: "Groceries", type: "expense", group: "Food", amounts: [6000, 6100] },
    { key: "c:3", label: "Dining", type: "expense", group: "Food", amounts: [1200, null] },
    { key: "c:4", label: "Gym", type: "expense", group: "Health", amounts: [null, null] },
  ],
  totals: { income: [60000, 62000], expense: [7200, 6100], debtPayment: [0, 0], net: [52800, 55900] },
  balances: { cash: [1, 2], investments: [0, 0], loans: [0, 0], netWorth: [1, 2] },
};

describe("groupTotals", () => {
  it("sums each column and stays blank where every line is blank", () => {
    expect(groupTotals(model.lines.slice(1, 3), 2)).toEqual([7200, 6100]);
    expect(groupTotals(model.lines.slice(3), 2)).toEqual([null, null]);
  });
});

describe("ForecastTable", () => {
  it("shows group totals, collapses a group and a section, keeps section totals", () => {
    const { getByRole, queryByText, getByText } = render(<ForecastTable model={model} currency="USD" selected={null} onSelect={null} />);
    const food = getByRole("button", { name: /Food/ });
    const foodRow = food.closest("tr")!;
    expect(foodRow.textContent).toContain("$7,200");
    expect(foodRow.textContent).toContain("$6,100");
    expect(getByRole("button", { name: /Health/ }).closest("tr")!.textContent).toContain("–");

    fireEvent.click(food);
    expect(food.getAttribute("aria-expanded")).toBe("false");
    expect(queryByText("Groceries")).toBeNull();
    expect(getByText("Gym")).toBeTruthy();

    fireEvent.click(getByRole("button", { name: /Income/ }));
    expect(queryByText("Salary")).toBeNull();
    expect(getByText("Total income")).toBeTruthy();
  });

  it("Collapse all hides every line, Expand all brings them back", () => {
    const { getByText, queryByText } = render(<ForecastTable model={model} currency="USD" selected={null} onSelect={null} />);
    fireEvent.click(getByText("Collapse all"));
    expect(queryByText("Salary")).toBeNull();
    expect(queryByText("Groceries")).toBeNull();
    expect(getByText("Total spending")).toBeTruthy();
    fireEvent.click(getByText("Expand all"));
    expect(getByText("Salary")).toBeTruthy();
    expect(getByText("Groceries")).toBeTruthy();
  });
});
