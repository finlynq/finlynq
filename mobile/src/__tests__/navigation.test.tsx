import React from "react";
import { render } from "@testing-library/react-native";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import TabNavigator from "../navigation/TabNavigator";
import TransactionsStack from "../navigation/TransactionsStack";
import RootNavigator from "../navigation/RootNavigator";

// Mock all screens to simple components
jest.mock("../screens/DashboardScreen", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return () => React.createElement(Text, null, "DashboardScreen");
});

jest.mock("../screens/TransactionsScreen", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return () => React.createElement(Text, null, "TransactionsScreen");
});

jest.mock("../screens/TransactionDetailScreen", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return () => React.createElement(Text, null, "TransactionDetailScreen");
});

jest.mock("../screens/AddTransactionScreen", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return () => React.createElement(Text, null, "AddTransactionScreen");
});

jest.mock("../screens/ImportScreen", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return () => React.createElement(Text, null, "ImportScreen");
});

jest.mock("../screens/BudgetsScreen", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return () => React.createElement(Text, null, "BudgetsScreen");
});

jest.mock("../screens/AccountsScreen", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return () => React.createElement(Text, null, "AccountsScreen");
});

jest.mock("../screens/AccountDetailScreen", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return () => React.createElement(Text, null, "AccountDetailScreen");
});

jest.mock("../screens/PortfolioScreen", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return () => React.createElement(Text, null, "PortfolioScreen");
});

jest.mock("../screens/GoalsScreen", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return () => React.createElement(Text, null, "GoalsScreen");
});

jest.mock("../screens/MoreScreen", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return () => React.createElement(Text, null, "MoreScreen");
});

jest.mock("../screens/SettingsScreen", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return () => React.createElement(Text, null, "SettingsScreen");
});

jest.mock("../screens/LockScreen", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return (props: any) => React.createElement(Text, null, "LockScreen");
});

jest.mock("../screens/LoginScreen", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return (props: any) => React.createElement(Text, null, "LoginScreen");
});

jest.mock("../api/client", () => ({
  endpoints: {
    getDashboard: jest.fn(),
    getHealthScore: jest.fn(),
    getBudgets: jest.fn(),
    getTransactions: jest.fn(),
    getAccounts: jest.fn(),
    getAccountBalances: jest.fn(),
    getCategories: jest.fn(),
    getGoals: jest.fn(),
    getPortfolioOverview: jest.fn(),
    recordTransfer: jest.fn(),
  },
  getSession: jest.fn(),
}));

// Mock useAuth with controllable state
let mockAuthReturn = {
  isUnlocked: true,
  hasSession: true,
  isLoading: false,
  error: null,
  biometricAvailable: false,
  biometricEnabled: false,
  autoLockMinutes: 5,
  signIn: jest.fn(),
  register: jest.fn(),
  signOut: jest.fn(),
  biometricUnlock: jest.fn(),
  saveServerUrl: jest.fn(),
  setBiometricEnabled: jest.fn(),
  setAutoLockMinutes: jest.fn(),
  clearError: jest.fn(),
};

jest.mock("../hooks/useAuth", () => ({
  useAuth: () => mockAuthReturn,
}));

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};

function renderWithTheme(component: React.ReactElement) {
  return render(
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
      {component}
    </ThemeContext.Provider>
  );
}

describe("TabNavigator", () => {
  it("renders without crashing", () => {
    const { toJSON } = renderWithTheme(<TabNavigator />);
    expect(toJSON()).toBeTruthy();
  });

  it("defines all five Option B tab screens", () => {
    const { toJSON } = renderWithTheme(<TabNavigator />);
    const tree = JSON.stringify(toJSON());
    expect(tree).toContain("Home");
    expect(tree).toContain("Accounts");
    expect(tree).toContain("Portfolio");
    expect(tree).toContain("Transactions");
    expect(tree).toContain("More");
  });
});

describe("TransactionsStack", () => {
  it("renders without crashing", () => {
    const { toJSON } = renderWithTheme(<TransactionsStack />);
    expect(toJSON()).toBeTruthy();
  });

  it("defines stack screens", () => {
    const { toJSON } = renderWithTheme(<TransactionsStack />);
    const tree = JSON.stringify(toJSON());
    expect(tree).toContain("TransactionsList");
    expect(tree).toContain("TransactionDetail");
    expect(tree).toContain("AddTransaction");
  });
});

describe("RootNavigator", () => {
  beforeEach(() => {
    mockAuthReturn = {
      isUnlocked: true,
      hasSession: true,
      isLoading: false,
      error: null,
      biometricAvailable: false,
      biometricEnabled: false,
      autoLockMinutes: 5,
      signIn: jest.fn(),
      register: jest.fn(),
      signOut: jest.fn(),
      biometricUnlock: jest.fn(),
      saveServerUrl: jest.fn(),
      setBiometricEnabled: jest.fn(),
      setAutoLockMinutes: jest.fn(),
      clearError: jest.fn(),
    };
  });

  it("shows a loading indicator while bootstrapping", () => {
    mockAuthReturn.isLoading = true;
    const { getByText, queryByText } = renderWithTheme(<RootNavigator />);
    // No screen content yet — still validating the stored session.
    expect(queryByText("LoginScreen")).toBeNull();
    expect(queryByText("LockScreen")).toBeNull();
  });

  it("shows TabNavigator when unlocked", () => {
    mockAuthReturn.isUnlocked = true;
    const { toJSON } = renderWithTheme(<RootNavigator />);
    const tree = JSON.stringify(toJSON());
    // When unlocked, should show tab navigator with the Home tab.
    expect(tree).toContain("Home");
  });

  it("shows LoginScreen when there is no session", () => {
    mockAuthReturn.isUnlocked = false;
    mockAuthReturn.hasSession = false;
    const { getByText } = renderWithTheme(<RootNavigator />);
    expect(getByText("LoginScreen")).toBeTruthy();
  });

  it("shows LockScreen when a session is held but locked behind biometrics", () => {
    mockAuthReturn.isUnlocked = false;
    mockAuthReturn.hasSession = true;
    mockAuthReturn.biometricAvailable = true;
    mockAuthReturn.biometricEnabled = true;
    const { getByText } = renderWithTheme(<RootNavigator />);
    expect(getByText("LockScreen")).toBeTruthy();
  });

  it("falls back to LoginScreen when locked but biometrics are off", () => {
    mockAuthReturn.isUnlocked = false;
    mockAuthReturn.hasSession = true;
    mockAuthReturn.biometricAvailable = true;
    mockAuthReturn.biometricEnabled = false;
    const { getByText } = renderWithTheme(<RootNavigator />);
    expect(getByText("LoginScreen")).toBeTruthy();
  });
});
