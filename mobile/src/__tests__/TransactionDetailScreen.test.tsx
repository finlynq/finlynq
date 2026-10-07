import React from "react";
import { render, waitFor, fireEvent } from "@testing-library/react-native";
import { Alert } from "react-native";
import TransactionDetailScreen from "../screens/TransactionDetailScreen";
import { endpoints } from "../api/client";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import type { Transaction } from "../../../shared/types";

jest.mock("../api/client", () => ({
  endpoints: {
    getAccountsDetailed: jest.fn(),
    getCategories: jest.fn(),
    getSplits: jest.fn(),
    getLinkedTransactions: jest.fn(),
    updateTransaction: jest.fn(),
    deleteTransaction: jest.fn(),
    loadPortfolioOperation: jest.fn(),
  },
}));

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};

const LINK = "5b0c6a3e-1f2d-4c3b-9a8e-7d6f5e4c3b2a";

// The leg the user opened: the DESTINATION (money in, EUR).
const destLeg: Transaction = {
  id: 11,
  date: "2026-09-14",
  accountId: 2,
  categoryId: 5,
  currency: "EUR",
  amount: 91.37,
  quantity: null,
  portfolioHolding: null,
  note: "Savings top-up",
  payee: "Transfer from Chequing",
  tags: "",
  isBusiness: 0,
  splitPerson: null,
  splitRatio: null,
  importHash: null,
  fitId: null,
  linkId: LINK,
  kind: "transfer",
};
const sourceLeg = {
  id: 10,
  date: "2026-09-14",
  accountId: 1,
  categoryId: 5,
  currency: "USD",
  amount: -100,
  quantity: null,
  portfolioHoldingId: null,
  note: "Savings top-up",
  payee: "v1:cipher:text",
  linkId: LINK,
};

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const navigation = {
  navigate: mockNavigate,
  goBack: mockGoBack,
  addListener: jest.fn(() => jest.fn()),
  getParent: jest.fn(),
} as any;

function renderDetail(transaction: Transaction) {
  return render(
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
      <TransactionDetailScreen navigation={navigation} route={{ key: "d", name: "TransactionDetail", params: { transaction } } as any} />
    </ThemeContext.Provider>,
  );
}

describe("TransactionDetailScreen — transfers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (endpoints.getAccountsDetailed as jest.Mock).mockResolvedValue({
      success: true,
      data: [
        { id: 1, name: "Chequing", currency: "USD", type: "A", group: "Banking", mode: "manual" },
        { id: 2, name: "Euro Savings", currency: "EUR", type: "A", group: "Banking", mode: "manual" },
      ],
    });
    (endpoints.getCategories as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (endpoints.getSplits as jest.Mock).mockResolvedValue({ success: true, data: [] });
  });

  it("edits a transfer leg as the pair, pre-filled from both legs", async () => {
    (endpoints.getLinkedTransactions as jest.Mock).mockResolvedValue({ success: true, data: [sourceLeg] });
    const { getByText } = renderDetail(destLeg);
    await waitFor(() => expect(getByText("Edit")).toBeTruthy());
    expect(endpoints.getLinkedTransactions).toHaveBeenCalledWith(LINK, 11);
    expect(getByText("Transfer")).toBeTruthy();

    fireEvent.press(getByText("Edit"));
    expect(mockNavigate).toHaveBeenCalledWith("AddTransaction", {
      mode: "transfer",
      editTransfer: {
        transactionId: 11,
        fromAccountId: 1,
        toAccountId: 2,
        fromCurrency: "USD",
        toCurrency: "EUR",
        enteredAmount: 100,
        receivedAmount: 91.37,
        date: "2026-09-14",
        note: "Savings top-up",
      },
    });
    // The generic single-row form never opens for a pair.
    expect(() => getByText("Save")).toThrow();
  });

  it("keeps the generic edit for an orphaned leg", async () => {
    (endpoints.getLinkedTransactions as jest.Mock).mockResolvedValue({ success: true, data: [] });
    const { getByText } = renderDetail(destLeg);
    await waitFor(() => expect(getByText("Edit")).toBeTruthy());
    expect(getByText("Transaction")).toBeTruthy();
    fireEvent.press(getByText("Edit"));
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(getByText("Save")).toBeTruthy();
  });

  it("does not look for a partner when the row has no linkId", async () => {
    const { getByText } = renderDetail({ ...destLeg, linkId: null });
    await waitFor(() => expect(getByText("Edit")).toBeTruthy());
    expect(endpoints.getLinkedTransactions).not.toHaveBeenCalled();
  });

  it("shows the server's refusal when a single-leg edit would move a transfer leg", async () => {
    const alertSpy = jest.spyOn(Alert, "alert");
    (endpoints.getLinkedTransactions as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (endpoints.updateTransaction as jest.Mock).mockResolvedValue({
      success: false,
      error: "This row is one leg of a transfer. Edit the transfer to change its amount, account or date.",
      code: "transfer_leg_edit_refused",
    });
    const { getByText } = renderDetail(destLeg);
    await waitFor(() => expect(getByText("Edit")).toBeTruthy());
    fireEvent.press(getByText("Edit"));
    fireEvent.press(getByText("Save"));
    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(
        "Part of a transfer",
        "This row is one leg of a transfer. Edit the transfer to change its amount, account or date.",
      ),
    );
    expect(mockGoBack).not.toHaveBeenCalled();
    expect(getByText("Save")).toBeTruthy(); // the form stays open
  });
});
