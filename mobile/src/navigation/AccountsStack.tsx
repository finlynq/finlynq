import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import AccountsScreen from "../screens/AccountsScreen";
import AccountDetailScreen from "../screens/AccountDetailScreen";
import AddAccountScreen from "../screens/AddAccountScreen";
import AddTransactionScreen from "../screens/AddTransactionScreen";
import type { AccountBalance, AccountDetailRow } from "../../../shared/types";

export type AccountsStackParamList = {
  AccountsList: undefined;
  AccountDetail: { account: AccountBalance };
  // `account` present → edit mode (prefill + PUT); absent → create mode.
  AddAccount: { account?: AccountDetailRow } | undefined;
  AddTransaction: {
    mode?: "expense" | "income" | "transfer";
    preselectedAccountId?: number;
  };
};

const Stack = createNativeStackNavigator<AccountsStackParamList>();

export default function AccountsStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="AccountsList" component={AccountsScreen} />
      <Stack.Screen name="AccountDetail" component={AccountDetailScreen} />
      <Stack.Screen
        name="AddAccount"
        component={AddAccountScreen}
        options={{ presentation: "modal" }}
      />
      <Stack.Screen
        name="AddTransaction"
        component={AddTransactionScreen}
        options={{ presentation: "modal" }}
      />
    </Stack.Navigator>
  );
}
