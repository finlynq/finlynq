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
// The tab navigator: "In Portfolio" navigates into the Portfolio tab's form.
const mockParentNavigate = jest.fn();
const navigation = {
  navigate: mockNavigate,
  goBack: mockGoBack,
  addListener: jest.fn(() => jest.fn()),
  getParent: jest.fn(() => ({ navigate: mockParentNavigate })),
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

describe("TransactionDetailScreen — portfolio-operation legs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (endpoints.getAccountsDetailed as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (endpoints.getCategories as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (endpoints.getSplits as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (endpoints.getLinkedTransactions as jest.Mock).mockResolvedValue({ success: true, data: [] });
  });

  // The bank-side leg of a brokerage deposit: a link_id pair, but no holding
  // and no quantity; only its kind says it belongs to a portfolio op.
  const depositBankLeg: Transaction = {
    ...destLeg,
    id: 500,
    accountId: 1,
    currency: "USD",
    amount: -500,
    kind: "brokerage_deposit_out",
    portfolioHoldingId: null,
  };

  it("opens the deposit form for a brokerage deposit's bank-side leg", async () => {
    (endpoints.loadPortfolioOperation as jest.Mock).mockResolvedValue({
      success: true,
      data: { op: "deposit", primaryTxId: 501 },
    });
    const { getByText, queryByText } = renderDetail(depositBankLeg);
    await waitFor(() => expect(getByText("In Portfolio")).toBeTruthy());
    expect(queryByText("Edit")).toBeNull(); // never the generic single-row edit
    expect(endpoints.getLinkedTransactions).not.toHaveBeenCalled(); // nor the transfer editor

    fireEvent.press(getByText("In Portfolio"));
    await waitFor(() =>
      expect(mockParentNavigate).toHaveBeenCalledWith("Portfolio", {
        screen: "OperationForm",
        params: { op: "deposit", editId: 501 },
      }),
    );
    expect(endpoints.loadPortfolioOperation).toHaveBeenCalledWith(500);
  });

  it("opens the buy form for a buy's cash leg, even with the holding name locked", async () => {
    (endpoints.loadPortfolioOperation as jest.Mock).mockResolvedValue({
      success: true,
      data: { op: "buy", primaryTxId: 600 },
    });
    const cashLeg: Transaction = {
      ...destLeg,
      id: 601,
      linkId: null,
      amount: -1500,
      kind: "buy_cash_leg",
      portfolioHolding: null, // cold DEK: the sleeve's name didn't decrypt
      portfolioHoldingId: 9,
    };
    const { getByText } = renderDetail(cashLeg);
    await waitFor(() => expect(getByText("In Portfolio")).toBeTruthy());
    fireEvent.press(getByText("In Portfolio"));
    await waitFor(() =>
      expect(mockParentNavigate).toHaveBeenCalledWith("Portfolio", {
        screen: "OperationForm",
        params: { op: "buy", editId: 600 },
      }),
    );
  });

  it("says to edit on the web when the app has no form for the operation", async () => {
    const alertSpy = jest.spyOn(Alert, "alert");
    (endpoints.loadPortfolioOperation as jest.Mock).mockResolvedValue({
      success: true,
      data: { op: "rebalance", primaryTxId: 700 },
    });
    const { getByText, queryByText } = renderDetail({ ...depositBankLeg, kind: "fx_fee" });
    await waitFor(() => expect(getByText("In Portfolio")).toBeTruthy());
    fireEvent.press(getByText("In Portfolio"));
    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith("Edit on the web", expect.stringContaining("Edit it on the web")),
    );
    expect(mockParentNavigate).not.toHaveBeenCalled();
    expect(queryByText("Save")).toBeNull();
  });

  it("shows the server's reason when the operation can't be loaded", async () => {
    const alertSpy = jest.spyOn(Alert, "alert");
    const reason = "Unsupported kind legacy_swap: only the 6 portfolio ops can be loaded for edit.";
    (endpoints.loadPortfolioOperation as jest.Mock).mockResolvedValue({ success: false, error: reason });
    const { getByText } = renderDetail({ ...depositBankLeg, kind: "sell", quantity: -3 });
    await waitFor(() => expect(getByText("In Portfolio")).toBeTruthy());
    fireEvent.press(getByText("In Portfolio"));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("Edit on the web", reason));
    expect(mockParentNavigate).not.toHaveBeenCalled();
  });

  it("keeps the generic edit for a plain transaction", async () => {
    const plain: Transaction = { ...destLeg, id: 800, linkId: null, kind: null, portfolioHoldingId: null };
    const { getByText, queryByText } = renderDetail(plain);
    await waitFor(() => expect(getByText("Edit")).toBeTruthy());
    expect(queryByText("In Portfolio")).toBeNull();
    fireEvent.press(getByText("Edit"));
    expect(getByText("Save")).toBeTruthy();
    expect(endpoints.loadPortfolioOperation).not.toHaveBeenCalled();
  });
});
