import React from "react";
import { render, waitFor, fireEvent } from "@testing-library/react-native";
import AccountsScreen from "../screens/AccountsScreen";
import { endpoints } from "../api/client";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";

// The shared RN mock has no SectionList — a minimal local one that renders
// section headers, items, and the empty/footer slots.
jest.mock("react-native", () => {
  const React = require("react");
  const RN = jest.requireActual("react-native");
  const slot = (C: unknown) =>
    C ? (typeof C === "function" ? React.createElement(C as React.ComponentType) : C) : null;
  const SectionList = ({
    sections,
    renderItem,
    renderSectionHeader,
    keyExtractor,
    ListEmptyComponent,
    ListFooterComponent,
  }: {
    sections: Array<{ key?: string; data: unknown[] }>;
    renderItem: (a: { item: unknown; index: number; section: unknown }) => React.ReactNode;
    renderSectionHeader?: (a: { section: unknown }) => React.ReactNode;
    keyExtractor?: (item: unknown, i: number) => string;
    ListEmptyComponent?: unknown;
    ListFooterComponent?: unknown;
  }) =>
    React.createElement(
      RN.View,
      null,
      sections.length === 0 ? slot(ListEmptyComponent) : null,
      sections.map((section, si) =>
        React.createElement(
          React.Fragment,
          { key: section.key ?? si },
          renderSectionHeader ? renderSectionHeader({ section }) : null,
          section.data.map((item, i) =>
            React.createElement(
              React.Fragment,
              { key: keyExtractor ? keyExtractor(item, i) : i },
              renderItem({ item, index: i, section }),
            ),
          ),
        ),
      ),
      slot(ListFooterComponent),
    );
  return { ...RN, SectionList };
});

const mockNavigate = jest.fn();

jest.mock("../api/client", () => ({
  endpoints: {
    getAccountsOverview: jest.fn(),
    getAccountGroupOrder: jest.fn(),
    getDropdownOrder: jest.fn(),
  },
}));

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};

const row = (p: Record<string, unknown>) => ({
  accountType: "A",
  accountGroup: "Banking",
  currency: "CAD",
  balance: 0,
  convertedBalance: 0,
  displayCurrency: "CAD",
  ...p,
});

function renderScreen() {
  const navigation = { navigate: mockNavigate, goBack: jest.fn() };
  return render(
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <AccountsScreen navigation={navigation as any} route={{ key: "k", name: "AccountsList" } as any} />
    </ThemeContext.Provider>,
  );
}

describe("AccountsScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (endpoints.getAccountsOverview as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        displayCurrency: "CAD",
        balances: [
          row({ accountId: 1, accountName: "Chequing", alias: "Daily", balance: 1000, convertedBalance: 1000 }),
          row({ accountId: 2, accountName: "Old savings", balance: 500, convertedBalance: 500, archived: true }),
          row({ accountId: 3, accountName: "Visa", accountType: "L", accountGroup: "Cards", balance: -200, convertedBalance: -200 }),
        ],
      },
    });
    (endpoints.getAccountGroupOrder as jest.Mock).mockResolvedValue({ success: true, data: { order: { A: [], L: [] } } });
    (endpoints.getDropdownOrder as jest.Mock).mockResolvedValue({ success: true, data: { version: 1, lists: {} } });
  });

  it("keeps archived accounts in net worth but hides them behind a toggle", async () => {
    const { getByText, queryByText } = renderScreen();
    // 1000 + 500 (archived) − 200, in the dashboard's display currency.
    await waitFor(() => expect(getByText("C$1,300")).toBeTruthy());
    expect(queryByText("Old savings")).toBeNull();

    fireEvent.press(getByText("Show archived (1)"));
    expect(getByText("Old savings")).toBeTruthy();
    expect(getByText("CAD · Archived")).toBeTruthy();
    expect(getByText("Hide archived")).toBeTruthy();
  });

  it("sections Assets before Liabilities and shows the alias", async () => {
    const { getByText, getAllByText } = renderScreen();
    await waitFor(() => expect(getByText("Daily")).toBeTruthy());
    const headers = getAllByText(/^(Assets|Liabilities)$/).map((n) => n.props.children);
    expect(headers).toEqual(["Assets", "Liabilities"]);
  });

  it("falls back to USD when the overview has no display currency", async () => {
    (endpoints.getAccountsOverview as jest.Mock).mockResolvedValue({
      success: true,
      data: { displayCurrency: "", balances: [] },
    });
    const { getByText } = renderScreen();
    await waitFor(() => expect(getByText("$0")).toBeTruthy());
    expect(getByText("No accounts yet")).toBeTruthy();
  });
});
