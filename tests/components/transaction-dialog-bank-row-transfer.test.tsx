/**
 * @vitest-environment jsdom
 *
 * Opening the transaction dialog from a bank row and switching to the Transfer
 * tab keeps the row's date and amount and puts its account on the side the
 * money moved through (2026-11-07, owner report: the tab opened on today's
 * date with no amount and no accounts).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

// base-ui's Dialog needs a portal jsdom doesn't render predictably; render the
// dialog's children inline.
vi.mock("@/components/ui/dialog", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => React.createElement("div", null, children);
  return {
    Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
      open ? React.createElement("div", null, children) : null,
    DialogContent: Pass,
    DialogHeader: Pass,
    DialogFooter: Pass,
    DialogDescription: Pass,
    DialogTitle: ({ children }: { children: React.ReactNode }) => React.createElement("h2", null, children),
  };
});

import { TransactionDialog } from "@/components/transactions/transaction-dialog";
import { bankRowDialogState } from "@/components/inbox/bank-row-dialog";

const ACCOUNTS = [
  { id: 25, name: "RBC ION Visa", currency: "CAD" },
  { id: 7, name: "Chequing", currency: "CAD" },
];

const row = { accountId: 25, date: "2026-10-12", currency: "CAD", payee: "Payment", suggestedCategoryId: null };

function openOnTransfer(amount: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => [] })),
  );
  render(
    <TransactionDialog
      open
      onOpenChange={() => {}}
      accounts={ACCOUNTS}
      categories={[]}
      holdings={[]}
      initialState={bankRowDialogState({ ...row, amount })}
      onSaved={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Transfer/ }));
}

/** What an account Combobox shows: its visible text plus every input value. */
function accountField(label: string): string {
  const field = screen.getByText(label).parentElement!;
  const values = Array.from(field.querySelectorAll("input")).map((i) => i.value);
  return [field.textContent ?? "", ...values].join(" | ");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TransactionDialog opened from a bank row", () => {
  it("money arriving: keeps date and amount, row's account in To", () => {
    openOnTransfer(137.35);
    expect(screen.getByText("New Transfer")).toBeTruthy();
    expect((screen.getByDisplayValue("2026-10-12") as HTMLInputElement).type).toBe("date");
    expect(screen.getByDisplayValue("137.35")).toBeTruthy();
    expect(accountField("To account")).toContain("RBC ION Visa");
    expect(accountField("From account")).not.toContain("RBC ION Visa");
  });

  it("money leaving: positive amount, row's account in From", () => {
    openOnTransfer(-45.04);
    expect(screen.getByDisplayValue("2026-10-12")).toBeTruthy();
    expect(screen.getByDisplayValue("45.04")).toBeTruthy();
    expect(accountField("From account")).toContain("RBC ION Visa");
    expect(accountField("To account")).not.toContain("RBC ION Visa");
  });
});
