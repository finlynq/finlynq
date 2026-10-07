import React from "react";
import { render, waitFor, fireEvent, act } from "@testing-library/react-native";
import { Alert } from "react-native";
import AddTransactionScreen from "../screens/AddTransactionScreen";
import { endpoints } from "../api/client";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";

const mockGoBack = jest.fn();
const mockPop = jest.fn();
// Route params per test: create mode by default, `editTransfer` for an edit.
let mockRouteParams: Record<string, unknown> = { mode: "transfer" };
jest.mock("@react-navigation/native", () => ({
  ...jest.requireActual("@react-navigation/native"),
  useNavigation: () => ({ goBack: mockGoBack, navigate: jest.fn(), pop: mockPop }),
  useRoute: () => ({ key: "AddTransaction", name: "AddTransaction", params: mockRouteParams }),
}));

jest.mock("../api/client", () => ({
  endpoints: {
    getAccounts: jest.fn(),
    getAccountsDetailed: jest.fn(),
    getCategories: jest.fn(),
    getAccountBalances: jest.fn(),
    getDropdownOrder: jest.fn(),
    createTransaction: jest.fn(),
    recordTransfer: jest.fn(),
    updateTransfer: jest.fn(),
    getFxPreview: jest.fn(),
  },
}));

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};

// Picker defaults: From = first account by name, To = the next one.
const account = (id: number, name: string, currency: string) => ({
  id,
  name,
  currency,
  type: "A",
  group: "Banking",
  note: "",
});
const usdChequing = account(1, "A Chequing", "USD");
const eurSavings = account(2, "B Euro Savings", "EUR");
const usdSavings = account(3, "B USD Savings", "USD");

function setupAccounts(accounts: ReturnType<typeof account>[]) {
  (endpoints.getAccounts as jest.Mock).mockResolvedValue({ success: true, data: accounts });
  (endpoints.getAccountsDetailed as jest.Mock).mockResolvedValue({ success: true, data: accounts });
  (endpoints.getCategories as jest.Mock).mockResolvedValue({
    success: true,
    data: [{ id: 7, type: "E", group: "Food", name: "Groceries", note: "" }],
  });
  (endpoints.getAccountBalances as jest.Mock).mockResolvedValue({ success: true, data: [] });
  (endpoints.getDropdownOrder as jest.Mock).mockResolvedValue({ success: true, data: null });
}

function preview(converted: number, extra: Record<string, unknown> = {}) {
  return {
    success: true,
    data: { from: "USD", to: "EUR", date: "2026-10-07", rate: 0.92, source: "yahoo", amount: 100, converted, ...extra },
  };
}

async function renderTransfer() {
  const utils = render(
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
      <AddTransactionScreen />
    </ThemeContext.Provider>,
  );
  await waitFor(() => expect(utils.getByText("FROM")).toBeTruthy());
  return utils;
}

const receivedInput = (utils: Awaited<ReturnType<typeof renderTransfer>>) =>
  utils.getByLabelText("Amount received in EUR");

