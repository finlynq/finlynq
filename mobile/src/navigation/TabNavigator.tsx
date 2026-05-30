import React from "react";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import type { NavigatorScreenParams } from "@react-navigation/native";
import { StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme";
import { Icon, type IconName } from "../components/icon";
import DashboardScreen from "../screens/DashboardScreen";
import AccountsStack from "./AccountsStack";
import PortfolioScreen from "../screens/PortfolioScreen";
import TransactionsStack from "./TransactionsStack";
import MoreStack, { type MoreStackParamList } from "./MoreStack";

// Option B — "Wealth-led" IA: Home · Accounts · Portfolio · Transactions · More.
export type TabParamList = {
  Home: undefined;
  Accounts: undefined;
  Portfolio: undefined;
  Transactions: undefined;
  // Nested-stack params so we can navigate the More tab back to its menu root.
  More: NavigatorScreenParams<MoreStackParamList> | undefined;
};

const ICON_BY_ROUTE: Record<keyof TabParamList, IconName> = {
  Home: "dashboard",
  Accounts: "accounts",
  Portfolio: "portfolio",
  Transactions: "transactions",
  More: "more",
};

const Tab = createBottomTabNavigator<TabParamList>();

export default function TabNavigator() {
  const { colors } = useTheme();
  // Add the bottom safe-area inset to the bar so the labels sit ABOVE the OS
  // gesture/home indicator instead of overlapping it. With edge-to-edge enabled
  // and an explicit height, RN would otherwise ignore the inset and the bar
  // draws under the system navigation area.
  const insets = useSafeAreaInsets();

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        // The tab bar is always dark in both light and dark mode (mirrors the
        // web sidebar) — uses the sidebar* token set.
        tabBarStyle: {
          backgroundColor: colors.sidebar,
          borderTopColor: colors.sidebarBorder,
          borderTopWidth: StyleSheet.hairlineWidth,
          height: 60 + insets.bottom,
          paddingBottom: insets.bottom + 6,
          paddingTop: 6,
        },
        tabBarActiveTintColor: colors.sidebarPrimary,
        tabBarInactiveTintColor: colors.sidebarMutedForeground,
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
        tabBarIcon: ({ color }) => (
          <Icon name={ICON_BY_ROUTE[route.name]} size={22} color={color} />
        ),
      })}
    >
      <Tab.Screen name="Home" component={DashboardScreen} />
      <Tab.Screen name="Accounts" component={AccountsStack} />
      <Tab.Screen name="Portfolio" component={PortfolioScreen} />
      <Tab.Screen name="Transactions" component={TransactionsStack} />
      <Tab.Screen
        name="More"
        component={MoreStack}
        // Always return the More tab to its menu root. `popToTopOnBlur` covers
        // the "drill in → switch tab → come back" case; the `tabPress` guard
        // covers re-tapping More while already inside a deep More screen.
        options={{ popToTopOnBlur: true }}
        listeners={({ navigation }) => ({
          tabPress: () => {
            if (navigation.isFocused()) {
              navigation.navigate("More", { screen: "MoreHome" });
            }
          },
        })}
      />
    </Tab.Navigator>
  );
}
