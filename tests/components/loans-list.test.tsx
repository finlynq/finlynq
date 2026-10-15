/**
 * @vitest-environment jsdom
 *
 * Loans list view (in-app feedback 2026-10-15: with 17 loans the cards fit
 * about three to a screen). One row per loan, amounts in the loan's own
 * currency, amount columns sorted by the display-currency companion.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { LoansList, type LoanListRow } from "@/app/(app)/loans/_components/loans-list";

afterEach(cleanup);

function loan(over: Partial<LoanListRow> & { id: number; name: string }): LoanListRow {
  return {
    type: "loan",
    principal: 10_000,
    annualRate: 5,
    interestMethod: "rate",
    effectiveAnnualRate: 5,
    paymentFrequency: "monthly",
    paymentPerPeriod: 200,
    monthlyPayment: 200,
    monthlyEquivalentPayment: 200,
    payoffDate: "2030-01-01",
    remainingBalance: 5_000,
    balanceSource: "projection",
    accountId: null,
    accountName: null,
    scheduleMode: "calculated",
    currency: "USD",
    remainingBalanceDisplay: 5_000,
    monthlyEquivalentPaymentDisplay: 200,
    ...over,
  };
}

function names(): string[] {
  return screen.getAllByTitle("Open its schedule").map((b) => b.textContent ?? "");
}

function renderList(loans: LoanListRow[], handlers: Partial<Record<"onSchedule" | "onEdit" | "onDelete", (l: LoanListRow) => void>> = {}) {
  return render(
    <LoansList
      loans={loans}
      displayCurrency="USD"
      selectedId={null}
      onSchedule={handlers.onSchedule ?? vi.fn()}
      onEdit={handlers.onEdit ?? vi.fn()}
      onDelete={handlers.onDelete ?? vi.fn()}
    />,
  );
}

describe("LoansList", () => {
  it("shows one row per loan with its figures", () => {
    renderList([
      loan({ id: 1, name: "Car", type: "student_loan", paymentFrequency: "biweekly", paymentPerPeriod: 150 }),
      loan({ id: 2, name: "House", type: "mortgage" }),
    ]);
    expect(names()).toEqual(["Car", "House"]);
    expect(screen.getByText("Student loan")).toBeTruthy();
    expect(screen.getByText("/2 wk")).toBeTruthy();
    expect(screen.getAllByText("50%")).toHaveLength(2);
  });

  it("shows a foreign loan in its own currency but sorts it by its converted balance", () => {
    renderList([
      // 900,000 RUB owed is about 10,000 USD: native is bigger, converted is smaller.
      loan({ id: 1, name: "Rouble loan", currency: "RUB", remainingBalance: 900_000, remainingBalanceDisplay: 10_000 }),
      loan({ id: 2, name: "Dollar loan", remainingBalance: 50_000, remainingBalanceDisplay: 50_000 }),
    ]);
    expect(screen.getByText("RUB")).toBeTruthy();

    fireEvent.click(screen.getByText("Remaining"));
    expect(names()).toEqual(["Rouble loan", "Dollar loan"]);
    fireEvent.click(screen.getByText("Remaining"));
    expect(names()).toEqual(["Dollar loan", "Rouble loan"]);
  });

  it("flags a loan the server could not schedule and offers no schedule for it", () => {
    const onSchedule = vi.fn();
    renderList([loan({ id: 7, name: "Broken", remainingBalance: null, remainingBalanceDisplay: null, payoffDate: null })], { onSchedule });
    expect(screen.getByText("Can't schedule")).toBeTruthy();
    const btn = screen.getByLabelText("View schedule for Broken") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("hands the row's loan to the schedule, edit and delete actions", () => {
    const onSchedule = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const target = loan({ id: 3, name: "Boat" });
    renderList([loan({ id: 1, name: "Car" }), target], { onSchedule, onEdit, onDelete });

    fireEvent.click(screen.getByLabelText("View schedule for Boat"));
    fireEvent.click(screen.getByText("Boat"));
    fireEvent.click(screen.getByLabelText("Edit loan Boat"));
    fireEvent.click(screen.getByLabelText("Delete loan Boat"));

    expect(onSchedule).toHaveBeenCalledTimes(2);
    expect(onSchedule.mock.calls.every(([l]) => l.id === 3)).toBe(true);
    expect(onEdit).toHaveBeenCalledWith(target);
    expect(onDelete).toHaveBeenCalledWith(target);
  });

  it("links a balance that comes from an account to that account", () => {
    renderList([loan({ id: 1, name: "Car", balanceSource: "account", accountId: 42, accountName: "Car Loan" })]);
    const link = screen.getByLabelText("Balance from Car Loan. Open the account.");
    expect(link.getAttribute("href")).toBe("/accounts/42");
    // Only one row: the link sits in it.
    expect(within(screen.getAllByRole("row")[1]).getByLabelText("Balance from Car Loan. Open the account.")).toBeTruthy();
  });
});