describe("AddTransactionScreen — transfers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRouteParams = { mode: "transfer" };
    (endpoints.recordTransfer as jest.Mock).mockResolvedValue({ success: true, data: {} });
  });

  it("asks for the amount received only when the currencies differ", async () => {
    setupAccounts([usdChequing, usdSavings]);
    const same = await renderTransfer();
    expect(same.queryByText(/AMOUNT RECEIVED/)).toBeNull();
    fireEvent.changeText(same.getByLabelText("Amount"), "50");
    // Same-currency transfers never ask for a rate.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    expect(endpoints.getFxPreview).not.toHaveBeenCalled();
    same.unmount();

    setupAccounts([usdChequing, eurSavings]);
    const cross = await renderTransfer();
    expect(cross.getByText("AMOUNT RECEIVED (EUR)")).toBeTruthy();
    expect(cross.queryByText(/Use the web app|do this on the web app/)).toBeNull();
  });

  it("pre-fills the amount received from the market-rate preview", async () => {
    setupAccounts([usdChequing, eurSavings]);
    (endpoints.getFxPreview as jest.Mock).mockResolvedValue(preview(92));
    const utils = await renderTransfer();
    fireEvent.changeText(utils.getByLabelText("Amount"), "100");

    await waitFor(() => expect(receivedInput(utils).props.value).toBe("92.00"));
    expect(endpoints.getFxPreview).toHaveBeenCalledWith(
      expect.objectContaining({ from: "USD", to: "EUR", amount: 100 }),
    );
    expect(utils.getByText("rate 0.920000 · yahoo")).toBeTruthy();
    expect(utils.getByText(/Pre-filled from market FX/)).toBeTruthy();
  });

  it("never overwrites an amount received the user typed", async () => {
    setupAccounts([usdChequing, eurSavings]);
    (endpoints.getFxPreview as jest.Mock).mockResolvedValueOnce(preview(92));
    const utils = await renderTransfer();
    fireEvent.changeText(utils.getByLabelText("Amount"), "100");
    await waitFor(() => expect(receivedInput(utils).props.value).toBe("92.00"));

    fireEvent.changeText(receivedInput(utils), "91.50");
    (endpoints.getFxPreview as jest.Mock).mockResolvedValueOnce(preview(184, { amount: 200 }));
    fireEvent.changeText(utils.getByLabelText("Amount"), "200");
    await waitFor(() => expect(endpoints.getFxPreview).toHaveBeenCalledTimes(2));
    // The later preview lands but leaves the typed value alone…
    await waitFor(() => expect(utils.getByText(/Market rate on .*: 0\.920000 \(yahoo\) → €184\.00/)).toBeTruthy());
    expect(receivedInput(utils).props.value).toBe("91.50");
    // …and the caption reports the rate the typed values imply.
    expect(utils.getByText("rate 0.457500 · entered")).toBeTruthy();
  });

  it("sends receivedAmount with a cross-currency transfer", async () => {
    setupAccounts([usdChequing, eurSavings]);
    (endpoints.getFxPreview as jest.Mock).mockResolvedValue(preview(92));
    const utils = await renderTransfer();
    fireEvent.changeText(utils.getByLabelText("Amount"), "100");
    await waitFor(() => expect(receivedInput(utils).props.value).toBe("92.00"));
    fireEvent.changeText(receivedInput(utils), "91.37");

    fireEvent.press(utils.getByText("Save"));
    await waitFor(() => expect(endpoints.recordTransfer).toHaveBeenCalledTimes(1));
    expect(endpoints.recordTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ fromAccountId: 1, toAccountId: 2, enteredAmount: 100, receivedAmount: 91.37 }),
    );
    await waitFor(() => expect(mockGoBack).toHaveBeenCalled());
  });

  it("sends a same-currency transfer exactly as before (no receivedAmount)", async () => {
    setupAccounts([usdChequing, usdSavings]);
    const utils = await renderTransfer();
    fireEvent.changeText(utils.getByLabelText("Amount"), "50");
    fireEvent.press(utils.getByText("Save"));
    await waitFor(() => expect(endpoints.recordTransfer).toHaveBeenCalledTimes(1));
    const body = (endpoints.recordTransfer as jest.Mock).mock.calls[0][0];
    expect(body).toEqual({
      fromAccountId: 1,
      toAccountId: 3,
      enteredAmount: 50,
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      note: undefined,
    });
    expect(body).not.toHaveProperty("receivedAmount");
    expect(endpoints.getFxPreview).not.toHaveBeenCalled();
  });

  it("says when there is no market rate, and handles the server's needs-override refusal", async () => {
    const alertSpy = jest.spyOn(Alert, "alert");
    setupAccounts([usdChequing, eurSavings]);
    (endpoints.getFxPreview as jest.Mock).mockResolvedValue({
      success: true,
      data: { from: "USD", to: "EUR", date: "2026-10-07", rate: 1, source: "fallback", amount: 100, converted: 100, needsOverride: true },
    });
    const utils = await renderTransfer();
    fireEvent.changeText(utils.getByLabelText("Amount"), "100");
    await waitFor(() => expect(utils.getByText(/No market rate is available for USD to EUR/)).toBeTruthy());
    // Nothing is pre-filled from a fallback rate.
    expect(receivedInput(utils).props.value).toBe("");

    (endpoints.recordTransfer as jest.Mock).mockResolvedValueOnce({
      success: false,
      error: "No FX rate available for EUR.",
      code: "fx-currency-needs-override",
    });
    fireEvent.press(utils.getByText("Save"));
    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith("Enter the amount received", expect.stringContaining("Type the amount")),
    );
    expect((endpoints.recordTransfer as jest.Mock).mock.calls[0][0]).not.toHaveProperty("receivedAmount");
    expect(mockGoBack).not.toHaveBeenCalled();

    // Typing the amount received and saving again books it.
    fireEvent.changeText(receivedInput(utils), "93.10");
    fireEvent.press(utils.getByText("Save"));
    await waitFor(() => expect(endpoints.recordTransfer).toHaveBeenCalledTimes(2));
    expect((endpoints.recordTransfer as jest.Mock).mock.calls[1][0]).toMatchObject({ receivedAmount: 93.1 });
  });
});

// ─── Editing an existing pair ───────────────────────────────────────────────
const sameCurrencySeed = {
  transactionId: 42,
  fromAccountId: 1,
  toAccountId: 3,
  fromCurrency: "USD",
  toCurrency: "USD",
  enteredAmount: 250,
  receivedAmount: 250,
  date: "2026-09-14",
  note: "Rent float",
};
const crossCurrencySeed = {
  ...sameCurrencySeed,
  transactionId: 77,
  toAccountId: 2,
  toCurrency: "EUR",
  enteredAmount: 100,
  receivedAmount: 91.37,
};

