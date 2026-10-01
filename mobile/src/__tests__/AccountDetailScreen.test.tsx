import React from "react";
import { render, waitFor, fireEvent, act } from "@testing-library/react-native";
import AccountDetailScreen from "../screens/AccountDetailScreen";
import { endpoints } from "../api/client";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import type { AccountBalance } from "../../../shared/types";

jest.mock("../components/inbox/ModePicker", () => ({ ModePicker: () => null }));

// The shared RN FlatList mock drops ListHeaderComponent / ListFooterComponent
// (the hero + manage card live there) — a local one that renders every slot.
jest.mock("react-native", () => {
  const React = require("react");
  const RN = jest.requireActual("react-native");
  const slot = (C: unknown) =>
    C ? (typeof C === "function" ? React.createElement(C as React.ComponentType) : C) : null;
  const FlatList = ({
    data,
    renderItem,
    keyExtractor,
    ListHeaderComponent,
    ListEmptyComponent,
    ListFooterComponent,
    ...props
  }: {
    data: unknown[];
    renderItem: (a: { item: unknown; index: number }) => React.ReactNode;
    keyExtractor?: (item: unknown, i: number) => string;
    ListHeaderComponent?: unknown;
    ListEmptyComponent?: unknown;
    ListFooterComponent?: unknown;
  }) =>
    React.createElement(
      RN.View,
      props,
      slot(ListHeaderComponent),
      !data || data.length === 0
        ? slot(ListEmptyComponent)
        : data.map((item, i) =>
            React.createElement(
              React.Fragment,
              { key: keyExtractor ? keyExtractor(item, i) : i },
              renderItem({ item, index: i }),
            ),
          ),
      slot(ListFooterComponent),
    );
  return { ...RN, FlatList };
});

jest.mock("../api/client", () => ({
  endpoints: {
    getTransactions: jest.fn(),
    getAccountsDetailed: jest.fn(),
    getAccountBalances: jest.fn(),
    updateAccount: jest.fn(),
    deleteAccountById: jest.fn(),
  },
}));

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};

const cash: AccountBalance = {
  accountId: 7,
  accountName: "Chequing",
  accountType: "A",
  accountGroup: "",
  currency: "USD",
  balance: 100,
  convertedBalance: 100,
  displayCurrency: "USD",
};

const detailRow = (p: Record<string, unknown> = {}) => ({
  id: 7,
  type: "A",
  group: "",
  name: "Chequing",
  alias: null,
  currency: "USD",
  archived: false,
  isInvestment: false,
  mode: "manual",
  ...p,
});

const mockNavigate = jest.fn();
const mockParentNavigate = jest.fn();

function renderScreen(account: AccountBalance = cash) {
  const navigation = {
    navigate: mockNavigate,
    goBack: jest.fn(),
    getParent: () => ({ navigate: mockParentNavigate }),
  };
  return render(
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
      <AccountDetailScreen
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        navigation={navigation as any}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        route={{ key: "k", name: "AccountDetail", params: { account } } as any}
      />
    </ThemeContext.Provider>,
  );
}

describe("AccountDetailScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (endpoints.getTransactions as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (endpoints.getAccountsDetailed as jest.Mock).mockResolvedValue({ success: true, data: [detailRow()] });
    (endpoints.getAccountBalances as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ ...cash, balance: 250, convertedBalance: 250 }],
    });
  });

  it("refreshes the header balance instead of trusting the route snapshot", async () => {
    const { getByText, queryByText } = renderScreen();
    await waitFor(() => expect(getByText("$250.00")).toBeTruthy());
    expect(queryByText("$100.00")).toBeNull();
  });

  it("renders the meta line without a leading separator when the group is empty", async () => {
    const { getByText, queryByText } = renderScreen();
    await waitFor(() => expect(getByText("Edit account")).toBeTruthy());
    expect(getByText("USD")).toBeTruthy();
    expect(queryByText(" · USD")).toBeNull();
  });

  it("loads an archived account, shows its note and hides quick-add", async () => {
    (endpoints.getAccountsDetailed as jest.Mock).mockResolvedValue({
      success: true,
      data: [detailRow({ archived: true })],
    });
    const { getByText, queryByText } = renderScreen({ ...cash, archived: true });
    await waitFor(() => expect(getByText(/This account is archived/)).toBeTruthy());
    expect(queryByText("+ Add transaction")).toBeNull();
    expect(queryByText("Archive account")).toBeNull();
  });

  it("shows an error with Retry instead of spinning forever when the detail fetch fails", async () => {
    (endpoints.getAccountsDetailed as jest.Mock).mockResolvedValueOnce({ success: false, error: "Boom" });
    const { getByText } = renderScreen();
    await waitFor(() => expect(getByText("Boom")).toBeTruthy());

    fireEvent.press(getByText("Retry"));
    await waitFor(() => expect(getByText("Edit account")).toBeTruthy());
    expect(endpoints.getAccountsDetailed).toHaveBeenCalledTimes(2);
  });

  it("opens the Portfolio OperationForm for an investment account", async () => {
    const brokerage: AccountBalance = { ...cash, accountId: 9, accountName: "Brokerage", isInvestment: true };
    (endpoints.getAccountsDetailed as jest.Mock).mockResolvedValue({
      success: true,
      data: [detailRow({ id: 9, name: "Brokerage", isInvestment: true })],
    });
    (endpoints.getAccountBalances as jest.Mock).mockResolvedValue({ success: true, data: [brokerage] });
    const { getByText, queryByText } = renderScreen(brokerage);
    await waitFor(() => expect(getByText("+ Investment transaction")).toBeTruthy());
    expect(queryByText(/manage on web/)).toBeNull();

    fireEvent.press(getByText("+ Investment transaction"));
    fireEvent.press(getByText("Buy"));
    expect(mockParentNavigate).toHaveBeenCalledWith("Portfolio", {
      screen: "OperationForm",
      params: { op: "buy", preselectAccountId: 9 },
      initial: false,
    });
  });

  it("supports pull-to-refresh", async () => {
    const { getByText, UNSAFE_root } = renderScreen();
    await waitFor(() => expect(getByText("Edit account")).toBeTruthy());
    const list = UNSAFE_root.findAll((n) => typeof n.props.onRefresh === "function")[0];
    expect(list).toBeTruthy();
    await act(async () => {
      await list.props.onRefresh();
    });
    expect(endpoints.getTransactions).toHaveBeenCalledTimes(2);
    expect(endpoints.getAccountsDetailed).toHaveBeenCalledTimes(2);
  });
});
