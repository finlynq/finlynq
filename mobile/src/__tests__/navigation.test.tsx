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

jest.mock("../screens/SettingsScreen", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return () => React.createElement(Text, null, "SettingsScreen");
});

jest.mock("../screens/UnlockScreen", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return (props: any) => React.createElement(Text, null, "UnlockScreen");
});

jest.mock("../api/client", () => ({
  endpoints: {
    getUnlockStatus: jest.fn(),
    getDashboard: jest.fn(),
    getHealthScore: jest.fn(),
    getBudgets: jest.fn(),
    getTransactions: jest.fn(),
    getAccounts: jest.fn(),
    getCategories: jest.fn(),
  },
}));

// Mock useAuth with controllable state
let mockAuthReturn = {
  isUnlocked: true,
  isLoading: false,
  needsSetup: false,
  error: null,
  biometricAvailable: false,
  biometricEnabled: false,
  autoLockMinutes: 5,
  unlock: jest.fn(),
  biometricUnlock: jest.fn(),
  lock: jest.fn(),
  checkStatus: jest.fn(),
  setBiometricEnabled: jest.fn(),
  setAutoLockMinutes: jest.fn(),
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
    <ThemeContext.Provider value={theme}>{component}</ThemeContext.Provider>
  );
}

describe("TabNavigator", () => {
  it("renders without crashing", () => {
    const { toJSON } = renderWithTheme(<TabNavigator />);
    expect(toJSON()).toBeTruthy();
  });

  it("defines all five tab screens", () => {
    const { toJSON } = renderWithTheme(<TabNavigator />);
    const tree = JSON.stringify(toJSON());
    expect(tree).toContain("Dashboard");
    expect(tree).toContain("Transactions");
    expect(tree).toContain("Import");
    expect(tree).toContain("Budgets");
    expect(tree).toContain("Settings");
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
      isLoading: false,
      needsSetup: false,
      error: null,
      biometricAvailable: false,
      biometricEnabled: false,
      autoLockMinutes: 5,
      unlock: jest.fn(),
      biometricUnlock: jest.fn(),
      lock: jest.fn(),
      checkStatus: jest.fn(),
      setBiometricEnabled: jest.fn(),
      setAutoLockMinutes: jest.fn(),
    };
  });

  it("shows TabNavigator when unlocked", () => {
    mockAuthReturn.isUnlocked = true;
    const { toJSON } = renderWithTheme(<RootNavigator />);
    const tree = JSON.stringify(toJSON());
    // When unlocked, should show tab navigator with screen names
    expect(tree).toContain("Dashboard");
  });

  it("shows UnlockScreen when locked", () => {
    mockAuthReturn.isUnlocked = false;
    const { getByText } = renderWithTheme(<RootNavigator />);
    expect(getByText("UnlockScreen")).toBeTruthy();
  });
});
