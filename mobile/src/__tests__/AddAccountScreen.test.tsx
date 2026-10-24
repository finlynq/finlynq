// Add Account's currency picker (in-app feedback 2026-10-23: Swiss francs could
// be picked as the display currency but not for a new account, because the
// screen offered a fixed CAD / USD / EUR / GBP list and started in CAD).
import React from "react";
import { render, waitFor, fireEvent } from "@testing-library/react-native";
import AddAccountScreen from "../screens/AddAccountScreen";
import { endpoints } from "../api/client";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import type { AccountDetailRow } from "../../../shared/types";

const mockGoBack = jest.fn();
let mockRouteParams: { account?: AccountDetailRow } | undefined;
jest.mock("@react-navigation/native", () => ({
  ...jest.requireActual("@react-navigation/native"),
  useNavigation: () => ({ goBack: mockGoBack }),
  useRoute: () => ({ key: "AddAccount", name: "AddAccount", params: mockRouteParams }),
}));

jest.mock("../api/client", () => ({
  endpoints: {
    getActiveCurrencies: jest.fn(),
    getDisplayCurrency: jest.fn(),
    createAccount: jest.fn(),
    updateAccount: jest.fn(),
  },
}));

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};

const createAccount = endpoints.createAccount as jest.Mock;
const updateAccount = endpoints.updateAccount as jest.Mock;
const getActiveCurrencies = endpoints.getActiveCurrencies as jest.Mock;
const getDisplayCurrency = endpoints.getDisplayCurrency as jest.Mock;

function renderScreen() {
  return render(
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
      <AddAccountScreen />
    </ThemeContext.Provider>,
  );
}

type Utils = ReturnType<typeof renderScreen>;
const saveNew = (u: Utils, name: string) => {
  fireEvent.changeText(u.getByPlaceholderText("e.g. Everyday Checking"), name);
  fireEvent.press(u.getByText("Save"));
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRouteParams = undefined;
  getActiveCurrencies.mockResolvedValue({ success: true, data: { active: ["CHF", "EUR"] } });
  getDisplayCurrency.mockResolvedValue({ success: true, data: { displayCurrency: "CHF" } });
  createAccount.mockResolvedValue({ success: true, data: { id: 31 } });
  updateAccount.mockResolvedValue({ success: true, data: { id: 7 } });
});

describe("AddAccountScreen: currency", () => {
  it("offers the user's own currencies and starts a new account in the display currency", async () => {
    const u = renderScreen();
    await waitFor(() => expect(u.getByText("CHF")).toBeTruthy());
    expect(u.getByText("EUR")).toBeTruthy();
    // The old fixed list is gone once the user's own list has arrived.
    expect(u.queryByText("CAD")).toBeNull();
    expect(u.queryByText("GBP")).toBeNull();

    saveNew(u, "Swiss savings");
    await waitFor(() =>
      expect(createAccount).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Swiss savings", currency: "CHF" }),
      ),
    );
    expect(mockGoBack).toHaveBeenCalled();
  });

  it("picks any other currency from More…", async () => {
    const u = renderScreen();
    await waitFor(() => expect(u.getByText("CHF")).toBeTruthy());

    fireEvent.press(u.getByLabelText("More currencies"));
    fireEvent.press(u.getByText("SEK — Swedish Krona"));
    // The pick is shown as the selected chip and the sheet is closed.
    expect(u.getByText("SEK")).toBeTruthy();
    expect(u.queryByText("SEK — Swedish Krona")).toBeNull();

    saveNew(u, "Stockholm account");
    await waitFor(() =>
      expect(createAccount).toHaveBeenCalledWith(expect.objectContaining({ currency: "SEK" })),
    );
  });

  it("keeps the user's pick when the display currency arrives late", async () => {
    let resolveDisplay: (v: unknown) => void = () => {};
    getDisplayCurrency.mockReturnValue(new Promise((r) => (resolveDisplay = r)));
    const u = renderScreen();
    await waitFor(() => expect(u.getByText("EUR")).toBeTruthy());

    fireEvent.press(u.getByText("EUR"));
    resolveDisplay({ success: true, data: { displayCurrency: "CHF" } });

    saveNew(u, "Euro account");
    await waitFor(() =>
      expect(createAccount).toHaveBeenCalledWith(expect.objectContaining({ currency: "EUR" })),
    );
  });

  it("falls back to the common list, plus More…, when the user's list can't be loaded", async () => {
    getActiveCurrencies.mockResolvedValue({ success: false, error: "offline" });
    getDisplayCurrency.mockResolvedValue({ success: false, error: "offline" });
    const u = renderScreen();
    await waitFor(() => expect(getActiveCurrencies).toHaveBeenCalled());

    for (const c of ["CAD", "USD", "EUR", "GBP"]) expect(u.getByText(c)).toBeTruthy();
    expect(u.getByLabelText("More currencies")).toBeTruthy();

    // Never CAD by default: the USD fallback matches the server's default.
    saveNew(u, "Fallback account");
    await waitFor(() =>
      expect(createAccount).toHaveBeenCalledWith(expect.objectContaining({ currency: "USD" })),
    );
  });

  it("editing keeps an account's currency even when it isn't in the user's list", async () => {
    mockRouteParams = {
      account: { id: 7, type: "A", group: "Savings", name: "Old yen account", currency: "JPY", mode: "manual" },
    };
    const u = renderScreen();
    await waitFor(() => expect(u.getByText("CHF")).toBeTruthy());
    expect(u.getByText("JPY")).toBeTruthy();
    // An existing account never asks for the display currency.
    expect(getDisplayCurrency).not.toHaveBeenCalled();

    fireEvent.press(u.getByText("Save"));
    await waitFor(() =>
      expect(updateAccount).toHaveBeenCalledWith(expect.objectContaining({ id: 7, currency: "JPY" })),
    );
  });
});
