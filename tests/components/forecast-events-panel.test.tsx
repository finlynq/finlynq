/**
 * @vitest-environment jsdom
 *
 * Forecast events panel: switch an event off, edit one through its dialog,
 * remove one; events this scenario creates (new loans, a home's mortgage)
 * are offered as loans for extra payments.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import React from "react";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { EventsPanel, newEvent } from "@/app/(app)/forecast/_components/events-panel";
import { eventSchema } from "@/lib/forecast/config";
import type { ForecastLineDef } from "@/lib/forecast/types";

afterEach(cleanup);

const lines: ForecastLineDef[] = [
  { key: "c:1", label: "Salary", type: "income", group: "Pay" },
  { key: "c:2", label: "Rent", type: "expense", group: "Home" },
];

describe("EventsPanel", () => {
  it("switches off, edits and removes events", () => {
    const gift = eventSchema.parse({ id: "g", kind: "one_off", label: "Inheritance", month: "2027-03", params: { direction: "in", amount: 1000 } });
    const onChange = vi.fn();
    const { getByLabelText, getByText } = render(<EventsPanel events={[gift]} lines={lines} loans={[]} onChange={onChange} />);
    expect(getByText(/In 1000 in Mar 2027/)).toBeTruthy();

    fireEvent.click(getByLabelText("Use Inheritance"));
    expect(onChange.mock.calls[0][0][0].enabled).toBe(false);

    fireEvent.click(getByLabelText("Edit event"));
    fireEvent.change(getByLabelText("Amount"), { target: { value: "25000" } });
    fireEvent.change(getByLabelText("From month"), { target: { value: "2027-05" } });
    fireEvent.click(getByText("Save event"));
    expect(onChange.mock.calls[1][0][0]).toMatchObject({ id: "g", month: "2027-05", params: { direction: "in", amount: 25000 } });

    fireEvent.click(getByLabelText("Remove event"));
    expect(onChange.mock.calls[2][0]).toEqual([]);
  });

  it("new events are valid for every kind, and a new loan's key points at it", () => {
    for (const k of ["one_off", "recurring_item", "income_change", "move_money", "extra_debt_payment", "new_loan", "refinance", "buy_home", "debt_strategy"] as const) {
      const e = newEvent(k, "2027-01", [{ key: "debt:9", label: "Car" }]);
      expect(eventSchema.safeParse(e).success, k).toBe(true);
    }
    const loanEv = newEvent("new_loan", "2027-01");
    const extra = newEvent("extra_debt_payment", "2027-02", [{ key: `newloan:${loanEv.id}`, label: "New loan" }]);
    expect((extra.params as { loanKey: string }).loanKey).toBe(`newloan:${loanEv.id}`);
  });
});
