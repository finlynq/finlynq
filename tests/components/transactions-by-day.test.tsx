/**
 * @vitest-environment jsdom
 *
 * GH #465 — the Transactions "By day" view. Rows are grouped under one header
 * per day; the header shows the WHOLE day's count and income / spending / net
 * from the server (so a day split across pages says so), a click on a row
 * opens the edit flow, a click on a header collapses the day, and a non-date
 * sort is explained.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TransactionsByDay } from "@/app/(app)/transactions/_components/transactions-by-day";
import type { Transaction } from "@/app/(app)/transactions/_types";

function tx(over: Partial<Transaction>): Transaction {
  return {
    id: 1,
    date: "2026-11-27",
    accountId: 3,
    accountName: "Chequing",
    categoryId: 10,
    categoryName: "Groceries",
    categoryType: "E",
    currency: "USD",
    amount: -84.1,
    quantity: null,
    portfolioHolding: null,
    note: "",
    payee: "Market",
    tags: "",
    isBusiness: null,
    linkId: null,
    ...over,
  };
}

const txns: Transaction[] = [
  tx({ id: 3, payee: "Employer", categoryName: "Salary", categoryType: "I", amount: 1200 }),
  tx({ id: 2, payee: "Market" }),
  tx({ id: 1, date: "2026-11-26", payee: "Cafe", amount: -12, enteredAmount: -10, enteredCurrency: "EUR" }),
];

const dayTotals = {
  displayCurrency: "USD",
  days: [
    { date: "2026-11-27", income: 1200, spending: 84.1, count: 2 },
    // The 26th has two more transactions on the next page.
    { date: "2026-11-26", income: 0, spending: 40, count: 3 },
  ],
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ data: { versions: {} } }) })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderView(props: Partial<React.ComponentProps<typeof TransactionsByDay>> = {}) {
  const onEdit = vi.fn();
  render(
    <TransactionsByDay
      loading={false}
      txns={txns}
      dayTotals={dayTotals}
      sortAscending={false}
      sortOverridden={false}
      onEdit={onEdit}
      {...props}
    />,
  );
  return { onEdit };
}

describe("TransactionsByDay", () => {
  it("shows one header per day with the whole day's count and money", () => {
    renderView();
    const headers = screen.getAllByRole("button", { expanded: true });
    expect(headers).toHaveLength(2);
    expect(headers[0].textContent).toContain("2 transactions");
    expect(headers[0].textContent).toContain("In +$1,200.00");
    expect(headers[0].textContent).toContain("Out −$84.10");
    expect(headers[0].textContent).toContain("Net +$1,115.90");
    // Split across pages: the full count, and how many are here.
    expect(headers[1].textContent).toContain("3 transactions (1 on this page)");
    // Spending only: no In and no Net.
    expect(headers[1].textContent).toContain("Out −$40.00");
    expect(headers[1].textContent).not.toContain("In ");
    expect(headers[1].textContent).not.toContain("Net ");
  });

  it("shows each row in its own currency and opens it on click", () => {
    const { onEdit } = renderView();
    expect(screen.getByText(/€10\.00/)).toBeTruthy();
    expect(screen.getByText(/→ .*\$12\.00/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Employer/ }));
    expect(onEdit).toHaveBeenCalledWith(txns[0]);
  });

  it("collapses a day when its header is clicked", () => {
    renderView();
    expect(screen.getByText("Market")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { expanded: true })[0]);
    expect(screen.queryByText("Market")).toBeNull();
    expect(screen.queryByText("Employer")).toBeNull();
    expect(screen.getByText("Cafe")).toBeTruthy();
  });

  it("totals the days on the page", () => {
    renderView();
    expect(screen.getByText("2 days on this page")).toBeTruthy();
    expect(screen.getByText("5 transactions")).toBeTruthy();
  });

  it("explains the grouping and a column sort it set aside", () => {
    renderView({ sortOverridden: true });
    expect(screen.getByText(/Grouped by day, newest first\. Your column sort applies in the List view\./)).toBeTruthy();
  });

  it("falls back to the page's row count while totals are unavailable", () => {
    renderView({ dayTotals: null });
    const headers = screen.getAllByRole("button", { expanded: true });
    expect(headers[0].textContent).toContain("2 transactions");
    expect(headers[0].textContent).not.toContain("In ");
    expect(headers[1].textContent).toContain("1 transaction");
  });
});
