import React from "react";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { View, Text, StyleSheet } from "react-native";
import { useTheme } from "../theme";
import DashboardScreen from "../screens/DashboardScreen";
import TransactionsStack from "./TransactionsStack";
import ImportScreen from "../screens/ImportScreen";
import BudgetsScreen from "../screens/BudgetsScreen";
import SettingsScreen from "../screens/SettingsScreen";

export type TabParamList = {
  Dashboard: undefined;
  Transactions: undefined;
  Import: undefined;
  Budgets: undefined;
  Settings: undefined;
};

const Tab = createBottomTabNavigator<TabParamList>();

function TabIcon({ name, focused, color }: { name: string; focused: boolean; color: string }) {
  const icons: Record<string, string> = {
    Dashboard: "⊞",
    Transactions: "⇄",
    Import: "↓",
    Budgets: "◎",
    Settings: "⚙",
  };
  return (
    <View style={styles.iconContainer}>
      <Text style={[styles.icon, { color }]}>{icons[name] ?? "•"}</Text>
      {focused && <View style={[styles.dot, { backgroundColor: color }]} />}
    </View>
  );
}

export default function TabNavigator() {
  const theme = useTheme();

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarStyle: {
          backgroundColor: theme.colors.card,
          borderTopColor: theme.colors.border,
          borderTopWidth: StyleSheet.hairlineWidth,
          height: 56,
          paddingBottom: 4,
        },
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.mutedForeground,
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: "600",
        },
        tabBarIcon: ({ focused, color }) => (
          <TabIcon name={route.name} focused={focused} color={color} />
        ),
      })}
    >
      <Tab.Screen name="Dashboard" component={DashboardScreen} />
      <Tab.Screen name="Transactions" component={TransactionsStack} />
      <Tab.Screen name="Import" component={ImportScreen} />
      <Tab.Screen name="Budgets" component={BudgetsScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}

const styles = StyleSheet.create({
  iconContainer: {
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
  },
  icon: {
    fontSize: 20,
    lineHeight: 24,
  },
  dot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    marginTop: 2,
  },
});