describe("AddTransactionScreen — editing a transfer pair", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (endpoints.updateTransfer as jest.Mock).mockResolvedValue({ success: true, data: { ok: true } });
  });

  it("opens pre-filled from both legs and PUTs a same-currency pair", async () => {
    mockRouteParams = { mode: "transfer", editTransfer: sameCurrencySeed };
    setupAccounts([usdChequing, eurSavings, usdSavings]);
    const utils = await renderTransfer();
    expect(utils.getByText("Edit Transfer")).toBeTruthy();
    expect(utils.queryByText("Expense")).toBeNull(); // no mode switch on an edit
    expect(utils.getByLabelText("Amount").props.value).toBe("250");
    expect(utils.getByDisplayValue("2026-09-14")).toBeTruthy();
    expect(utils.getByText("A Chequing")).toBeTruthy();
    expect(utils.getByText("B USD Savings")).toBeTruthy();
    expect(utils.getByLabelText("Note").props.value).toBe("Rent float");
    expect(utils.queryByText(/AMOUNT RECEIVED/)).toBeNull();
    // Edit mode reads accounts with archived ones included.
    expect(endpoints.getAccountsDetailed).toHaveBeenCalled();

    fireEvent.changeText(utils.getByLabelText("Amount"), "275");
    fireEvent.press(utils.getByText("Save"));
    await waitFor(() => expect(endpoints.updateTransfer).toHaveBeenCalledTimes(1));
    expect(endpoints.updateTransfer).toHaveBeenCalledWith({
      transactionId: 42,
      fromAccountId: 1,
      toAccountId: 3,
      enteredAmount: 275,
      date: "2026-09-14",
      note: "Rent float",
    });
    expect(endpoints.recordTransfer).not.toHaveBeenCalled();
    expect(endpoints.getFxPreview).not.toHaveBeenCalled();
    // Back past the stale detail screen.
    await waitFor(() => expect(mockPop).toHaveBeenCalledWith(2));
  });

  it("keeps a cross-currency pair's booked amount received and PUTs it", async () => {
    mockRouteParams = { mode: "transfer", editTransfer: crossCurrencySeed };
    setupAccounts([usdChequing, eurSavings]);
    (endpoints.getFxPreview as jest.Mock).mockResolvedValue(preview(92));
    const utils = await renderTransfer();
    expect(receivedInput(utils).props.value).toBe("91.37");
    expect(utils.getByText("rate 0.913700 · as booked")).toBeTruthy();
    expect(utils.getByText(/Saved from the original transfer/)).toBeTruthy();

    // The market-rate preview lands but never replaces the booked amount.
    await waitFor(() => expect(endpoints.getFxPreview).toHaveBeenCalled());
    await waitFor(() => expect(utils.getByText(/Market rate on .*: 0\.920000 \(yahoo\)/)).toBeTruthy());
    expect(receivedInput(utils).props.value).toBe("91.37");

    fireEvent.press(utils.getByText("Save"));
    await waitFor(() => expect(endpoints.updateTransfer).toHaveBeenCalledTimes(1));
    expect(endpoints.updateTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: 77,
        fromAccountId: 1,
        toAccountId: 2,
        enteredAmount: 100,
        receivedAmount: 91.37,
        date: "2026-09-14",
      }),
    );
  });

  it("drops the 'as booked' label once the amounts change", async () => {
    mockRouteParams = { mode: "transfer", editTransfer: crossCurrencySeed };
    setupAccounts([usdChequing, eurSavings]);
    (endpoints.getFxPreview as jest.Mock).mockResolvedValue(preview(92));
    const utils = await renderTransfer();
    fireEvent.changeText(receivedInput(utils), "90");
    expect(utils.getByText("rate 0.900000 · entered")).toBeTruthy();
    expect(utils.getByText(/Pre-filled from market FX/)).toBeTruthy();
  });

  it("leaves an encrypted (unreadable) note alone unless retyped", async () => {
    mockRouteParams = { mode: "transfer", editTransfer: { ...sameCurrencySeed, note: null } };
    setupAccounts([usdChequing, usdSavings]);
    const utils = await renderTransfer();
    expect(utils.getByLabelText("Note").props.value).toBe("");
    fireEvent.press(utils.getByText("Save"));
    await waitFor(() => expect(endpoints.updateTransfer).toHaveBeenCalledTimes(1));
    expect((endpoints.updateTransfer as jest.Mock).mock.calls[0][0]).not.toHaveProperty("note");
  });

  it("shows the server's error and stays open when the PUT is refused", async () => {
    const alertSpy = jest.spyOn(Alert, "alert");
    mockRouteParams = { mode: "transfer", editTransfer: sameCurrencySeed };
    setupAccounts([usdChequing, usdSavings]);
    (endpoints.updateTransfer as jest.Mock).mockResolvedValueOnce({ success: false, error: "Transfer not found" });
    const utils = await renderTransfer();
    fireEvent.press(utils.getByText("Save"));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("Error", "Transfer not found"));
    expect(mockPop).not.toHaveBeenCalled();
    expect(mockGoBack).not.toHaveBeenCalled();
    expect(utils.getByText("Edit Transfer")).toBeTruthy();
  });
});
