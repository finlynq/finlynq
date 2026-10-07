/**
 * @vitest-environment jsdom
 *
 * Transactions calendar view (in-app feedback 2026-10-07: "day / week / month
 * / year … click a date to list that day's transactions"). Each day shows its
 * totals, clicking a day hands that ISO day to the workspace (which narrows the
 * list to it), clicking the selected day again clears it, the week view shows
 * seven days, and the year view's month tiles open that month.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SWRConfig } from "swr";
import { TransactionsCalendar } from "@/app/(app)/transactions/_components/transactions-calendar";

const payload = {
  success: true,
  data: {
    start: "2026-10-01",
    end: "2026-10-31",
    displayCurrency: "USD",
    days: [
      { date: "2026-10-03", income: 2500, spending: 42.5, count: 3 },
      { date: "2026-10-09", income: 0, spending: 0, count: 2 },
    ],
    totals: { income: 2500, spending: 42.5, count: 5 },
  },
};

function renderCalendar(props: Partial<React.ComponentProps<typeof TransactionsCalendar>> = {}) {
  const fetchMock = vi.fn(async (_url: string) => ({ ok: true, json: async () => payload }));
  vi.stubGlobal("fetch", fetchMock);
  const handlers = {
    onSelectDay: vi.fn(),
    onModeChange: vi.fn(),
    onShift: vi.fn(),
    onToday: vi.fn(),
    onOpenMonth: vi.fn(),
  };
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <TransactionsCalendar
        mode="month"
        anchor="2026-10-15"
        selectedDay={null}
        accountId=""
        categoryId=""
        {...handlers}
        {...props}
      />
    </SWRConfig>,
  );
  return { fetchMock, ...handlers };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TransactionsCalendar — month", () => {
  it("requests the month with the list's account and category filters", async () => {
    const { fetchMock } = renderCalendar({ accountId: "7", categoryId: "12" });
    await screen.findByText("+$2,500");
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain("/api/transactions/calendar?");
    expect(url).toContain("month=2026-10");
    expect(url).toContain("accountId=7");
    expect(url).toContain("categoryId=12");
  });

  it("shows a day's income, spending and count, and the totals", async () => {
    renderCalendar();
    expect(await screen.findByText("+$2,500")).toBeTruthy();
    expect(screen.getByText("−$43")).toBeTruthy();
    expect(screen.getByText("3 tx")).toBeTruthy();
    // A transfer-only day: counted, no money line.
    expect(screen.getByText("2 tx")).toBeTruthy();
    expect(screen.getByText("$2,500.00")).toBeTruthy();
    expect(screen.getByText("$42.50")).toBeTruthy();
    expect(screen.getByText("Net for the month")).toBeTruthy();
  });

  it("clicking a day selects its ISO date; clicking the selected day clears it", async () => {
    const first = renderCalendar();
    await screen.findByText("+$2,500");
    fireEvent.click(screen.getByRole("button", { name: /October 2026 3,/ }));
    expect(first.onSelectDay).toHaveBeenLastCalledWith("2026-10-03");

    cleanup();
    const second = renderCalendar({ selectedDay: "2026-10-03" });
    await screen.findByText("+$2,500");
    fireEvent.click(screen.getByRole("button", { name: /October 2026 3,/ }));
    expect(second.onSelectDay).toHaveBeenLastCalledWith(null);
  });
});

describe("TransactionsCalendar — week and year", () => {
  it("week view requests the Sunday-to-Saturday range and shows seven days", async () => {
    // Oct 1 2026 is a Thursday → the week runs Sun Sep 27 … Sat Oct 3.
    const { fetchMock, onSelectDay } = renderCalendar({ mode: "week", anchor: "2026-10-01" });
    await screen.findByText("+$2,500");
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain("start=2026-09-27");
    expect(url).toContain("end=2026-10-03");
    expect(url).not.toContain("month=");
    expect(screen.getAllByRole("button", { pressed: false })).toHaveLength(7);
    fireEvent.click(screen.getByRole("button", { name: /October 3, 3 transactions/ }));
    expect(onSelectDay).toHaveBeenCalledWith("2026-10-03");
  });

  it("year view requests the whole year, shows twelve months, and a month tile opens that month", async () => {
    const { fetchMock, onOpenMonth } = renderCalendar({ mode: "year", anchor: "2026-10-07" });
    await screen.findByText("October");
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain("start=2026-01-01");
    expect(url).toContain("end=2026-12-31");
    expect(screen.getAllByRole("button", { name: /^Open / })).toHaveLength(12);
    fireEvent.click(screen.getByRole("button", { name: /^Open October 2026/ }));
    expect(onOpenMonth).toHaveBeenCalledWith("2026-10-01");
    expect(screen.getByText("Net for the year")).toBeTruthy();
  });

  it("the Week / Month / Year switch reports the chosen mode", async () => {
    const { onModeChange } = renderCalendar();
    await screen.findByText("+$2,500");
    fireEvent.click(screen.getByRole("tab", { name: "Year" }));
    expect(onModeChange).toHaveBeenCalledWith("year");
  });
});
