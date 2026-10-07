/**
 * @vitest-environment jsdom
 *
 * Transactions calendar view (in-app feedback 2026-10-07): each day shows its
 * totals, and clicking a day hands that day to the workspace (which narrows the
 * list to it). Clicking the selected day again clears the selection.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SWRConfig } from "swr";
import { TransactionsCalendar } from "@/app/(app)/transactions/_components/transactions-calendar";

const payload = {
  success: true,
  data: {
    month: "2026-10",
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
  const onSelectDay = vi.fn();
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <TransactionsCalendar
        year={2026}
        month={9}
        selectedDay={null}
        accountId=""
        categoryId=""
        onSelectDay={onSelectDay}
        onShiftMonth={vi.fn()}
        onToday={vi.fn()}
        {...props}
      />
    </SWRConfig>,
  );
  return { fetchMock, onSelectDay };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TransactionsCalendar", () => {
  it("requests the month with the list's account and category filters", async () => {
    const { fetchMock } = renderCalendar({ accountId: "7", categoryId: "12" });
    await screen.findByText("+$2,500");
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/api/transactions/calendar?");
    expect(url).toContain("month=2026-10");
    expect(url).toContain("accountId=7");
    expect(url).toContain("categoryId=12");
  });

  it("shows a day's income, spending and count, and the month totals", async () => {
    renderCalendar();
    expect(await screen.findByText("+$2,500")).toBeTruthy();
    expect(screen.getByText("−$43")).toBeTruthy();
    expect(screen.getByText("3 tx")).toBeTruthy();
    // A transfer-only day: counted, no money line.
    expect(screen.getByText("2 tx")).toBeTruthy();
    expect(screen.getByText("$2,500.00")).toBeTruthy();
    expect(screen.getByText("$42.50")).toBeTruthy();
  });

  it("clicking a day selects it; clicking the selected day clears it", async () => {
    const { onSelectDay } = renderCalendar();
    await screen.findByText("+$2,500");
    fireEvent.click(screen.getByRole("button", { name: /October 2026 3,/ }));
    expect(onSelectDay).toHaveBeenLastCalledWith(3);

    cleanup();
    const second = renderCalendar({ selectedDay: 3 });
    await screen.findByText("+$2,500");
    fireEvent.click(screen.getByRole("button", { name: /October 2026 3,/ }));
    expect(second.onSelectDay).toHaveBeenLastCalledWith(null);
  });
});
