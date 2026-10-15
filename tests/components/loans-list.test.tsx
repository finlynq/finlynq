/**
 * @vitest-environment jsdom
 *
 * Loans list (in-app feedback 2026-10-15: with 17 loans the cards it replaced
 * fitted about three to a screen). One row per loan, amounts in the loan's own
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
    totalInterest: 1_000,
    totalInterestDisplay: 1_000,
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
  return screen.getAllByTitle(/Open its schedule|Fix its details/).map((b) => b.textContent ?? "");
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
    // What it is worth in the display currency sits under the native balance.
    expect(screen.getByText(/≈ \$10,000\.00/)).toBeTruthy();
    expect(screen.queryAllByText(/≈/)).toHaveLength(1);

    fireEvent.click(screen.getByText("Remaining"));
    expect(names()).toEqual(["Rouble loan", "Dollar loan"]);
    fireEvent.click(screen.getByText("Remaining"));
    expect(names()).toEqual(["Dollar loan", "Rouble loan"]);
  });

  it("shows no converted balance for a paid-off foreign loan", () => {
    renderList([loan({ id: 1, name: "Old CAD loan", currency: "CAD", remainingBalance: 0, remainingBalanceDisplay: 0 })]);
    expect(screen.queryAllByText(/≈/)).toHaveLength(0);
  });

  it("sorts total interest by its converted figure, shown in the loan's currency", () => {
    renderList([
      loan({ id: 1, name: "Rouble loan", currency: "RUB", totalInterest: 300_000, totalInterestDisplay: 3_300 }),
      loan({ id: 2, name: "Dollar loan", totalInterest: 4_000, totalInterestDisplay: 4_000 }),
    ]);
    fireEvent.click(screen.getByText("Total interest"));
    expect(names()).toEqual(["Rouble loan", "Dollar loan"]);
  });

  it("shows a lease's residual under its term end", () => {
    renderList([loan({ id: 1, name: "Car lease", type: "lease", residualValue: 4_000 })]);
    expect(screen.getByText("residual $4,000.00")).toBeTruthy();
  });

  it("flags a loan the server could not schedule; its name opens the form, not a schedule", () => {
    const onSchedule = vi.fn();
    const onEdit = vi.fn();
    const broken = loan({ id: 7, name: "Broken", remainingBalance: null, remainingBalanceDisplay: null, payoffDate: null });
    renderList([broken], { onSchedule, onEdit });
    expect(screen.getByText("Can't schedule")).toBeTruthy();
    const btn = screen.getByLabelText("View schedule for Broken") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(screen.getByText("Broken"));
    expect(onEdit).toHaveBeenCalledWith(broken);
    expect(onSchedule).not.toHaveBeenCalled();
  });

  it("puts the payment and share paid under the name for phones", () => {
    renderList([loan({ id: 1, name: "Car", paymentPerPeriod: 245.5, paymentFrequency: "biweekly" })]);
    expect(screen.getByText(/\$245\.50\/2 wk · 50% paid/)).toBeTruthy();
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
